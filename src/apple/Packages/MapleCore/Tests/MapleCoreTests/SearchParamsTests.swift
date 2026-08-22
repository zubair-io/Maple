// SearchParamsTests.swift
//
// Verifies SearchParams serialises to the exact `GET /api/search` query
// contract the web app uses (paramsFrom in search.service.ts): correct
// param names, enum raw values, comma-joined lists, tri-state booleans,
// and the nil/empty skip rules.

import XCTest
@testable import MapleCore

final class SearchParamsTests: XCTestCase {

  /// Collapse [URLQueryItem] into a name→value dictionary for assertions.
  private func dict(_ items: [URLQueryItem]) -> [String: String] {
    Dictionary(uniqueKeysWithValues: items.map { ($0.name, $0.value ?? "") })
  }

  func test_facetItems_emptyParams_onlyLibraryId() {
    var p = SearchParams(libraryID: "lib-1")
    p.q = ""   // empty → omitted
    let d = dict(p.facetQueryItems())
    XCTAssertEqual(d, ["libraryId": "lib-1"])
    // Facets never carry sort / page / limit.
    XCTAssertNil(d["sort"])
    XCTAssertNil(d["page"])
    XCTAssertNil(d["limit"])
  }

  func test_listItems_addSortPageLimit() {
    let p = SearchParams(libraryID: "lib-1")
    let d = dict(p.listQueryItems(page: 2, limit: 50))
    XCTAssertEqual(d["libraryId"], "lib-1")
    XCTAssertEqual(d["sort"], "captured_desc")
    XCTAssertEqual(d["page"], "2")
    XCTAssertEqual(d["limit"], "50")
  }

  func test_fullParams_serialiseToWireContract() {
    var p = SearchParams(libraryID: "lib-1")
    p.q = "sunset"
    p.camera = "X-T5"
    p.lens = "XF 35mm"
    p.isoMin = 100
    p.isoMax = 6400
    p.apertureMin = 2.8
    p.apertureMax = 11
    p.focalMin = 35
    p.focalMax = 50
    p.from = "2024-01-01"
    p.to = "2024-12-31"
    p.rating = 4
    p.flag = .pick
    p.color = .red
    p.ext = ["dng", "cr3"]
    p.sceneType = .outdoor
    p.activity = "hiking"
    p.subjects = ["mountain", "lake"]
    p.isScreenshot = false
    p.hasCapturedAt = true
    p.sort = .rating

    let d = dict(p.listQueryItems(page: 0, limit: 100))

    XCTAssertEqual(d["q"], "sunset")
    XCTAssertEqual(d["camera"], "X-T5")
    XCTAssertEqual(d["lens"], "XF 35mm")
    XCTAssertEqual(d["isoMin"], "100")
    XCTAssertEqual(d["isoMax"], "6400")
    XCTAssertEqual(d["apertureMin"], "2.8")
    // Whole-number doubles serialise without a trailing ".0".
    XCTAssertEqual(d["apertureMax"], "11")
    XCTAssertEqual(d["focalMin"], "35")
    XCTAssertEqual(d["focalMax"], "50")
    XCTAssertEqual(d["from"], "2024-01-01")
    XCTAssertEqual(d["to"], "2024-12-31")
    XCTAssertEqual(d["rating"], "4")
    XCTAssertEqual(d["flag"], "pick")
    XCTAssertEqual(d["color"], "red")
    XCTAssertEqual(d["ext"], "dng,cr3")
    XCTAssertEqual(d["sceneType"], "outdoor")
    XCTAssertEqual(d["activity"], "hiking")
    XCTAssertEqual(d["subjects"], "mountain,lake")
    XCTAssertEqual(d["isScreenshot"], "false")
    XCTAssertEqual(d["hasCapturedAt"], "true")
    XCTAssertEqual(d["sort"], "rating")
  }

  func test_placeQuery_serialisesAlongsideQ() {
    var p = SearchParams(libraryID: "lib-1")
    p.placeQuery = "boy playing ball"
    let d = dict(p.facetQueryItems())
    XCTAssertEqual(d["placeQuery"], "boy playing ball")
    // q stays empty/omitted — the main search box drives placeQuery, not q.
    XCTAssertNil(d["q"])
  }

  func test_placeQuery_emptyOmitted() {
    var p = SearchParams(libraryID: "lib-1")
    p.placeQuery = ""
    XCTAssertNil(dict(p.facetQueryItems())["placeQuery"])
  }

  func test_isScreenshot_triState() {
    var p = SearchParams()
    // nil → omitted entirely (both photos & screenshots).
    XCTAssertNil(dict(p.facetQueryItems())["isScreenshot"])
    p.isScreenshot = true
    XCTAssertEqual(dict(p.facetQueryItems())["isScreenshot"], "true")
    p.isScreenshot = false
    XCTAssertEqual(dict(p.facetQueryItems())["isScreenshot"], "false")
  }

