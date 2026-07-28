// RemoteCatalogDownloadAssetTests.swift
//
// Both tests are fully in-process: `StubURLProtocol` answers every request
// synchronously from a closure, and `RemoteCatalog.downloadAsset` runs on the
// injected `TestURLSession.make()` session. The suite costs milliseconds.
//
// #2387: it intermittently cost 444 s instead — always passing, emitting
// nothing for seven minutes, which is indistinguishable from a hang while you
// watch it (and was misread as one, on an otherwise-green PR). Two guards keep
// that from recurring silently:
//
//   • Each test runs under an explicit deadline. A stall an order of magnitude
//     past the suite's real cost is a bug, so it fails, loudly and by ticket
//     number, instead of passing slowly.
//   • Each test asserts the stub saw exactly the requests it expects. A
//     request that escapes to the network can no longer be masked by a
//     later-arriving correct answer — the count is wrong and the test fails.
//
// The stall's one machine-global dependency is fixed at the source, in
// `AuthenticatedHTTPClient.acquireRefreshLock`: a test process now takes its
// refresh lock in its own temporary directory rather than resolving the shared
// App Group container (an untimed `containermanagerd` XPC round-trip) and
// flock'ing a file every other Maple process on the machine also contends for.

import XCTest
@testable import MapleCore

final class RemoteCatalogDownloadAssetTests: XCTestCase {
  override func setUp() {
    super.setUp()
    StubURLProtocol.register()
    StubURLProtocol.reset()
  }

  override func tearDown() {
    StubURLProtocol.reset()
    super.tearDown()
  }

  // 24-hex-char Mongo ObjectIDs to satisfy RemoteCatalog.validateAssetID
  // (added in Phase 5; the original Phase 4 tests pre-dated it).
  private let validAssetID1 = "0123456789abcdef01234567"
  private let validAssetID2 = "fedcba9876543210fedcba98"

  func testDownloadAssetStreamsBytesToFile() async throws {
    let payload = Data(repeating: 0xAB, count: 1024 * 1024) // 1 MB
    let expectedPath = "/api/assets/\(validAssetID1)/raw"
    var servedPaths: [String] = []
    StubURLProtocol.handler = { req in
      servedPaths.append(req.url!.path)
      XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer A1")
      return (200, payload, [:])
    }
    let session = TestURLSession.make()
    let http = AuthenticatedHTTPClient(
      server: URL(string: "https://x.test")!,
      urlSession: session,
      tokensProvider: { AuthTokens(access: "A1", refresh: "R1") },
      onTokensRefreshed: { _ in },
      onSignOut: {}
    )
    let catalog = RemoteCatalog(http: http,
                                server: URL(string: "https://x.test")!,
                                downloadURLSession: session)
    let tmp = URL(fileURLWithPath: NSTemporaryDirectory())
      .appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: tmp) }
    let assetID = validAssetID1
    try await withStubDeadline {
      try await catalog.downloadAsset(assetID: assetID, to: tmp)
    }
    let written = try Data(contentsOf: tmp)
    XCTAssertEqual(written, payload)
    // One request, served by the stub — nothing reached the network.
    XCTAssertEqual(servedPaths, [expectedPath])
  }

  func testDownloadAssetRefreshesOn401AndRetries() async throws {
    let payload = Data("retry-ok".utf8)
    var calls: [(path: String, auth: String?)] = []
    StubURLProtocol.handler = { req in
      calls.append((req.url!.path, req.value(forHTTPHeaderField: "Authorization")))
      if req.url!.path == "/api/auth/refresh" {
        return (200, Data(#"{"access_token":"A2","refresh_token":"R2"}"#.utf8), [:])
      }
      let auth = req.value(forHTTPHeaderField: "Authorization")
      if auth == "Bearer A1" { return (401, Data("nope".utf8), [:]) }
      if auth == "Bearer A2" { return (200, payload, [:]) }
      return (500, Data("?".utf8), [:])
    }
    var current = AuthTokens(access: "A1", refresh: "R1")
    let session = TestURLSession.make()
    let http = AuthenticatedHTTPClient(
      server: URL(string: "https://x.test")!,
      urlSession: session,
      tokensProvider: { current },
      onTokensRefreshed: { current = $0 },
      onSignOut: {}
    )
    let catalog = RemoteCatalog(http: http,
                                server: URL(string: "https://x.test")!,
                                downloadURLSession: session)
    let tmp = URL(fileURLWithPath: NSTemporaryDirectory())
      .appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: tmp) }
    let assetID = validAssetID2
    try await withStubDeadline {
      try await catalog.downloadAsset(assetID: assetID, to: tmp)
    }
    XCTAssertEqual(try Data(contentsOf: tmp), payload)
    XCTAssertEqual(current.access, "A2")
    // Three calls total: 401, refresh, retry-200 — and the stub served every
    // one of them, in that order.
    XCTAssertEqual(calls.map(\.path), [
      "/api/assets/\(validAssetID2)/raw",
      "/api/auth/refresh",
      "/api/assets/\(validAssetID2)/raw",
    ])
    XCTAssertEqual(calls.map(\.auth), ["Bearer A1", nil, "Bearer A2"])
  }

  // MARK: - The guard itself

  func testStubDeadlineFailsFastInsteadOfWaitingOutASlowBody() async {
    // A guard against silent slowness is worthless if it can itself fail
    // silently, so pin it: a body that outlives its budget must surface
    // `StubDeadlineExceeded` promptly, not run to completion and pass.
    let start = Date()
    do {
      try await withStubDeadline(seconds: 0.05) {
        try await Task.sleep(nanoseconds: 5_000_000_000)
      }
      XCTFail("expected the deadline to fire")
    } catch is StubDeadlineExceeded {
      XCTAssertLessThan(
        Date().timeIntervalSince(start), 2,
        "the deadline must fire promptly, not after the body finishes")
    } catch {
      XCTFail("expected StubDeadlineExceeded, got \(error)")
    }
  }
}

