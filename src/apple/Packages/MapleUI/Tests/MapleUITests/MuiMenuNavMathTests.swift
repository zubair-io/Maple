import XCTest
@testable import MapleUI

final class MuiMenuNavMathTests: XCTestCase {
    // MARK: moveActive (context-menu style)

    func testMoveActiveFromNilForwardEntersAtFirstSelectable() {
        XCTAssertEqual(MuiMenuNavMath.moveActive(current: nil, direction: 1, selectable: [1, 3, 4]), 1)
    }

    func testMoveActiveFromNilBackwardEntersAtLastSelectable() {
        XCTAssertEqual(MuiMenuNavMath.moveActive(current: nil, direction: -1, selectable: [1, 3, 4]), 4)
    }

    func testMoveActiveForwardWrapsToFirst() {
        XCTAssertEqual(MuiMenuNavMath.moveActive(current: 4, direction: 1, selectable: [1, 3, 4]), 1)
    }

    func testMoveActiveBackwardWrapsToLast() {
        XCTAssertEqual(MuiMenuNavMath.moveActive(current: 1, direction: -1, selectable: [1, 3, 4]), 4)
    }

    func testMoveActiveSkipsNonSelectableIndices() {
        // 2 is disabled/a divider and never appears in `selectable`.
        XCTAssertEqual(MuiMenuNavMath.moveActive(current: 1, direction: 1, selectable: [1, 3, 4]), 3)
    }

    func testMoveActiveWithEmptySelectableReturnsCurrentUnchanged() {
        XCTAssertNil(MuiMenuNavMath.moveActive(current: nil, direction: 1, selectable: []))
        XCTAssertEqual(MuiMenuNavMath.moveActive(current: 2, direction: 1, selectable: []), 2)
    }

    // MARK: wrappedIndex (suggestion/command-menu style)

    func testWrappedIndexForwardWraps() {
        XCTAssertEqual(MuiMenuNavMath.wrappedIndex(current: 2, direction: 1, count: 3), 0)
    }

    func testWrappedIndexBackwardWraps() {
        XCTAssertEqual(MuiMenuNavMath.wrappedIndex(current: 0, direction: -1, count: 3), 2)
    }

    func testWrappedIndexMidRangeSteps() {
        XCTAssertEqual(MuiMenuNavMath.wrappedIndex(current: 1, direction: 1, count: 3), 2)
    }

    func testWrappedIndexZeroCountReturnsZero() {
        XCTAssertEqual(MuiMenuNavMath.wrappedIndex(current: 0, direction: 1, count: 0), 0)
    }

    // MARK: clampedIndex (command-menu style)

    func testClampedIndexWithinRangePassesThrough() {
        XCTAssertEqual(MuiMenuNavMath.clampedIndex(1, count: 5), 1)
    }

    func testClampedIndexPastEndClampsToLast() {
        XCTAssertEqual(MuiMenuNavMath.clampedIndex(9, count: 3), 2)
    }

    func testClampedIndexEmptyReturnsNegativeOne() {
        XCTAssertEqual(MuiMenuNavMath.clampedIndex(0, count: 0), -1)
    }
}
