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

  // MARK: - MapPlaceSearchTarget.apply(to:) — shared by every Apple map
  // surface's pin-tap → search wiring (macOS/iOS's `selectMapPlace`, #2830;
  // tvOS's `TVMapScreen.activate(_:)`, #2833).

  func test_apply_placeQuery_setsPlaceQueryAndLeavesScopeUntouched() {
    var params = SearchParams(libraryID: "lib-1")
    params.scope = "people" // pre-existing filter must survive untouched.
    MapPlaceSearchTarget.placeQuery("Kyoto").apply(to: &params)

    XCTAssertEqual(params.placeQuery, "Kyoto")
    XCTAssertEqual(params.scope, "people")
    XCTAssertEqual(params.libraryID, "lib-1", "the caller's existing filter must be narrowed, not discarded")
  }

  func test_apply_hasLocationScope_setsPlacesScopeAndLeavesPlaceQueryUntouched() {
    var params = SearchParams(libraryID: "lib-1")
    params.placeQuery = "stale text"
    MapPlaceSearchTarget.hasLocationScope.apply(to: &params)

    XCTAssertEqual(params.scope, "places")
    XCTAssertEqual(params.placeQuery, "stale text")
  }

  /// End-to-end fallback chain from a raw cell straight through to the
  /// `SearchParams` a pin/cluster selection would submit: a cell with no
  /// place data lands on the has-GPS scope, not a no-op.
  func test_fallbackChain_cellWithoutPlaceLabel_resolvesToHasLocationScope() {
    let cell = MapCluster(lat: 1, lng: 2, count: 3, representativeAssetId: "a4")
    let item = MapAnnotationItem.from(cell)
    var params = SearchParams()
    item.searchTarget.apply(to: &params)

    XCTAssertEqual(params.scope, "places")
    XCTAssertEqual(params.placeQuery, "")
  }

  func test_fallbackChain_cellWithPlaceLabel_resolvesToPlaceQuery() {
    let cell = MapCluster(lat: 1, lng: 2, count: 3, representativeAssetId: "a5", placeLabel: "Nairobi")
    let item = MapAnnotationItem.from(cell)
    var params = SearchParams()
    item.searchTarget.apply(to: &params)

    XCTAssertEqual(params.placeQuery, "Nairobi")
    XCTAssertNil(params.scope)
  }

  // MARK: - MapPlaceSearchTarget.searchParams(seededFrom:) — the pure
  // composition `AppShell+Map.swift`'s `selectMapPlace` hands straight to
  // `activateSearch(server:libraryID:params:)` (#2886). Before #2886,
  // `selectMapPlace` hand-built its own `SearchViewModel` / clients; this
  // is the part of that duplicated logic that's actually testable outside
  // the app target — the shared-path refactor's behavioural contract.

  func test_searchParamsSeededFrom_placeQueryTarget_appliesPlaceAndPreservesFilter() {
    var filter = SearchParams(libraryID: nil)
    filter.camera = "Hasselblad"
    filter.rating = 4
    filter.from = "2026-01-01"

    let params = MapPlaceSearchTarget.placeQuery("Kyoto").searchParams(seededFrom: filter)

    XCTAssertEqual(params.placeQuery, "Kyoto")
    XCTAssertNil(params.libraryID, "map search is account-wide, same scope as the map itself")
    XCTAssertEqual(params.camera, "Hasselblad", "the map's active filter must be narrowed, not discarded")
    XCTAssertEqual(params.rating, 4)
    XCTAssertEqual(params.from, "2026-01-01")
  }

  func test_searchParamsSeededFrom_hasLocationScopeTarget_appliesScopeAndPreservesFilter() {
    var filter = SearchParams(libraryID: nil)
    filter.lens = "70-200mm"
    filter.flag = .pick

    let params = MapPlaceSearchTarget.hasLocationScope.searchParams(seededFrom: filter)

    XCTAssertEqual(params.scope, "places")
    XCTAssertNil(params.libraryID)
    XCTAssertEqual(params.lens, "70-200mm")
    XCTAssertEqual(params.flag, .pick)
  }

  func test_searchParamsSeededFrom_doesNotMutateTheSeedFilter() {
    let filter = SearchParams(libraryID: nil)
    _ = MapPlaceSearchTarget.placeQuery("Lisbon").searchParams(seededFrom: filter)

    XCTAssertEqual(filter.placeQuery, "", "seededFrom takes filter by value — the caller's mapVM.filter must be untouched")
  }
}