// MARK: - Deadline guard (#2387)

private struct StubDeadlineExceeded: Error, CustomStringConvertible {
  let seconds: Double
  var description: String {
    """
    exceeded the \(seconds)s deadline for a fully-stubbed request (#2387). \
    This suite's real cost is milliseconds — three orders of magnitude \
    below this budget — so reaching it means a stall outside the test's own \
    logic: a request that escaped StubURLProtocol, or a blocking call into \
    machine-global state. Do not raise this budget; find the stall.
    """
  }
}

private enum StubDeadlineOutcome: Sendable {
  case finished
  case expired
}

/// Run `body` under a hard deadline. Every request these tests make is
/// answered in-process, so anything approaching this budget is a defect
/// rather than a slow machine — failing is the correct outcome, and the
/// failure names the ticket so the next person doesn't rediscover it.
///
/// The two children report an OUTCOME rather than racing to throw: if `body`
/// fails on its own that error must reach the test verbatim, and a sleeper
/// throwing at the same instant would otherwise mask it (or be masked by the
/// cancellation error `body` raises on its way out).
///
/// Scope: this converts a silent slow pass into a loud, ticket-named failure.
/// It cannot abort a `body` wedged inside a non-cancellable synchronous call —
/// structured concurrency still awaits the child on the way out — so such a
/// run would report the failure late rather than at the deadline. That is
/// still strictly better than passing, and #2387's runs always did complete.
private func withStubDeadline(
  seconds: Double = 10,
  _ body: @escaping @Sendable () async throws -> Void
) async throws {
  try await withThrowingTaskGroup(of: StubDeadlineOutcome.self) { group in
    group.addTask {
      try await body()
      return .finished
    }
    group.addTask {
      try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
      return .expired
    }
    let first = try await group.next()
    group.cancelAll()
    if first == .expired { throw StubDeadlineExceeded(seconds: seconds) }
  }
}
