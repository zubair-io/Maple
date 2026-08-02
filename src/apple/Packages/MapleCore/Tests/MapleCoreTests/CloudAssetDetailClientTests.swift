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

  // MARK: - by-address fetch (#2518)

  func test_detail_byAddress_targetsCorrectPathAndQuery() async throws {
    nonisolated(unsafe) var capturedURL: URL?
    let server = URL(string: "https://x")!
    let session = URLSession.stubbedSequence { req in
      capturedURL = req.url
      let resp = HTTPURLResponse(
        url: req.url!, statusCode: 200, httpVersion: "HTTP/1.1",
        headerFields: ["Content-Type": "application/json"])!
      return (Data(#"{"id":"abc123"}"#.utf8), resp)
    }
    let client = CloudAssetDetailClient(
      server: server,
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))
    _ = try await client.detail(address: "lib:2026/IMG 42.dng")
    XCTAssertEqual(capturedURL?.path, "/api/assets/by-address")
    let comps = URLComponents(url: capturedURL!, resolvingAgainstBaseURL: false)
    XCTAssertEqual(comps?.queryItems?.first(where: { $0.name == "address" })?.value,
                   "lib:2026/IMG 42.dng")
  }

  // MARK: - rich sections projection (place / vision / faces)

  private func decodeDetail(_ json: String) throws -> CloudAssetDetail {
    try JSONDecoder().decode(CloudAssetDetail.self, from: Data(json.utf8))
  }

  func test_sections_place_formatsRollupsAndCity() throws {
    let detail = try decodeDetail(#"""
    {"id":"a","size":2048,
     "place":{"display_name":"Albany, NY, USA",
       "address":{"city":"Albany","state":"New York","country":"United States"},
       "rollups":{"locality":"Albany","region":"New York","country_code":"us"}}}
    """#)
    let s = detail.sections
    XCTAssertEqual(s.city, "Albany")
    XCTAssertEqual(s.fileSize, 2048)
    XCTAssertEqual(s.place?.rollupLine, "Albany, New York")
    XCTAssertEqual(s.place?.displayName, "Albany, NY, USA")
    XCTAssertFalse(s.isEmpty)
  }

  func test_sections_city_fallsBackToTownThenLocality() throws {
    let townOnly = try decodeDetail(#"""
    {"id":"a","place":{"address":{"town":"Cooperstown"},"rollups":{}}}
    """#)
    XCTAssertEqual(townOnly.sections.city, "Cooperstown")
    let localityOnly = try decodeDetail(#"""
    {"id":"a","place":{"address":{},"rollups":{"locality":"Metro"}}}
    """#)
    XCTAssertEqual(localityOnly.sections.city, "Metro")
  }

  func test_sections_vision_chipsScreenshotAndFooter() throws {
    let detail = try decodeDetail(#"""
    {"id":"a",
     "vision":{"subjects":["person","dog"],"scene_type":"outdoor","setting":"beach",
       "activity":"surfing","shot_type":"action","mood":"joyful","composition":"wide shot",
       "time_of_day":"golden hour","lighting":"natural","weather":"clear",
       "colors":["teal","gold"],"notable_objects":["surfboard"],"is_screenshot":false},
     "vision_meta":{"model":"qwen2.5-vl","prompt_version":6}}
    """#)
    let v = try XCTUnwrap(detail.sections.vision)
    XCTAssertFalse(v.isScreenshot)
    XCTAssertEqual(v.subjects, ["person", "dog"])
    XCTAssertEqual(v.primaryChips, ["outdoor", "beach", "surfing", "action"])
    XCTAssertEqual(v.secondaryChips, ["joyful", "wide shot", "golden hour", "natural", "clear"])
    XCTAssertEqual(v.colors, ["teal", "gold"])
    XCTAssertEqual(v.notableObjects, ["surfboard"])
    XCTAssertEqual(v.footer, "qwen2.5-vl · prompt v6")
  }

  func test_sections_vision_dropsIndoorAndUnknownWeather() throws {
    let detail = try decodeDetail(#"""
    {"id":"a","vision":{"weather":"indoor","mood":"calm","is_screenshot":false}}
    """#)
    let v = try XCTUnwrap(detail.sections.vision)
    XCTAssertEqual(v.secondaryChips, ["calm"])  // "indoor" weather dropped
  }

  func test_sections_vision_screenshotOnly_stillShows() throws {
    let detail = try decodeDetail(#"""
    {"id":"a","vision":{"is_screenshot":true}}
    """#)
    let v = try XCTUnwrap(detail.sections.vision)
    XCTAssertTrue(v.isScreenshot)
    XCTAssertFalse(v.isEmpty)
  }

  func test_sections_vision_allEmpty_collapsesToNil() throws {
    let detail = try decodeDetail(#"""
    {"id":"a","vision":{"is_screenshot":false,"subjects":[],"colors":[]}}
    """#)
    XCTAssertNil(detail.sections.vision)
  }

  func test_sections_faces_resolvesNamesTaggedAndUntagged() throws {
    let detail = try decodeDetail(#"""
    {"id":"a","faces":[
      {"person_id":"p1","name":"Alice","confidence":0.9},
      {"person_id":null,"confidence":0.8},
      {"person_id":"p2","confidence":0.7}]}
    """#)
    let f = detail.sections.faces
    XCTAssertEqual(f.count, 3)
    XCTAssertEqual(f.tagged.map(\.personID), ["p1", "p2"])
    // p1 shows its resolved name and is searchable; p2 has no name so its
    // chip falls back to the id and is not searchable.
    XCTAssertEqual(f.tagged[0].label, "Alice")
    XCTAssertEqual(f.tagged[0].searchName, "Alice")
    XCTAssertEqual(f.tagged[1].label, "p2")
    XCTAssertNil(f.tagged[1].searchName)
    XCTAssertEqual(f.untaggedCount, 1)
  }
}
