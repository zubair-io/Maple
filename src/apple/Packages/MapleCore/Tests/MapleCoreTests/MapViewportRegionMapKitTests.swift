// Tests for the MapKit → MapViewportRegion bridge (#2858).
//
// This conversion is the hinge the whole "more pins as you zoom in" behaviour
// hangs on: both macOS/iOS and tvOS read the LIVE camera out of MapKit through
// it and turn that into the bbox+zoom they ask the server for. #2858 was
// exactly this link being absent on tvOS — the screen drove a write-only
// `.constant` camera, never observed the real one, and so never refetched.

import CoreLocation
import MapKit
import XCTest

@testable import MapleCloudKit

final class MapViewportRegionMapKitTests: XCTestCase {
  func test_init_carriesCenterAndSpanThrough() {
    let region = MKCoordinateRegion(
      center: CLLocationCoordinate2D(latitude: 21.31, longitude: -157.86),
      span: MKCoordinateSpan(latitudeDelta: 1.5, longitudeDelta: 2.25))

    let viewport = MapViewportRegion(region)

    XCTAssertEqual(viewport.centerLatitude, 21.31, accuracy: 1e-9)
    XCTAssertEqual(viewport.centerLongitude, -157.86, accuracy: 1e-9)
    XCTAssertEqual(viewport.latitudeDelta, 1.5, accuracy: 1e-9)
    XCTAssertEqual(viewport.longitudeDelta, 2.25, accuracy: 1e-9)
  }

  /// The regression this ticket is about, expressed as an invariant: a camera
  /// that has zoomed in must produce a HIGHER zoom level and a TIGHTER bbox
  /// than the camera it zoomed from. If the conversion (or the observation of
  /// the live camera) is broken, the two are identical and the server keeps
  /// returning the same coarse grid — which is what the Apple TV showed.
  func test_zoomedInCameraYieldsHigherZoomAndTighterBbox() {
    let center = CLLocationCoordinate2D(latitude: 21.31, longitude: -157.86)
    let wide = MapViewportRegion(
      MKCoordinateRegion(center: center,
                         span: MKCoordinateSpan(latitudeDelta: 8, longitudeDelta: 20)))
    let tight = MapViewportRegion(
      MKCoordinateRegion(center: center,
                         span: MKCoordinateSpan(latitudeDelta: 0.5, longitudeDelta: 1.25)))

    XCTAssertGreaterThan(MapViewport.zoomLevel(for: tight), MapViewport.zoomLevel(for: wide))

    let wideBox = MapViewport.bbox(for: wide)
    let tightBox = MapViewport.bbox(for: tight)
    XCTAssertLessThan(tightBox.east - tightBox.west, wideBox.east - wideBox.west)
    XCTAssertLessThan(tightBox.north - tightBox.south, wideBox.north - wideBox.south)
  }

  /// A Hawaii-sized viewport is the case the bug was reported against; assert
  /// it converts to a bbox that actually contains Hawaii rather than the whole
  /// world it was frozen at.
  func test_hawaiiViewportProducesLocalBbox() {
    let viewport = MapViewportRegion(
      MKCoordinateRegion(
        center: CLLocationCoordinate2D(latitude: 21.31, longitude: -157.86),
        span: MKCoordinateSpan(latitudeDelta: 2, longitudeDelta: 4)))

    let box = MapViewport.bbox(for: viewport)

    XCTAssertLessThan(box.west, -157.86)
    XCTAssertGreaterThan(box.east, -157.86)
    XCTAssertLessThan(box.south, 21.31)
    XCTAssertGreaterThan(box.north, 21.31)
    // Emphatically not the whole world.
    XCTAssertLessThan(box.east - box.west, 10)
  }

  // MARK: - MKCoordinateRegion.init(_:) — the reverse bridge (#2912)

  /// `MapCameraPolicy.initial` (framework-free) has to reach a SwiftUI
  /// `Map(initialPosition:)` as a real `MKCoordinateRegion` — this is that
  /// conversion, round-tripped against the `MapViewportRegion.init(_:)`
  /// direction above.
  func test_mkCoordinateRegionInit_carriesCenterAndSpanThrough() {
    let viewport = MapViewportRegion(
      centerLatitude: 20, centerLongitude: 0, latitudeDelta: 140, longitudeDelta: 360)

    let region = MKCoordinateRegion(viewport)

    XCTAssertEqual(region.center.latitude, 20, accuracy: 1e-9)
    XCTAssertEqual(region.center.longitude, 0, accuracy: 1e-9)
    XCTAssertEqual(region.span.latitudeDelta, 140, accuracy: 1e-9)
    XCTAssertEqual(region.span.longitudeDelta, 360, accuracy: 1e-9)
  }

  func test_mkCoordinateRegionInit_roundTripsThroughMapViewportRegion() {
    let original = MKCoordinateRegion(
      center: CLLocationCoordinate2D(latitude: 21.31, longitude: -157.86),
      span: MKCoordinateSpan(latitudeDelta: 1.5, longitudeDelta: 2.25))

    let roundTripped = MKCoordinateRegion(MapViewportRegion(original))

    XCTAssertEqual(roundTripped.center.latitude, original.center.latitude, accuracy: 1e-9)
    XCTAssertEqual(roundTripped.center.longitude, original.center.longitude, accuracy: 1e-9)
    XCTAssertEqual(roundTripped.span.latitudeDelta, original.span.latitudeDelta, accuracy: 1e-9)
    XCTAssertEqual(roundTripped.span.longitudeDelta, original.span.longitudeDelta, accuracy: 1e-9)
  }
}
