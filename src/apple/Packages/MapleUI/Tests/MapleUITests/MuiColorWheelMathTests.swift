import XCTest
@testable import MapleUI

final class MuiColorWheelMathTests: XCTestCase {
    func testWrapHueNormalizesNegativeDegrees() {
        XCTAssertEqual(MuiColorWheelMath.wrapHue(-10), 350)
        XCTAssertEqual(MuiColorWheelMath.wrapHue(370), 10)
    }

    func testWrapHueNormalizesNegativeZero() {
        XCTAssertEqual(MuiColorWheelMath.wrapHue(-0.0), 0)
        XCTAssertFalse(MuiColorWheelMath.wrapHue(-0.0).sign == .minus)
    }

    func testValueAtRightEdgeIsHueZeroFullSaturation() {
        let result = MuiColorWheelMath.value(dx: 1, dy: 0, currentHue: 99)
        XCTAssertEqual(result.hue, 0)
        XCTAssertEqual(result.saturation, 100)
    }

    func testValueAtTopIsHueNinety() {
        let result = MuiColorWheelMath.value(dx: 0, dy: 1, currentHue: 0)
        XCTAssertEqual(result.hue, 90)
    }

    func testValueAtCenterKeepsCurrentHueAndZeroSaturation() {
        let result = MuiColorWheelMath.value(dx: 0, dy: 0, currentHue: 210)
        XCTAssertEqual(result.hue, 210)
        XCTAssertEqual(result.saturation, 0)
    }

    func testValueOutsideDiscClampsSaturationToRim() {
        let result = MuiColorWheelMath.value(dx: 19, dy: 0, currentHue: 0)
        XCTAssertEqual(result.saturation, 100)
    }

    func testPuckPositionRoundTripsValue() {
        // hue 90 (straight up), full saturation -> centered horizontally, top of the box.
        let puck = MuiColorWheelMath.puckPosition(hue: 90, saturation: 100)
        XCTAssertEqual(puck.leftPct, 50, accuracy: 1e-9)
        XCTAssertEqual(puck.topPct, 0, accuracy: 1e-9)
    }

    func testPuckPositionAtZeroSaturationIsCentered() {
        let puck = MuiColorWheelMath.puckPosition(hue: 45, saturation: 0)
        XCTAssertEqual(puck.leftPct, 50, accuracy: 1e-9)
        XCTAssertEqual(puck.topPct, 50, accuracy: 1e-9)
    }
}