  func test_emptyCollectionsOmitted() {
    var p = SearchParams()
    p.ext = []
    p.subjects = []
    let d = dict(p.facetQueryItems())
    XCTAssertNil(d["ext"])
    XCTAssertNil(d["subjects"])
  }

  func test_hasActiveFilters() {
    var p = SearchParams(libraryID: "lib-1")
    p.q = "anything"        // q is not a "structured" filter
    p.placeQuery = "a dog"  // nor is the main-box content query
    p.sort = .name          // nor is sort
    XCTAssertFalse(p.hasActiveFilters)
    p.rating = 3
    XCTAssertTrue(p.hasActiveFilters)
  }

  // MARK: - Unified filters (#2866)

  func test_people_serialisesCommaJoined_onListAndFacetItems() {
    var p = SearchParams(libraryID: "lib-1")
    p.people = ["Priya Patel", "Sam Ochoa"]
    XCTAssertEqual(dict(p.listQueryItems(page: 0, limit: 100))["people"],
                   "Priya Patel,Sam Ochoa")
    XCTAssertEqual(dict(p.facetQueryItems())["people"], "Priya Patel,Sam Ochoa")
  }

  func test_place_serialisesPipeJoined_onListAndFacetItems() {
    // Pipe-joined because place labels themselves contain commas.
    var p = SearchParams(libraryID: "lib-1")
    p.place = ["Portland, OR", "Kyoto"]
    XCTAssertEqual(dict(p.listQueryItems(page: 0, limit: 100))["place"],
                   "Portland, OR|Kyoto")
    XCTAssertEqual(dict(p.facetQueryItems())["place"], "Portland, OR|Kyoto")
  }

  func test_peopleAndPlace_omittedWhenEmpty() {
    let p = SearchParams(libraryID: "lib-1")
    let d = dict(p.listQueryItems(page: 0, limit: 100))
    XCTAssertNil(d["people"])
    XCTAssertNil(d["place"])
  }

  func test_peopleAndPlace_countAsActiveFilters() {
    var p = SearchParams(libraryID: "lib-1")
    XCTAssertFalse(p.hasActiveFilters)
    p.people = ["Priya Patel"]
    XCTAssertTrue(p.hasActiveFilters)
    p.people = []
    p.place = ["Kyoto"]
    XCTAssertTrue(p.hasActiveFilters)
  }

  func test_hasUnifiedFilters_dateOrPeopleOrPlace() {
    var p = SearchParams(libraryID: "lib-1")
    p.placeQuery = "sunset"   // free text is not a filter
    XCTAssertFalse(p.hasUnifiedFilters)
    p.from = "2026-01-01"
    XCTAssertTrue(p.hasUnifiedFilters)
    p.from = nil
    p.to = "2026-12-31"
    XCTAssertTrue(p.hasUnifiedFilters)
    p.to = nil
    p.people = ["Priya Patel"]
    XCTAssertTrue(p.hasUnifiedFilters)
    p.people = []
    p.place = ["Portland, OR"]
    XCTAssertTrue(p.hasUnifiedFilters)
  }

  func test_unifiedFilterCount_dateCountsOnce() {
    var p = SearchParams(libraryID: "lib-1")
    XCTAssertEqual(p.unifiedFilterCount, 0)
    p.from = "2026-01-01"
    p.to = "2026-12-31"
    XCTAssertEqual(p.unifiedFilterCount, 1, "from+to is one date-range filter")
    p.people = ["Priya Patel", "Sam Ochoa"]
    p.place = ["Kyoto"]
    XCTAssertEqual(p.unifiedFilterCount, 4)
  }

  func test_scope_serialisesWhenSet() {
    var p = SearchParams(libraryID: "lib-1")
    p.scope = "places"
    let d = dict(p.listQueryItems(page: 0, limit: 100))
    XCTAssertEqual(d["scope"], "places")
  }

  func test_scope_omittedWhenNilOrEmpty() {
    var p = SearchParams(libraryID: "lib-1")
    XCTAssertNil(dict(p.listQueryItems(page: 0, limit: 100))["scope"])
    p.scope = ""
    XCTAssertNil(dict(p.listQueryItems(page: 0, limit: 100))["scope"])
  }
}

extension SearchParamsTests {
  /// Pins the `month` wire name (#2715) and the nil-omitted skip rule.
  func test_month_serialisesAndOmitsWhenNil() {
    var p = SearchParams(libraryID: "lib1")
    XCTAssertNil(dict(p.listQueryItems(page: 0, limit: 100))["month"])
    p.month = 8
    XCTAssertEqual(dict(p.listQueryItems(page: 0, limit: 100))["month"], "8")
  }
}
