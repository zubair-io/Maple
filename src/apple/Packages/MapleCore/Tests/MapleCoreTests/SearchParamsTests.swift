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
    p.sort = .name          // nor is sort
    XCTAssertFalse(p.hasActiveFilters)
    p.rating = 3
    XCTAssertTrue(p.hasActiveFilters)
  }
}
