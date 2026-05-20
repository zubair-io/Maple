# Maple File Provider — Phase 2 Design (XMP writes)

**Status:** approved, 2026-05-16
**Phase 1 reference:** `.archived-plans/plans/2026-05-14-file-provider-phase1.md`
**Implementation plan (to be written):** `.archived-plans/plans/2026-05-16-file-provider-phase2.md`

## Goal

Let external editors (Lightroom Classic, Capture One, Bridge) and the Finder
itself round-trip XMP sidecars through the File Provider mount. Phase 1
proved that read-only enumeration + lazy materialization works; Phase 2 makes
the picture writable for the one file format that needs to be writable.

## Scope

In:
- XMP create / modify / delete via the Finder mount
- Conflict copies on collision: `IMG (conflict from <device>).xmp`
- Atomic, last-writer-aware writes (mtime precondition)

Out (deferred):
- RAW writes, rename, move
- Working-set tracking (Phase 5)
- Push change feed / SSE — manual Refresh stays the only invalidation signal
- Quick Look generator, iOS extension

## Load-bearing principles (unchanged from Phase 1)

- **Originals are untouched.** RAWs remain read-only. XMP is the only writable type.
- **Server is source of truth.** The on-disk XMP next to the RAW is authoritative;
  the client never holds a divergent copy beyond the duration of a single
  `modifyItem` call.
- **Server-side identifiers.** XMPs are addressed by the asset's MongoDB ObjectId,
  not by path. A rename or move on the server (Phase 3+) won't break our refs.
- **Phase boundary clean.** No partial Phase 3+ scaffolding (no rename / move
  APIs, no working-set machinery) sneaks in.

## Architecture overview

Three subsystems change. Everything else from Phase 1 stays as-is.

### 1. Server enumeration — sidecars in the directory listing

`GET /api/fs/dir?path=<abs>` extends its response with a `sidecars` array:

```json
{
  "path": "/photos/2024",
  "parent": "/photos",
  "dirs":  [...],
  "images": [{ "name": "IMG_1.ARW", "assetID": "650a...", ... }],
  "sidecars": [
    { "name": "IMG_1.xmp", "path": "/photos/2024/IMG_1.xmp",
      "mtime": "2026-05-15T10:00:00Z", "size": 18432, "asset_id": "650a..." }
  ]
}
```

Pairing rule: for each `.xmp` in the directory, strip the extension *and any
`" (conflict from <device>)"` suffix*, then look up the asset whose `abs_path`
base matches. XMPs without a paired indexed asset are dropped (same filter as
`images`). The mtime is encoded as ISO-8601 for symmetry with the rest of the
listing.

The conflict-suffix regex is anchored: `^(.+?)( \(conflict from [^)]+\))?\.xmp$`.
The first capture group is the canonical base that pairs to the asset. The
second group is optional and identifies the file as a conflict copy.

### 2. Server write path — mtime precondition + conflict copies

`PUT /api/assets/:id/xmp` gains two optional request headers:

| Header | Purpose |
|---|---|
| `X-If-Mtime-Matches: <epoch-seconds>` | Precondition. Omit on create. |
| `X-Maple-Device-Name: <string>` | Used in conflict-copy filenames. Defaults to `"Unknown device"`. |

Behaviour matrix:

| `X-If-Mtime-Matches` | On-disk state | Result |
|---|---|---|
| absent | (any) | Atomic overwrite or create. `204 No Content` + `Last-Modified` header carrying the new mtime (RFC 7231 HTTP-date). |
| present, matches | matches | Atomic overwrite. `204 No Content` + `Last-Modified`. |
| present, mismatches | newer file exists | **Conflict copy.** Server writes the incoming bytes to `<base> (conflict from <device>).xmp`. Original untouched. Response: `409 Conflict` with `{ "conflict_path": "...", "conflict_mtime": "..." }` (mtime as ISO-8601). |

The `Last-Modified` header is load-bearing: the client uses it as the next
`X-If-Mtime-Matches` value. Without it, the client would have to refetch via
enumeration before the next save, which defeats the purpose of the precondition.

Notes:
- The conflict-copy filename uses the **device name from the header**, not the
  authenticated user. Two devices owned by the same user produce distinct copies.
- The conflict-copy mtime is a fresh `Date.now()` server-side. Clients pick it up
  via the next enumeration.
- mtime comparison is at one-second granularity (filesystem `mtime`). XMPs
  change at human cadence; sub-second precision isn't needed and avoids a
  server-side hash on every read.

`DELETE /api/assets/:id/xmp` is new:
- Removes the sidecar if it exists. Idempotent: `204` regardless.
- Never touches the RAW. The asset doc itself is untouched (no soft-delete bookkeeping
  in Phase 2; the asset stays indexed).

### 3. Client — writable sidecar items + write-path implementations

`MapleCore.FileProviderIdentifier` gains a third case:

```swift
case sidecar(assetID: String)   // raw form: "sidecar/<asset-id>"
```

`MapleCore.RemoteCatalog` learns three new methods:

