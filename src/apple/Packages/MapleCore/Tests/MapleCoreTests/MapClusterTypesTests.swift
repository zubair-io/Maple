// MapClusterTypesTests.swift
//
// Decode-only tests for `MapCluster` / `MapClustersResponse` — the
// `GET /api/map/clusters` wire contract (#2830, #2825/#2832). Covers the
// two optional-field shapes the server contract calls out explicitly: a
// multi-count cell (no `thumbKey`) and a cell whose representative asset
// has no place data (no `placeLabel`).

import XCTest
@testable import MapleCloudKit

final class MapClusterTypesTests: XCTestCase {

  func test_decode_singleCountCellWithThumbKeyAndPlaceLabel() throws {
    let json = """
    {"lat":48.8566,"lng":2.3522,"count":1,"representativeAssetId":"a1",
     "placeLabel":"Paris","thumbKey":"/photos/eiffel.dng"}
    """
    let cell = try JSONDecoder().decode(MapCluster.self, from: Data(json.utf8))

    XCTAssertEqual(cell.lat, 48.8566)
    XCTAssertEqual(cell.lng, 2.3522)
    XCTAssertEqual(cell.count, 1)
    XCTAssertEqual(cell.representativeAssetId, "a1")
    XCTAssertEqual(cell.id, "a1")
    XCTAssertEqual(cell.placeLabel, "Paris")
    XCTAssertEqual(cell.thumbKey, "/photos/eiffel.dng")
  }

  /// Multi-count cells carry no `thumbKey` — the server convention this
  /// whole client (`MapAnnotationItem.from`) depends on to decide
  /// thumbnail-pin vs count-bubble rendering.
  func test_decode_multiCountCellHasNoThumbKey() throws {
    let json = """
    {"lat":40.0,"lng":-3.7,"count":42,"representativeAssetId":"a2","placeLabel":"Madrid"}
    """
    let cell = try JSONDecoder().decode(MapCluster.self, from: Data(json.utf8))

    XCTAssertEqual(cell.count, 42)
    XCTAssertNil(cell.thumbKey)
    XCTAssertEqual(cell.placeLabel, "Madrid")
  }

  /// A representative asset with no place data at all (never geocoded, or
  /// geocoding found nothing) decodes to a nil `placeLabel` rather than
  /// failing the whole response.
  func test_decode_cellWithoutPlaceLabel() throws {
    let json = """
    {"lat":0.0,"lng":0.0,"count":1,"representativeAssetId":"a3","thumbKey":"/x.jpg"}
    """
    let cell = try JSONDecoder().decode(MapCluster.self, from: Data(json.utf8))

    XCTAssertNil(cell.placeLabel)
    XCTAssertEqual(cell.thumbKey, "/x.jpg")
  }

  func test_decode_responseWithMultipleCells() throws {
    let json = """
    {"cells":[
      {"lat":1,"lng":2,"count":1,"representativeAssetId":"a","thumbKey":"/a.jpg"},
      {"lat":3,"lng":4,"count":9,"representativeAssetId":"b","placeLabel":"Tokyo"}
    ]}
    """
    let response = try JSONDecoder().decode(MapClustersResponse.self, from: Data(json.utf8))

    XCTAssertEqual(response.cells.count, 2)
    XCTAssertEqual(response.cells[0].representativeAssetId, "a")
    XCTAssertEqual(response.cells[1].placeLabel, "Tokyo")
  }

  func test_decode_emptyCellsArray() throws {
    let json = #"{"cells":[]}"#
    let response = try JSONDecoder().decode(MapClustersResponse.self, from: Data(json.utf8))
    XCTAssertTrue(response.cells.isEmpty)
  }
}
