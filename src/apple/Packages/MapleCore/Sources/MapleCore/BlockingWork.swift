// BlockingWork.swift — bridge for long, uninterruptible synchronous work
// (PR #3455 review, follow-up to #3450).
//
// Swift's cooperative thread pool is sized to the core count, and a task
// that blocks one of its threads makes that thread unavailable to every
// other task in the process. Most work never notices, because `await`
// releases the thread. A single `CIContext.jpegRepresentation` of a 100MP
// frame does not: it is tens of seconds of straight-line C with no
// suspension point, so wrapping it in `Task.detached` releases nothing —
// it parks a cooperative thread for the whole bake. Start and cancel a
// handful of exports and the pool is gone, and unrelated async work in the
// app stalls. That is the same failure #3450 fixed on the main actor, moved
// one layer down.
//
// Dispatch's global queues are the right home for that kind of work: they
// are not the pool Swift concurrency schedules on, and they grow past the
// core count on demand. This bridges one back into async/await.

import Foundation

public enum BlockingWork {
    /// Runs `work` on a Dispatch global queue and suspends the calling task
    /// until it returns. The calling task holds no thread while it waits, so
    /// N concurrent calls cost N Dispatch threads and zero cooperative ones.
    ///
    /// Cancellation is observed only BEFORE `work` starts — its callers wrap
    /// an image encode and a file write, neither of which has an
    /// interruption point once entered. A cancel arriving mid-encode
    /// therefore still pays for the bake; what it buys is that the caller
    /// stops waiting on it and discards the result.
    public static func run<T: Sendable>(
        _ work: @escaping @Sendable () throws -> T
    ) async throws -> T {
        let cancelled = CancellationFlag()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation {
                (continuation: CheckedContinuation<T, Error>) in
                DispatchQueue.global(qos: .userInitiated).async {
                    guard !cancelled.isSet else {
                        continuation.resume(throwing: CancellationError())
                        return
                    }
                    continuation.resume(with: Result { try work() })
                }
            }
        } onCancel: {
            cancelled.set()
        }
    }
}

/// One-way flag, set from the cancellation handler (which runs on an
/// arbitrary thread) and read from the Dispatch queue.
private final class CancellationFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var value = false

    var isSet: Bool {
        lock.lock()
        defer { lock.unlock() }
        return value
    }

    func set() {
        lock.lock()
        value = true
        lock.unlock()
    }
}
