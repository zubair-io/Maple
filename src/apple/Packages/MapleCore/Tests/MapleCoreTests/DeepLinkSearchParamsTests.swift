// DeepLinkSearchParamsTests.swift — #3163
//
// `SearchParams.fromDeepLinkQuery(_:)` is the widget's `maple://search?…`
// whitelist parser: raw query pairs (already carried verbatim by
// `DeepLinkParser`, see `DeepLinkParserSearchTests`) become the `SearchParams`
// both the phone Search tab and the mac/iPad search overlay seed from.
import XCTest
@testable import MapleCore

final class DeepLinkSearchParamsTests: XCTestCase {
  func test_placeQuery_carriesVerbatim() {
    let params = SearchParams.fromDeepLinkQuery(["placeQuery": "spring wedding"])
    XCTAssertEqual(params.placeQuery, "spring wedding")
  }

  func test_missingPlaceQuery_isEmptyString() {
    let params = SearchParams.fromDeepLinkQuery([:])
    XCTAssertEqual(params.placeQuery, "")
  }

  func test_validDateRange_carried() {
    let params = SearchParams.fromDeepLinkQuery(["from": "2026-06-01", "to": "2026-06-30"])
    XCTAssertEqual(params.from, "2026-06-01")
    XCTAssertEqual(params.to, "2026-06-30")
  }

  func test_malformedDates_dropped() {
    let params = SearchParams.fromDeepLinkQuery(["from": "June 2026", "to": "2026-13-40"])
    // "2026-13-40" matches the bare \d{4}-\d{2}-\d{2} shape check (this
    // builder validates SHAPE, not calendar validity — the server widens
    // and validates bare dates itself), so only the non-shaped "from" drops.
    XCTAssertNil(params.from)
    XCTAssertEqual(params.to, "2026-13-40")
  }

  func test_validMonth_carried() {
    let params = SearchParams.fromDeepLinkQuery(["month": "12"])
    XCTAssertEqual(params.month, 12)
  }

  func test_outOfRangeMonth_dropped() {
    XCTAssertNil(SearchParams.fromDeepLinkQuery(["month": "0"]).month)
    XCTAssertNil(SearchParams.fromDeepLinkQuery(["month": "13"]).month)
  }

  func test_nonNumericMonth_dropped() {
    XCTAssertNil(SearchParams.fromDeepLinkQuery(["month": "june"]).month)
  }

  func test_validSceneType_carried() {
    let params = SearchParams.fromDeepLinkQuery(["sceneType": "aerial"])
    XCTAssertEqual(params.sceneType, .aerial)
  }

  func test_unknownSceneType_dropped() {
    XCTAssertNil(SearchParams.fromDeepLinkQuery(["sceneType": "underwater"]).sceneType)
  }

  func test_people_splitCommaTrimmedAndFiltered() {
    let params = SearchParams.fromDeepLinkQuery(["people": "Priya Patel, Sam Ochoa,  , "])
    XCTAssertEqual(params.people, ["Priya Patel", "Sam Ochoa"])
  }

  func test_missingPeople_isEmptyArray() {
    XCTAssertEqual(SearchParams.fromDeepLinkQuery([:]).people, [])
  }

  func test_libraryIdNotReadByThisBuilder() {
    // The caller resolves + forces `libraryID` itself (see
    // `AppShell+DeepLink.swift`'s `navigateToSearch` and
    // `AppShell+CloudActions.swift`'s `activateSearch(server:libraryID:params:)`)
    // — a raw `libraryId` pair here has no effect.
    let params = SearchParams.fromDeepLinkQuery(["libraryId": "abc123"])
    XCTAssertNil(params.libraryID)
  }

  func test_fullCollection_allFieldsSeed() {
    let params = SearchParams.fromDeepLinkQuery([
      "placeQuery": "spring wedding",
      "from": "2026-04-01",
      "to": "2026-04-30",
      "month": "4",
      "sceneType": "outdoor",
      "people": "Priya Patel,Sam Ochoa",
    ])
    XCTAssertEqual(params.placeQuery, "spring wedding")
    XCTAssertEqual(params.from, "2026-04-01")
    XCTAssertEqual(params.to, "2026-04-30")
    XCTAssertEqual(params.month, 4)
    XCTAssertEqual(params.sceneType, .outdoor)
    XCTAssertEqual(params.people, ["Priya Patel", "Sam Ochoa"])
  }
}
