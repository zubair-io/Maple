// TVMapFocusOrderTests.swift
//
// Deterministic pin focus-traversal order for the tvOS map screen (#2833).
// There's no live focus engine in a headless `swift test` run, so what's
// testable — and what the tvOS screen actually relies on for its default
// focus target — is the pure ordering function, not real remote-driven
// navigation.

import XCTest
@testable import MapleCloudKit

final class TVMapFocusOrderTests: XCTestCase {

  private func item(id: String, lat: Double, lng: Double) -> MapAnnotationItem {
    MapAnnotationItem(id: id, latitude: lat, longitude: lng, kind: .cluster(count: 1), placeLabel: nil)
  }

  func test_ordered_sortsNorthToSouth() {
    let items = [
      item(id: "south", lat: -10, lng: 0),
      item(id: "north", lat: 40, lng: 0),
      item(id: "middle", lat: 5, lng: 0),
    ]
    XCTAssertEqual(TVMapFocusOrder.ordered(items).map(\.id), ["north", "middle", "south"])
  }

  func test_ordered_sameLatitude_sortsWestToEast() {
    let items = [
      item(id: "east", lat: 0, lng: 40),
      item(id: "west", lat: 0, lng: -40),
      item(id: "center", lat: 0, lng: 0),
    ]
    XCTAssertEqual(TVMapFocusOrder.ordered(items).map(\.id), ["west", "center", "east"])
  }

  /// Cells sharing the exact same grid cell (identical lat/lng — the
  /// server's grid-bucketing makes this possible at a cell boundary) still
  /// resolve to a single, deterministic order via the `id` tie-break,
  /// rather than depending on whatever order the input array happened to
  /// arrive in.
  func test_ordered_tiesOnLatLng_breakOnID() {
    let items = [
      item(id: "b", lat: 1, lng: 1),
      item(id: "a", lat: 1, lng: 1),
      item(id: "c", lat: 1, lng: 1),
    ]
    XCTAssertEqual(TVMapFocusOrder.ordered(items).map(\.id), ["a", "b", "c"])
  }

  func test_ordered_isStableAcrossInputPermutations() {
    let a = item(id: "a", lat: 10, lng: -5)
    let b = item(id: "b", lat: 10, lng: 5)
    let c = item(id: "c", lat: -3, lng: 0)

    XCTAssertEqual(TVMapFocusOrder.ordered([a, b, c]).map(\.id), ["a", "b", "c"])
    XCTAssertEqual(TVMapFocusOrder.ordered([c, b, a]).map(\.id), ["a", "b", "c"])
    XCTAssertEqual(TVMapFocusOrder.ordered([b, c, a]).map(\.id), ["a", "b", "c"])
  }

  func test_ordered_emptyInput_returnsEmpty() {
    XCTAssertTrue(TVMapFocusOrder.ordered([]).isEmpty)
  }

  // MARK: - defaultFocusTarget(_:)

  func test_defaultFocusTarget_isFirstInReadingOrder() {
    let items = [
      item(id: "south", lat: -10, lng: 0),
      item(id: "north", lat: 40, lng: 0),
    ]
    XCTAssertEqual(TVMapFocusOrder.defaultFocusTarget(items)?.id, "north")
  }

  func test_defaultFocusTarget_emptyInput_returnsNil() {
    XCTAssertNil(TVMapFocusOrder.defaultFocusTarget([]))
  }
}
