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
///
/// **Single-waiter only.** There is exactly one `continuation` slot: a
/// second `wait()` call while a first is still parked silently overwrites
/// it, permanently stranding the first caller (`CheckedContinuation` reports
/// the leak, and that Task never resumes). Nothing in this type enforces
/// that — callers are responsible for never calling `wait()` concurrently
/// with itself. `BackupEngine.run()` upholds this via its own `isRunning`
/// reentrancy guard rather than this type growing a waiter list or a
/// crashing precondition — a background backup path silently going idle
/// forever is bad, but a `precondition` trap taking the app down over it
/// would be worse, and a multi-waiter primitive is unneeded generality this
/// engine has exactly one caller for.
actor RetryWakeSignal {
    private var continuation: CheckedContinuation<Void, Never>?
    private var pending = false

    /// Park until `signal()` fires, or return immediately if one already
    /// landed.
    ///
    /// The `pending` flag is checked TWICE, and the second check is the
    /// load-bearing one. `await withTaskCancellationHandler` is a suspension
    /// point, so actor isolation can be released between the first check and
    /// the moment the continuation is stored. A `signal()` landing in that
    /// window finds `continuation == nil`, sets `pending = true`, and would
    /// then be dropped by a waiter that parked without looking again. The
    /// re-check inside the continuation body runs back under isolation and
    /// converts that into an immediate resume.
    ///
    /// That window is not theoretical here: `BackupEngine.finishRetry` signals
    /// on every retry exit, and if the lost wake were the LAST retry's, `run()`
    /// would park forever with `pending == true` — the exact stall this
    /// primitive exists to prevent.
    ///
    /// Wrapped in `withTaskCancellationHandler` so a cancelled caller Task
    /// always wakes instead of parking forever — `onCancel` isn't
    /// actor-isolated, so it hops back onto the actor to resume via
    /// `cancelWait()`, not `signal()` (see that method for why).
    func wait() async {
        if pending {
            pending = false
            return
        }
        await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                // Back under actor isolation. A signal may have landed while
                // the enclosing `await` was suspended.
                if pending {
                    pending = false
                    continuation.resume()
                    return
                }
                self.continuation = continuation
            }
        } onCancel: { [weak self] in
            // Detached so the wake isn't born already-cancelled — an inherited
            // cancelled context could drop the hop and leave the waiter parked.
            Task.detached { await self?.cancelWait() }
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

    /// Resume a parked waiter on cancellation, without setting `pending`.
    /// Deliberately distinct from `signal()`: if a real `signal()` already
    /// won the race and resumed the continuation before cancellation landed,
    /// `continuation` is already `nil` here, so this is a no-op — it must
    /// NOT fall through to setting `pending = true`, or a cancellation that
    /// arrives just after a genuine wake would cause the *next* `wait()` to
    /// return spuriously instead of only this one.
    private func cancelWait() {
        if let continuation {
            self.continuation = nil
            continuation.resume()
        }
    }
}
