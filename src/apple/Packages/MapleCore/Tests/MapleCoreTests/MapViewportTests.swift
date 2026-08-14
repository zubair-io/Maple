// MapViewportTests.swift
//
// Pure region → bbox/zoom math for `/api/map/clusters` (#2830). Framework-
// free — no MapKit region is constructed here, only the `MapViewportRegion`
// plain-double mirror a SwiftUI `Map`'s camera-change callback converts
// into.

import XCTest
@testable import MapleCloudKit

final class MapViewportTests: XCTestCase {

  // MARK: - bbox(for:)

  func test_bbox_computesHalfSpanBoundsAroundCenter() {
    let region = MapViewportRegion(centerLatitude: 10, centerLongitude: 20,
                                   latitudeDelta: 2, longitudeDelta: 4)
    let bbox = MapViewport.bbox(for: region)

    XCTAssertEqual(bbox.south, 9)
    XCTAssertEqual(bbox.north, 11)
    XCTAssertEqual(bbox.west, 18)
    XCTAssertEqual(bbox.east, 22)
  }

  func test_bbox_queryValue_isCommaJoinedWestSouthEastNorth() {
    let bbox = MapBBox(west: 1, south: 2, east: 3, north: 4)
    XCTAssertEqual(bbox.queryValue, "1.0,2.0,3.0,4.0")
  }

  /// A region centered near the north pole must not push `north` past 90.
  func test_bbox_clampsNorthAtNinety() {
    let region = MapViewportRegion(centerLatitude: 89, centerLongitude: 0,
                                   latitudeDelta: 4, longitudeDelta: 4)
    let bbox = MapViewport.bbox(for: region)

    XCTAssertEqual(bbox.north, 90)
    XCTAssertEqual(bbox.south, 87)
  }

  /// A region centered near the south pole must not push `south` past -90.
  func test_bbox_clampsSouthAtNegativeNinety() {
    let region = MapViewportRegion(centerLatitude: -89, centerLongitude: 0,
                                   latitudeDelta: 4, longitudeDelta: 4)
    let bbox = MapViewport.bbox(for: region)

    XCTAssertEqual(bbox.south, -90)
    XCTAssertEqual(bbox.north, -87)
  }

  /// Longitude is left unclamped — a region spanning the antimeridian
  /// legitimately produces `west > east`, which the server treats as an
  /// antimeridian-crossing box.
  func test_bbox_leavesLongitudeUnclampedAcrossAntimeridian() {
    let region = MapViewportRegion(centerLatitude: 0, centerLongitude: 179,
                                   latitudeDelta: 1, longitudeDelta: 4)
    let bbox = MapViewport.bbox(for: region)

    XCTAssertEqual(bbox.west, 177)
    XCTAssertEqual(bbox.east, 181)
  }

  // MARK: - zoomLevel(for:)

  /// The whole 360° world in one tile is zoom 0.
  func test_zoomLevel_wholeWorldSpanIsZoomZero() {
    let region = MapViewportRegion(centerLatitude: 0, centerLongitude: 0,
                                   latitudeDelta: 180, longitudeDelta: 360)
    XCTAssertEqual(MapViewport.zoomLevel(for: region), 0)
  }

  func test_zoomLevel_narrowSpanIsHighZoom() {
    // log2(360 / 0.36) == log2(1000) ≈ 9.966 → rounds to 10.
    let region = MapViewportRegion(centerLatitude: 0, centerLongitude: 0,
                                   latitudeDelta: 0.36, longitudeDelta: 0.36)
    XCTAssertEqual(MapViewport.zoomLevel(for: region), 10)
  }

  /// A zero (or negative) longitude span can't feed `log2` — clamp to the
  /// max zoom rather than producing infinity.
  func test_zoomLevel_zeroSpanClampsToMaxZoom() {
    let region = MapViewportRegion(centerLatitude: 0, centerLongitude: 0,
                                   latitudeDelta: 0, longitudeDelta: 0)
    XCTAssertEqual(MapViewport.zoomLevel(for: region), 21)
  }

  /// A span wider than the whole world (shouldn't happen from a real
  /// camera, but defensively) clamps to zoom 0, not a negative level.
  func test_zoomLevel_widerThanWorldClampsToZero() {
    let region = MapViewportRegion(centerLatitude: 0, centerLongitude: 0,
                                   latitudeDelta: 1000, longitudeDelta: 1000)
    XCTAssertEqual(MapViewport.zoomLevel(for: region), 0)
  }
}
