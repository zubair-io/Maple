import XCTest
@testable import MapleUI

final class MuiControlSurfaceTests: XCTestCase {
    func testBipolarTrueWhenRangeStraddlesZero() {
        let slider = MuiControlSurfaceSlider(id: "exposure", label: "Exposure", value: 0, min: -5, max: 5)
        XCTAssertTrue(MuiControlSurface.bipolar(slider))
    }

    func testBipolarFalseWhenRangeIsAllPositive() {
        let slider = MuiControlSurfaceSlider(id: "temp", label: "Temp", value: 5500, min: 2000, max: 9000)
        XCTAssertFalse(MuiControlSurface.bipolar(slider))
    }

    func testBipolarFalseWhenRangeIsAllNegative() {
        let slider = MuiControlSurfaceSlider(id: "shadows", label: "Shadows", value: -10, min: -100, max: 0)
        XCTAssertFalse(MuiControlSurface.bipolar(slider))
    }
}
