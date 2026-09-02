// ExpiringActivityRefreshExecutor.swift — the extension counterpart to
// `BackgroundExecution` (src/apple/Maple/BackgroundExecution.swift, #2455 /
// #2471): protects the auth-refresh critical section — the one that owns
// the cross-process App Group `flock` across `URLSession.data(for:)` —
// while running inside a File Provider or Quick Look extension process
// (#2472). Both extensions still defaulted to `DirectAuthenticatedRefreshExecutor`
// after #2455 landed for the app target, leaving them exposed to the same
// RunningBoard `0xdead10cc` termination the app fixed.
//
// Extensions cannot call `UIApplication.beginBackgroundTask` (no
// `UIApplication` instance in an extension process), but
// `ProcessInfo.performExpiringActivity` provides the equivalent assertion
// on the platforms that need it — plain Foundation, no UIKit import
// required, which is why this lives in the dependency-free MapleCloudKit
// target. It is `@available(macOS, unavailable)`, which is not a gap here:
// macOS does not suspend a running process the way iOS does (the same
// reasoning `AppShell.persistPreviewOnBackground` already relies on), so
// `MapleFileProvider` and `MapleQuickLook` (both macOS-only or
// macOS-compiled) fall straight through to running the operation directly,
// same as `DirectAuthenticatedRefreshExecutor` — there is no cross-process
// suspension window on that platform for this assertion to close.
//
// `performExpiringActivity` is a BLOCKING, callback-based API — the call
// does not return until its block returns, and Apple's own usage pattern is
// to do the protected work synchronously inside that call. Bridging that
// into this `async` method naively (blocking a `DispatchSemaphore` inside
// the block while `operation()` runs as a `Task`) would, if done on a
// thread Swift's cooperative concurrency pool needs, stall that pool and
// starve the very operation it is waiting on — see
// `AppShell.persistPreviewOnBackground`'s doc comment for the identical
// hazard in the app target. The fix is the same shape here: hop onto a
// dedicated GCD thread that is NOT part of the cooperative pool before
// calling `performExpiringActivity`, so the semaphore wait blocks only that
// throwaway thread while `operation()`'s async work proceeds independently
// on the pool.
import Foundation

public struct ExpiringActivityRefreshExecutor: AuthenticatedRefreshExecutor {
  public init() {}

  public func execute(
    _ operation: @escaping AuthenticatedHTTPClient.RefreshOperation
  ) async throws -> AuthTokens {
    #if os(macOS)
    // No suspension risk to protect against on this platform — see the
    // file's header comment.
    return try await operation()
    #else
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<AuthTokens, Error>) in
      let box = ExpiringActivityResultBox(continuation: continuation)
      // `.utility`, not `.default`/`.userInteractive`: this thread exists
      // only to host the blocking `performExpiringActivity` call, so it
      // should never compete with real work for a higher-priority worker.
      DispatchQueue.global(qos: .utility).async {
        ProcessInfo.processInfo.performExpiringActivity(
          withReason: "app.justmaple.aperture.auth-refresh"
        ) { expired in
          guard !expired else {
            // The OS is revoking (or never granted) the assertion. If an
            // operation is already in flight, cancel it so
            // `URLSession.data(for:)` unwinds and the operation's own
            // `defer` releases the flock before this process becomes
            // freely suspendable — same recovery story as
            // `BackgroundExecution`. If nothing has started yet (this
            // invocation IS the first one and it arrived already
            // expired), there is no lock to release — refuse to proceed
            // rather than starting the locked section unprotected.
            box.handleExpired()
            return
          }
          // Adopting the task only from inside this (non-expired)
          // invocation is what makes the assertion meaningful: the
          // operation — and the flock it takes — must not start until the
          // activity is actually granted. The semaphore blocks THIS
          // dedicated thread only; `operation()` itself runs on the
          // cooperative pool via its own `Task`.
          let semaphore = DispatchSemaphore(value: 0)
          let task = Task {
            do {
              let tokens = try await operation()
              box.resolve(.success(tokens))
            } catch {
              box.resolve(.failure(error))
            }
            semaphore.signal()
          }
          box.adopt(task)
          semaphore.wait()
        }
      }
    }
    #endif
  }
}

/// Thread-safe bridge between `performExpiringActivity`'s callback — which
/// may run more than once, from different threads, per the activity's
/// lifecycle — and the single `CheckedContinuation` this executor must
/// resume exactly once.
///
/// Internal rather than `private` (deliberately, unusually for this file's
/// neighbours) so its adopt/resolve/handleExpired state machine — the part
/// with real double-resolve/hang risk — is unit-testable directly, since
/// `performExpiringActivity` itself is `@available(macOS, unavailable)` and
/// so cannot be exercised at all by `swift test`, which always builds for
/// the macOS host. See `ExpiringActivityRefreshExecutorTests`.
final class ExpiringActivityResultBox: @unchecked Sendable {
  private let lock = NSLock()
  private var continuation: CheckedContinuation<AuthTokens, Error>?
  private var task: Task<Void, Never>?

  init(continuation: CheckedContinuation<AuthTokens, Error>) {
    self.continuation = continuation
  }

  func adopt(_ task: Task<Void, Never>) {
    lock.lock()
    self.task = task
    lock.unlock()
  }

  func resolve(_ result: Result<AuthTokens, Error>) {
    lock.lock()
    let pending = continuation
    continuation = nil
    lock.unlock()
    pending?.resume(with: result)
  }

  /// Cancels the in-flight operation if one has started; otherwise resolves
  /// immediately as declined, so a same-invocation expiry can never leave
  /// the continuation unresumed (a hang) or fall through to running the
  /// locked section unprotected.
  func handleExpired() {
    lock.lock()
    let inFlight = task
    lock.unlock()
    if let inFlight {
      inFlight.cancel()
    } else {
      resolve(.failure(CancellationError()))
    }
  }
}
