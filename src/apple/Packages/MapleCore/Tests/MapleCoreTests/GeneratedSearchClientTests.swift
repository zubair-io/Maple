// GeneratedSearchClientTests.swift
//
// Decode-only tests for the `/api/generated-searches` wire shapes, matching
// the pattern in CloudSearchTypesTests. The server is the source of truth
// for these payloads (src/api/src/routes/generated-searches.ts); a decode
// regression here would empty the widget silently rather than error visibly.
import XCTest
// The response wrappers are internal to MapleCloudKit on purpose — they are
// wire-shape implementation detail, not client API. @testable reaches them
// without widening the module's public surface.
@testable import MapleCloudKit

final class GeneratedSearchClientTests: XCTestCase {

  func test_decode_collectionCard() throws {
    let json = """
    {"results":[
      {"id":"66c0f1","theme":"summer sprinklers","title":"Running Through Sprinklers",
       "subtitle":"Back-garden afternoons","query":{"month":"8"},
       "result_count":34,"cover_asset_id":"abc123","generated_for":"2026-08-17"}
    ]}
    """
    let decoded = try JSONDecoder().decode(GeneratedSearchListResponse.self, from: Data(json.utf8))

    XCTAssertEqual(decoded.results.count, 1)
    let card = decoded.results[0]
    XCTAssertEqual(card.id, "66c0f1")
    XCTAssertEqual(card.title, "Running Through Sprinklers")
    XCTAssertEqual(card.subtitle, "Back-garden afternoons")
    XCTAssertEqual(card.result_count, 34)
    XCTAssertEqual(card.cover_asset_id, "abc123")
  }

  /// `query` is present on the wire but deliberately un-modelled: a client
  /// must never execute it locally, because the server applies the
  /// hidden-people and screenshot exclusions when it runs the query itself.
  /// Synthesized Codable ignores unknown keys, so its presence must not break
  /// the decode — this pins that.
  func test_decode_ignoresTheServerSideQueryField() throws {
    let json = """
    {"results":[
      {"id":"x","theme":"t","title":"T","subtitle":null,
       "query":{"placeQuery":"children on a beach","month":"8","people":"Zoe"},
       "result_count":9,"cover_asset_id":null,"generated_for":"2026-08-17"}
    ]}
    """
    let decoded = try JSONDecoder().decode(GeneratedSearchListResponse.self, from: Data(json.utf8))
    XCTAssertEqual(decoded.results[0].title, "T")
    XCTAssertNil(decoded.results[0].subtitle)
    XCTAssertNil(decoded.results[0].cover_asset_id)
  }

  func test_decode_emptyDayIsNotAnError() throws {
    // A run can legitimately produce nothing (every proposal missed the
    // result floor). The widget must render its empty state, not fail.
    let decoded = try JSONDecoder().decode(
      GeneratedSearchListResponse.self, from: Data(#"{"results":[]}"#.utf8))
    XCTAssertTrue(decoded.results.isEmpty)
  }

  func test_decode_assetsResponse() throws {
    let json = """
    {"total":34,"results":[
      {"id":"a1","folder_id":"lib-1","abs_path":"/p/a.dng","filename":"a.dng"}
    ]}
    """
    let decoded = try JSONDecoder().decode(
      GeneratedSearchAssetsResponse.self, from: Data(json.utf8))

    XCTAssertEqual(decoded.total, 34)
    XCTAssertEqual(decoded.results.count, 1)
    XCTAssertEqual(decoded.results[0].filename, "a.dng")
  }
}
