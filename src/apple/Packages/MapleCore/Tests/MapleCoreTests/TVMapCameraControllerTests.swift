// TVMapCameraControllerTests.swift
//
// Pure Siri Remote camera-stepping math for the tvOS map screen (#2833) —
// no MapKit, no focus engine, no running app: just region-in/region-out
// assertions against `TVMapCameraController`.

import XCTest
@testable import MapleCloudKit

final class TVMapCameraControllerTests: XCTestCase {

  private func region(lat: Double = 0, lng: Double = 0, latDelta: Double = 10, lngDelta: Double = 10) -> MapViewportRegion {
    MapViewportRegion(centerLatitude: lat, centerLongitude: lng, latitudeDelta: latDelta, longitudeDelta: lngDelta)
  }

  // MARK: - panned(_:direction:)

  func test_panned_up_movesCenterNorthBySpanFraction() {
    let start = region(lat: 0, latDelta: 10)
    let stepped = TVMapCameraController.panned(start, direction: .up)
    XCTAssertEqual(stepped.centerLatitude, 3.5, accuracy: 1e-9)
    XCTAssertEqual(stepped.latitudeDelta, start.latitudeDelta, "pan must not change the span")
    XCTAssertEqual(stepped.longitudeDelta, start.longitudeDelta)
  }

  func test_panned_down_movesCenterSouthBySpanFraction() {
    let start = region(lat: 0, latDelta: 10)
    let stepped = TVMapCameraController.panned(start, direction: .down)
    XCTAssertEqual(stepped.centerLatitude, -3.5, accuracy: 1e-9)
  }

  func test_panned_right_movesCenterEastBySpanFraction() {
    let start = region(lng: 0, lngDelta: 10)
    let stepped = TVMapCameraController.panned(start, direction: .right)
    XCTAssertEqual(stepped.centerLongitude, 3.5, accuracy: 1e-9)
  }

  func test_panned_left_movesCenterWestBySpanFraction() {
    let start = region(lng: 0, lngDelta: 10)
    let stepped = TVMapCameraController.panned(start, direction: .left)
    XCTAssertEqual(stepped.centerLongitude, -3.5, accuracy: 1e-9)
  }

  /// A wider span means a wider absolute pan step — the fraction is
  /// relative to the CURRENT span, not a fixed degree amount.
  func test_panned_stepSizeScalesWithCurrentSpan() {
    let narrow = TVMapCameraController.panned(region(lng: 0, lngDelta: 1), direction: .right)
    let wide = TVMapCameraController.panned(region(lng: 0, lngDelta: 100), direction: .right)
    XCTAssertEqual(narrow.centerLongitude, 0.35, accuracy: 1e-9)
    XCTAssertEqual(wide.centerLongitude, 35, accuracy: 1e-9)
  }

  func test_panned_clampsLatitudeAtNinety() {
    let start = region(lat: 89, latDelta: 10)
    let stepped = TVMapCameraController.panned(start, direction: .up)
    XCTAssertEqual(stepped.centerLatitude, 90)
  }

  func test_panned_clampsLatitudeAtNegativeNinety() {
    let start = region(lat: -89, latDelta: 10)
    let stepped = TVMapCameraController.panned(start, direction: .down)
    XCTAssertEqual(stepped.centerLatitude, -90)
  }

  /// Panning past the antimeridian wraps the center back into
  /// `[-180, 180]` rather than letting it drift out of range.
  func test_panned_wrapsLongitudeAcrossAntimeridian() {
    let start = region(lng: 179, lngDelta: 10)
    let stepped = TVMapCameraController.panned(start, direction: .right)
    // 179 + 3.5 = 182.5 → wraps to -177.5.
    XCTAssertEqual(stepped.centerLongitude, -177.5, accuracy: 1e-9)
  }

  /// Four opposite-direction pairs cancel out exactly, back to the start —
  /// stepping is reversible, not lossy.
  func test_panned_upThenDown_returnsToOriginalCenter() {
    let start = region(lat: 10, latDelta: 4)
    let roundTrip = TVMapCameraController.panned(TVMapCameraController.panned(start, direction: .up), direction: .down)
    XCTAssertEqual(roundTrip.centerLatitude, start.centerLatitude, accuracy: 1e-9)
  }

