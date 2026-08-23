import XCTest
@testable import MapleUI

final class MuiFilterPanelTests: XCTestCase {
    private let group = MuiFilterGroup(
        id: "camera",
        label: "Camera",
        options: [
            MuiFilterOption(id: "a7", label: "Sony A7 IV", checked: false),
            MuiFilterOption(id: "x100", label: "Fujifilm X100V", checked: false),
        ],
        searchable: true
    )

    private let nonSearchable = MuiFilterGroup(
        id: "type",
        label: "File Type",
        options: [MuiFilterOption(id: "raw", label: "RAW", checked: true)],
        searchable: false
    )

    func testVisibleOptionsWithAnEmptyDraftShowsEverything() {
        XCTAssertEqual(MuiFilterPanel.visibleOptions(group, draft: "").map(\.id), ["a7", "x100"])
    }

    func testVisibleOptionsFiltersCaseInsensitivelyOnTheLabel() {
        XCTAssertEqual(MuiFilterPanel.visibleOptions(group, draft: "sony").map(\.id), ["a7"])
    }

    func testVisibleOptionsWithAWhitespaceOnlyDraftShowsEverything() {
        XCTAssertEqual(MuiFilterPanel.visibleOptions(group, draft: "   ").map(\.id), ["a7", "x100"])
    }

    func testVisibleOptionsOnANonSearchableGroupIgnoresTheDraftEntirely() {
        XCTAssertEqual(MuiFilterPanel.visibleOptions(nonSearchable, draft: "zzz").map(\.id), ["raw"])
    }

    func testVisibleOptionsWithNoMatchesReturnsAnEmptyList() {
        XCTAssertTrue(MuiFilterPanel.visibleOptions(group, draft: "zzz").isEmpty)
    }
}
