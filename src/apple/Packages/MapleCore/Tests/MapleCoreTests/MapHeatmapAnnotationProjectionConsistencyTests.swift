// MapHeatmapAnnotationProjectionConsistencyTests.swift
//
// Map T9 (#2834) requires the tvOS heatmap's blobs to line up with the
// annotation pins from the same map view (#2833) — a heat blob drawn
// somewhere other than its cell's actual pin would misrepresent the data.
// Neither `MapHeatmapPoint` nor `MapAnnotationItem` know about each other,
// so the guarantee has to come from both projecting the SAME
// `MapCluster.lat`/`lng` in the SAME order — this test locks that down
// directly against the two real projections, rather than only trusting each
// type's own isolated tests to imply it.
//
// This is deliberately independent of `MapProxy`/`Canvas` (neither is
// unit-testable headlessly): both `TVMapHeatmapLayerView` and
// `TVMapAnnotationButton`'s `Annotation(coordinate:)` feed the exact
// coordinate this test compares into the same `MapProxy.convert`, so
// agreement here is agreement on screen too.

import XCTest
@testable import MapleCloudKit

final class MapHeatmapAnnotationProjectionConsistencyTests: XCTestCase {

  private func cell(lat: Double, lng: Double, count: Int, id: String) -> MapCluster {
    MapCluster(lat: lat, lng: lng, count: count, representativeAssetId: id)
  }

  func test_heatmapPoints_andAnnotationItems_shareTheSameCoordinatesInTheSameOrder() {
    let cells = [
      cell(lat: 48.8566, lng: 2.3522, count: 1, id: "paris"),
      cell(lat: 35.6762, lng: 139.6503, count: 42, id: "tokyo"),
      cell(lat: -33.8688, lng: 151.2093, count: 7, id: "sydney"),
    ]

    let heatmapCoordinates = MapHeatmapPoint.points(from: cells).map { ($0.latitude, $0.longitude) }
    let annotationCoordinates = MapAnnotationItem.items(from: cells).map { ($0.latitude, $0.longitude) }

    XCTAssertEqual(heatmapCoordinates.count, annotationCoordinates.count)
    for (heat, annotation) in zip(heatmapCoordinates, annotationCoordinates) {
      XCTAssertEqual(heat.0, annotation.0, "latitude must match the cell the annotation renders")
      XCTAssertEqual(heat.1, annotation.1, "longitude must match the cell the annotation renders")
    }
  }

  func test_emptyCells_yieldNeitherHeatmapPointsNorAnnotations() {
    XCTAssertTrue(MapHeatmapPoint.points(from: []).isEmpty)
    XCTAssertTrue(MapAnnotationItem.items(from: []).isEmpty)
  }

  /// The hottest cell (by `count`) still projects to the SAME coordinate as
  /// its annotation — the weight normalization in `MapHeatmapPoint` must
  /// never perturb the coordinate it's attached to.
  func test_hottestCellsCoordinate_isUnchangedByWeightNormalization() {
    let cells = [
      cell(lat: 1, lng: 1, count: 3, id: "cold"),
      cell(lat: 2, lng: 2, count: 99, id: "hot"),
    ]

    let hottestHeatPoint = MapHeatmapPoint.points(from: cells).max { $0.weight < $1.weight }!
    let hottestAnnotation = MapAnnotationItem.items(from: cells).first { $0.id == "hot" }!

    XCTAssertEqual(hottestHeatPoint.weight, 1.0)
    XCTAssertEqual(hottestHeatPoint.latitude, hottestAnnotation.latitude)
    XCTAssertEqual(hottestHeatPoint.longitude, hottestAnnotation.longitude)
  }
}
