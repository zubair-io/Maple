import XCTest
@testable import MapleCloudKit
@testable import MapleCore

/// Covers `ExpiringActivityRefreshExecutor` (#2472) — the File Provider /
/// Quick Look extension counterpart to `BackgroundExecution` (app target,
/// untestable UIKit). `ProcessInfo.performExpiringActivity` is itself
/// `@available(macOS, unavailable)`, and `swift test` always builds for the
/// macOS host — so the actual iOS/tvOS bridge through `performExpiringActivity`
/// is exercised only by the iOS Simulator `xcodebuild` build (type-checked
/// there, matching `BackgroundExecution`'s own UIKit half) and, ultimately, a
/// device run — the same caveat PR #2455 documented for that half.
///
/// What genuinely IS testable here, and is where the real double-resolve /
/// hang risk lives, is `ExpiringActivityResultBox`'s state machine: exactly
/// one of a completed operation or an expiry must resolve the continuation,
/// and an expiry that arrives before any operation started must resolve
/// (declined) rather than leave the continuation hanging forever. The
/// `execute(_:)` integration tests below cover the macOS pass-through branch,
/// which is real code (not a stub) and shares nothing with the iOS path.
final class ExpiringActivityResultBoxTests: XCTestCase {

  func test_resolve_fulfillsTheContinuation() async throws {
    let tokens = try await withCheckedThrowingContinuation { continuation in
      let box = ExpiringActivityResultBox(continuation: continuation)
      box.resolve(.success(AuthTokens(access: "A", refresh: "R")))
    }
    XCTAssertEqual(tokens.access, "A")
  }

  func test_resolve_isIdempotent_secondCallIsANoOp() async throws {
    // If both the operation's completion and a late expiry call `resolve`,
    // only the first may reach the continuation — `CheckedContinuation`
    // traps on a double-resume, which would crash the extension process.
    let tokens = try await withCheckedThrowingContinuation { continuation in
      let box = ExpiringActivityResultBox(continuation: continuation)
      box.resolve(.success(AuthTokens(access: "first", refresh: "R")))
      box.resolve(.success(AuthTokens(access: "second", refresh: "R")))
    }
    XCTAssertEqual(tokens.access, "first")
  }

  func test_handleExpired_beforeAnyTaskAdopted_declinesRatherThanHanging() async {
    // The edge case a naive implementation gets wrong: the very first
    // `performExpiringActivity` invocation can itself arrive already
    // expired (no time granted at all). With no task to cancel, the box
    // must still resolve — otherwise the continuation, and the `await` on
    // the other end of it, hangs forever.
    do {
      _ = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<AuthTokens, Error>) in
        let box = ExpiringActivityResultBox(continuation: continuation)
        box.handleExpired()
      }
      XCTFail("expected the decline to surface as an error")
    } catch is CancellationError {
      // expected
    } catch {
      XCTFail("expected CancellationError, got \(error)")
    }
  }

  func test_handleExpired_withAnAdoptedTask_cancelsItRatherThanResolvingDirectly() async {
    // Once an operation is in flight, expiry must cancel IT (so the
    // flock-holding `URLSession.data(for:)` unwinds and the operation's own
    // `defer` releases the lock) — the box itself must not resolve until
    // that cancelled task's own completion handler calls `resolve`. The
    // continuation resolving with `CancellationError` here is the expected
    // outcome, not a test failure — it's exactly what a real cancelled
    // refresh surfaces as, matching `BackgroundExecution`'s contract.
    let cancelled = XCTestExpectation(description: "adopted task observed cancellation")
    do {
      _ = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<AuthTokens, Error>) in
        let box = ExpiringActivityResultBox(continuation: continuation)
        let task = Task {
          // A task with no suspension point never observes cancellation
          // before it finishes, so give it one to check against.
          try? await Task.sleep(for: .milliseconds(200))
          if Task.isCancelled {
            cancelled.fulfill()
            box.resolve(.failure(CancellationError()))
          } else {
            box.resolve(.success(AuthTokens(access: "ranToCompletion", refresh: "R")))
          }
        }
        box.adopt(task)
        box.handleExpired()
      }
      XCTFail("expected the cancelled operation's own CancellationError to surface")
    } catch is CancellationError {
      // expected — see the comment above.
    } catch {
      XCTFail("expected CancellationError, got \(error)")
    }
    await fulfillment(of: [cancelled], timeout: 2)
  }
}

final class ExpiringActivityRefreshExecutorTests: XCTestCase {

  /// Runs `work` and fails loudly if it doesn't finish within `seconds` —
  /// turns "the executor hung" from an infinite test-run stall into a
  /// normal red test.
  private func withTimeout<T: Sendable>(
    _ seconds: TimeInterval = 5, _ work: @escaping @Sendable () async throws -> T
  ) async throws -> T {
    try await withThrowingTaskGroup(of: T.self) { group in
      group.addTask { try await work() }
      group.addTask {
        try await Task.sleep(for: .seconds(seconds))
        throw TimeoutError()
      }
      let result = try await group.next()!
      group.cancelAll()
      return result
    }
  }

  private struct TimeoutError: Error {}

  func test_execute_runsTheOperationAndReturnsItsResult() async throws {
    let executor = ExpiringActivityRefreshExecutor()
    let tokens = try await withTimeout {
      try await executor.execute {
        AuthTokens(access: "A", refresh: "R")
      }
    }
    XCTAssertEqual(tokens.access, "A")
    XCTAssertEqual(tokens.refresh, "R")
  }

  func test_execute_propagatesAThrowFromTheOperation() async {
    struct OpError: Error, Equatable {}
    let executor = ExpiringActivityRefreshExecutor()
    do {
      _ = try await withTimeout {
        try await executor.execute { throw OpError() }
      }
      XCTFail("expected the operation's throw to propagate")
    } catch is OpError {
      // expected
    } catch {
      XCTFail("expected OpError, got \(error)")
    }
  }

  // MARK: - Wired through AuthenticatedHTTPClient (mirrors
  // AuthenticatedRefreshExecutorTests, but with the extension executor)

  override func setUp() {
    super.setUp()
    StubURLProtocol.register()
  }

  override func tearDown() {
    StubURLProtocol.reset()
    super.tearDown()
  }

  func test_wiredThroughAuthenticatedHTTPClient_rotatesAndRetries() async throws {
    let server = URL(string: "https://expiring-activity-executor.test")!
    StubURLProtocol.handler = { req in
      if req.url!.path == "/api/auth/refresh" {
        return (200, Data(#"{"access_token":"A2","refresh_token":"R2"}"#.utf8), [:])
      }
      return req.value(forHTTPHeaderField: "Authorization") == "Bearer A2"
        ? (200, Data("{}".utf8), [:])
        : (401, Data("{}".utf8), [:])
    }
    var current = AuthTokens(access: "A1", refresh: "R1")
    let client = AuthenticatedHTTPClient(
      server: server,
      urlSession: TestURLSession.make(),
      tokensProvider: { current },
      onTokensRefreshed: { current = $0 },
      onSignOut: {},
      refreshExecutor: ExpiringActivityRefreshExecutor()
    )

    let (_, resp) = try await withTimeout {
      try await client.data(for: URLRequest(url: server.appending(path: "/api/folders")))
    }

    XCTAssertEqual((resp as! HTTPURLResponse).statusCode, 200)
    XCTAssertEqual(current.access, "A2", "the rotation must land through the extension executor")
  }
}
