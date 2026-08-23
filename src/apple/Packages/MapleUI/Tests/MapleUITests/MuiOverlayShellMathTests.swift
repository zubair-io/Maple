import XCTest
@testable import MapleUI

final class MuiOverlayShellMathTests: XCTestCase {
    func testSmMapsTo360() {
        XCTAssertEqual(MuiOverlayShellMath.maxWidth(for: .sm), 360)
    }

    func testMdMapsTo560() {
        XCTAssertEqual(MuiOverlayShellMath.maxWidth(for: .md), 560)
    }

    func testLgMapsTo800() {
        XCTAssertEqual(MuiOverlayShellMath.maxWidth(for: .lg), 800)
    }

    func testFullHasNoCap() {
        XCTAssertNil(MuiOverlayShellMath.maxWidth(for: .full))
    }

    func testSizesAreStrictlyIncreasing() {
        let sm = MuiOverlayShellMath.maxWidth(for: .sm)!
        let md = MuiOverlayShellMath.maxWidth(for: .md)!
        let lg = MuiOverlayShellMath.maxWidth(for: .lg)!
        XCTAssertLessThan(sm, md)
        XCTAssertLessThan(md, lg)
    }
}
