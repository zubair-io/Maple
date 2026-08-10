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
//
// Also watches `.delete`/`.rename`/`.revoke` on the SAME descriptor — those
// fire when the WATCHED FOLDER ITSELF is removed, renamed, or its access is
// revoked. Without them, that case silently detaches the file descriptor
// and this watcher dies for the rest of the session with nothing telling
// anyone (#2656 review) — the folder simply stops being watched, and the
// only remaining reconciliation path is the next `open()`. `onInvalidated`
// is how a caller finds out instead of trusting a silently-dead watcher.

import Foundation
#if canImport(Darwin)
import Darwin
#endif

/// Not an `actor` — the DispatchSource callback fires on its own queue,
/// outside any actor's isolation. `debounceTask` is mutated both from that
/// queue (`scheduleDebouncedFire`, always queue-confined) and potentially
/// from an arbitrary caller thread (`stop()`), so `stop()` synchronizes onto
/// `dispatchQueue` before touching it — seeing `debounceTask` mutated from
/// two different threads with no ordering between them is a genuine data
/// race behind `@unchecked Sendable`, not something the queue alone
/// prevents unless every access actually routes through it.
public final class FolderChangeWatcher: @unchecked Sendable {
    private let source: DispatchSourceFileSystemObject
    private let fileDescriptor: Int32
    private let dispatchQueue: DispatchQueue
    private let debounceNanoseconds: UInt64
    private var debounceTask: Task<Void, Never>?

    /// Marks `dispatchQueue` so `stop()` can tell whether it's already
    /// running ON that queue (called from inside the event handler, e.g. via
    /// `handleInvalidation`) versus from an arbitrary external caller
    /// (`FilesystemSource.close()`) — `DispatchQueue.sync` onto the queue
    /// you're already executing on deadlocks, so this distinguishes the two
    /// cases rather than synchronizing unconditionally.
    private let queueKey = DispatchSpecificKey<UInt8>()

    /// `nil` when `folderURL` can't be opened for `O_EVTONLY` (e.g. it's
    /// been deleted, or sandbox access hasn't been granted) — callers treat
    /// that the same way as "no watcher available," matching every other
    /// best-effort helper in this module: the rescan-on-open path still
    /// reconciles renames made while Maple was closed even if a live
    /// watcher never started.
    ///
    /// - Parameters:
    ///   - onChange: fires (debounced) when a direct child of the folder is
    ///     created, removed, or renamed.
    ///   - onInvalidated: fires once, undebounced, when the WATCHED FOLDER
    ///     ITSELF is removed, renamed, or its access is revoked. The watcher
    ///     stops itself before calling this — `onInvalidated` is purely a
    ///     notification, not a request.
    public init?(
        folderURL: URL, debounceInterval: TimeInterval = 0.3,
        onChange: @escaping @Sendable () -> Void,
        onInvalidated: (@Sendable () -> Void)? = nil
    ) {
        let fd = open(folderURL.path, O_EVTONLY)
        guard fd >= 0 else { return nil }
        self.fileDescriptor = fd
        self.debounceNanoseconds = UInt64(max(0, debounceInterval) * 1_000_000_000)
        let queue = DispatchQueue(label: "app.justmaple.aperture.folder-change-watcher")
        self.dispatchQueue = queue
        queue.setSpecific(key: queueKey, value: 1)

        let src = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: fd, eventMask: [.write, .delete, .rename, .revoke], queue: queue)
        self.source = src
        src.setEventHandler { [weak self] in
            guard let self else { return }
            let flags = src.data
            if flags.contains(.delete) || flags.contains(.rename) || flags.contains(.revoke) {
                self.handleInvalidation(onInvalidated: onInvalidated)
            } else {
                self.scheduleDebouncedFire(onChange: onChange)
            }
        }
        src.setCancelHandler { [fd] in
            close(fd)
        }
        src.resume()
    }

    /// Coalesces a burst of events into one downstream call, `debounceNanoseconds`
    /// after the LAST event in the burst. Always runs on `dispatchQueue` (the
    /// event handler is confined there), matching every OTHER queue-confined
    /// access to `debounceTask`.
    private func scheduleDebouncedFire(onChange: @escaping @Sendable () -> Void) {
        debounceTask?.cancel()
        let nanoseconds = debounceNanoseconds
        debounceTask = Task {
            try? await Task.sleep(nanoseconds: nanoseconds)
            guard !Task.isCancelled else { return }
            onChange()
        }
    }

    /// The watched folder itself vanished, was renamed, or access was
    /// revoked — there is nothing left to watch. Runs on `dispatchQueue`
    /// (called from the event handler), so it cancels the debounce task
    /// directly rather than through `stop()`'s synchronized path — see
    /// `stop()`'s doc comment for why calling `dispatchQueue.sync` from here
    /// would deadlock.
    private func handleInvalidation(onInvalidated: (@Sendable () -> Void)?) {
        debounceTask?.cancel()
        debounceTask = nil
        source.cancel()
        onInvalidated?()
    }

    /// Stop watching. Idempotent — cancelling an already-cancelled
    /// `DispatchSource` is a documented no-op. Callers
    /// (`FilesystemSource.close()`) call this explicitly so the descriptor
    /// is released promptly rather than waiting on `deinit`; `deinit` below
    /// also calls it as a safety net for any path that drops the last
    /// reference without an explicit `stop()`.
    ///
    /// Synchronizes onto `dispatchQueue` before touching `debounceTask` —
    /// UNLESS already running on it (see `queueKey`), which happens when
    /// `stop()` is reached indirectly from inside the event handler; a
    /// queue is not reentrant for `sync`, so synchronizing again there would
    /// deadlock. External callers (the common case) always take the `sync`
    /// branch.
    public func stop() {
        if DispatchQueue.getSpecific(key: queueKey) != nil {
            debounceTask?.cancel()
            debounceTask = nil
        } else {
            dispatchQueue.sync {
                debounceTask?.cancel()
                debounceTask = nil
            }
        }
        source.cancel()
    }

    deinit {
        source.cancel()
    }
}
