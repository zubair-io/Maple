# Maple File Provider — Phase 5 Design (Quick Look + working set + perf)

**Status:** draft, 2026-05-16
**Phase 1 reference:** `docs/superpowers/plans/2026-05-14-file-provider-phase1.md`
**Phase 2 reference:** `docs/superpowers/specs/2026-05-16-file-provider-phase2-design.md`
**Phase 3 reference:** `docs/superpowers/specs/2026-05-16-file-provider-phase3-design.md`
**Phase 4 reference:** `docs/superpowers/specs/2026-05-16-file-provider-phase4-design.md`
**Implementation plans (to be written):**
- `docs/superpowers/plans/2026-05-16-file-provider-phase5a-quick-look.md`
- `docs/superpowers/plans/2026-05-16-file-provider-phase5b-working-set.md`
- `docs/superpowers/plans/2026-05-16-file-provider-phase5c-perf.md`

## Goal

Close the long-tail performance and integration work the earlier phases
deliberately deferred. Phase 5 ships as one branch but the work splits into
three independent areas, each plannable and reviewable on its own:

- **5a — Quick Look generator.** Stop materializing a full 150 MB RAW every
  time the user hits spacebar in Finder; serve the pre-baked `.maple/` JPEG
  preview instead.
- **5b — Working set + push channel.** Make refresh automatic (push) and
  bounded (the OS asks for the working-set subset, the extension keeps that
  subset coherent). Replaces the Phase 1 manual-Refresh button as the
  primary invalidation mechanism.
- **5c — Perf optimisation pass.** Strip per-tick allocations, add HTTP
  caching headers (ETag / If-Modified-Since), profile the cold-open path,
  fix what shows up. Driven by measurement, not speculation.

The three are deliberately bundled because **5b unlocks 5c**: a coherent
working set is what lets ETag/If-Modified-Since become useful (otherwise
the OS keeps asking for full re-enumerations). And **5a leans on the
caching from 5c** — Quick Look is hot-path; the second request for the
same preview should be free.

## Scope

In:
- A Quick Look extension (`MapleQuickLook.appex`) on macOS and iOS that
  serves `.maple/<basename>.jpg` previews for any asset in any Maple File
  Provider domain.
- A working-set enumerator that tracks at most ~20k items: every XMP, every
  asset where `rating ≥ 1`, every asset captured in the last 30 days, and
  every asset in the currently-active folder.
- A server-side change feed exposed as Server-Sent Events at
  `GET /api/changes?since=<cursor>` plus a polled catch-up form at
  `GET /api/changes?since=<cursor>&limit=N`.
- Caching headers (ETag + Last-Modified, supporting If-None-Match +
  If-Modified-Since) on `GET /api/folders`, `GET /api/fs/dir`, and
  `GET /api/assets/:id`.
- One round of measured optimisation: profile cold-open and warm-enumerate,
  fix anything that shows ≥ 50 ms or ≥ 1 MB allocation.

Out (deferred):
- WebSocket as a change-feed transport. SSE is enough; WebSocket gives no
  ergonomic win for one-way server-push.
- Background prefetch of likely-next photos (could ride on the push channel
  but the heuristics are uncertain). Phase 6+.
- Smart-folder-style virtual containers beyond "Trash". The OS already lets
  the user pin a Finder favourite; that covers most of the "recent" muscle
  memory.
- Selective sync controls ("keep this folder offline"). NSFileProviderManager
  exposes the APIs; a Settings UI for them is Phase 6+.

## Load-bearing principles (unchanged from Phase 1-4)

Same four as the previous phases. The most relevant to Phase 5:

- **Server is source of truth.** The push channel is a *hint* — every change
  delivered via SSE is also retrievable by polling the change endpoint.
  Losing a few events to a connection blip can't corrupt state.
- **Phase boundary clean.** No selective-sync, no smart folders, no
  prefetch. Five-and-a-half is a different phase.

---

## Area 5a — Quick Look generator

### Problem

Today (Phase 1-4), spacebar in Finder on a Maple-mounted RAW triggers
`fetchContents`, which downloads the entire RAW (40-150 MB) so the system
QuickLook can decode it. That works but is a brutal waste of bandwidth for
the user's most common interaction.

The server already keeps a JPEG preview for every indexed asset in
`<folder_root>/.maple/<basename>.jpg`, served by `GET /api/assets/:id/thumb`.
We ship a Quick Look extension that reads that endpoint instead of
materializing the RAW.

### Architecture

