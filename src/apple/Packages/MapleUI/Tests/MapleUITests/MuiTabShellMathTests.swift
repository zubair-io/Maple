import XCTest
@testable import MapleUI

final class MuiTabShellMathTests: XCTestCase {
    func testTopForcesTopRegardlessOfWidth() {
        XCTAssertFalse(MuiTabShellMath.isBottom(placement: .top, hostWidth: 200))
        XCTAssertFalse(MuiTabShellMath.isBottom(placement: .top, hostWidth: 2000))
    }

    func testBottomForcesBottomRegardlessOfWidth() {
        XCTAssertTrue(MuiTabShellMath.isBottom(placement: .bottom, hostWidth: 200))
        XCTAssertTrue(MuiTabShellMath.isBottom(placement: .bottom, hostWidth: 2000))
    }

    func testAutoIsBottomBelowThreshold() {
        XCTAssertTrue(MuiTabShellMath.isBottom(placement: .auto, hostWidth: 375))
    }

    func testAutoIsTopAtOrAboveThreshold() {
        XCTAssertFalse(MuiTabShellMath.isBottom(placement: .auto, hostWidth: MuiTabShellMath.bottomBelowWidthPx))
        XCTAssertFalse(MuiTabShellMath.isBottom(placement: .auto, hostWidth: 1024))
    }
}
