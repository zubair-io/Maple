// CloudAssetDetailClientTests.swift
//
// Covers the URL composition + JSON decode path for the asset-detail
// client (Info-pane enrichment), plus the pure `sections` display
// projection. The enrichment itself is produced by the server's worker
// stages — this client is "fetch JSON, decode the subset we render,
// surface errors."

import XCTest
@testable import MapleCore

final class CloudAssetDetailClientTests: XCTestCase {

  // MARK: - Decode

  func test_detail_200_decodesEnrichmentSubset() async throws {
    let json = """
    {
      "id": "abc123",
      "description": "a red barn at dusk",
      "ocr_text": "OPEN 24 HOURS",
      "transcript": {
        "text": "hello there",
        "segments": [{"start": 0, "end": 1.2, "text": "hello there"}],
        "language": "en",
        "model": "whisper-base",
        "duration_sec": 3.4,
        "generated_at": "2026-07-24T00:00:00Z"
      }
    }
    """
    let server = URL(string: "https://x")!
    let session = URLSession.stubbed(response: json, contentType: "application/json", status: 200)
    let client = CloudAssetDetailClient(
      server: server,
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))

    let detail = try await client.detail(assetID: "abc123")
    XCTAssertEqual(detail.description, "a red barn at dusk")
    XCTAssertEqual(detail.ocrText, "OPEN 24 HOURS")
    XCTAssertEqual(detail.transcript?.text, "hello there")
    XCTAssertEqual(detail.transcript?.language, "en")
    XCTAssertEqual(detail.transcript?.model, "whisper-base")
  }

  func test_detail_ignoresUnrelatedDtoKeys() async throws {
    // The wire response is the full AssetDetailDto — the decoder must
    // tolerate the many keys we don't model.
    let json = """
    {
      "id": "abc123",
      "folder_id": "f1",
      "filename": "clip.mov",
      "size": 100,
      "place": {"source": "nominatim"},
      "faces": [],
      "vision": {"caption": "x"},
      "description": "only this and transcript matter",
      "transcript": {"text": "t", "segments": [], "language": "es", "model": "whisper-small"}
    }
    """
    let server = URL(string: "https://x")!
    let session = URLSession.stubbed(response: json, contentType: "application/json", status: 200)
    let client = CloudAssetDetailClient(
      server: server,
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))

    let detail = try await client.detail(assetID: "abc123")
    XCTAssertEqual(detail.description, "only this and transcript matter")
    XCTAssertNil(detail.ocrText)
    XCTAssertEqual(detail.transcript?.language, "es")
  }

  func test_detail_absentEnrichment_isNil() async throws {
    let server = URL(string: "https://x")!
    let session = URLSession.stubbed(
      response: #"{"id":"abc123"}"#, contentType: "application/json", status: 200)
    let client = CloudAssetDetailClient(
      server: server,
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))

    let detail = try await client.detail(assetID: "abc123")
    XCTAssertNil(detail.description)
    XCTAssertNil(detail.ocrText)
    XCTAssertNil(detail.transcript)
    XCTAssertTrue(detail.sections.isEmpty)
  }

  func test_detail_404_throws() async {
    let server = URL(string: "https://x")!
    let session = URLSession.stubbed(
      response: "not found", contentType: "application/json", status: 404)
    let client = CloudAssetDetailClient(
      server: server,
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))
    do {
      _ = try await client.detail(assetID: "missing")
      XCTFail("expected throw on 404")
    } catch {
      let nsErr = error as NSError
      XCTAssertEqual(nsErr.domain, "CloudAssetDetailClient")
      XCTAssertEqual(nsErr.code, 404)
    }
  }

  func test_detail_targetsCorrectPath() async throws {
    nonisolated(unsafe) var capturedURL: URL?
    let server = URL(string: "https://x")!
    let session = URLSession.stubbedSequence { req in
      capturedURL = req.url
      let resp = HTTPURLResponse(
        url: req.url!, statusCode: 200,
        httpVersion: "HTTP/1.1",
        headerFields: ["Content-Type": "application/json"])!
      return (Data(#"{"id":"abc123"}"#.utf8), resp)
    }
    let client = CloudAssetDetailClient(
      server: server,
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))
    _ = try await client.detail(assetID: "abc123")
    XCTAssertEqual(capturedURL?.path, "/api/assets/abc123")
  }

  // MARK: - sections projection (pure)

  func test_sections_projectsAllThree_withTranscriptFooter() {
    let detail = CloudAssetDetail(
      description: "a caption",
      ocrText: "some words",
      transcript: CloudTranscript(text: "spoken words", language: "en", model: "whisper-base"))
    let s = detail.sections
    XCTAssertEqual(s.description, "a caption")
    XCTAssertEqual(s.ocrText, "some words")
    XCTAssertEqual(s.transcriptText, "spoken words")
    XCTAssertEqual(s.transcriptFooter, "en · whisper-base")
    XCTAssertFalse(s.isEmpty)
  }

  func test_sections_trimsWhitespaceOnlyFieldsToNil() {
    let detail = CloudAssetDetail(
      description: "   ",
      ocrText: "\n\t",
      transcript: CloudTranscript(text: "  ", language: "en", model: "whisper-base"))
    let s = detail.sections
    XCTAssertNil(s.description)
    XCTAssertNil(s.ocrText)
    // Empty transcript text ⇒ no transcript section, even though a
    // language/model exist.
    XCTAssertNil(s.transcriptText)
    XCTAssertTrue(s.isEmpty)
  }

  func test_sections_footerDropsBlankLanguage() {
    let detail = CloudAssetDetail(
      description: nil,
      ocrText: nil,
      transcript: CloudTranscript(text: "words", language: "", model: "whisper-base"))
    let s = detail.sections
    XCTAssertEqual(s.transcriptText, "words")
    XCTAssertEqual(s.transcriptFooter, "whisper-base")
    XCTAssertFalse(s.isEmpty)
  }
}
