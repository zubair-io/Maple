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
// annotation update routed through it to change the resulting camera. A
// dynamic "fetch cells, then re-read `MapCameraPolicy.initial`" test would
// add nothing beyond that structural guarantee — `initial` is a `static
// let`, so any such equality is enforced by the compiler regardless of
// what a test does in between (`MapViewModelTests` already covers
// fetch-populates-cells/heatmapPoints on its own). What's actually worth
// pinning here is the concrete value below, plus the zero-parameter shape
// documented on `MapCameraPolicy` itself. `MapAvailability`/
// `TVMapFocusOrder` establish the same "extract the pure decision so
// `swift test` can reach it" pattern for this same file tree.

import XCTest
@testable import MapleCloudKit

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
}
