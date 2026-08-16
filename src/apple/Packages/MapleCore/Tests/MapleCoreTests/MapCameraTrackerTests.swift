// Tests for `MapCameraTracker` (#2869) — the shared per-frame camera signal
// that fixes the macOS/iOS/tvOS heatmap not moving during a pan/zoom.
//
// `MapProxy`/`Canvas` aren't unit-testable headlessly (see
// `MapHeatmapAnnotationProjectionConsistencyTests`'s header), so this can't
// assert the live SwiftUI `Canvas` actually redraws. What it CAN pin down is
// the exact mechanism the bug and fix both hinge on: `MapHeatmapLayerView`
// used to receive only `points` (changes on refetch) and `zoomLevel` (a
// rounded `Int` that holds steady across a whole pan) as inputs, so a pan
// that doesn't cross a zoom-level boundary produced a byte-for-byte identical
// set of inputs on every frame — SwiftUI skipped re-evaluating the heat
// layer's body, and the blobs sat glued to the screen while the tiles slid
// underneath. `region` is the fix specifically because it changes on EVERY
// frame of a pan even when `zoomLevel` does not; if a future edit reintroduces
// a tracker (or a derived value) that goes constant mid-pan, these tests
// catch it.

import CoreLocation
import MapKit
import XCTest

@testable import MapleCloudKit

final class MapCameraTrackerTests: XCTestCase {

  // MARK: - Defaults

  func test_freshTracker_hasNoRegion_andZoomLevelZero() {
    let tracker = MapCameraTracker()

    XCTAssertNil(tracker.region)
    XCTAssertEqual(tracker.zoomLevel, 0)
  }

  // MARK: - The core regression: region changes independently of zoomLevel

  /// The exact shape of a mid-pan camera update: the center moves, the span
  /// (and so the derived zoom level) does not. This is precisely the case
  /// the original bug got wrong — `zoomLevel` alone is not enough of a
  /// signal for the heat layer to redraw against, because it's identical
  /// across this pair of regions even though the camera plainly moved.
  func test_region_reflectsAPanEvenWhenDerivedZoomLevelDoesNot() {
    let tracker = MapCameraTracker()
    let span = MKCoordinateSpan(latitudeDelta: 0.5, longitudeDelta: 0.5)
    let start = MKCoordinateRegion(
      center: CLLocationCoordinate2D(latitude: 40.0, longitude: -74.0), span: span)
    let panned = MKCoordinateRegion(
      center: CLLocationCoordinate2D(latitude: 40.2, longitude: -74.3), span: span)

    tracker.region = start
    let zoomAtStart = tracker.zoomLevel
    let centerAtStart = tracker.region?.center

    tracker.region = panned
    let zoomAfterPan = tracker.zoomLevel
    let centerAfterPan = tracker.region?.center

    XCTAssertEqual(zoomAfterPan, zoomAtStart,
                    "test assumes a pan that doesn't cross a zoom-level boundary")
    XCTAssertNotEqual(centerAfterPan?.latitude, centerAtStart?.latitude,
                       "region must still carry the pan even though the derived zoom level is unchanged")
    XCTAssertNotEqual(centerAfterPan?.longitude, centerAtStart?.longitude,
                       "region must still carry the pan even though the derived zoom level is unchanged")
  }

  /// Every write is retained verbatim and readable back — the tracker is a
  /// plain per-frame relay, not something that coalesces or drops updates.
  func test_region_holdsTheMostRecentWrite() {
    let tracker = MapCameraTracker()
    let first = MKCoordinateRegion(
      center: CLLocationCoordinate2D(latitude: 10, longitude: 10),
      span: MKCoordinateSpan(latitudeDelta: 1, longitudeDelta: 1))
    let second = MKCoordinateRegion(
      center: CLLocationCoordinate2D(latitude: 20, longitude: 20),
      span: MKCoordinateSpan(latitudeDelta: 1, longitudeDelta: 1))

    tracker.region = first
    XCTAssertEqual(tracker.region?.center.latitude, 10)

    tracker.region = second
    XCTAssertEqual(tracker.region?.center.latitude, 20)
  }

  // MARK: - zoomLevel derivation

  /// `zoomLevel` must track `MapViewport.zoomLevel(for:)` exactly — it's a
  /// pass-through, not a reimplementation — so the heatmap's crossfade lines
  /// up with the `/api/map/clusters` `zoom` the same camera produces.
  func test_zoomLevel_matchesMapViewportForTheSameRegion() {
    let tracker = MapCameraTracker()
    let region = MKCoordinateRegion(
      center: CLLocationCoordinate2D(latitude: 48.8566, longitude: 2.3522),
      span: MKCoordinateSpan(latitudeDelta: 0.75, longitudeDelta: 1.1))
    tracker.region = region

    XCTAssertEqual(tracker.zoomLevel, MapViewport.zoomLevel(for: MapViewportRegion(region)))
  }

  /// A zoomed-in camera still produces a higher zoom level through the
  /// tracker than a zoomed-out one — the end-to-end version of
  /// `MapViewportRegionMapKitTests`'s equivalent check, but through the type
  /// the heat layer actually reads.
  func test_zoomLevel_risesAsTheCameraZoomsIn() {
    let tracker = MapCameraTracker()
    let center = CLLocationCoordinate2D(latitude: 48.8566, longitude: 2.3522)

    tracker.region = MKCoordinateRegion(center: center, span: MKCoordinateSpan(latitudeDelta: 8, longitudeDelta: 20))
    let wideZoom = tracker.zoomLevel

    tracker.region = MKCoordinateRegion(center: center, span: MKCoordinateSpan(latitudeDelta: 0.5, longitudeDelta: 1.25))
    let tightZoom = tracker.zoomLevel

    XCTAssertGreaterThan(tightZoom, wideZoom)
  }
}
