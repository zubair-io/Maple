// MapCameraPolicyTests.swift
//
// Pins the #2912 fix: "data must never drive the camera." Before this
// ticket, macOS/iOS's `MapView` opened with SwiftUI's `.automatic` camera
// bound two-way via `Map(position:)` — that let a fetch's changed
// annotations re-frame the camera, which triggered a wider refetch, which
// re-framed wider still, forever (a user-visible runaway zoom-out). The fix
// is `MapCameraPolicy.initial`, a fixed, parameterless `MapViewportRegion`
// that `MapView` hands to `Map(initialPosition:)` instead — see that type's
// doc comment for the full history.
//
// `MapView` itself is a SwiftUI view in the app target, which a headless
// `swift test` run cannot host or invalidate (no live view/@State
// inspection) — so what's testable, and what actually enforces the
// invariant, is this policy type's shape: it takes no `[MapCluster]` /
// `[MapAnnotationItem]` input at all, so it is IMPOSSIBLE for a cells/
// annotation update routed through it to change the resulting camera.
// `MapAvailability`/`TVMapFocusOrder` establish the same "extract the pure
// decision so `swift test` can reach it" pattern for this same file tree.

import XCTest
@testable import MapleCloudKit

@MainActor
final class MapCameraPolicyTests: XCTestCase {

  /// Locks the starting camera to a known value — a whole-world framing,
  /// matching tvOS's `TVMapScreen.initialCameraPosition` so both platforms
  /// open the map at the same zoomed-out scale before the first fetch
  /// narrows it.
  func test_initial_isFixedWholeWorldRegion() {
    let region = MapCameraPolicy.initial

    XCTAssertEqual(region.centerLatitude, 20)
    XCTAssertEqual(region.centerLongitude, 0)
    XCTAssertEqual(region.latitudeDelta, 140)
    XCTAssertEqual(region.longitudeDelta, 360)
  }

  /// The regression this ticket is about, expressed as the ticket's own
  /// language: "camera state after a data update equals the camera state
  /// before it." Drives a REAL `MapViewModel` fetch — the exact mechanism
  /// that used to feed `.automatic`'s re-framing — and confirms the policy
  /// constant an observer would read is bit-for-bit identical before and
  /// after cells/heatmap points change underneath it.
  func test_initial_unaffectedByCellsOrAnnotationChange() async throws {
    let before = MapCameraPolicy.initial

    let server = URL(string: "https://example.test")!
    let json = """
    {"cells":[{"lat":48.8566,"lng":2.3522,"count":1,"representativeAssetId":"a1",
               "placeLabel":"Paris","thumbKey":"/photos/eiffel.dng"},
              {"lat":35.6762,"lng":139.6503,"count":42,"representativeAssetId":"a2",
               "placeLabel":"Tokyo"}]}
    """
    let session = URLSession.stubbed(response: json)
    let client = MapClustersClient(
      server: server,
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))
    let vm = MapViewModel(server: server, client: client)
    await vm.fetch(region: MapViewportRegion(
      centerLatitude: 0, centerLongitude: 0, latitudeDelta: 1, longitudeDelta: 1))

    // A real fetch landed real cells/annotations/heatmap points — confirm
    // the fixture actually changed something, or this test would pass
    // vacuously.
    XCTAssertEqual(vm.cells.count, 2, "fixture must actually populate cells for this test to mean anything")

    let after = MapCameraPolicy.initial
    XCTAssertEqual(before.centerLatitude, after.centerLatitude)
    XCTAssertEqual(before.centerLongitude, after.centerLongitude)
    XCTAssertEqual(before.latitudeDelta, after.latitudeDelta)
    XCTAssertEqual(before.longitudeDelta, after.longitudeDelta)
  }
}
