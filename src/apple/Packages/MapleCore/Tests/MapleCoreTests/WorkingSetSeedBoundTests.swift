// src/apple/Packages/MapleCore/Tests/MapleCoreTests/WorkingSetSeedBoundTests.swift
import XCTest

@testable import MapleFileProviderCore

/// #5456: seeding the working set used to fetch three 20,000-row asset
/// lists at once, which alone exceeds iOS's 20 MB extension limit. Each
/// list is now capped at the platform working-set capacity and fetched one
/// at a time.
final class WorkingSetSeedBoundTests: XCTestCase {
  private actor Tracker {
    private(set) var inFlight = 0
    private(set) var peak = 0
    func start() {
      inFlight += 1
      peak = max(peak, inFlight)
    }
    func end() { inFlight -= 1 }
  }

  private final class Limits: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String] = []
    func record(_ value: String?) { lock.withLock { values.append(value ?? "nil") } }
    var snapshot: [String] { lock.withLock { values } }
  }

  func testSeedQueriesRunOneAtATimeAtTheWorkingSetCapacity() async throws {
    let tracker = Tracker()
    let limits = Limits()
    let session = URLSession.stubbedSequence(
      delay: .milliseconds(20),
      onRequestStart: { await tracker.start() },
      onRequestEnd: { await tracker.end() }
    ) { req in
      limits.record(
        URLComponents(url: req.url!, resolvingAgainstBaseURL: false)?
          .queryItems?.first { $0.name == "limit" }?.value)
      let resp = HTTPURLResponse(
        url: req.url!, statusCode: 200, httpVersion: "HTTP/1.1",
        headerFields: ["Content-Type": "application/json"])!
      return (Data(#"{"assets": []}"#.utf8), resp)
    }
    let server = URL(string: "https://x.test")!
    let http = AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session)
    let cache = WorkingSetListCache(
      catalog: RemoteCatalog(http: http, server: server, downloadURLSession: session))

    _ = try await cache.entries()

    XCTAssertEqual(limits.snapshot, Array(repeating: String(WorkingSet.defaultCapacity), count: 3))
    let peak = await tracker.peak
    XCTAssertEqual(peak, 1, "only one list response may be decoding at a time")
  }
}