```swift
public func putXMP(assetID: String, data: Data,
                   ifMtimeMatches: Date?, deviceName: String) async throws -> XMPWriteResult
public func deleteXMP(assetID: String) async throws

public enum XMPWriteResult {
    case ok
    case conflictCopy(path: String, mtime: Date)
}
```

The DTO extension on `DirContents`:

```swift
public struct SidecarChild: Codable, Equatable, Sendable {
    public let name: String
    public let path: String
    public let mtime: Date
    public let size: Int64
    public let assetID: String      // CodingKey "asset_id"
}

public struct DirContents { ... existing fields ... ; public let sidecars: [SidecarChild] }
```

`MapleFileProvider.MapleItem` gains a sidecar init:

```swift
init(sidecar: SidecarChild, parentIdentifier: NSFileProviderItemIdentifier) {
    self.identifier      = .sidecar(assetID: sidecar.assetID)
    self.displayName     = sidecar.name
    self.isDirectory     = false
    self.size            = NSNumber(value: sidecar.size)
    self.modified        = sidecar.mtime
    self.utType          = UTType("dyn.ah62d4rv4ge80g25dr3w") ?? .xml
    self.capabilities    = [.allowsReading, .allowsWriting, .allowsDeleting]
    self.itemVersion     = mtimeVersion(sidecar.mtime)
    ...
}
```

`itemVersion` for sidecars encodes the mtime as both `contentVersion` and
`metadataVersion` (same scheme Phase 1 used for assets, but here it's actually
load-bearing — the OS compares versions to decide what to ship to `modifyItem`).

`FileProviderExtension` replaces its three stub write methods:

#### `createItem`
- Triggered when Lightroom writes an XMP that wasn't enumerated (first save).
- Decode the template's filename → strip `.xmp` → look up the matching asset
  via the parent folder's enumeration cache. If the asset isn't found, return
  `NSFileProviderError.cannotSynchronize` (we don't allow XMPs for un-indexed
  files).
- Read the bytes from the `contents` URL the OS provides.
- Call `catalog.putXMP(assetID:, data:, ifMtimeMatches: nil, deviceName:)`.
- On success, return a fresh `MapleItem(sidecar:)` carrying the new mtime.
- On `conflictCopy` (impossible for create, but defensive): signal Finder and
  return the path as `filenameCollision`.

#### `modifyItem`
- Triggered when Lightroom saves an existing XMP.
- Decode the identifier as `sidecar/<asset-id>`. Read bytes from `contents`.
- Pull the prior mtime out of the item's `itemVersion`.
- Call `catalog.putXMP(... ifMtimeMatches: priorMtime ...)`.
- On `ok`: return a fresh item with the new mtime.
- On `conflictCopy(path:, mtime:)`:
  - Build an `NSError(domain: NSFileProviderErrorDomain,
    code: NSFileProviderError.filenameCollision.rawValue,
    userInfo: [NSFileProviderErrorCollidingItemKey: synthesizedItem])`.
  - Synthesize a `MapleItem` for the conflict path so Finder shows it.
  - Trigger a parent-folder re-enumeration so the next listing surfaces both files.

#### `deleteItem`
- Decode `sidecar/<asset-id>`, call `catalog.deleteXMP(assetID:)`. Return success.

### 4. Device name

