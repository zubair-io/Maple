import XCTest
@testable import MapleUI

/// Component-level `value(atLocation:)` cases, mirroring the web
/// reference's `mui-color-wheel.component.spec.ts` fixture geometry (a
/// 100×100 wheel) so the two platforms agree on the same pointer
/// positions.
final class MuiColorWheelTests: XCTestCase {
    private let size: CGFloat = 100

    func testRightmostEdgeAtCenterYIsHueZeroFullSaturation() {
        let value = MuiColorWheel.value(atLocation: CGPoint(x: 100, y: 50), size: size, currentHue: 0)
        XCTAssertEqual(value.hue, 0)
        XCTAssertEqual(value.saturation, 100)
    }

    func testCenterIsZeroSaturation() {
        let value = MuiColorWheel.value(atLocation: CGPoint(x: 50, y: 50), size: size, currentHue: 0)
        XCTAssertEqual(value.saturation, 0)
    }

    func testTopIsHueNinety() {
        let value = MuiColorWheel.value(atLocation: CGPoint(x: 50, y: 0), size: size, currentHue: 0)
        XCTAssertEqual(value.hue, 90)
    }

    func testOutsideTheDiscClampsToTheRim() {
        let value = MuiColorWheel.value(atLocation: CGPoint(x: 1000, y: 50), size: size, currentHue: 0)
        XCTAssertEqual(value.saturation, 100)
    }
}
