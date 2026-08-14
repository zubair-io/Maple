// MapHeatmapOverlayTests.swift
//
// The real `MKOverlay` geometry for the heatmap (#2831): `boundingMapRect`
// must cover every point it's built from (with headroom for blob overflow),
// collapse to `.null` for an empty response (MapKit never asks a renderer
// with a null bounding rect to draw — the "empty cells → no heat"
// contract), and `coordinate` must sit at the rect's own center.

import XCTest
import MapKit
@testable import MapleCloudKit

final class MapHeatmapOverlayTests: XCTestCase {

  private func cell(count: Int, lat: Double, lng: Double) -> MapCluster {
    MapCluster(lat: lat, lng: lng, count: count, representativeAssetId: "a-\(lat)-\(lng)")
  }

  // MARK: - boundingMapRect

  func test_boundingMapRect_emptyPoints_isNull() {
    XCTAssertTrue(MapHeatmapOverlay.boundingMapRect(for: []).isNull)
  }

  func test_boundingMapRect_singlePoint_containsThatPoint() {
    let coordinate = CLLocationCoordinate2D(latitude: 48.8566, longitude: 2.3522)
    let point = MapHeatmapPoint(latitude: coordinate.latitude, longitude: coordinate.longitude, weight: 1)
    let rect = MapHeatmapOverlay.boundingMapRect(for: [point])

    XCTAssertFalse(rect.isNull)
    XCTAssertTrue(rect.contains(MKMapPoint(coordinate)))
  }

  /// A single point's tight rect is zero-sized — the padding must still
  /// give it a non-zero footprint (a fixed floor, not a fraction of zero).
  func test_boundingMapRect_singlePoint_isNotZeroSized() {
    let point = MapHeatmapPoint(latitude: 0, longitude: 0, weight: 1)
    let rect = MapHeatmapOverlay.boundingMapRect(for: [point])

    XCTAssertGreaterThan(rect.width, 0)
    XCTAssertGreaterThan(rect.height, 0)
  }

  func test_boundingMapRect_multiplePoints_containsEveryPoint() {
    let points = [
      MapHeatmapPoint(latitude: 48.8566, longitude: 2.3522, weight: 1),   // Paris
      MapHeatmapPoint(latitude: 35.6762, longitude: 139.6503, weight: 0.5), // Tokyo
      MapHeatmapPoint(latitude: -33.8688, longitude: 151.2093, weight: 0.1), // Sydney
    ]
    let rect = MapHeatmapOverlay.boundingMapRect(for: points)

    for point in points {
      let coordinate = CLLocationCoordinate2D(latitude: point.latitude, longitude: point.longitude)
      XCTAssertTrue(rect.contains(MKMapPoint(coordinate)), "rect must contain (\(point.latitude), \(point.longitude))")
    }
  }

  /// The padding gives some headroom beyond the tightest-fit union, so a
  /// blob centered right on the boundary point isn't immediately clipped.
  func test_boundingMapRect_padsBeyondTheTightUnion() {
    let points = [
      MapHeatmapPoint(latitude: 0, longitude: 0, weight: 1),
      MapHeatmapPoint(latitude: 10, longitude: 10, weight: 1),
    ]
    let rect = MapHeatmapOverlay.boundingMapRect(for: points)
    let mapPoints = points.map { MKMapPoint(CLLocationCoordinate2D(latitude: $0.latitude, longitude: $0.longitude)) }
    let tight = MKMapRect(x: min(mapPoints[0].x, mapPoints[1].x), y: min(mapPoints[0].y, mapPoints[1].y),
                           width: abs(mapPoints[0].x - mapPoints[1].x), height: abs(mapPoints[0].y - mapPoints[1].y))

    XCTAssertGreaterThan(rect.width, tight.width)
    XCTAssertGreaterThan(rect.height, tight.height)
    XCTAssertTrue(rect.contains(tight))
  }

  // MARK: - blobBounds (per-tile culling)

