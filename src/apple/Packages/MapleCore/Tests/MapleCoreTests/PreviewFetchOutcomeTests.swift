import XCTest

@testable import MapleCore

final class PreviewFetchOutcomeTests: XCTestCase {
  private let libPath = "/srv/photos/Library"
  private let ref = ImageRef(id: "fs:/srv/photos/Library/Private Trip/a.dng", displayName: "a.dng")

  // MARK: Pure mapping

  func test_classify_200WithBytesIsData() {
    XCTAssertEqual(classify(200, body: "AVIF"), .data(Data("AVIF".utf8)))
  }

  func test_classify_202HonoursRetryAfter() {
    XCTAssertEqual(classify(202, headers: ["Retry-After": "2"]), .indexing(retryAfter: 2))
  }

  func test_classify_202WithoutUsableRetryAfterIsStillIndexing() {
    XCTAssertEqual(classify(202), .indexing(retryAfter: nil))
    XCTAssertEqual(
      classify(202, headers: ["Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT"]),
      .indexing(retryAfter: nil))
    XCTAssertEqual(classify(202, headers: ["Retry-After": "-3"]), .indexing(retryAfter: nil))
  }

  func test_classify_permanentClientErrorsAreNotFound() {
    XCTAssertEqual(classify(404), .notFound(reason: "http 404"))
    XCTAssertEqual(classify(410), .notFound(reason: "http 410"))
    XCTAssertEqual(classify(403), .notFound(reason: "http 403"))
    XCTAssertFalse(classify(404).isRetryable)
  }

  func test_classify_5xxAndAuthAreTransient() {
    XCTAssertEqual(classify(500), .transientFailure(reason: "http 500"))
    XCTAssertEqual(classify(503), .transientFailure(reason: "http 503"))
    XCTAssertEqual(classify(401), .transientFailure(reason: "http 401"))
    XCTAssertEqual(classify(429), .transientFailure(reason: "http 429"))
    XCTAssertTrue(classify(503).isRetryable)
  }

  func test_classify_emptySuccessBodyIsTransient() {
    XCTAssertEqual(classify(200, body: ""), .transientFailure(reason: "http 200 empty body"))
  }

  func test_classify_timeoutIsTransientWithURLErrorCode() {
    XCTAssertEqual(
      PreviewFetchOutcome.classify(error: URLError(.timedOut)),
      .transientFailure(reason: "urlerror -1001"))
  }

  func test_classify_unregisteredPathIsNotFound() {
    XCTAssertEqual(
      PreviewFetchOutcome.classify(error: CloudAddressError.unregisteredPath("/x")),
      .notFound(reason: "unregistered path"))
  }

  func test_reason_neverContainsThePath() {
    let outcome = PreviewFetchOutcome.classify(
      error: CloudAddressError.unregisteredPath("/srv/photos/Private Trip/a.dng"))
    XCTAssertFalse(outcome.reason?.contains("Private") ?? true)
  }

  // MARK: CloudSource over a stubbed transport

  func test_cloudPreviewOutcome_202ReturnsIndexingWithServerRetryAfter() async {
    let outcome = await cloudOutcome(
      status: 202, body: #"{"status":"indexing"}"#, headers: ["Retry-After": "2"])
    XCTAssertEqual(outcome, .indexing(retryAfter: 2))
  }

  func test_cloudPreviewOutcome_404IsNotFound() async {
    let outcome = await cloudOutcome(status: 404, body: "not found")
    XCTAssertEqual(outcome, .notFound(reason: "http 404"))
  }

  func test_cloudPreviewOutcome_503IsTransient() async {
    let outcome = await cloudOutcome(status: 503, body: "busy")
    XCTAssertEqual(outcome, .transientFailure(reason: "http 503"))
  }

  func test_cloudPreviewOutcome_timeoutIsTransient() async {
    let outcome = await cloudOutcome(status: 200, body: "", transportError: URLError(.timedOut))
    XCTAssertEqual(outcome, .transientFailure(reason: "urlerror -1001"))
  }

  func test_cloudPreviewOutcome_200IsData() async {
    let outcome = await cloudOutcome(status: 200, body: "PREVIEW")
    XCTAssertEqual(outcome, .data(Data("PREVIEW".utf8)))
  }

  func test_cloudPreview_keepsNilForIndexingAndThrowsForTransient() async throws {
    let indexing = try await cloudSource(status: 202, body: "{}").preview(for: ref)
    XCTAssertNil(indexing)
    do {
      _ = try await cloudSource(status: 503, body: "busy").preview(for: ref)
      XCTFail("a transient failure must throw from the Data? API")
    } catch {}
  }

  // MARK: Helpers

  private func classify(_ status: Int, body: String = "x", headers: [String: String] = [:])
    -> PreviewFetchOutcome
  {
    let response = HTTPURLResponse(
      url: URL(string: "https://x/api/preview/library/a.dng")!, statusCode: status,
      httpVersion: "HTTP/1.1", headerFields: headers)!
    return PreviewFetchOutcome.classify(data: Data(body.utf8), response: response)
  }

  private func cloudOutcome(
    status: Int, body: String, headers: [String: String] = [:], transportError: Error? = nil
  ) async -> PreviewFetchOutcome {
    await cloudSource(status: status, body: body, headers: headers, transportError: transportError)
      .previewOutcome(for: ref)
  }

  private func cloudSource(
    status: Int, body: String, headers: [String: String] = [:], transportError: Error? = nil
  ) -> CloudSource {
    let server = URL(string: "https://x")!
    let libPath = self.libPath
    let failTransport: (URLRequest) -> Error? = { request in
      request.url?.path == "/api/folders" ? nil : transportError
    }
    let session = URLSession.stubbedSequence(errorProvider: failTransport) { request in
      if request.url?.path == "/api/folders" {
        let json = """
          [{"id":"f1","slug":"library","path":"\(libPath)","label":"Library",
            "last_scan":null,"file_count":3,"created_at":"2026-01-01T00:00:00Z"}]
          """
        let resp = HTTPURLResponse(
          url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1",
          headerFields: ["Content-Type": "application/json"])!
        return (Data(json.utf8), resp)
      }
      let resp = HTTPURLResponse(
        url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
      return (Data(body.utf8), resp)
    }
    return CloudSource(
      server: server, folderID: "f1", libraryPath: libPath,
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))
  }
}
