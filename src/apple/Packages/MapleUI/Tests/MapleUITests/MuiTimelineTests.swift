import XCTest
@testable import MapleUI

final class MuiTimelineTests: XCTestCase {
    func testVisibleRowsFloorsAtOneForAnEmptyGroup() {
        XCTAssertEqual(MuiTimeline.visibleRows(itemCount: 0, columns: 4), 1)
    }

    func testVisibleRowsRoundsUpToTheNearestFullRow() {
        // 9 items over 4 columns is 2.25 rows, rounded up to 3.
        XCTAssertEqual(MuiTimeline.visibleRows(itemCount: 9, columns: 4), 3)
    }

    func testVisibleRowsClampsAtTheMaximum() {
        XCTAssertEqual(MuiTimeline.visibleRows(itemCount: 400, columns: 4), MuiTimeline.maxVisibleRows)
    }

    func testVisibleRowsWithZeroColumnsStaysAtOneRatherThanDividingByZero() {
        XCTAssertEqual(MuiTimeline.visibleRows(itemCount: 12, columns: 0), 1)
    }

    func testVisibleRowsAnExactMultipleOfColumnsDoesNotOverRound() {
        XCTAssertEqual(MuiTimeline.visibleRows(itemCount: 8, columns: 4), 2)
    }
}