  func test_blobBounds_isCenteredSquareOfTwiceTheRadius() {
    let center = MKMapPoint(x: 1_000, y: 2_000)
    let bounds = MapHeatmapOverlay.blobBounds(center: center, radiusMapPoints: 50)

    XCTAssertEqual(bounds.minX, 950)
    XCTAssertEqual(bounds.minY, 1_950)
    XCTAssertEqual(bounds.width, 100)
    XCTAssertEqual(bounds.height, 100)
    XCTAssertTrue(bounds.contains(center))
  }

  /// The whole point of the cull: a blob far from the tile being drawn must
  /// NOT intersect it, so the renderer can skip its `drawRadialGradient`.
  func test_blobBounds_farFromTile_doesNotIntersect() {
    let tile = MKMapRect(x: 0, y: 0, width: 100, height: 100)
    let bounds = MapHeatmapOverlay.blobBounds(center: MKMapPoint(x: 10_000, y: 10_000), radiusMapPoints: 50)
    XCTAssertFalse(bounds.intersects(tile))
  }

  func test_blobBounds_centeredInsideTile_intersects() {
    let tile = MKMapRect(x: 0, y: 0, width: 100, height: 100)
    let bounds = MapHeatmapOverlay.blobBounds(center: MKMapPoint(x: 50, y: 50), radiusMapPoints: 10)
    XCTAssertTrue(bounds.intersects(tile))
  }

  /// A blob whose CENTER is outside the tile but whose radius reaches into
  /// it must still be drawn — culling on the center alone would clip the
  /// heat bleeding across every tile seam.
  func test_blobBounds_centerOutsideTileButRadiusReachesIn_intersects() {
    let tile = MKMapRect(x: 0, y: 0, width: 100, height: 100)
    let center = MKMapPoint(x: 130, y: 50)
    let bounds = MapHeatmapOverlay.blobBounds(center: center, radiusMapPoints: 50)

    XCTAssertFalse(tile.contains(center), "center is outside the tile")
    XCTAssertTrue(bounds.intersects(tile), "but its radius reaches in, so it must not be culled")
  }

  // MARK: - coordinate

  func test_coordinate_emptyPoints_isOriginSentinel() {
    let overlay = MapHeatmapOverlay(points: [])
    XCTAssertEqual(overlay.coordinate.latitude, 0)
    XCTAssertEqual(overlay.coordinate.longitude, 0)
  }

  func test_coordinate_isRectMidpoint() {
    let points = [
      MapHeatmapPoint(latitude: 48.8566, longitude: 2.3522, weight: 1),
      MapHeatmapPoint(latitude: 35.6762, longitude: 139.6503, weight: 0.5),
    ]
    let overlay = MapHeatmapOverlay(points: points)
    let expected = MKMapPoint(x: overlay.boundingMapRect.midX, y: overlay.boundingMapRect.midY).coordinate

    XCTAssertEqual(overlay.coordinate.latitude, expected.latitude, accuracy: 1e-9)
    XCTAssertEqual(overlay.coordinate.longitude, expected.longitude, accuracy: 1e-9)
  }

  // MARK: - from(cells:)

  func test_from_cells_buildsWeightedPointsAndCoveringRect() {
    let cells = [cell(count: 5, lat: 10, lng: 20), cell(count: 50, lat: 11, lng: 21)]
    let overlay = MapHeatmapOverlay.from(cells: cells)

    XCTAssertEqual(overlay.points.count, 2)
    XCTAssertEqual(overlay.points.map(\.weight), [0.1, 1.0])
    for point in overlay.points {
      let coordinate = CLLocationCoordinate2D(latitude: point.latitude, longitude: point.longitude)
      XCTAssertTrue(overlay.boundingMapRect.contains(MKMapPoint(coordinate)))
    }
  }

  func test_from_emptyCells_producesNullRect() {
    XCTAssertTrue(MapHeatmapOverlay.from(cells: []).boundingMapRect.isNull)
  }
}
