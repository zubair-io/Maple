// BackgroundExecution.swift
//
// Keeps a short, cancellation-aware UIKit background assertion around work
// that must not be suspended while it owns a cross-process file lock.

import MapleCore

#if os(iOS)
import UIKit

@MainActor
private final class BackgroundExecutionLease {
    private var identifier: UIBackgroundTaskIdentifier = .invalid

    func begin(name: String, expiration: @escaping @Sendable () -> Void) -> Bool {
        identifier = UIApplication.shared.beginBackgroundTask(
            withName: name,
            expirationHandler: expiration
        )
        return identifier != .invalid
    }

    func end() {
        guard identifier != .invalid else { return }
        UIApplication.shared.endBackgroundTask(identifier)
        identifier = .invalid
    }
}
#endif

struct BackgroundExecution: AuthenticatedRefreshExecutor {
    /// Protect an authentication refresh from suspension while its App Group
    /// `flock` is held. If iOS expires the assertion, cancellation reaches
    /// `URLSession.data(for:)`; the refresh operation's `defer` then unlocks
    /// and closes the descriptor before the process becomes suspendable.
    func execute(
        _ operation: @escaping AuthenticatedHTTPClient.RefreshOperation
    ) async throws -> AuthTokens {
        #if os(iOS)
        let operationTask = Task { try await operation() }
        let lease = await MainActor.run { BackgroundExecutionLease() }
        let began = await lease.begin(
            name: "app.justmaple.aperture.auth-refresh",
            expiration: {
                operationTask.cancel()
                Task {
                    _ = try? await operationTask.value
                    await lease.end()
                }
            }
        )
        guard began else {
            operationTask.cancel()
            throw CancellationError()
        }

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
