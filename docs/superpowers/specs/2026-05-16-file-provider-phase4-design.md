# Maple File Provider — Phase 4 Design (iOS full-library mirror)

**Status:** draft, 2026-05-16
**Phase 1 reference:** `docs/superpowers/plans/2026-05-14-file-provider-phase1.md`
**Phase 2 reference:** `docs/superpowers/specs/2026-05-16-file-provider-phase2-design.md`
**Phase 3 reference:** `docs/superpowers/specs/2026-05-16-file-provider-phase3-design.md`
**Implementation plan (to be written):** `docs/superpowers/plans/2026-05-16-file-provider-phase4.md`

## Goal

Bring the same File Provider domain Phase 1-3 ship on macOS to iOS and
iPadOS, exposing the *full* library tree through the iOS Files app and
through any `UIDocumentPicker` that browses File Provider domains.

The original design summary recommended a curated-subset policy on iOS
(Recent + Favorites + pinned folders) to keep the working set bounded. The
product call is to mirror macOS instead — the same tree, the same identifiers,
the same enumerators. That's a deliberate trade: it costs Files-app first-paint
latency on huge libraries but preserves a single mental model across
platforms.

Phase 4 makes the trade-off survivable with three concrete mitigations:
streaming downloads to respect iOS extension memory limits, server-side
enumeration paging for deep folders, and lazy-by-default root enumeration so
that the first folder open doesn't fan out to every library root.

## Scope

In:
- An iOS / iPadOS app-extension target (`MapleFileProviderIOS.appex`) that
  conforms to `NSFileProviderReplicatedExtension`, sharing all of
  `MapleCore`/`FileProvider/` with the existing macOS extension.
- iOS variants of the App Group + Keychain access group, wired the same way
  as macOS (`group.app.justmaple.aperture`, `$(AppIdentifierPrefix)…shared`).
- Streaming downloads via `URLSession.downloadTask(with:)` for asset fetches
  (deferred from Phase 1, becomes load-bearing here).
- Server-side enumeration paging on `GET /api/fs/dir` when the directory has
  more than 500 children. The existing endpoint stays backward-compatible:
  no `cursor` query → returns all entries (current behaviour); with
  `?cursor=…&limit=N` → paged response.
- Per-folder content read on demand. The root enumerator returns library roots
  (cheap) but does not pre-fetch any child enumeration.
- iOS Settings panel in the Maple app for enabling/disabling the File
  Provider domain (mirrors macOS Settings → Finder tab).

Out (deferred):
- Phase 3 writes on iOS. Uploads from the iOS Files app are unusual; if
  needed they can ship as a Phase 4 follow-up after macOS Phase 3 lands
  and we know the upload codepath is solid. iOS Files-app deletes hit the
  same Phase 3 server endpoints if those endpoints exist by Phase 4 ship —
  the extension code wires them either way, behind a feature gate.
- Quick Look generator (Phase 5a).
- Working-set tracking and push change feed (Phase 5b). iOS gets the same
  manual-refresh-only behaviour as macOS Phase 1-3.
- Background download scheduling for opportunistic prefetch. iOS supports
  `NSURLSession` background config with `discretionary = true`, but Phase 4
  ships without prefetch — every file materializes only when the user taps
  it.

## Load-bearing principles (unchanged from Phase 1-3)

- **Originals are sacred.** No iOS-specific code path mutates a RAW byte.
- **Server is source of truth.** iOS extension is a thin shell over the same
  HTTP API.
- **Server-side identifiers.** Same `FileProviderIdentifier` enum, same
  encoded strings. macOS and iOS see the same item IDs for the same items.
- **Phase boundary clean.** No working-set, no push channel, no Quick Look
  scaffolding sneaks into Phase 4. Phase 4 is "macOS extension, but on iOS,
  with the memory/scaling fixes needed to make full-mirror work."

## Architecture overview

Three new pieces of code, two server changes, one shared change.

### 1. New iOS extension target

