import Foundation
import XCTest

@testable import MapleCore

final class CloudSourceOriginalHTTPTests: XCTestCase {
  private final class Progress: @unchecked Sendable {
    let lock = NSLock()
    var received: Int64 = 0
    var total: Int64?
    var sawPartial = false
    func report(_ bytes: Int64, _ expected: Int64?) {
      lock.withLock {
        received = bytes
        total = expected
        if let expected, bytes > 0 && bytes < expected { sawPartial = true }
      }
    }
    var value: (Int64, Int64?, Bool) { lock.withLock { (received, total, sawPartial) } }
  }

  func testBothReadersUseAuthenticatedUnifiedURLsAndProgressFromRealHTTP() async throws {
    let fixture = try await CloudOriginalHTTPFixture.start()
    defer { fixture.stop() }
    let client = AuthenticatedHTTPClient(
      server: fixture.url,
      urlSession: URLSession(configuration: .ephemeral),
      tokensProvider: { AuthTokens(access: "original-token", refresh: "refresh-token") },
      onTokensRefreshed: { _ in }, onSignOut: {})
    // The timeline creates a server-wide source with no configured root.
    let source = CloudSource(server: fixture.url, folderID: "", libraryPath: "", httpClient: client)
    let ref = ImageRef(id: "fs:/srv/photos/Library/My Album/a #?.dng", displayName: "a #?.dng")
    let ordinary = try await source.rawBytes(for: ref)
    XCTAssertEqual(ordinary, fixture.original)
    let progress = Progress()
    let downloaded = try await source.rawBytesWithProgress(
      for: ref, expectedTotal: 1,
      onProgress: { received, total in progress.report(received, total) })
    XCTAssertEqual(downloaded, fixture.original)
    XCTAssertEqual(progress.value.0, Int64(fixture.original.count))
    XCTAssertEqual(progress.value.1, Int64(fixture.original.count))
    XCTAssertTrue(progress.value.2, "progress must arrive while bytes are still in flight")
    let requests = fixture.requests
    XCTAssertEqual(requests.count, 3, "one shared folder lookup plus two original downloads")
    XCTAssertEqual(requests.filter { $0.hasPrefix("GET /maple/api/image/library/") }.count, 2)
    XCTAssertFalse(requests.contains { $0.contains("/api/fs/raw") })
    XCTAssertTrue(
      requests.allSatisfy { $0.lowercased().contains("authorization: bearer original-token") })
  }

  func testCancellationTerminatesAnInFlightProgressDownload() async throws {
    let fixture = try await CloudOriginalHTTPFixture.start()
    defer { fixture.stop() }
    let client = AuthenticatedHTTPClient(
      server: fixture.url,
      urlSession: URLSession(configuration: .ephemeral),
      tokensProvider: { AuthTokens(access: "original-token", refresh: "refresh-token") },
      onTokensRefreshed: { _ in }, onSignOut: {})
    let source = CloudSource(server: fixture.url, folderID: "", libraryPath: "", httpClient: client)
    let ref = ImageRef(id: "fs:/srv/photos/Library/My Album/a #?.dng", displayName: "a #?.dng")
    let progress = Progress()
    let transfer = Task {
      try await source.rawBytesWithProgress(
        for: ref, expectedTotal: nil,
        onProgress: { progress.report($0, $1) })
    }
    for _ in 0..<100 {
      if progress.value.2 { break }
      try await Task.sleep(for: .milliseconds(10))
    }
    XCTAssertTrue(progress.value.2)
    transfer.cancel()
    do {
      _ = try await transfer.value
      XCTFail("cancelled download must fail")
    } catch { XCTAssertTrue(error is CancellationError) }
  }
}
