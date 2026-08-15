// CloudSearchTypesTests.swift
//
// Decode-only tests for SearchAsset's `has_xmp` + `place` wire fields
// (Task D1, #2102). `place` is a rich `Place | null` object on the wire
// (src/api/src/db/schema.ts `interface Place`) — NOT a string — so these
// guard against a `String?` regression that would throw `typeMismatch` and
// break the whole `SearchAsset` decode for every geocoded asset.
import XCTest
@testable import MapleCore

final class CloudSearchTypesTests: XCTestCase {

  func test_decode_fullPlaceObjectAndHasXmpTrue() throws {
    let json = """
    {"id":"a1","folder_id":"lib-1","abs_path":"/p/a.dng","filename":"a.dng",
     "has_xmp":true,
     "place":{"display_name":"Paris, Île-de-France, France",
               "rollups":{"locality":"Paris","region":"Île-de-France","country_code":"fr"}}}
    """
    let asset = try JSONDecoder().decode(SearchAsset.self, from: Data(json.utf8))

    XCTAssertEqual(asset.has_xmp, true)
    XCTAssertEqual(asset.place?.display_name, "Paris, Île-de-France, France")
    XCTAssertEqual(asset.place?.rollups?.locality, "Paris")
    XCTAssertEqual(asset.place?.rollups?.region, "Île-de-France")
    XCTAssertEqual(asset.place?.rollups?.country_code, "fr")
  }

  func test_decode_nullPlaceAndHasXmpFalse() throws {
    let json = """
    {"id":"a2","folder_id":"lib-1","abs_path":"/p/b.dng","filename":"b.dng",
     "has_xmp":false,"place":null}
    """
    let asset = try JSONDecoder().decode(SearchAsset.self, from: Data(json.utf8))

    XCTAssertEqual(asset.has_xmp, false)
    XCTAssertNil(asset.place)
  }

  func test_decode_absentKeysDecodeToNil() throws {
    let json = """
    {"id":"a3","folder_id":"lib-1","abs_path":"/p/c.dng","filename":"c.dng"}
    """
    let asset = try JSONDecoder().decode(SearchAsset.self, from: Data(json.utf8))

    XCTAssertNil(asset.has_xmp)
    XCTAssertNil(asset.place)
  }

  // MARK: - SearchFacets people/places (#2866)

  /// A server predating the `people` / `places` facet arrays must still
  /// decode — absent keys default to empty, keeping older Self Hosted
  /// deployments working with the new filter UI (it just shows no rows).
  func test_decodeFacets_absentPeoplePlacesDefaultToEmpty() throws {
    let json = """
    {"total":3,"cameras":[],"lenses":[],"extensions":[],
     "scene_types":[],"activities":[],"subjects":[],
     "is_screenshot":{"true":0,"false":3,"unknown":0}}
    """
    let facets = try JSONDecoder().decode(SearchFacets.self, from: Data(json.utf8))
    XCTAssertEqual(facets.total, 3)
    XCTAssertEqual(facets.people, [])
    XCTAssertEqual(facets.places, [])
    XCTAssertNil(facets.iso_range)
    XCTAssertNil(facets.capture_range)
  }

  func test_decodeFacets_peoplePlacesRoundTripValues() throws {
    let json = """
    {"total":9,"cameras":[],"lenses":[],"extensions":[],
     "scene_types":[],"activities":[],"subjects":[],
     "is_screenshot":{"true":0,"false":9,"unknown":0},
     "people":[{"value":"Priya Patel","count":812},{"value":"Sam Ochoa","count":40}],
     "places":[{"value":"Portland, OR","count":946}]}
    """
    let facets = try JSONDecoder().decode(SearchFacets.self, from: Data(json.utf8))
    XCTAssertEqual(facets.people.map(\.value), ["Priya Patel", "Sam Ochoa"])
    XCTAssertEqual(facets.people.map(\.count), [812, 40])
    XCTAssertEqual(facets.places.first?.value, "Portland, OR")
    XCTAssertEqual(facets.places.first?.count, 946)
  }

  /// Unmodeled `Place` fields (address/pois/lat/lon/etc.) must not break
  /// decoding — `SearchAssetPlace` only models what the timeline
  /// caption/day-header needs, and synthesized Codable ignores extras.
  func test_decode_placeWithUnmodeledFieldsIgnoresExtras() throws {
    let json = """
    {"id":"a4","folder_id":"lib-1","abs_path":"/p/d.dng","filename":"d.dng",
     "place":{"display_name":"Kyoto, Japan","address":{"road":"Some Rd"},
              "lat":35.0,"lon":135.7,"pois":["Fushimi Inari"],
              "rollups":{"locality":"Kyoto","region":null,"country_code":"jp"}}}
    """
    let asset = try JSONDecoder().decode(SearchAsset.self, from: Data(json.utf8))

    XCTAssertEqual(asset.place?.display_name, "Kyoto, Japan")
    XCTAssertEqual(asset.place?.rollups?.locality, "Kyoto")
    XCTAssertNil(asset.place?.rollups?.region)
    XCTAssertEqual(asset.place?.rollups?.country_code, "jp")
  }
}
