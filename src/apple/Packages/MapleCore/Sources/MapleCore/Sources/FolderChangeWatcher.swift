// FolderChangeWatcher.swift — DispatchSource-based folder-content watcher
// (issue #2656). Fires a debounced callback whenever the watched folder's
// OWN listing changes (a direct child created, removed, or renamed) so
// `FilesystemSource` can re-run its scan-diff and reconcile an external
// rename made in Finder while Maple is open — the same reconciliation the
// next-launch rescan already performs via `ExternalRenameReconciler`, just
// triggered live instead of at next `open()`.
//
// `DispatchSource.makeFileSystemObjectSource` with `.write` on a directory
// file descriptor fires once per batch of direct-child changes (create,
// remove, rename) — it does NOT fire for changes inside subdirectories
// (irrelevant here: `FilesystemSource._index()` is non-recursive) and does
// NOT tell you what changed, only that something did. A rename shows up as
// one or more `.write` events; debouncing collapses a burst (Finder's
// rename can fire more than one FS event for a single user action) into a
// single downstream re-scan.

import Foundation
#if canImport(Darwin)
import Darwin
#endif

/// Not an `actor` — the DispatchSource callback fires on its own queue,
/// outside any actor's isolation, and the only mutable state here
/// (`debounceTask`) is confined to that same queue via `dispatchQueue`'s
/// serial execution, so a lock/actor would be redundant. `@unchecked
/// Sendable` reflects that the type's own invariants (not the compiler)
/// guarantee safety — every mutation of `debounceTask` happens on
/// `dispatchQueue`.
public final class FolderChangeWatcher: @unchecked Sendable {
    private let source: DispatchSourceFileSystemObject
    private let fileDescriptor: Int32
    private let dispatchQueue: DispatchQueue
    private let debounceNanoseconds: UInt64
    private var debounceTask: Task<Void, Never>?

    /// `nil` when `folderURL` can't be opened for `O_EVTONLY` (e.g. it's
    /// been deleted, or sandbox access hasn't been granted) — callers treat
    /// that the same way as "no watcher available," matching every other
    /// best-effort helper in this module: the rescan-on-open path still
    /// reconciles renames made while Maple was closed even if a live
    /// watcher never started.
    public init?(folderURL: URL, debounceInterval: TimeInterval = 0.3, onChange: @escaping @Sendable () -> Void) {
        let fd = open(folderURL.path, O_EVTONLY)
        guard fd >= 0 else { return nil }
        self.fileDescriptor = fd
        self.debounceNanoseconds = UInt64(max(0, debounceInterval) * 1_000_000_000)
        self.dispatchQueue = DispatchQueue(label: "app.justmaple.aperture.folder-change-watcher")

        let queue = dispatchQueue
        let src = DispatchSource.makeFileSystemObjectSource(fileDescriptor: fd, eventMask: [.write], queue: queue)
        self.source = src
        src.setEventHandler { [weak self] in
            self?.scheduleDebouncedFire(onChange: onChange)
        }
        src.setCancelHandler { [fd] in
            close(fd)
        }
        src.resume()
    }

    /// Coalesces a burst of events into one downstream call, `debounceNanoseconds`
    /// after the LAST event in the burst. Runs on `dispatchQueue`, matching
    /// every access to `debounceTask`.
    private func scheduleDebouncedFire(onChange: @escaping @Sendable () -> Void) {
        debounceTask?.cancel()
        let nanoseconds = debounceNanoseconds
        debounceTask = Task {
            try? await Task.sleep(nanoseconds: nanoseconds)
            guard !Task.isCancelled else { return }
            onChange()
        }
    }

    /// Stop watching. Idempotent — cancelling an already-cancelled
    /// `DispatchSource` is a documented no-op. Callers
    /// (`FilesystemSource.close()`) call this explicitly so the descriptor
    /// is released promptly rather than waiting on `deinit`; `deinit` below
    /// also calls it as a safety net for any path that drops the last
    /// reference without an explicit `stop()`.
    public func stop() {
        debounceTask?.cancel()
        source.cancel()
    }

    deinit {
        source.cancel()
    }
}
