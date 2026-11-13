// src/apple/Packages/MapleCore/Tests/MapleCoreTests/RemoteCatalogETagByteBudgetTests.swift
import XCTest

@testable import MapleFileProviderCore

/// #5456: the File Provider extension gives `RemoteCatalog` a byte budget
/// for its ETag cache, because 256 cached listing pages or thumbnails can
/// exceed iOS's 20 MB extension limit on their own.
final class RemoteCatalogETagByteBudgetTests: XCTestCase {
  private let server = URL(string: "https://example.test")!

  private func makeCatalog(bodyBytes: Int, budget: Int?) -> (RemoteCatalog, RequestLines) {
    let observed = RequestLines()
    let padding = String(repeating: "x", count: max(0, bodyBytes - 80))
    let body =
      #"{"path":"/p","parentPath":null,"folders":[],"images":[],"sidecars":[],"pad":"\#(padding)"}"#
    let session = URLSession.stubbedDirectorySequence { req in
      observed.record(
        req.url!.path + " | " + (req.value(forHTTPHeaderField: "If-None-Match") ?? "nil"))
      let resp = HTTPURLResponse(
        url: req.url!, statusCode: 200, httpVersion: "HTTP/1.1",
        headerFields: ["ETag": "\"\(abs(req.url!.path.hashValue))\""])!
      return (Data(body.utf8), resp)
    }
    let http = AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session)
    return (RemoteCatalog(http: http, server: server, etagCacheByteBudget: budget), observed)
  }

  func testCachedBytesNeverExceedTheBudget() async throws {
    let budget = 41_000
    let (catalog, observed) = makeCatalog(bodyBytes: 10_000, budget: budget)
    for index in 0..<20 {
      _ = try await catalog.listDir(absolutePath: "/dir/\(index)")
      let cached = await catalog._etagCacheBytesForTesting
      XCTAssertLessThanOrEqual(cached, budget)
    }
    let v1 = await catalog._etagCacheCountForTesting
    XCTAssertEqual(v1, 4)

    _ = try await catalog.listDir(absolutePath: "/dir/0")
    _ = try await catalog.listDir(absolutePath: "/dir/19")
    let seen = observed.snapshot()
    XCTAssertTrue(seen[seen.count - 2].hasSuffix(" | nil"), "the oldest page was evicted")
    XCTAssertFalse(seen[seen.count - 1].hasSuffix(" | nil"), "the newest page is still cached")
  }

  func testEntryLargerThanTheBudgetIsNeverCached() async throws {
    let (catalog, _) = makeCatalog(bodyBytes: 8_000, budget: 4_000)
    _ = try await catalog.listDir(absolutePath: "/dir/big")
    let v2 = await catalog._etagCacheCountForTesting
    XCTAssertEqual(v2, 0)
    let v3 = await catalog._etagCacheBytesForTesting
    XCTAssertEqual(v3, 0)
  }

  func testRefetchingAnEntryReplacesItsBytes() async throws {
    let (catalog, _) = makeCatalog(bodyBytes: 1_000, budget: 100_000)
    _ = try await catalog.listDir(absolutePath: "/dir/a")
    let once = await catalog._etagCacheBytesForTesting
    _ = try await catalog.listDir(absolutePath: "/dir/a")
    let v4 = await catalog._etagCacheBytesForTesting
    XCTAssertEqual(v4, once)
    let v5 = await catalog._etagCacheCountForTesting
    XCTAssertEqual(v5, 1)
  }

  func testNoBudgetKeepsTheEntryCountCap() async throws {
    let (catalog, _) = makeCatalog(bodyBytes: 10_000, budget: nil)
    for index in 0..<20 {
      _ = try await catalog.listDir(absolutePath: "/dir/\(index)")
    }
    let v6 = await catalog._etagCacheCountForTesting
    XCTAssertEqual(v6, 20)
  }
}

private final class RequestLines: @unchecked Sendable {
  private let lock = NSLock()
  private var lines: [String] = []

  func record(_ line: String) { lock.withLock { lines.append(line) } }
  func snapshot() -> [String] { lock.withLock { lines } }
}
