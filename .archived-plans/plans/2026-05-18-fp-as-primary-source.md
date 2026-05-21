# Plan: FP-mounted folder as primary RAW + XMP source for Maple app

**Tracks:** [#93](https://github.com/zubair-io/Maple/issues/93)
**Sizing:** one focused session
**Out of scope:** thumbnails, Mode 2/3/4, iOS app

## Why

Today the Maple app and the FP extension keep separate caches for the same library:
- Maple app caches RAW + XMP it fetched via API
- FP extension caches the same files when accessed through Finder

User edits in Maple don't show in Finder until the FP extension re-fetches. User edits in Finder don't show in Maple until the app re-fetches. Cache size doubles.

Resolution: when File Sync (FP) is enabled for the active server, the Maple app reads from + writes to the FP-mounted path directly. The OS handles materialization through the existing FP extension on cache miss. No HTTP path change — just routing through FileManager instead of URLSession.

## What ships

### 1. `MapleCore` helper

`Sources/MapleCore/FileProvider/FileProviderMount.swift` (new):

```swift
public struct FileProviderMount {
    /// Lookup the FP domain registered for `serverURL`, if any.
    /// Returns nil when the user hasn't enabled File Sync for that server.
    public static func domain(forServer serverURL: URL) async throws -> NSFileProviderDomain?

    /// Resolve the user-visible local URL for an asset, via the FP mount.
    /// Returns nil when no domain is registered for the server, or when
    /// the asset's `absPath` doesn't fall under any of the domain's roots.
    public static func localURL(
        forAsset asset: AssetMetadata,
        root: LibraryRoot,
        domain: NSFileProviderDomain
    ) async throws -> URL?
}
```

Implementation reuses the same path-stripping logic as `FileProviderExtensionCore.resolveAssetParent`.

### 2. Wire the app's data layer

Find every call site in the Maple app that hits `GET /api/assets/:id/raw`, `GET /api/assets/:id/xmp`, or `PUT /api/assets/:id/xmp`. For each:

```swift
if let domain = try? await FileProviderMount.domain(forServer: server),
   let localURL = try? await FileProviderMount.localURL(forAsset: asset, root: root, domain: domain) {
    // FP-primary path
    return try Data(contentsOf: localURL)  // OS materializes via FP fetchContents on first hit
}
// Fallback: existing direct-API path
return try await catalog.downloadAsset(assetID: asset.id, ...)
```

Same shape for writes: write to localURL → FP's `modifyItem` PUTs to server.

### 3. Sandbox / TCC

The Maple app is sandboxed (Release config), so reading from `~/Library/CloudStorage/<DomainDisplay>/` may require TCC permission. Test path:

1. Sandbox-enabled Debug build (after PR #90)
2. Try `Data(contentsOf: fpURL)` directly — does it throw EPERM?
3. If yes, add a one-time `NSOpenPanel` to grant access, persist a security-scoped bookmark, wrap reads in `url.startAccessingSecurityScopedResource()`.

If TCC turns out to be a hard blocker, fall back to keeping the app's existing direct-API path and treat #93 as not-yet-viable. Don't ship a half-working version.

### 4. Fallback semantics

Three failure modes the FP-primary path needs to handle:

- **No domain registered** → use API path (the common case for first-time users).
- **Domain registered but dormant** (FP extension can't reach server, no tokens) → `Data(contentsOf:)` will throw EPERM or block; we should fast-fail to API instead of waiting on the FP extension.
- **Read succeeds but bytes are stale** (extension served from cache; server has newer version) → not currently a concern because we don't have a "force refresh" use case. If we add one, also send a `signalEnumerator(.workingSet)` first.

Detect dormant by attempting to fetch the user-visible URL — `getUserVisibleURL` throws when the domain is in a broken state.

## Test plan

- [ ] Unit test for `localURL(forAsset:root:domain:)` — given a fake domain + roots + asset, returns the expected path string.
- [ ] Manual: open a RAW in Maple while FP is enabled. Verify network log shows no `/api/assets/:id/raw` call after first materialization.
- [ ] Manual: edit XMP in Maple → verify the change appears in Finder's `.xmp` next to the RAW (mtime matches the edit time, contents match).
- [ ] Manual: edit XMP in Finder (via TextEdit or another editor) → reopen the photo in Maple → verify Maple shows the new metadata.
- [ ] Manual: disable FP mid-session → next open of an asset must work via API fallback.
- [ ] Manual: server is unreachable + FP dormant → app shows a sensible error instead of hanging.

## Not in scope

- Thumbnail rendering (no win — `.maple/` not exposed via FP)
- Multi-mode unification (Mode 2/3/4 already use local file paths in their own ways; not touching)
- iOS Maple-app integration with iOS FP mount (separate problem, iOS sandbox model differs)
- Force-refresh / cache-invalidate UI affordance (no immediate use case)

## Risks

- **TCC for `~/Library/CloudStorage/`** could require user-facing permission grant that feels invasive. Mitigation: keep the API fallback as a working path always; the FP-primary route is the optimization, not a hard dependency.
- **Slower first access** when FP extension wakes up — first materialization includes extension launch + sandbox setup + HTTP. Direct API is faster on a cold first hit. Probably a wash for warmed runs.
- **Hidden state inconsistency** — if the FP extension is using the dev fallback path (PR #79's `devFallbackConfig` is removed in #90 but the principle stands), the URL the extension thinks is the server may differ from what the app thinks. Should be impossible after #90 lands and the user does the disable+enable cycle, but worth a check.
