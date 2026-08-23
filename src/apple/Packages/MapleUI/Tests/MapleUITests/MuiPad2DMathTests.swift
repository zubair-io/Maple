import XCTest
@testable import MapleUI

final class MuiPad2DMathTests: XCTestCase {
    func testTopLeftCornerIsMinusXPlusY() {
        let result = MuiPad2DMath.value(fracX: 0, fracY: 0)
        XCTAssertEqual(result.x, -1)
        XCTAssertEqual(result.y, 1)
    }

    func testBottomRightCornerIsPlusXMinusY() {
        let result = MuiPad2DMath.value(fracX: 1, fracY: 1)
        XCTAssertEqual(result.x, 1)
        XCTAssertEqual(result.y, -1)
    }

    func testCenterIsOrigin() {
        let result = MuiPad2DMath.value(fracX: 0.5, fracY: 0.5)
        XCTAssertEqual(result.x, 0)
        XCTAssertEqual(result.y, 0)
    }

    func testValueClampsOutOfBoundsFractions() {
        let result = MuiPad2DMath.value(fracX: 1.5, fracY: -0.5)
        XCTAssertEqual(result.x, 1)
        XCTAssertEqual(result.y, 1)
    }

    func testPuckPositionIsInverseOfValue() {
        let puck = MuiPad2DMath.puckPosition(x: -1, y: 1)
        XCTAssertEqual(puck.leftPct, 0)
        XCTAssertEqual(puck.topPct, 0)

        let puck2 = MuiPad2DMath.puckPosition(x: 1, y: -1)
        XCTAssertEqual(puck2.leftPct, 100)
        XCTAssertEqual(puck2.topPct, 100)
    }
}