New target: `MapleQuickLook.appex` (macOS) and `MapleQuickLookIOS.appex`
(iOS, in Phase 4's tree if Phase 4 has shipped; else iOS slot is empty).
Both target a small Swift class conforming to `QLPreviewProvider`.

```swift
final class MaplePreviewProvider: QLPreviewProvider, QLPreviewingController {
    func providePreview(for request: QLFilePreviewRequest) async throws -> QLPreviewReply {
        // request.fileURL is the File Provider's local cache URL.
        // The filename includes the assetID via our FileProviderIdentifier scheme.
        let assetID = try resolveAssetID(from: request.fileURL)
        let domain = try resolveDomain(from: request.fileURL)
        let cfg = FileProviderConfig().load(domain: domain.identifier.rawValue)!
        let http = AuthenticatedHTTPClient(server: cfg.serverURL, ...)
        let previewURL = cfg.serverURL.appending(path: "/api/assets/\(assetID)/thumb")
        let (data, resp) = try await http.data(for: URLRequest(url: previewURL))
        guard (resp as? HTTPURLResponse)?.statusCode == 200 else {
            throw NSError(.qlNoPreview)
        }
        return QLPreviewReply(dataOfContentType: .jpeg,
                              contentSize: imageSizeFromHeader(resp)) { reply in
            return data
        }
    }
}
```

Two challenges:

1. **Resolving asset identifier from `fileURL`.** When Quick Look fires,
   it hands us a local file URL that the File Provider materialized.
   We need the assetID to call `/api/assets/:id/thumb`. The filename
   carries the right hex string for our File Provider items (we set
   `MapleItem.filename` to the asset's original filename, not its ID),
   so we can't use the filename alone. We need a stable mapping.

   Solution: when the File Provider extension responds to
   `fetchContents`, we write a sibling file at
   `<local>.maple-meta.json` containing `{"asset_id": "...", "domain": "..."}`.
   The Quick Look provider reads that sidecar. The sidecar is hidden from
   the user (begins with `.`).

   Alternative considered: extended attributes (`xattr`). Rejected because
   File Provider's local cache directory is sandboxed and the xattr API
   doesn't reliably round-trip through the system there.

2. **Auth sharing with the Quick Look extension.** Quick Look extensions
   run in their own process. They share the App Group + Keychain access
   group already set up in Phase 1; constructing the `AuthenticatedHTTPClient`
   the same way works without changes.

### Server changes

None. Phase 5a is a pure client-side addition that uses an existing
endpoint. The thumb endpoint already supports `If-None-Match` (added in 5c
below) so repeated Quick Look invocations don't re-fetch.

### Fallback

If `/api/assets/:id/thumb` returns 404 (the indexer hasn't generated the
preview yet — e.g., the asset was just uploaded), Quick Look falls back to
materializing the full RAW via the OS default. The user sees a slower
first-time preview; the second invocation hits the cache.

If the network is down, `data(for:)` throws; Quick Look returns
`QLPreviewError.noPreview` and the OS shows the default file icon. Better
than hanging.

---

## Area 5b — Working set + push change feed

### Problem

Phase 1-4 enumerators all return `moreComing: false` on every
`enumerateChanges` call and use a static sync anchor "0". Manual Refresh in
Settings is the only way the extension learns about server-side changes.

For a user who edits a photo on their phone and then opens their Mac, the
photo's new XMP doesn't show up until they hit Refresh. That's an
unacceptably high-friction story for the "everything in sync" promise.

### Architecture

#### Server: monotonic change cursor

A new collection `asset_changes` records every mutation to an asset:

```typescript
interface AssetChangeDoc {
    _id: ObjectId;
    cursor: number;            // monotonically increasing, ≈ epoch milliseconds
    asset_id: ObjectId;
    folder_id: ObjectId;
    kind: "create" | "update" | "delete" | "restore";
    abs_path: string;
    at: Date;
}
```

Writers (`/api/folders/:id/upload`, `DELETE /api/assets/:id`,
`POST /api/assets/:id/restore`, the indexer's enrichment workers when they
update an asset's search blob) all insert a change row in the same Mongo
transaction as the asset write.

The `cursor` field is assigned via a server-side counter
(`server_state.collection.findOneAndUpdate(..., $inc: { next_cursor: 1 })`).
Mongo's `$inc` is atomic at the document level — no race between writers.

#### Server: HTTP change endpoint

`GET /api/changes?since=<cursor>&limit=N` returns up to `N` changes (default
100, max 1000) where `cursor > since`. Response:

```json
{
  "changes": [
    { "cursor": 42, "asset_id": "...", "kind": "update", "abs_path": "...", "at": "..." }
  ],
  "next_cursor": 42      // = max cursor in this page; absent if no changes
}
```

The client polls in a loop until `next_cursor` matches the last `since`
to catch up after a long disconnect.

#### Server: SSE push channel

`GET /api/changes/subscribe?since=<cursor>` upgrades to Server-Sent Events.
Each new change becomes one SSE message:

```
id: 43
event: change
data: {"cursor": 43, "asset_id": "...", "kind": "update", ...}

```

The client tracks the last-seen cursor and resumes from there if the
connection drops. Bun's Elysia handler attaches to a Node.js `EventEmitter`
that the write endpoints publish to.

If the client requests `since` > current server cursor, the server returns
an empty stream and waits for new changes. If `since` < current cursor by
more than a backlog window (server keeps last 10k changes in a ring buffer
in-process), the server returns HTTP 409 with `{ "error": "cursor too old",
"current": N }` and the client knows to fall back to full re-enumeration.

#### Extension: working-set enumerator

`enumerator(for: .workingSet)` is no longer the empty stub. New
`WorkingSetEnumerator`:

1. On `enumerateItems`, return everything tracked in the in-memory working
   set (cap: 20k items).
2. On `enumerateChanges(from: anchor)`, return everything that changed
   since `anchor`.
3. On `currentSyncAnchor`, return the latest known cursor.

The working set is built from:
- All sidecars (XMP files) — always tracked, regardless of count.
- All assets with `rating ≥ 1` (favorites).
- All assets captured in the last 30 days.
- All assets in the currently-active folder (tracked by the OS via
  `materializedItemsEnumerator` interactions).

The extension fetches this on startup via three calls:
- `GET /api/assets?has_xmp=1` (sidecars)
- `GET /api/assets?rating_gte=1`
- `GET /api/assets?captured_after=<30d ago>`

(Three new server filters; trivial query additions.)

Total expected size: a working photographer with 200 favourites + 500 recent
+ 5000 XMPs + 1000 active = ~7k items. Cap is 20k; in practice we're at
~1/3 of the budget.

#### Extension: SSE subscription

On `init`, the extension starts an SSE subscription to
`/api/changes/subscribe?since=<last-known-cursor>` using
`URLSession.dataTask`'s delegate-based streaming. Each event:

1. Parses to an `AssetChangeDoc`.
2. Updates `LibraryRootCache` if it's a folder-level change.
3. Calls `NSFileProviderManager(for: domain)?.signalEnumerator(for: <container>)`
   for the affected container.
4. Bumps the working-set anchor.

If the connection drops, exponential-backoff reconnect (2 s → 16 s cap).
On reconnect, the client passes its last-seen cursor, which the server
uses to backfill missed events.

#### Compatibility with Phase 1's Settings Refresh

The manual Refresh button stays. It still calls
`NSFileProviderManager.signalEnumerator(for: .rootContainer)`. With the SSE
channel running, Refresh is now redundant in normal operation, but useful
as an escape hatch if SSE is somehow stuck (e.g., behind a corporate proxy
that buffers SSE).

---

## Area 5c — Perf optimisation pass

### Approach

Profile-driven, not speculative. Two scenarios:

1. **Cold open of a Finder window on a Maple library** (50 library roots,
   each with 100s of folders): measure the time from open to fully-rendered.
2. **Hitting Refresh** with no server-side changes: measure the wasted
   work.

Hypotheses going in (will adjust based on measurement):

- (1) is bottlenecked by root enumeration's serial folder-listing fetches.
- (2) wastes bandwidth re-downloading enumeration bodies that are identical
  to the previous version.

### Planned changes (subject to measurement)

#### HTTP caching: ETag + If-None-Match

The server adds `ETag` headers to the responses of:
- `GET /api/folders` — ETag = hash of the folders list (sort + concat ids + mtimes).
- `GET /api/fs/dir?path=...` — ETag = hash of the directory's entries
  (sort + concat names + mtimes + sidecar mtimes).
- `GET /api/assets/:id` — ETag = asset's `updated_at`.
- `GET /api/assets/:id/thumb` — ETag = thumb file's mtime + size.

The client (`RemoteCatalog`) tracks ETags per URL in an in-memory dictionary
on the actor. Subsequent requests send `If-None-Match: <etag>`. On `304 Not
Modified`, the client reuses its cached decoded response.

For enumeration responses (which can be many megabytes for big folders),
this saves both download time and JSON parse time.

#### Eager root cache

Currently `RootEnumerator.enumerateItems` does one HTTP call to
`/api/folders`. With ETag, that becomes a 304 on the warm path, but it's
still a round-trip.

The extension's startup primes `LibraryRootCache` from disk
(`UserDefaults`-backed cache of the last-known folders list). First
`enumerateItems` returns the cached list immediately and triggers a
background revalidation. If the revalidation finds drift, the OS gets a
`signalEnumerator` to re-enumerate.

#### Per-tick allocation audit

A single `os_signpost`-instrumented run through a typical session
(open Finder, navigate to a folder, open a RAW). Look for any
`heap_allocated_bytes` spike > 1 MB.

Expected suspects:
- `JSONDecoder().decode(...)` on big folder listings — switch to
  `JSONSerialization` + manual mapping if it shows up, else leave alone.
- `String(data:, encoding:)` on response bodies — switch to streaming
  decode if it shows up, else leave alone.
- `MapleItem` instances accumulating across pages — verify they get
  released after `observer.didEnumerate`.

If measurement shows none of these are the bottleneck, the budget for this
work shrinks and we move on. If measurement shows something we didn't
expect, we fix that instead.

#### Pagination follow-through

Phase 4 added server-side pagination of `GET /api/fs/dir`. Phase 5c
verifies the client follows multi-page cursors correctly under realistic
load and surfaces partial results to Finder eagerly (i.e., `didEnumerate`
fires per page, not just at the end).

---

## Identifier scheme (unchanged from Phase 3)

Phase 5 does not introduce new identifier forms. The working-set enumerator
returns items whose identifiers already encode their parent — the OS uses
that to attach them to the right container in its local cache.

## Testing strategy

### Quick Look (5a)
- Unit: `MaplePreviewProvider` is hard to unit-test in isolation (lives in
  an extension). Integration test below covers the happy path.
- Integration:
  1. Start API, enable Maple FP domain.
  2. In Finder, hit spacebar on a RAW.
  3. Confirm: a JPEG preview shows within 200 ms (compared to multi-second
     materialization before).
  4. Repeat spacebar — confirm second open is instant (cache hit).
  5. Delete `<folder>/.maple/<basename>.jpg` server-side, repeat spacebar
     — confirm fallback to full materialization.

### Working set + change feed (5b)
- API tests:
  - `changes-cursor.test.ts`: insert/update/delete an asset → corresponding
    change row written with monotonic cursor.
  - `changes-poll.test.ts`: `GET /api/changes?since=N` returns expected
    rows; pagination works; cursor too-old returns 409.
  - `changes-sse.test.ts`: connect to SSE, write 3 assets, confirm 3 events
    received with correct cursors in order; reconnect with `since` picks
    up missed events.
- Swift tests: `WorkingSetEnumeratorTests` for in-memory working-set
  bookkeeping, fully synchronous (no network).
- Integration:
  1. Enable FP domain on Mac A, sign in to the same server on Mac B.
  2. From Mac B, change a photo's rating.
  3. Confirm Mac A's Finder reflects the new XMP within 5 seconds with no
     manual Refresh.
  4. Drop the network on Mac A for 2 minutes, change 5 photos on Mac B,
     restore Mac A's network. Confirm Mac A catches up via the
     reconnect-backfill path.

### Perf pass (5c)
- API tests for ETag responses: `If-None-Match` returns 304 with no body.
- Manual benchmark: run the profiling scenario before-and-after, capture
  numbers in the plan's commit message. No automated regression test
  (perf tests are hard to keep stable in CI for this surface).

### Skipped
- Quick Look UITest. The QL panel isn't accessible from `XCTest`.
- Load test for SSE concurrent connections. Bun handles many concurrent
  connections fine; this is a known scalability axis with public answers.

## Performance invariants

After Phase 5:

- **Finder cold open** (mounted Maple library, 50 roots): < 1 s to first
  paint of root container.
- **Spacebar preview** (5a): < 250 ms on warm cache, < 500 ms on cold
  cache hit.
- **Server-change propagation** (5b SSE happy path): < 5 s end-to-end.
- **Refresh after no changes** (5c ETag): one round-trip per container,
  no JSON parse, no UI update.
- **Slider tick:** still 16 ms target. Phase 5 doesn't touch the render
  loop; the Maple app's own editor is unaffected by File Provider
  changes.

## What ships at the end of Phase 5

A user can:
1. Hit spacebar on any RAW in Finder and get a sub-second preview without
   downloading the full file.
2. Edit a photo on iPhone, switch to MacBook 5 seconds later, see the new
   XMP reflected in Finder *and* in the Maple app without touching any
   refresh button.
3. Work offline, reconnect, watch the queue of missed edits flow in over
   the change feed.
4. Open a Maple-mounted folder containing thousands of photos and see the
   first page appear in a fraction of a second, with later pages filling
   in.

The mental model of "files are real, server is the source of truth, everything
just syncs" finally holds end-to-end. Phases 6+ (rename/move, smart
folders, selective sync, prefetch) become product asks rather than
infrastructure debt.
