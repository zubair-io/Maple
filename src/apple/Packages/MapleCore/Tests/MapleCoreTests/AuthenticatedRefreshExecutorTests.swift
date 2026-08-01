import XCTest
@testable import MapleCore

/// Covers the `AuthenticatedRefreshExecutor` seam (#2471).
///
/// The seam exists so the iOS app can hold a UIKit background assertion
/// around the refresh critical section — the section that owns a
/// cross-process App Group `flock` across `URLSession.data(for:)`. UIKit
/// itself isn't testable here, but everything that makes the assertion
/// *safe* is: that the executor genuinely wraps the locked section, that a
/// cancelled refresh releases the lock as it unwinds, and that a refusal to
/// run doesn't escalate into a sign-out.
final class AuthenticatedRefreshExecutorTests: XCTestCase {
  override func setUp() {
    super.setUp()
    StubURLProtocol.register()
  }

  override func tearDown() {
    StubURLProtocol.reset()
    super.tearDown()
  }

  // MARK: - Test doubles

  /// Records how often the refresh critical section ran through it, and can
  /// be told to refuse to run the operation at all.
  private final class SpyExecutor: AuthenticatedRefreshExecutor, @unchecked Sendable {
    private let lock = NSLock()
    private var _calls = 0
    private let failure: Error?

    var calls: Int { lock.withLock { _calls } }

    init(failingWith failure: Error? = nil) { self.failure = failure }

    func execute(
      _ operation: @escaping AuthenticatedHTTPClient.RefreshOperation
    ) async throws -> AuthTokens {
      lock.withLock { _calls += 1 }
      if let failure { throw failure }
      return try await operation()
    }
  }

  // MARK: - Tests

  func testRefreshRunsThroughTheInjectedExecutorExactlyOnce() async throws {
    let server = URL(string: "https://executor-routing.test")!
    StubURLProtocol.handler = { req in
      if req.url!.path == "/api/auth/refresh" {
        return (200, Data(#"{"access_token":"A2","refresh_token":"R2"}"#.utf8), [:])
      }
      return req.value(forHTTPHeaderField: "Authorization") == "Bearer A2"
        ? (200, Data("{}".utf8), [:])
        : (401, Data("{}".utf8), [:])
    }
    var current = AuthTokens(access: "A1", refresh: "R1")
    let spy = SpyExecutor()
    let client = AuthenticatedHTTPClient(
      server: server,
      urlSession: TestURLSession.make(),
      tokensProvider: { current },
      onTokensRefreshed: { current = $0 },
      onSignOut: {},
      refreshExecutor: spy
    )

    let (_, resp) = try await client.data(for: URLRequest(url: server.appending(path: "/api/folders")))

    XCTAssertEqual((resp as! HTTPURLResponse).statusCode, 200)
    XCTAssertEqual(current.access, "A2", "the rotation must still land through the seam")
    XCTAssertEqual(spy.calls, 1, "the 401 refresh must be routed through the executor")
  }

  func testAnExecutorThatRefusesToRunNeverReachesTheRefreshEndpoint() async throws {
    // Proves the executor wraps the WHOLE critical section, not just a
    // trailing part of it: refusing to invoke the operation must leave the
    // lock untaken and the network untouched. If the request escaped the
    // seam, `/api/auth/refresh` would still be hit.
    let server = URL(string: "https://executor-wrapping.test")!
    var refreshRequests = 0
    StubURLProtocol.handler = { req in
      if req.url!.path == "/api/auth/refresh" {
        refreshRequests += 1
        return (200, Data(#"{"access_token":"A2","refresh_token":"R2"}"#.utf8), [:])
      }
      return (401, Data("{}".utf8), [:])
    }
    var signedOut = false
    let client = AuthenticatedHTTPClient(
      server: server,
      urlSession: TestURLSession.make(),
      tokensProvider: { AuthTokens(access: "A1", refresh: "R1") },
      onTokensRefreshed: { _ in },
      onSignOut: { signedOut = true },
      // What `BackgroundExecution` throws when iOS declines to grant an
      // assertion: suspension is imminent, so the locked section must not run.
      refreshExecutor: SpyExecutor(failingWith: CancellationError())
    )

    do {
      _ = try await client.data(for: URLRequest(url: server.appending(path: "/api/folders")))
      XCTFail("expected the refused refresh to surface as an error")
    } catch let error as AuthenticatedHTTPClient.AuthenticationError {
      // A refresh we declined to attempt is "try again later", never "the
      // server rejected us" — escalating this to a sign-out would log the
      // user out every time they background the app at the wrong moment.
      XCTAssertEqual(error, .temporarilyUnavailable)
    }

    XCTAssertEqual(refreshRequests, 0, "the operation must never have run")
    XCTAssertFalse(signedOut, "a refused refresh must not sign the user out")
  }

  func testCancelledRefreshReleasesTheCrossProcessLockForTheNextAttempt() async throws {
    // The load-bearing claim of the whole design: when the background
    // assertion expires, cancellation reaches `URLSession.data(for:)` and the
    // operation's `defer` unlocks and closes the descriptor as it unwinds.
    // `URLError.cancelled` is the exact wire outcome of that cancellation.
    //
    // If the lock leaked, the follow-up refresh would spin the acquisition
    // retry loop for its full 10s ceiling and then fail — so this asserts on
    // elapsed time too, to fail loudly rather than merely slowly.
    let server = URL(string: "https://executor-lock-release.test")!
    var refreshAttempts = 0
    StubURLProtocol.responder = { req in
      guard req.url!.path == "/api/auth/refresh" else {
        return .http(status: 401, body: Data("{}".utf8))
      }
      refreshAttempts += 1
      return refreshAttempts == 1
        ? .failure(URLError(.cancelled))
        : .http(status: 200, body: Data(#"{"access_token":"A2","refresh_token":"R2"}"#.utf8))
    }
    var current = AuthTokens(access: "A1", refresh: "R1")
    var signedOut = false
    let client = AuthenticatedHTTPClient(
      server: server,
      urlSession: TestURLSession.make(),
      tokensProvider: { current },
      onTokensRefreshed: { current = $0 },
      onSignOut: { signedOut = true },
      refreshExecutor: SpyExecutor()
    )
    let request = URLRequest(url: server.appending(path: "/api/folders"))

    do {
      _ = try await client.data(for: request)
      XCTFail("expected the cancelled refresh to surface")
    } catch let error as URLError {
      // Cancellation is a transport failure, not a rejection: tokens stay in
      // the Keychain and the next foreground request retries them.
      XCTAssertEqual(error.code, .cancelled)
    }
    XCTAssertFalse(signedOut, "a cancelled refresh must not sign the user out")

    let started = ContinuousClock.now
    _ = try? await client.data(for: request)
    let elapsed = ContinuousClock.now - started

    XCTAssertEqual(refreshAttempts, 2, "the second attempt must reach the endpoint")
    XCTAssertEqual(current.access, "A2", "the retry must complete the rotation")
    XCTAssertLessThan(
      elapsed, .seconds(2),
      "the refresh lock leaked — the retry spun on acquisition instead of taking it immediately"
    )
  }
}
