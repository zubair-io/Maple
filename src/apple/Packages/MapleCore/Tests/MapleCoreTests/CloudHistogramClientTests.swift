// CloudHistogramClientTests.swift
//
// Covers the URL composition + JSON decode path for the histogram
// client (closes #633). The actual histogram math + caching lives on
// the server — this client is "fetch JSON, decode, surface errors."

import XCTest
@testable import MapleCore

final class CloudHistogramClientTests: XCTestCase {

  func test_histogram_200_decodesBins() async throws {
    // Synthetic histogram: spike at bin 0 on each channel.
    var r = Array(repeating: 0, count: 256)
    var g = r, b = r
    r[0] = 10
    g[0] = 5
    b[0] = 7
    let json = """
    {"r":\(jsonArray(r)),"g":\(jsonArray(g)),"b":\(jsonArray(b))}
    """
    let server = URL(string: "https://x")!
    let session = URLSession.stubbed(response: json, contentType: "application/json", status: 200)
    let client = CloudHistogramClient(
      server: server,
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))

    let result = try await client.histogram(assetID: "deadbeef")
    XCTAssertEqual(result.r.count, 256)
    XCTAssertEqual(result.g.count, 256)
    XCTAssertEqual(result.b.count, 256)
    XCTAssertEqual(result.r[0], 10)
    XCTAssertEqual(result.g[0], 5)
    XCTAssertEqual(result.b[0], 7)
  }

  func test_histogram_503_throws() async {
    let server = URL(string: "https://x")!
    let session = URLSession.stubbed(
      response: "dylib unavailable",
      contentType: "application/json",
      status: 503)
    let client = CloudHistogramClient(
      server: server,
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))
    do {
      _ = try await client.histogram(assetID: "deadbeef")
      XCTFail("expected throw on 503")
    } catch {
      let nsErr = error as NSError
      XCTAssertEqual(nsErr.domain, "CloudHistogramClient")
      XCTAssertEqual(nsErr.code, 503)
    }
  }

  func test_histogram_targetsCorrectPath() async throws {
    // Stub captures the request URL so we can assert the path shape.
    nonisolated(unsafe) var capturedURL: URL?
    let server = URL(string: "https://x")!
    let session = URLSession.stubbedSequence { req in
      capturedURL = req.url
      let r = Array(repeating: 0, count: 256)
      let json = """
      {"r":\(jsonArray(r)),"g":\(jsonArray(r)),"b":\(jsonArray(r))}
      """
      let resp = HTTPURLResponse(
        url: req.url!, statusCode: 200,
        httpVersion: "HTTP/1.1",
        headerFields: ["Content-Type": "application/json"])!
      return (Data(json.utf8), resp)
    }
    let client = CloudHistogramClient(
      server: server,
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))
    _ = try await client.histogram(assetID: "abc123")
    XCTAssertEqual(capturedURL?.path, "/api/assets/abc123/histogram")
  }
}

/// JSON-safe array literal for the synthetic bin arrays. Avoids
/// inlining 256 zeroes in the source.
private func jsonArray(_ values: [Int]) -> String {
  "[" + values.map(String.init).joined(separator: ",") + "]"
}