  // MARK: - zoomedIn(_:) / zoomedOut(_:)

  func test_zoomedIn_halvesBothDeltas() {
    let start = region(latDelta: 20, lngDelta: 40)
    let zoomed = TVMapCameraController.zoomedIn(start)
    XCTAssertEqual(zoomed.latitudeDelta, 10, accuracy: 1e-9)
    XCTAssertEqual(zoomed.longitudeDelta, 20, accuracy: 1e-9)
    XCTAssertEqual(zoomed.centerLatitude, start.centerLatitude, "zoom must not move the center")
    XCTAssertEqual(zoomed.centerLongitude, start.centerLongitude)
  }

  func test_zoomedOut_doublesBothDeltas() {
    let start = region(latDelta: 20, lngDelta: 40)
    let zoomed = TVMapCameraController.zoomedOut(start)
    XCTAssertEqual(zoomed.latitudeDelta, 40, accuracy: 1e-9)
    XCTAssertEqual(zoomed.longitudeDelta, 80, accuracy: 1e-9)
  }

  func test_zoomedIn_clampsAtMinSpan() {
    let start = region(latDelta: TVMapCameraController.minSpanDegrees, lngDelta: TVMapCameraController.minSpanDegrees)
    let zoomed = TVMapCameraController.zoomedIn(start)
    XCTAssertEqual(zoomed.latitudeDelta, TVMapCameraController.minSpanDegrees, accuracy: 1e-12)
    XCTAssertEqual(zoomed.longitudeDelta, TVMapCameraController.minSpanDegrees, accuracy: 1e-12)
  }

  func test_zoomedOut_clampsAtMaxSpan() {
    let start = region(latDelta: TVMapCameraController.maxLatitudeSpanDegrees,
                       lngDelta: TVMapCameraController.maxLongitudeSpanDegrees)
    let zoomed = TVMapCameraController.zoomedOut(start)
    XCTAssertEqual(zoomed.latitudeDelta, TVMapCameraController.maxLatitudeSpanDegrees)
    XCTAssertEqual(zoomed.longitudeDelta, TVMapCameraController.maxLongitudeSpanDegrees)
  }

  /// Repeatedly zooming in from the default region eventually hits the
  /// floor rather than overshooting to zero or a negative span.
  func test_zoomedIn_repeatedlyConvergesToMinSpanWithoutOvershooting() {
    var current = TVMapCameraController.defaultRegion
    for _ in 0..<40 {
      current = TVMapCameraController.zoomedIn(current)
    }
    XCTAssertEqual(current.latitudeDelta, TVMapCameraController.minSpanDegrees, accuracy: 1e-12)
    XCTAssertEqual(current.longitudeDelta, TVMapCameraController.minSpanDegrees, accuracy: 1e-12)
  }

  func test_zoomedIn_thenZoomedOut_returnsToOriginalSpan() {
    let start = region(latDelta: 20, lngDelta: 40)
    let roundTrip = TVMapCameraController.zoomedOut(TVMapCameraController.zoomedIn(start))
    XCTAssertEqual(roundTrip.latitudeDelta, start.latitudeDelta, accuracy: 1e-9)
    XCTAssertEqual(roundTrip.longitudeDelta, start.longitudeDelta, accuracy: 1e-9)
  }

  // MARK: - defaultRegion

  /// The starting camera is a wide, roughly-whole-world view — the
  /// longitude span exactly matches `MapViewport.bbox(for:)`'s own
  /// `longitudeDelta < 360` "whole world" threshold, so the very first
  /// fetch already covers everything.
  func test_defaultRegion_isWholeWorldWidth() {
    XCTAssertEqual(TVMapCameraController.defaultRegion.longitudeDelta, 360)
    let bbox = MapViewport.bbox(for: TVMapCameraController.defaultRegion)
    XCTAssertEqual(bbox.west, -180)
    XCTAssertEqual(bbox.east, 180)
  }
}
