import XCTest
@testable import MapleUI

final class MuiSettingsShellMathTests: XCTestCase {
    func testStackedBelowThreshold() {
        XCTAssertTrue(MuiSettingsShellMath.isStacked(hostWidth: 400))
    }

    func testNotStackedAtOrAboveThreshold() {
        XCTAssertFalse(MuiSettingsShellMath.isStacked(hostWidth: MuiSettingsShellMath.stackBelowWidthPx))
        XCTAssertFalse(MuiSettingsShellMath.isStacked(hostWidth: 900))
    }
}
