import XCTest
@testable import MapleUI

final class MuiSheetShellMathTests: XCTestCase {
    // MARK: heightFraction

    func testHeightFractionForActiveIndex() {
        XCTAssertEqual(MuiSheetShellMath.heightFraction(detents: [0.4, 0.9], activeDetent: 1), 0.9)
        XCTAssertEqual(MuiSheetShellMath.heightFraction(detents: [0.4, 0.9], activeDetent: 0), 0.4)
    }

    func testHeightFractionFallsBackToFirstDetentWhenIndexOutOfRange() {
        XCTAssertEqual(MuiSheetShellMath.heightFraction(detents: [0.4, 0.9], activeDetent: 5), 0.4)
        XCTAssertEqual(MuiSheetShellMath.heightFraction(detents: [0.4, 0.9], activeDetent: -1), 0.4)
    }

    func testHeightFractionFallsBackToDefaultWhenDetentsEmpty() {
        XCTAssertEqual(MuiSheetShellMath.heightFraction(detents: [], activeDetent: 0), 0.4)
    }

    // MARK: isDistanceDismissed

    func testNotDismissedBelowThreshold() {
        XCTAssertFalse(MuiSheetShellMath.isDistanceDismissed(dy: 50, sheetHeight: 400))
    }

    func testDismissedAtExactThreshold() {
        // dismissFraction is 0.25, so 25% of 400 = 100.
        XCTAssertTrue(MuiSheetShellMath.isDistanceDismissed(dy: 100, sheetHeight: 400))
    }

    func testDismissedAboveThreshold() {
        XCTAssertTrue(MuiSheetShellMath.isDistanceDismissed(dy: 300, sheetHeight: 400))
    }

    func testNotDismissedForZeroHeightSheet() {
        // An unmeasured (zero-height) sheet can't be evaluated yet — must
        // not spuriously dismiss.
        XCTAssertFalse(MuiSheetShellMath.isDistanceDismissed(dy: 1000, sheetHeight: 0))
    }

    func testDismissFractionIsAQuarter() {
        XCTAssertEqual(MuiSheetShellMath.dismissFraction, 0.25)
    }
}
