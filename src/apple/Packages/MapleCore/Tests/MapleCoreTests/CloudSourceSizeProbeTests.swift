// CloudSourceSizeProbeTests.swift — the panorama download's size probe
// reads headers only, even from a server that ignores `Range` (#5489).

import Foundation
import Testing
import os

@testable import MapleCore

/// Ignores `Range` and streams an 80 MB body a megabyte at a time,
/// counting what it hands to URLSession before it is stopped.
private final class RangeIgnoringServer: URLProtocol, @unchecked Sendable {
  static let bodyBytes = 80 << 20
  static let chunk = Data(repeating: 1, count: 1 << 20)
  static let delivered = OSAllocatedUnfairLock(initialState: 0)
  static let acceptEncoding = OSAllocatedUnfairLock<String?>(initialState: nil)

  private let stopped = OSAllocatedUnfairLock(initialState: false)

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    Self.acceptEncoding.withLock { $0 = request.value(forHTTPHeaderField: "Accept-Encoding") }
    let response = HTTPURLResponse(
      url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1",
      headerFields: ["Content-Length": "\(Self.bodyBytes)"])!
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    Thread.detachNewThread { [self] in
      var sent = 0
      while sent < Self.bodyBytes, !stopped.withLock({ $0 }) {
        client?.urlProtocol(self, didLoad: Self.chunk)
        sent += Self.chunk.count
        Self.delivered.withLock { $0 += Self.chunk.count }
        Thread.sleep(forTimeInterval: 0.01)
      }
      if sent >= Self.bodyBytes { client?.urlProtocolDidFinishLoading(self) }
    }
  }

  override func stopLoading() { stopped.withLock { $0 = true } }
}

@Suite(.serialized) struct CloudSourceSizeProbeTests {
  @Test func aServerThatIgnoresRangeIsNotDownloaded() async throws {
    RangeIgnoringServer.delivered.withLock { $0 = 0 }
    var request = CloudSource.uncompressed(
      URLRequest(url: URL(string: "https://maple.test/api/image/lib/A.dng")!))
    request.setValue("bytes=0-0", forHTTPHeaderField: "Range")

    let response = try await CloudSource.headers(
      for: request, protocolClasses: [RangeIgnoringServer.self])
    try await Task.sleep(for: .milliseconds(200))

    #expect(CloudSource.totalBytes(of: response) == Int64(RangeIgnoringServer.bodyBytes))
    #expect(RangeIgnoringServer.delivered.withLock { $0 } < RangeIgnoringServer.bodyBytes / 2)
    #expect(RangeIgnoringServer.acceptEncoding.withLock { $0 } == "identity")
  }

  @Test func aPartialReplyGivesTheTotalFromContentRange() throws {
    let response = try #require(
      HTTPURLResponse(
        url: URL(string: "https://maple.test/a")!, statusCode: 206, httpVersion: "HTTP/1.1",
        headerFields: ["Content-Range": "bytes 0-0/104857600", "Content-Length": "1"]))
    #expect(CloudSource.totalBytes(of: response) == 104_857_600)
  }

  @Test func aReplyWithNoSizeGivesNil() throws {
    let response = try #require(
      HTTPURLResponse(
        url: URL(string: "https://maple.test/a")!, statusCode: 206, httpVersion: "HTTP/1.1",
        headerFields: [:]))
    #expect(CloudSource.totalBytes(of: response) == nil)
  }
}
