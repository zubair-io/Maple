import XCTest
@testable import MapleUI

final class MuiCollectionGridTests: XCTestCase {
    private let ids = ["a", "b", "c", "d", "e"]

    func testPlainClickReplacesSelectionAndReanchors() {
        let result = MuiCollectionGrid.selectionAfterClick(
            orderedIds: ids, current: ["a", "b"], anchor: "a", tapped: "c", shift: false, commandOrControl: false
        )
        XCTAssertEqual(result.selection, ["c"])
        XCTAssertEqual(result.anchor, "c")
    }

    func testCommandClickTogglesJustTheTappedItemAndKeepsTheAnchor() {
        let addResult = MuiCollectionGrid.selectionAfterClick(
            orderedIds: ids, current: ["a"], anchor: "a", tapped: "c", shift: false, commandOrControl: true
        )
        XCTAssertEqual(addResult.selection, ["a", "c"])
        XCTAssertEqual(addResult.anchor, "a")

        let removeResult = MuiCollectionGrid.selectionAfterClick(
            orderedIds: ids, current: ["a", "c"], anchor: "a", tapped: "c", shift: false, commandOrControl: true
        )
        XCTAssertEqual(removeResult.selection, ["a"])
    }

    func testShiftClickSelectsTheContiguousRangeFromTheAnchor() {
        let forward = MuiCollectionGrid.selectionAfterClick(
            orderedIds: ids, current: ["a"], anchor: "a", tapped: "d", shift: true, commandOrControl: false
        )
        XCTAssertEqual(forward.selection, ["a", "b", "c", "d"])
        XCTAssertEqual(forward.anchor, "a")

        let backward = MuiCollectionGrid.selectionAfterClick(
            orderedIds: ids, current: ["d"], anchor: "d", tapped: "b", shift: true, commandOrControl: false
        )
        XCTAssertEqual(backward.selection, ["b", "c", "d"])
    }

    func testShiftClickWithNoAnchorFallsBackToAPlainSingleSelect() {
        let result = MuiCollectionGrid.selectionAfterClick(
            orderedIds: ids, current: ["a"], anchor: nil, tapped: "c", shift: true, commandOrControl: false
        )
        XCTAssertEqual(result.selection, ["c"])
        XCTAssertEqual(result.anchor, "c")
    }

    func testShiftClickWithAStaleAnchorNoLongerInTheListFallsBackToAPlainSingleSelect() {
        let result = MuiCollectionGrid.selectionAfterClick(
            orderedIds: ids, current: [], anchor: "stale", tapped: "c", shift: true, commandOrControl: false
        )
        XCTAssertEqual(result.selection, ["c"])
    }

    func testDragStartPromotesAnUnselectedItemToAOneItemSelection() {
        XCTAssertEqual(MuiCollectionGrid.selectionAfterDragStart(current: ["a", "b"], draggedId: "c"), ["c"])
    }

    func testDragStartLeavesAnAlreadySelectedItemsSelectionUntouched() {
        XCTAssertEqual(MuiCollectionGrid.selectionAfterDragStart(current: ["a", "b"], draggedId: "b"), ["a", "b"])
    }
}
