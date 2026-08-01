// BackgroundExecution.swift
//
// Keeps a short, cancellation-aware UIKit background assertion around work
// that must not be suspended while it owns a cross-process file lock.

import MapleCore

#if os(iOS)
import UIKit

/// How long the expiration handler waits for a cancelled operation to unwind
/// before releasing the assertion anyway.
///
/// The handler is the OS's last warning: not calling `endBackgroundTask`
/// promptly is itself a termination path, so this wait must be bounded. But
/// releasing while the `flock` is still held puts us straight back at
/// `0xdead10cc`, so it must not be zero either. Cancelling `URLSession` and
/// running the operation's `defer` is sub-millisecond in practice; this is
/// slack for the one genuinely uncancellable step inside the critical
/// section — `containerURL(forSecurityApplicationGroupIdentifier:)`, a
/// synchronous untimed XPC round-trip to `containermanagerd`.
private let backgroundExecutionUnwindGrace: Duration = .seconds(1)

@MainActor
private final class BackgroundExecutionLease {
    private var identifier: UIBackgroundTaskIdentifier = .invalid
    private var operation: Task<AuthTokens, Error>?
    private var expired = false

    /// Acquire the assertion. False means iOS declined to grant background
    /// time at all, which the caller must not treat as "proceed unprotected."
    func begin(name: String) -> Bool {
        identifier = UIApplication.shared.beginBackgroundTask(
            withName: name,
            expirationHandler: { [weak self] in
                Task { @MainActor in self?.expire() }
            }
        )
        return identifier != .invalid
    }

    /// Hand the lease the task to cancel if the assertion expires.
    ///
    /// Adopting *after* `begin` is the whole point: the operation must not be
    /// able to take the cross-process lock until the assertion is actually
    /// held. Starting it first leaves a window where the lock is owned by a
    /// freely-suspendable process, which is the state this type exists to
    /// prevent.
    func adopt(_ task: Task<AuthTokens, Error>) {
        guard !expired else { return task.cancel() }
        operation = task
    }

    /// Idempotent, so whichever of the completion path or the OS expiration
    /// handler fires first releases the assertion exactly once.
    func end() {
        guard identifier != .invalid else { return }
        UIApplication.shared.endBackgroundTask(identifier)
        identifier = .invalid
        operation = nil
    }

    private func expire() {
        expired = true
        // Cancellation is what actually makes this safe: it reaches
        // `URLSession.data(for:)` (and the lock-acquisition retry sleep), and
        // the operation's `defer` unlocks and closes the descriptor as it
        // unwinds. The completion path in `execute` then ends the assertion.
        operation?.cancel()
        // Backstop for an unwind that never arrives. Bounded so a wedged
        // operation costs us a late `endBackgroundTask` rather than never
        // calling it at all.
        Task { @MainActor in
            try? await Task.sleep(for: backgroundExecutionUnwindGrace)
            end()
        }
    }
}
#endif

struct BackgroundExecution: AuthenticatedRefreshExecutor {
    /// Protect an authentication refresh from suspension while its App Group
    /// `flock` is held. If iOS expires the assertion, cancellation reaches
    /// `URLSession.data(for:)`; the refresh operation's `defer` then unlocks
    /// and closes the descriptor before the process becomes suspendable.
    ///
    /// A refresh cancelled mid-flight may have already rotated server-side,
    /// leaving this process holding a revoked refresh token. That is
    /// recoverable — the server re-mints a replayed just-rotated token inside
    /// `REFRESH_GRACE_MS` (60s, #858), which the next foreground request
    /// lands inside. It is also strictly better than what it replaces: a
    /// RunningBoard kill aborts the same request and loses the same response,
    /// and costs the user a crash on top.
    func execute(
        _ operation: @escaping AuthenticatedHTTPClient.RefreshOperation
    ) async throws -> AuthTokens {
        #if os(iOS)
        let lease = await MainActor.run { BackgroundExecutionLease() }
        guard await lease.begin(name: "app.justmaple.aperture.auth-refresh") else {
            // iOS grants no background time, meaning we are already in the
            // background and suspension is imminent. Do NOT fall through to an
            // unprotected run: taking the cross-process lock here is precisely
            // what gets the app terminated. Refusing surfaces as
            // `temporarilyUnavailable` and the next foreground request retries.
            throw CancellationError()
        }

        let operationTask = Task { try await operation() }
        await lease.adopt(operationTask)
        do {
            let tokens = try await operationTask.value
            await lease.end()
            return tokens
        } catch {
            await lease.end()
            throw error
        }
        #else
        return try await operation()
        #endif
    }
}
