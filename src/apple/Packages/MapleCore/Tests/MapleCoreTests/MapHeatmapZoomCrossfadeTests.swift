// MapHeatmapZoomCrossfadeTests.swift
//
// The heatmap's zoom-based opacity curve (#2831): opaque at low zoom (the
// heatmap "owns" the wide view), fading to ~0 by the zoom where clustered
// pins are legible, so the two layers never fight. Also covers the
// `MKZoomScale` ↔ integer-zoom conversion the real `MKOverlayRenderer` path
// uses, cross-checked against `MapViewport`'s own zoom convention so both
// stay in lockstep.

import XCTest
@testable import MapleCloudKit

final class MapHeatmapZoomCrossfadeTests: XCTestCase {

  // MARK: - opacity(forZoomLevel:)

  func test_opacity_atFadeStartZoom_isFullyOpaque() {
    XCTAssertEqual(MapHeatmapZoomCrossfade.opacity(forZoomLevel: MapHeatmapZoomCrossfade.fadeStartZoom), 1.0)
  }

  func test_opacity_belowFadeStartZoom_isFullyOpaque() {
    XCTAssertEqual(MapHeatmapZoomCrossfade.opacity(forZoomLevel: 0), 1.0)
  }

  func test_opacity_atFadeEndZoom_isZero() {
    XCTAssertEqual(MapHeatmapZoomCrossfade.opacity(forZoomLevel: MapHeatmapZoomCrossfade.fadeEndZoom), 0.0)
  }

  func test_opacity_wellAboveFadeEndZoom_isZero() {
    XCTAssertEqual(MapHeatmapZoomCrossfade.opacity(forZoomLevel: 21), 0.0)
  }

  func test_opacity_midpointBetweenThresholds_isHalf() {
    let midpoint = (MapHeatmapZoomCrossfade.fadeStartZoom + MapHeatmapZoomCrossfade.fadeEndZoom) / 2
    XCTAssertEqual(MapHeatmapZoomCrossfade.opacity(forZoomLevel: midpoint), 0.5, accuracy: 1e-9)
  }

  func test_opacity_isMonotonicallyNonIncreasingAcrossTheFullZoomRange() {
    var previous = 1.0
    for zoom in 0...21 {
      let opacity = MapHeatmapZoomCrossfade.opacity(forZoomLevel: zoom)
      XCTAssertLessThanOrEqual(opacity, previous, "opacity must never rise as zoom increases (zoom \(zoom))")
      previous = opacity
    }
  }

  // MARK: - zoomLevel(forZoomScale:)

  func test_zoomLevel_forZoomScale_nonPositiveClampsToZero() {
    XCTAssertEqual(MapHeatmapZoomCrossfade.zoomLevel(forZoomScale: 0), 0)
    XCTAssertEqual(MapHeatmapZoomCrossfade.zoomLevel(forZoomScale: -1), 0)
  }

  /// `zoomScale = (tileSize * 2^zoom) / worldMapPointWidth` is the same
  /// convention `MapViewport.zoomLevel` derives from (`zoom =
  /// log2(360 / longitudeDelta)`, a whole-world span == zoom 0) — feed the
  /// formula a handful of representative zooms and confirm the round trip
  /// lands back on the same integer.
  func test_zoomLevel_forZoomScale_roundTripsThroughTheZoomFormula() {
    let worldMapPointWidth = 268_435_456.0
    let tileSize = 256.0
    for zoom in [0, 1, 4, 9, 10, 15, 21] {
      let zoomScale = (tileSize * pow(2, Double(zoom))) / worldMapPointWidth
      XCTAssertEqual(MapHeatmapZoomCrossfade.zoomLevel(forZoomScale: zoomScale), zoom, "zoom \(zoom)")
    }
  }

  func test_zoomLevel_forZoomScale_clampsAboveTwentyOne() {
    XCTAssertEqual(MapHeatmapZoomCrossfade.zoomLevel(forZoomScale: 1_000_000), 21)
  }

  // MARK: - opacity(forZoomScale:) — the composed entry point the renderer calls

  func test_opacityForZoomScale_wholeWorldZoomScale_isFullyOpaque() {
    // zoom 0 → zoomScale = 256 / 268_435_456.
    let worldZoomScale = 256.0 / 268_435_456.0
    XCTAssertEqual(MapHeatmapZoomCrossfade.opacity(forZoomScale: worldZoomScale), 1.0)
  }

  func test_opacityForZoomScale_streetLevelZoomScale_isZero() {
    let worldMapPointWidth = 268_435_456.0
    let tileSize = 256.0
    let zoomScale = (tileSize * pow(2, 15)) / worldMapPointWidth
    XCTAssertEqual(MapHeatmapZoomCrossfade.opacity(forZoomScale: zoomScale), 0.0)
  }
}
