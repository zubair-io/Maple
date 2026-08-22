// DeepLinkParserSearchTests.swift — the `maple://search?…` destination
// (widget tap → seeded search). Values ride verbatim; whitelisting happens
// where SearchParams is built, so this only pins carriage and edge shapes.
import XCTest
@testable import MapleCore

final class DeepLinkParserSearchTests: XCTestCase {
  func test_search_carriesQueryPairs() {
    let url = URL(string: "maple://search?placeQuery=spring%20wedding&month=3&sceneType=indoor")!
    XCTAssertEqual(
      DeepLinkParser.parse(url),
      .search(query: ["placeQuery": "spring wedding", "month": "3", "sceneType": "indoor"])
    )
  }

  func test_search_withNoParams_isAnUnseededSearch() {
    XCTAssertEqual(DeepLinkParser.parse(URL(string: "maple://search")!), .search(query: [:]))
  }

  func test_search_dropsEmptyValues() {
    let url = URL(string: "maple://search?placeQuery=&month=8")!
    XCTAssertEqual(DeepLinkParser.parse(url), .search(query: ["month": "8"]))
  }

  func test_existingHosts_stillParse() {
    XCTAssertEqual(DeepLinkParser.parse(URL(string: "maple://image/abc")!), .image(id: "abc"))
    XCTAssertEqual(DeepLinkParser.parse(URL(string: "maple://source/a/b")!), .source(id: "a/b"))
  }
}
