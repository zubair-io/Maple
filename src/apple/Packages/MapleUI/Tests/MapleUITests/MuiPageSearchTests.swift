import XCTest
@testable import MapleUI

final class MuiPageSearchTests: XCTestCase {
    private let corpus: [MuiPageSearchAsset] = [
        MuiPageSearchAsset(id: "1", item: MuiCollectionItem(id: "1", url: nil, alt: "A"), keywords: ["iceland", "glacier"], fileType: "raw"),
        MuiPageSearchAsset(id: "2", item: MuiCollectionItem(id: "2", url: nil, alt: "B"), keywords: ["faroe", "fog"], fileType: "jpg"),
        MuiPageSearchAsset(id: "3", item: MuiCollectionItem(id: "3", url: nil, alt: "C"), keywords: ["iceland", "coast"], fileType: "jpg"),
    ]

    func testEmptyQueryAndNoFiltersReturnsEverything() {
        XCTAssertEqual(MuiPageSearch.filteredResults(corpus, query: "", activeFileTypeIds: []).map(\.id), ["1", "2", "3"])
    }

    func testQueryNarrowsToMatchingKeywordsCaseInsensitively() {
        XCTAssertEqual(MuiPageSearch.filteredResults(corpus, query: "ICELAND", activeFileTypeIds: []).map(\.id), ["1", "3"])
    }

    func testFileTypeFilterNarrowsIndependentlyOfQuery() {
        XCTAssertEqual(MuiPageSearch.filteredResults(corpus, query: "", activeFileTypeIds: ["raw"]).map(\.id), ["1"])
    }

    func testQueryAndFileTypeFilterCombineWithAnd() {
        XCTAssertEqual(MuiPageSearch.filteredResults(corpus, query: "iceland", activeFileTypeIds: ["jpg"]).map(\.id), ["3"])
    }

    func testNoMatchesReturnsAnEmptyArray() {
        XCTAssertTrue(MuiPageSearch.filteredResults(corpus, query: "nonexistent", activeFileTypeIds: []).isEmpty)
    }
}
