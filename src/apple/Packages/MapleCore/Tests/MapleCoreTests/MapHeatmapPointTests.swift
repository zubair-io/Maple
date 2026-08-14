// MapHeatmapPointTests.swift
//
// Weight-normalization for the heatmap overlay (#2831): the hottest cell in
// a `/api/map/clusters` response must always land at weight 1, every other
// cell scales relative to it, and no located photos means no heat.

import XCTest
@testable import MapleCloudKit

final class MapHeatmapPointTests: XCTestCase {

  private func cell(count: Int, lat: Double = 0, lng: Double = 0) -> MapCluster {
    MapCluster(lat: lat, lng: lng, count: count, representativeAssetId: "a-\(count)-\(lat)-\(lng)")
  }

  func test_points_emptyCells_returnsNoHeat() {
    XCTAssertTrue(MapHeatmapPoint.points(from: []).isEmpty)
  }

  func test_points_singleCell_weightIsOne() {
    let points = MapHeatmapPoint.points(from: [cell(count: 7)])
    XCTAssertEqual(points.map(\.weight), [1.0])
  }

  func test_points_hottestCellIsMaxCount_normalizedToOne() {
    let cells = [cell(count: 3), cell(count: 40), cell(count: 1)]
    let points = MapHeatmapPoint.points(from: cells)

    XCTAssertEqual(points.count, 3)
    XCTAssertEqual(points[1].weight, 1.0, "the count==40 cell is the hottest in this response")
    XCTAssertEqual(points[0].weight, 3.0 / 40.0, accuracy: 1e-9)
    XCTAssertEqual(points[2].weight, 1.0 / 40.0, accuracy: 1e-9)
  }

  func test_points_preservesLatLng() {
    let points = MapHeatmapPoint.points(from: [cell(count: 5, lat: 48.8566, lng: 2.3522)])
    XCTAssertEqual(points[0].latitude, 48.8566)
    XCTAssertEqual(points[0].longitude, 2.3522)
  }

  /// Order is preserved — same convention as `MapAnnotationItem.items(from:)`,
  /// no client-side re-sorting/re-clustering of the server's cells.
  func test_points_preservesInputOrder() {
    let cells = [cell(count: 9, lat: 1), cell(count: 2, lat: 2), cell(count: 5, lat: 3)]
    let points = MapHeatmapPoint.points(from: cells)
    XCTAssertEqual(points.map(\.latitude), [1, 2, 3])
  }
}
