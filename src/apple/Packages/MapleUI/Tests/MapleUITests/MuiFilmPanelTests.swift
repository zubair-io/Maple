import XCTest
@testable import MapleUI

final class MuiFilmPanelTests: XCTestCase {
    private let looks: [MuiFilmLook] = [
        MuiFilmLook(id: "kodak", name: "Kodak Gold", url: nil, category: "film"),
        MuiFilmLook(id: "portra", name: "Portra 400", url: nil, category: "film"),
        MuiFilmLook(id: "flat", name: "Flat Digital", url: nil, category: "digital"),
    ]

    func testVisibleLooksWithNoActiveCategoryShowsEverything() {
        XCTAssertEqual(MuiFilmPanel.visibleLooks(looks, activeCategoryId: nil).map(\.id), ["kodak", "portra", "flat"])
    }

    func testVisibleLooksWithAnActiveCategoryFiltersToThatCategory() {
        XCTAssertEqual(MuiFilmPanel.visibleLooks(looks, activeCategoryId: "digital").map(\.id), ["flat"])
    }

    func testVisibleLooksWithACategoryThatMatchesNothingReturnsAnEmptyList() {
        XCTAssertTrue(MuiFilmPanel.visibleLooks(looks, activeCategoryId: "missing").isEmpty)
    }
}
