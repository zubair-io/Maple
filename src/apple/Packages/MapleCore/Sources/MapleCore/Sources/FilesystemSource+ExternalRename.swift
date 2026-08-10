// FilesystemSource+ExternalRename.swift — the #2656 live-watcher wiring,
// split out of `FilesystemSource.swift` to stay clear of the 570-line
// headroom warning (`tools/check-budget-headroom.sh`). `_index()` itself
// (the reconciliation call site) stays in the main file next to
// `open()`/`restore()`/`close()`, since it needs `folderURL`/`_assets`,
// which stay `private` there; everything here only needs `changeWatcher`
// and `externalRenameFingerprintProvider`, both already accessible from
// this file (see their doc comments in `FilesystemSource.swift`).

import Foundation

extension FilesystemSource {

    /// Test seam (#2656): sets `externalRenameFingerprintProvider` from
    /// outside the actor. A plain property assignment works too (actor
    /// state is externally settable via `await`), but a dedicated method
    /// reads more clearly at call sites than `await source.foo = bar`.
    func setExternalRenameFingerprintProvider(_ provider: @escaping @Sendable (URL) -> ExternalRenameFingerprint?) {
        externalRenameFingerprintProvider = provider
    }

    /// Test seam (#2656 review — B3): sets `indexTestDelayNanoseconds` from
    /// outside the actor — see its doc comment.
    func setIndexTestDelayNanoseconds(_ nanoseconds: UInt64) {
        indexTestDelayNanoseconds = nanoseconds
    }

    /// Start a live watcher on `folder` (#2656) so an external rename made
    /// in Finder while this folder is open gets reconciled without waiting
    /// for the next `open()`. Best-effort: `FolderChangeWatcher.init?`
    /// returning `nil` (folder unreadable for `O_EVTONLY`) just means no
    /// live reconciliation this session — the next-launch rescan path is
    /// unaffected. `[weak self]` — the watcher must never keep this actor
    /// alive past `close()`/`deinit`.
    func startWatchingForExternalChanges(_ folder: URL) {
        changeWatcher?.stop()
        changeWatcher = FolderChangeWatcher(
            folderURL: folder,
            onChange: { [weak self] in
                Task { await self?.reindexAfterExternalChange() }
            },
            onInvalidated: { [weak self] in
                Task { await self?.handleWatcherInvalidated() }
            }
        )
    }

    /// The watcher's debounced callback: re-run `_index()`, which re-scans
    /// the folder and reconciles through `ExternalRenameReconciler` exactly
    /// like a fresh `open()` would. Errors are swallowed — a transient
    /// listing failure (folder briefly unavailable mid-rename) just means
    /// this live refresh is skipped; the next FS event or app relaunch
    /// tries again.
    private func reindexAfterExternalChange() async {
        try? await _index()
    }

    /// The WATCHED FOLDER ITSELF was removed, renamed, or its access was
    /// revoked (#2656 review — I6) — `FolderChangeWatcher` has already
    /// stopped itself before calling this. Drops our (now-dead) reference
    /// and logs so the loss of LIVE reconciliation is visible instead of
    /// silent for the rest of the session; the next-launch rescan path
    /// (`open()`/`restore()`) is entirely unaffected, since it re-lists the
    /// folder fresh and starts a new watcher regardless of this one's fate.
    private func handleWatcherInvalidated() {
        changeWatcher = nil
        filesystemSourceLog.notice(
            "folder change watcher invalidated (folder removed, renamed, or access revoked) — live external-rename reconciliation stopped for this session; the next open() still reconciles")
    }
}
