// LocalFileOperations+CacheAndIndex.swift — steps 5 & 7 of the relocate
// contract (issue #2631): best-effort identity repointing. Both halves are
// deliberately best-effort and run only on a real `.move` (never `.copy`,
// which leaves the original — and its caches/index entry — untouched and
// still correct).

import Foundation

extension LocalFileOperations {

    // MARK: - Cache invalidation (step 7)

    /// Delete the OLD location's derived thumb + preview cache entries.
    /// Both caches key off the filename (docs/caching.md § 2-3), so there
    /// is nothing to relocate — the NEW path simply has no entry yet and
    /// regenerates on next access through the existing thumbnail/preview
    /// pipeline. This just clears the now-orphaned OLD entry rather than
    /// leaving it for LRU eviction, mirroring the API's `dropOldCache`
    /// (`src/api/src/workers/migration/restructure-fs.ts`) — the closest
    /// local equivalent of "bump the stage version."
    ///
    /// `async` since #2659: the two `removeItem`s above only clear the
    /// on-disk `.maple/{thumbs,previews}/` files at the CROSS-PLATFORM
    /// path-keyed names (`MapleSidecarPaths`). `RenderedPreviewCache`
    /// (docs/caching.md § 3) is a SEPARATE, Apple-local cold-open cache —
    /// its own `{urlHash}_{variantHash}.jpg` naming under the same
    /// `.maple/previews/` folder, plus a 20-entry in-memory front — that a
    /// bare `removeItem` never touches. Without this call the #2659
    /// verification pass found the OLD entry (memory AND disk) survives a
    /// move indefinitely: an actual unbounded leak, not just a bounded
    /// LRU-eviction wait, since nothing ever re-visits an asset's OLD URL to
    /// evict it. `invalidate(assetURL:)` already exists and clears both
    /// tiers by prefix match — this just wires it in. Awaited (not
    /// fire-and-forget) so every caller's completion genuinely means "the
    /// old identity's caches are gone," matching this function's own
    /// best-effort framing: a failure inside `invalidate` is silently
    /// swallowed the same way the two `removeItem`s already are.
    static func invalidateDerivedCaches(forOldPrimaryPath oldPrimaryPath: String) async {
        let oldURL = URL(fileURLWithPath: oldPrimaryPath)
        let fm = FileManager.default
        try? fm.removeItem(at: MapleSidecarPaths.thumbURL(for: oldURL))
        try? fm.removeItem(at: MapleSidecarPaths.previewURL(for: oldURL))
        await RenderedPreviewCache.shared.invalidate(assetURL: oldURL)
    }

    // MARK: - LibraryIndex best-effort refresh (step 5)

    /// `sidecarURL` is computed, never stored (docs/spec/01-data-model.md
    /// invariant #2), so the only stale identity a move leaves behind is
    /// the per-folder `LibraryIndex` cold-open cache keyed by filename —
    /// best-effort, since it exists purely for cold-open perf and the
    /// AUTHORITATIVE culling state lives in the `.xmp` sidecar itself
    /// (already relocated by the time this runs). Stars/flag are carried
    /// over from the old entry when one existed, so a moved photo doesn't
    /// transiently look unflagged to a consumer reading the index cache
    /// before the folder is next fully rebuilt.
    static func refreshLibraryIndexAfterMove(_ plan: RelocatePlan) async {
        let oldURL = URL(fileURLWithPath: plan.sourcePrimaryPath)
        let newURL = URL(fileURLWithPath: plan.finalPrimaryPath)
        let oldFolder = oldURL.deletingLastPathComponent()
        let newFolder = newURL.deletingLastPathComponent()

        let oldStore = LibraryIndexStore(folderURL: oldFolder)
        let priorEntry = (try? await oldStore.load())?.entries[oldURL.lastPathComponent]
        try? await oldStore.removeEntry(named: oldURL.lastPathComponent)

        let newStore = oldFolder.path == newFolder.path
            ? oldStore
            : LibraryIndexStore(folderURL: newFolder)
        let culling = CullingState(
            stars: priorEntry?.stars ?? 0,
            flag: priorEntry.flatMap { CullFlag(rawValue: $0.flag) } ?? .none
        )
        let attrs = try? FileManager.default.attributesOfItem(atPath: newURL.path)
        let mtime = attrs?[.modificationDate] as? Date
        try? await newStore.updateEntry(name: newURL.lastPathComponent, culling: culling, mtime: mtime)
    }
}
