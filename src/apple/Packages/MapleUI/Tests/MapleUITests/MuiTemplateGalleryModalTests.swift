import XCTest
@testable import MapleUI

final class MuiTemplateGalleryModalTests: XCTestCase {
    private let templates = [
        MuiGalleryTemplate(id: "1", name: "Moody Landscape", thumbnailUrl: nil, description: "Desaturated greens", category: "Landscape"),
        MuiGalleryTemplate(id: "2", name: "Portrait Warm", thumbnailUrl: nil, category: "Portrait"),
    ]

    func testFilteredReturnsAllWhenSearchBlank() {
        XCTAssertEqual(MuiTemplateGalleryModal.filtered(templates, search: "").count, 2)
    }

    func testFilteredMatchesNameCaseInsensitively() {
        let result = MuiTemplateGalleryModal.filtered(templates, search: "moody")
        XCTAssertEqual(result.map(\.id), ["1"])
    }

    func testFilteredMatchesDescriptionAndCategory() {
        XCTAssertEqual(MuiTemplateGalleryModal.filtered(templates, search: "greens").map(\.id), ["1"])
        XCTAssertEqual(MuiTemplateGalleryModal.filtered(templates, search: "portrait").map(\.id), ["2"])
    }

    func testFilteredEmptyWhenNoMatch() {
        XCTAssertTrue(MuiTemplateGalleryModal.filtered(templates, search: "nonexistent").isEmpty)
    }
}