`ProcessInfo.processInfo.hostName` returns `<machinename>.local` on macOS.
The extension reads it once at construction (it doesn't change at runtime),
stores in a `let`, sends as `X-Maple-Device-Name` on every write.

### 5. Enumeration plumbing

`MapleEnumerator.FolderEnumerator.enumerateItems` extends its current behaviour
(images + dirs) to also emit sidecars:

```swift
items.append(contentsOf: contents.sidecars.map {
    MapleItem(sidecar: $0, parentIdentifier: containerIdentifier)
})
```

No changes to `RootEnumerator` or the deferred-folder mechanism. The XMP is
always a sibling of its RAW so it surfaces wherever the RAW does.

## Identifier scheme (updated)

| Conceptual item | Encoded form | Notes |
|---|---|---|
| Domain root | `NSFileProviderItemIdentifier.rootContainer` | Unchanged. |
| Library root folder | `folder/<folder_id>:` | Unchanged. |
| Subdirectory | `folder/<folder_id>:<b64url-relpath>` | Unchanged. |
| RAW asset | `asset/<mongo-objectid>` | Unchanged. |
| **Canonical XMP sidecar** | **`sidecar/<mongo-objectid>`** | **New.** Empty payload after the ObjectId. |
| **Conflict-copy XMP sidecar** | **`sidecar/<mongo-objectid>:<b64url-basename>`** | **New.** Basename without the `.xmp` extension, base64url-encoded. |

Two sidecars per asset are possible: the canonical `IMG_1.xmp` and any number
of conflict copies like `IMG_1 (conflict from MacBook).xmp`. Each gets a distinct
identifier; both pair to the same asset doc in the directory listing.
`FileProviderIdentifier.init(rawValue:)` accepts the new prefix and parses
both forms (with and without the `:<basename>` suffix), rejecting malformed
inputs with `DecodeError.invalidPrefix` or `DecodeError.malformedSidecar`.

The extension's `MapleItem(sidecar:)` init picks the right form based on the
filename in the enumeration response: canonical if the name matches the
asset's filename-base + `.xmp`, otherwise the conflict-suffix form.

## Conflict resolution (user flow)

1. Device A and Device B both opened `IMG_1.xmp` for editing (read at mtime T1).
2. Device A saves first → server writes T2. Mtime is now T2.
3. Device B saves with `X-If-Mtime-Matches: T1` → mismatch.
4. Server writes B's bytes to `IMG_1 (conflict from device-b).xmp`, returns 409
   with the path.
5. Device B's File Provider surfaces this as a `filenameCollision` to Finder.
6. On the next root re-enumeration on any device, both files appear.
7. **User manually picks one and deletes the other.** Phase 2 ships no automerge.

The Maple app's own editor uses the same API path. If the user opens IMG_1 in
Maple and edits while Finder/Lightroom is also editing, the same conflict-copy
flow applies. The Maple editor isn't aware of File Provider at all — it just
PUTs to the API with the same headers.

## Error handling

- **Network failure during write:** macOS treats the write as failed, retains the
  bytes in the local cache, retries when reachable. Standard File Provider
  behaviour; no client-side queue needed.
- **Auth failure (401, refresh fails):** Bubble up as `NSFileProviderError.notAuthenticated`.
  User signs back into the Maple app, the Phase 1 token-mirror restores the
  extension.
- **Asset not found (404 on PUT):** The asset was deleted server-side while the
  XMP was being edited. Return `NSFileProviderError.noSuchItem`; the next
  re-enumeration drops the orphan.
- **Server rejects DELETE for an active asset:** Phase 2 doesn't define this
  case — DELETE is idempotent and always succeeds.
- **Concurrent client edits on the same device:** macOS serializes
  `modifyItem` per-item, so two Lightroom auto-saves can't collide locally.

## Testing strategy

### Unit (Swift, `swift test`)
- `FileProviderIdentifierTests` — round-trip the new `sidecar/<id>` (canonical)
  and `sidecar/<id>:<b64url-name>` (conflict) forms; reject malformed.
- `RemoteCatalogTests` — decode `DirContents` with empty and populated
  `sidecars` arrays.

### API (Bun, `bun test`)
- `assets-xmp-conflict.test.ts`:
  - PUT without precondition writes normally.
  - PUT with matching mtime overwrites atomically.
  - PUT with mismatching mtime produces a conflict copy at the expected name;
    409 + body carries `conflict_path` and `conflict_mtime`; original untouched.
  - Two concurrent PUTs racing each other: the loser produces a conflict copy.
  - Missing `X-Maple-Device-Name` → conflict filename contains `"Unknown device"`.
- `assets-xmp-delete.test.ts`:
  - DELETE removes existing sidecar, returns 204.
  - DELETE of non-existent sidecar still returns 204.
  - DELETE never touches the RAW.
- `fs-dir-sidecars.test.ts`:
  - Paired `IMG.ARW` + `IMG.xmp` returns both in `images` and `sidecars`.
  - Orphan `.xmp` (no asset doc) is dropped from `sidecars`.
  - Conflict-name XMP pairs to the same asset as its base RAW.

All API tests use `mkdtempSync` for the working dir + the real Elysia handler
(no Mongo mocks). Pattern matches the existing `backup-*.test.ts` files.

### Integration (manual, pre-merge)
1. `bun run dev`, register a folder with at least one indexed RAW.
2. Enable the Finder domain via the Phase 1 Settings tab.
3. Open the RAW in Lightroom Classic from the Finder mount, change a rating,
   Cmd+S.
4. The Maple app should reflect the new rating (proves XMP round-tripped).
5. From a second machine signed into the same server, rate the same RAW
   differently, save.
6. Confirm a `(conflict from <hostname>).xmp` shows up in Finder and in
   `/api/fs/dir`.
7. Drag the conflict copy to Trash; confirm DELETE fires, file is gone server-side.

### Skipped
- No XMP-roundtrip UITest (would need to drive Lightroom; not worth the complexity).
- No load test for write throughput. Lightroom's natural cadence is low; revisit
  if profiling reveals a bottleneck.

## Performance invariants (unchanged)

Phase 2 doesn't touch the render loop. The 16ms slider-tick budget is unaffected
because XMP writes are out-of-band — Maple's own editor still writes via direct
HTTP, not via File Provider. The File Provider write path is only used by
external editors (which run in their own processes).

## What ships at the end of Phase 2

A user can:
1. Open a RAW in Lightroom Classic from the Finder mount.
2. Edit the rating / stars / color label / develop sliders.
3. Save in Lightroom → XMP propagates to the Maple server.
4. View the same edits in the Maple app on another device.
5. Edit the same RAW from two devices, see the conflict copy surface in Finder
   on the loser side, manually pick a winner.
6. Drag an XMP to the Trash → server-side sidecar is removed.

The RAW itself never changes; only sidecars move.
