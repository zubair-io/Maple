import XCTest
@testable import MapleUI

final class MuiToolbarSplitTests: XCTestCase {
    private func item(_ id: String) -> MuiToolbarEntry {
        .item(MuiToolbarActionItem(id: id, icon: "star", label: id))
    }

    func testUnderBudgetEverythingStaysVisible() {
        let entries = [item("a"), item("b")]
        let split = MuiToolbar.split(entries: entries, maxVisible: 5)
        XCTAssertEqual(split.visible.count, 2)
        XCTAssertTrue(split.overflow.isEmpty)
    }

    func testOverBudgetMovesTheRestToOverflow() {
        let entries = [item("a"), item("b"), item("c"), item("d")]
        let split = MuiToolbar.split(entries: entries, maxVisible: 2)
        XCTAssertEqual(split.visible.count, 2)
        XCTAssertEqual(split.overflow.map(\.id), ["c", "d"])
    }

    func testDividerBeforeOverflowStartsStaysVisible() {
        let entries = [item("a"), .divider, item("b"), item("c")]
        let split = MuiToolbar.split(entries: entries, maxVisible: 1)
        // "a" fills the budget; the divider is still emitted since overflow
        // hasn't started yet; "b" and "c" both overflow.
        XCTAssertEqual(split.visible.count, 2)
        XCTAssertEqual(split.overflow.map(\.id), ["b", "c"])
    }

    func testTrailingDividerAfterOverflowStartsIsDropped() {
        let entries = [item("a"), item("b"), .divider, item("c")]
        let split = MuiToolbar.split(entries: entries, maxVisible: 1)
        // "a" fills the budget; "b" overflows, so the divider after it adds
        // nothing to either list; "c" also overflows.
        XCTAssertEqual(split.visible.count, 1)
        XCTAssertEqual(split.overflow.map(\.id), ["b", "c"])
    }
}