Bundle ID: `app.justmaple.aperture.FileProviderIOS`. Deployment target:
iOS 17 (matches the host app's `IPHONEOS_DEPLOYMENT_TARGET`).

Target layout mirrors `src/apple/MapleFileProvider/`:

```
src/apple/MapleFileProviderIOS/
  FileProviderExtensionIOS.swift   # NSFileProviderReplicatedExtension entry-point
  MapleFileProviderIOS.entitlements
  Info.plist
```

The Swift implementation is *almost* the same as macOS: same enumerators,
same `MapleItem`, same `LibraryRootCache`. The differences are all conditional
compilation (`#if os(iOS)`) within shared files, not separate parallel
implementations:

- `fetchContents` uses `URLSession.downloadTask(with:completionHandler:)` on
  iOS, retaining the existing buffered `URLSession.data(for:)` path on macOS
  where the memory limit isn't binding.
- `enumerator(for:)` defaults to a smaller page size (200 items) on iOS.
- The dormant-fallback fatalError-avoidance from Phase 1 is unchanged.

**Most of `FileProviderExtensionIOS.swift` is a one-line entry-point** that
constructs `FileProviderExtension` (the shared core class). The split exists
because Apple wires extensions by target, not by class — each target needs a
principal class that's part of *that* target's module — but the behaviour
lives in the shared core.

To avoid duplicating the entire `FileProviderExtension` body, we promote it
to a shared file under `MapleCore/FileProvider/FileProviderExtensionCore.swift`
and have each platform-specific target ship a 20-line subclass:

```swift
// MapleFileProvider/FileProviderExtension.swift (macOS)
import FileProvider
import MapleCore
final class FileProviderExtension: FileProviderExtensionCore { }
```

```swift
// MapleFileProviderIOS/FileProviderExtensionIOS.swift (iOS)
import FileProvider
import MapleCore
final class FileProviderExtensionIOS: FileProviderExtensionCore { }
```

Both inherit from `FileProviderExtensionCore` in `MapleCore`. `Info.plist`
in each target points `NSExtensionPrincipalClass` at its own subclass.

This refactor is Step 1 of the Phase 4 plan. It's a no-op behaviour change
on macOS but unlocks the iOS target without copy-pasting 250 lines.

### 2. Streaming download path (becomes default on iOS, opt-in on macOS)

`RemoteCatalog.downloadAsset(assetID:to:)` currently buffers the full body via
`URLSession.data(for:)`. Phase 1 left a comment: *"Phase 1 simplification:
full-body buffering. A 100MP RAW spikes ~150MB. Acceptable on macOS; revisit
with URLSession.download(for:) before iOS."*

Phase 4 implements the revisit. The new shape:

```swift
public func downloadAsset(assetID: String, to localURL: URL) async throws {
    let req = URLRequest(url: server.appending(path: "/api/assets/\(assetID)/raw"))
    let injected = await http.inject(req)
    let (tmpURL, resp) = try await urlSession.download(for: injected)
    try Self.check2xx(resp)
    // download() returns a tmp URL in NSTemporaryDirectory; move into place.
    if FileManager.default.fileExists(atPath: localURL.path) {
        try FileManager.default.removeItem(at: localURL)
    }
    try FileManager.default.moveItem(at: tmpURL, to: localURL)
}
```

Two changes from Phase 1:
1. The HTTP auth headers must be injected *before* handing the request to
   `urlSession.download`, because `URLSession.download(for:)` doesn't call
   back into our `AuthenticatedHTTPClient.data(for:)` wrapper. A new
   `inject(_ req:) async -> URLRequest` actor method on `AuthenticatedHTTPClient`
   handles the per-request header injection without forcing the body buffer.
2. The 401-retry logic from `AuthenticatedHTTPClient.data(for:)` doesn't
   apply automatically. `downloadAsset` checks the response status and on
   401 forces a refresh via `await http.refreshTokens()` and a single retry.
   That logic moves into a private `downloadOnce` helper.

The token-refresh path is the trickiest part. We don't want to duplicate the
single-flight refresh logic from `AuthenticatedHTTPClient.data(for:)` — so
we expose `AuthenticatedHTTPClient.refreshIfNeededAndRetry<T>(_ block: @escaping (URLRequest) async throws -> T) async throws -> T` and use it from
both call sites.

Memory-wise: on iOS, a 100 MP RAW downloads through `URLSession`'s temporary
file (not RAM), then we move-not-copy into the File Provider's destination.
Peak memory stays under 5 MB instead of 150 MB.

### 3. Server-side enumeration paging

`GET /api/fs/dir?path=<abs>` accepts two new optional query parameters:

- `cursor=<opaque-string>` — token returned by the previous page. Omit on the
  first call.
- `limit=<N>` — page size, default 500, max 2000.

When `cursor` is omitted, the response is identical to today (single shot,
all entries). When `cursor` is present (or the directory has > `limit`
entries), the response gains a `next_cursor` field:

```json
{
  "path": "...",
  "parent": "...",
  "dirs": [...],
  "images": [...],
  "sidecars": [...],
  "next_cursor": "eyJvZmZzZXQiOjUwMH0"
}
```

If `next_cursor` is `null` (or omitted), the listing is complete. The cursor
is server-defined (currently a base64-encoded `{"offset": N}` for filesystem
enumeration; the server is free to switch to a stable-sort key later
without API changes).

The directory walk on the server is already lazy — `readdir` returns one batch.
The new logic: sort the names deterministically (lexicographic by NFD-normalised
filename), then slice `[offset, offset + limit)` and emit a cursor.

The File Provider extension calls `RemoteCatalog.listDir(absolutePath:cursor:)`
and follows the cursor to completion in a tight loop within
`enumerateItems(for:startingAt:)`, calling `observer.didEnumerate(items)`
multiple times per call as pages arrive. `NSFileProviderEnumerator` is
designed exactly for this pattern.

For the typical case (most folders < 500 photos), there's a single round-trip
and no cursor in play. For deep folders (a "Photos" root that someone dumped
20k flat into), the iOS extension paginates without exhausting memory or
hitting a 60-second URLSession timeout.

### 4. iOS Settings UI

A new SwiftUI view, `FileProviderSettingsViewIOS`, mirrors the macOS
`FileProviderSettingsView` from Phase 1 with the iOS chrome (Form, NavigationView,
no TabView). It's wired into the existing app's settings shell.

The actual `FileProviderDomainController` from Phase 1 is platform-neutral
and works on iOS unchanged. The only platform-conditional code is the
SwiftUI presentation layer.

### 5. Background refresh

The macOS extension can refresh via the user clicking "Refresh" in Settings.
iOS adds one more trigger: foreground entry. When the host app comes to the
foreground, it calls `FileProviderDomainController.refresh(domainIdentifier:)`
for every active domain. The OS pulls the latest root enumeration on next
display.

This is a one-line addition to the app's `scenePhase` handler. It's not a
push channel — server changes still take the next refresh cycle to surface —
but for an app the user has open, "every time they re-foreground" is a
reasonable approximation of fresh.

## Identifier scheme (unchanged from Phase 3)

iOS uses the same `FileProviderIdentifier` enum as macOS. A photo's identifier
on macOS is the same string as on iOS. This is load-bearing for any future
cross-device drag operations (a user dragging from iPhone to MacBook over
AirDrop's File Provider integration, for example).

## Memory budget validation

`NSFileProviderReplicatedExtension` on iOS has a memory limit of 60 MB per
process (per Apple's filed-but-not-officially-published guidance, observable
via `os_proc_available_memory()`). The extension does not get the host app's
memory budget.

Phase 4 budget breakdown for the worst case:

| Component | Steady-state | Peak |
|---|---|---|
| `MapleCore` static data + Swift runtime | ~8 MB | ~8 MB |
| `LibraryRootCache` (50 roots × ~200 B each) | ~10 KB | ~10 KB |
| `RemoteCatalog` JSONDecoder | < 1 MB | < 1 MB |
| One in-flight enumeration page (500 items) | ~500 KB | ~500 KB |
| `URLSession` download buffer (`URLSession.download(for:)`) | ~512 KB | ~2 MB |
| `URLSession` upload buffer (Phase 4 doesn't ship uploads) | n/a | n/a |
| MapleCore's `RawPipeline.xcframework` (libraw_ffi.a) | ~6 MB | ~6 MB |

Total: ~16 MB steady-state, ~17 MB peak. Comfortably under the 60 MB limit
with room for unexpected one-off allocations (e.g., a malformed enumeration
response producing a large `DecodingError`).

The single load-bearing requirement is *not buffering full asset bodies in
RAM*. The streaming-download change (§2) makes that hold.

## First-paint latency on big libraries

A user with 50 library roots and 100k photos: the iOS Files app shows
"Maple" under Locations. Tap → root enumeration fires.

Root enumeration cost = 1 HTTP call to `/api/folders`, ~50 KB response,
< 200 ms RTT on a decent network. Returns 50 `MapleItem` instances for the
library roots + 50 more for the Trash folders (if Phase 3 has shipped).
First paint: ~250 ms.

Tap a library root → folder enumeration for that root's first level. If the
root contains 200 year-folders (e.g., one per shoot), that's another
sub-second listing.

Tap a specific year → its sub-folders. Each level is one HTTP call.

Drill down to a specific day's folder → list of photos. If the day has < 500
photos: single shot. If > 500: paginated, with `observer.didEnumerate`
called every page (the OS shows the partial listing while later pages
stream in).

Comparison to "curated subset" (the rejected alternative): single shot of
top 5000 favourites or recents, also sub-second. The full-mirror is slower
*at depth*, but it preserves the structural mental model. For most users
who don't have year-deep folder hierarchies, the difference is invisible.

If a user with a truly pathological library reports a slow Files app, the
mitigation is to ship working set + push channel (Phase 5b) — not to change
the enumeration model.

## Testing strategy

### Unit (Swift, `swift test`)
- `RemoteCatalogTests` gains:
  - Decode a paged `DirContents` (with `next_cursor`).
  - Decode an unpaged `DirContents` (without `next_cursor`).
  - Round-trip encoding of cursor strings (opaque, base64).
- `AuthenticatedHTTPClientTests` gains:
  - `inject(_:)` returns a request with the right `Authorization` header.
  - `refreshIfNeededAndRetry` calls the block once on success.
  - `refreshIfNeededAndRetry` triggers refresh and calls the block again on
    401.

### API (Bun, `bun test`)
- `fs-dir-paging.test.ts`:
  - Directory with 200 children, no cursor → single response, no
    `next_cursor`.
  - Directory with 1200 children, no cursor → first page of 500 +
    `next_cursor`. Follow cursor twice → second page of 500, third page of
    200, no further `next_cursor`.
  - Invalid cursor → 400.
  - `limit > 2000` clamped to 2000.

### Integration (manual, pre-merge)
1. Build the host app + iOS extension for an iPhone or iPad simulator.
2. Sign in to a Self-Hosted server with at least three library roots
   registered, one of which has 1000+ files in a single folder.
3. In the Maple app's Settings → Finder tab (or its iOS equivalent), enable
   the File Provider domain.
4. Open the Files app → Locations → Maple.
5. Confirm library roots show. Tap into one. Confirm folders show.
6. Tap a folder with > 500 files. Confirm the listing fills in (not all at
   once — observable as partial loading).
7. Tap a photo → confirm Quick Look opens via OS default (Quick Look
   generator is Phase 5a; for Phase 4, this triggers a full download and
   the OS renders the RAW with system tools).
8. Watch Activity Monitor (or Console) — memory of `MapleFileProviderIOS`
   process stays under 30 MB.
9. Disable in Settings, confirm domain disappears from Files app.

### Skipped
- Automated UI test on iOS. The Files app is an opaque system app; UITest
  can't drive it. Manual integration is the gate.
- Load test for paged enumeration. Server `readdir` already streams; the
  paging code is < 30 lines of slicing + cursor encoding.

## Performance invariants

- **Memory:** Extension process stays under 30 MB steady-state, under 60 MB
  peak. Verified manually per the integration test above; if a future test
  trips it, the fix is to look at what allocated, not to relax the budget.
- **First-paint:** Root enumeration completes in < 1 s on a decent network.
- **Streaming:** No asset fetch buffers > 2 MB of body in RAM regardless of
  asset size.
- **Slider tick:** Unchanged (16 ms). iOS Phase 4 doesn't run inside the
  render loop.

## What ships at the end of Phase 4

A user can:
1. Install Maple on iPhone or iPad.
2. Sign in to a Self-Hosted server.
3. Enable the Maple File Provider domain from in-app Settings.
4. Open the iOS Files app and see "Maple" under Locations.
5. Browse the full library tree, the same way they would on macOS Finder.
6. Tap a photo to materialize it locally for sharing, editing in a third
   party app, or attaching to an email.
7. Drag a photo from Maple into Mail, Messages, or another doc-picker-aware
   app.

The iOS extension does not write. It does not push, it does not prefetch.
Phase 4 is "the macOS extension, on iOS, without the memory and scaling
caveats biting." Writes, push, and Quick Look ride along in later phases.
