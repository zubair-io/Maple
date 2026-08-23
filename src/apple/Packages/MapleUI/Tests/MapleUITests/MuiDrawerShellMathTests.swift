import XCTest
@testable import MapleUI

final class MuiDrawerShellMathTests: XCTestCase {
    // MARK: closingSign

    func testClosingSignForLeftIsNegative() {
        XCTAssertEqual(MuiDrawerShellMath.closingSign(edge: .left), -1)
    }

    func testClosingSignForRightIsPositive() {
        XCTAssertEqual(MuiDrawerShellMath.closingSign(edge: .right), 1)
    }

    // MARK: closingDelta

    func testLeftDrawerClosingDragIsNegativeDx() {
        XCTAssertEqual(MuiDrawerShellMath.closingDelta(rawDx: -80, edge: .left), -80)
    }

    func testLeftDrawerOpeningDragIsIgnored() {
        // Dragging rightward (positive dx) on a left-edge drawer is the
        // "wrong way" — a no-op, matching the web reference.
        XCTAssertEqual(MuiDrawerShellMath.closingDelta(rawDx: 80, edge: .left), 0)
    }

    func testRightDrawerClosingDragIsPositiveDx() {
        XCTAssertEqual(MuiDrawerShellMath.closingDelta(rawDx: 80, edge: .right), 80)
    }

    func testRightDrawerOpeningDragIsIgnored() {
        XCTAssertEqual(MuiDrawerShellMath.closingDelta(rawDx: -80, edge: .right), 0)
    }

    // MARK: isDismissed

    func testNotDismissedBelowThreshold() {
        // dismissFraction is 0.3, so 30% of 320 = 96.
        XCTAssertFalse(MuiDrawerShellMath.isDismissed(dx: 50, width: 320))
    }

    func testDismissedAtExactThreshold() {
        XCTAssertTrue(MuiDrawerShellMath.isDismissed(dx: 96, width: 320))
    }

    func testDismissedUsesAbsoluteValue() {
        XCTAssertTrue(MuiDrawerShellMath.isDismissed(dx: -96, width: 320))
    }

    func testNotDismissedForZeroWidthPanel() {
        XCTAssertFalse(MuiDrawerShellMath.isDismissed(dx: 1000, width: 0))
    }
}
