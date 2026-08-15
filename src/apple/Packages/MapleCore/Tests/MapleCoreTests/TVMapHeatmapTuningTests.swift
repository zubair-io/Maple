// TVMapHeatmapTuningTests.swift
//
// TV-specific tuning for the shared heatmap renderer (Map T9, #2834):
// wider blob radii and a zoom-crossfade opacity boost than the handheld
// platforms use, since the renderer itself is shared but the numbers fed
// into it are allowed to diverge for ten-foot legibility. Covers the same
// two contracts the ticket calls out — "hottest cell draws biggest" via
// `radius(forWeight:)`, and "visible at low zoom, ~0 at high zoom" via
// `opacity(forZoomLevel:)` — using the TV entry points, not the shared
// handheld defaults `MapHeatmapPainterTests`/`MapHeatmapZoomCrossfadeTests`
// already cover.

import XCTest
@testable import MapleCloudKit

final class TVMapHeatmapTuningTests: XCTestCase {

  // MARK: - radius(forWeight:)

  func test_radius_weightZero_isTVMinRadius() {
    XCTAssertEqual(TVMapHeatmapTuning.radius(forWeight: 0), TVMapHeatmapTuning.minScreenRadius)
  }

  func test_radius_weightOne_isTVMaxRadius() {
    XCTAssertEqual(TVMapHeatmapTuning.radius(forWeight: 1), TVMapHeatmapTuning.maxScreenRadius)
  }

  func test_radius_weightHalf_isMidpointOfTVBounds() {
    let expected = (TVMapHeatmapTuning.minScreenRadius + TVMapHeatmapTuning.maxScreenRadius) / 2
    XCTAssertEqual(TVMapHeatmapTuning.radius(forWeight: 0.5), expected)
  }

  /// The ticket explicitly expects TV radii to diverge from the handheld
  /// defaults (bigger, for viewing distance) — assert the divergence rather
  /// than just its own internal consistency, so a future edit that
  /// accidentally re-collapses the two constant sets fails loudly.
  func test_tvBounds_areWiderThanHandheldDefaults() {
    XCTAssertGreaterThan(TVMapHeatmapTuning.minScreenRadius, MapHeatmapPainter.minScreenRadius)
    XCTAssertGreaterThan(TVMapHeatmapTuning.maxScreenRadius, MapHeatmapPainter.maxScreenRadius)
  }

  func test_radius_clampsNegativeWeightToTVMin() {
    XCTAssertEqual(TVMapHeatmapTuning.radius(forWeight: -3), TVMapHeatmapTuning.minScreenRadius)
  }

  func test_radius_clampsOverOneWeightToTVMax() {
    XCTAssertEqual(TVMapHeatmapTuning.radius(forWeight: 7), TVMapHeatmapTuning.maxScreenRadius)
  }

  // MARK: - opacity(forZoomLevel:)

  func test_opacity_atFadeStartZoom_isFullyOpaque() {
    // The shared crossfade is already 1.0 here — the boost multiplies past
    // 1 but the TV entry point re-clamps back down.
    XCTAssertEqual(TVMapHeatmapTuning.opacity(forZoomLevel: MapHeatmapZoomCrossfade.fadeStartZoom), 1.0)
  }

  func test_opacity_belowFadeStartZoom_isFullyOpaque() {
    XCTAssertEqual(TVMapHeatmapTuning.opacity(forZoomLevel: 0), 1.0)
  }

  func test_opacity_atFadeEndZoom_isZero() {
    // Boosting zero by any positive factor is still zero.
    XCTAssertEqual(TVMapHeatmapTuning.opacity(forZoomLevel: MapHeatmapZoomCrossfade.fadeEndZoom), 0.0)
  }

  func test_opacity_wellAboveFadeEndZoom_isZero() {
    XCTAssertEqual(TVMapHeatmapTuning.opacity(forZoomLevel: 21), 0.0)
  }

  /// Mid-fade is exactly where the boost is supposed to matter — the TV
  /// value must read strictly hotter than the plain shared crossfade at the
  /// same zoom, but never exceed 1.
  func test_opacity_midFade_isBoostedAboveSharedCrossfadeButClampedToOne() {
    let midpoint = (MapHeatmapZoomCrossfade.fadeStartZoom + MapHeatmapZoomCrossfade.fadeEndZoom) / 2
    let shared = MapHeatmapZoomCrossfade.opacity(forZoomLevel: midpoint)
    let boosted = TVMapHeatmapTuning.opacity(forZoomLevel: midpoint)

    XCTAssertEqual(shared, 0.5, accuracy: 1e-9, "test assumes the standard crossfade midpoint")
    XCTAssertEqual(boosted, min(shared * TVMapHeatmapTuning.intensityBoost, 1), accuracy: 1e-9)
    XCTAssertGreaterThan(boosted, shared)
    XCTAssertLessThanOrEqual(boosted, 1.0)
  }

  func test_opacity_isMonotonicallyNonIncreasingAcrossTheFullZoomRange() {
    var previous = 1.0
    for zoom in 0...21 {
      let opacity = TVMapHeatmapTuning.opacity(forZoomLevel: zoom)
      XCTAssertLessThanOrEqual(opacity, previous, "opacity must never rise as zoom increases (zoom \(zoom))")
      previous = opacity
    }
  }
}
