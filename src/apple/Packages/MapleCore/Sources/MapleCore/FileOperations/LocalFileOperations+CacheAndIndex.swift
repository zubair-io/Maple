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
    static func invalidateDerivedCaches(forOldPrimaryPath oldPrimaryPath: String) {
        let oldURL = URL(fileURLWithPath: oldPrimaryPath)
        let fm = FileManager.default
        try? fm.removeItem(at: MapleSidecarPaths.thumbURL(for: oldURL))
        try? fm.removeItem(at: MapleSidecarPaths.previewURL(for: oldURL))
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
