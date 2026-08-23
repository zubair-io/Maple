import XCTest
@testable import MapleUI

final class MuiDragBarTests: XCTestCase {
    func testClickJumpsToPositionProportionally() {
        // 150/200 = 75% of a [-100, 100] range -> value 50.
        let value = MuiDragBar.valueAtPosition(x: 150, barWidth: 200, range: -100...100, step: 1)
        XCTAssertEqual(value, 50)
    }

    func testCenterPositionIsZero() {
        let value = MuiDragBar.valueAtPosition(x: 100, barWidth: 200, range: -100...100, step: 1)
        XCTAssertEqual(value, 0)
    }

    func testLeftEdgeIsMinimum() {
        let value = MuiDragBar.valueAtPosition(x: 0, barWidth: 200, range: -100...100, step: 1)
        XCTAssertEqual(value, -100)
    }

    func testValueSnapsToStep() {
        let value = MuiDragBar.valueAtPosition(x: 103, barWidth: 200, range: -100...100, step: 5)
        // 103/200 = 51.5% -> raw value 3 -> snapped to nearest multiple of 5 -> 5.
        XCTAssertEqual(value, 5)
    }

    func testZeroWidthBarReturnsRangeMinimum() {
        let value = MuiDragBar.valueAtPosition(x: 50, barWidth: 0, range: -100...100, step: 1)
        XCTAssertEqual(value, -100)
    }
}
