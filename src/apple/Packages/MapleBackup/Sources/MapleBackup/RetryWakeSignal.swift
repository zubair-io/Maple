// Sources/MapleBackup/RetryWakeSignal.swift
//
// Single-slot, event-driven wakeup used by BackupEngine.run() to park while
// upload retries are sleeping before they re-enqueue, instead of waking on a
// fixed poll interval (#1026). Its own actor rather than private state on
// BackupEngine so the primitive — and its concurrency invariants — can be
// reasoned about (and tested) in isolation from the rest of the engine.
//
// Spec: .archived-plans/specs/2026-05-09-photokit-backup-design.md §15.

/// An awaitable "work available" signal with exactly one coalesced slot.
///
/// `wait()` parks the caller until `signal()` is called (or the waiting Task
/// is cancelled). `signal()` wakes a parked waiter or, if none is parked yet,
/// remembers the wake so the very next `wait()` call returns immediately
/// instead of missing it.
///
/// One Bool is enough state for the pending case — never a counter or a
/// queue — because the signal carries no payload; it only ever means "go
/// re-check the real source of work." Folding any number of signals that
/// arrive before a `wait()` into that single flag is therefore lossless, and
/// keeps buffering O(1) no matter how many retries fire back-to-back.
actor RetryWakeSignal {
    private var continuation: CheckedContinuation<Void, Never>?
    private var pending = false

    /// Park until `signal()` fires, or return immediately if one already
    /// landed. Race-free by construction: nothing suspends between checking
    /// `pending` and parking the continuation below, so a concurrent (also
    /// actor-isolated) `signal()` call lands strictly before or strictly
    /// after this span — never inside it — and a wake can never be dropped.
    ///
    /// Wrapped in `withTaskCancellationHandler` so a cancelled caller Task
    /// always wakes instead of parking forever — `onCancel` isn't
    /// actor-isolated, so it hops back onto the actor to resume.
    func wait() async {
        if pending {
            pending = false
            return
        }
        await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                self.continuation = continuation
            }
        } onCancel: { [weak self] in
            Task { await self?.signal() }
        }
    }

    /// Wake a parked waiter, or set the pending flag if nobody is parked
    /// yet. Idempotent — calling this again after the continuation already
    /// fired just re-sets the flag instead of resuming twice.
    func signal() {
        if let continuation {
            self.continuation = nil
            continuation.resume()
        } else {
            pending = true
        }
    }
}
