import XCTest
@testable import MapleUI

final class MuiToggleTests: XCTestCase {
    func testEnabledOpacityIsFullyOpaque() {
        XCTAssertEqual(MuiToggle.opacity(disabled: false), 1)
    }

    func testDisabledOpacityIsDimmed() {
        let value = MuiToggle.opacity(disabled: true)
        XCTAssertEqual(value, 0.45)
        XCTAssertLessThan(value, MuiToggle.opacity(disabled: false))
    }
}
