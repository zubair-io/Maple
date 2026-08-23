import XCTest
@testable import MapleUI

/// Component-level `value(atLocation:)` cases, mirroring the web
/// reference's `mui-pad-2d.component.spec.ts` fixture geometry (a 100×100
/// pad) so the two platforms agree on the same pointer positions.
final class MuiPad2DTests: XCTestCase {
    private let size: CGFloat = 100

    func testTopLeftCornerIsMinusOneOne() {
        let value = MuiPad2D.value(atLocation: CGPoint(x: 0, y: 0), size: size)
        XCTAssertEqual(value.x, -1)
        XCTAssertEqual(value.y, 1)
    }

    func testCenterIsOrigin() {
        let value = MuiPad2D.value(atLocation: CGPoint(x: 50, y: 50), size: size)
        XCTAssertEqual(value.x, 0)
        XCTAssertEqual(value.y, 0)
    }

    func testBottomRightCornerIsOneMinusOne() {
        let value = MuiPad2D.value(atLocation: CGPoint(x: 100, y: 100), size: size)
        XCTAssertEqual(value.x, 1)
        XCTAssertEqual(value.y, -1)
    }

    func testZeroSizeReturnsOrigin() {
        let value = MuiPad2D.value(atLocation: CGPoint(x: 10, y: 10), size: 0)
        XCTAssertEqual(value.x, 0)
        XCTAssertEqual(value.y, 0)
    }
}
