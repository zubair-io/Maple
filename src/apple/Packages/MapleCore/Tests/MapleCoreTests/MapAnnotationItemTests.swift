// MapAnnotationItemTests.swift
//
// Pure `MapCluster` → `MapAnnotationItem` projection (#2830) — the
// "clustered annotations" grouping: `count == 1` cells with a `thumbKey`
// become a thumbnail pin, everything else becomes a count bubble. Also
// covers the pin-tap place-label fallback chain.

import XCTest
@testable import MapleCloudKit

final class MapAnnotationItemTests: XCTestCase {

  // MARK: - from(_:) / items(from:)

  func test_from_singleCountCellWithThumbKey_becomesThumbnail() {
    let cell = MapCluster(lat: 1, lng: 2, count: 1, representativeAssetId: "a1",
                          placeLabel: "Paris", thumbKey: "/photos/a.jpg")
    let item = MapAnnotationItem.from(cell)

    XCTAssertEqual(item.id, "a1")
    XCTAssertEqual(item.latitude, 1)
    XCTAssertEqual(item.longitude, 2)
    XCTAssertEqual(item.placeLabel, "Paris")
    XCTAssertEqual(item.kind, .thumbnail(assetID: "a1", thumbKey: "/photos/a.jpg"))
  }

  func test_from_multiCountCell_becomesClusterBubble() {
    let cell = MapCluster(lat: 1, lng: 2, count: 12, representativeAssetId: "a2")
    let item = MapAnnotationItem.from(cell)
    XCTAssertEqual(item.kind, .cluster(count: 12))
  }

  /// Defensive fallback: a `count == 1` cell that arrives without the
  /// `thumbKey` the server contract promises still renders as a bubble
  /// rather than crashing or being dropped.
  func test_from_singleCountCellMissingThumbKey_fallsBackToClusterOfOne() {
    let cell = MapCluster(lat: 1, lng: 2, count: 1, representativeAssetId: "a3")
    let item = MapAnnotationItem.from(cell)
    XCTAssertEqual(item.kind, .cluster(count: 1))
  }

  func test_itemsFrom_preservesOrderAndProjectsEachCell() {
    let cells = [
      MapCluster(lat: 1, lng: 1, count: 1, representativeAssetId: "a", thumbKey: "/a.jpg"),
      MapCluster(lat: 2, lng: 2, count: 5, representativeAssetId: "b"),
      MapCluster(lat: 3, lng: 3, count: 1, representativeAssetId: "c", thumbKey: "/c.jpg"),
    ]
    let items = MapAnnotationItem.items(from: cells)

    XCTAssertEqual(items.map(\.id), ["a", "b", "c"])
    XCTAssertEqual(items[0].kind, .thumbnail(assetID: "a", thumbKey: "/a.jpg"))
    XCTAssertEqual(items[1].kind, .cluster(count: 5))
    XCTAssertEqual(items[2].kind, .thumbnail(assetID: "c", thumbKey: "/c.jpg"))
  }

  // MARK: - searchTarget fallback chain

  func test_searchTarget_realLabel_isTrimmedPlaceQuery() {
    XCTAssertEqual(MapAnnotationItem.searchTarget(placeLabel: " Paris "), .placeQuery("Paris"))
  }

  func test_searchTarget_nilLabel_fallsBackToHasLocationScope() {
    XCTAssertEqual(MapAnnotationItem.searchTarget(placeLabel: nil), .hasLocationScope)
  }

  func test_searchTarget_emptyLabel_fallsBackToHasLocationScope() {
    XCTAssertEqual(MapAnnotationItem.searchTarget(placeLabel: ""), .hasLocationScope)
  }

  func test_searchTarget_whitespaceOnlyLabel_fallsBackToHasLocationScope() {
    XCTAssertEqual(MapAnnotationItem.searchTarget(placeLabel: "   "), .hasLocationScope)
  }

  func test_searchTargetProperty_mirrorsStaticFallback() {
    let withLabel = MapAnnotationItem(id: "a", latitude: 0, longitude: 0,
                                      kind: .cluster(count: 2), placeLabel: "Tokyo")
    XCTAssertEqual(withLabel.searchTarget, .placeQuery("Tokyo"))

    let withoutLabel = MapAnnotationItem(id: "b", latitude: 0, longitude: 0,
                                         kind: .cluster(count: 2), placeLabel: nil)
    XCTAssertEqual(withoutLabel.searchTarget, .hasLocationScope)
  }
}
