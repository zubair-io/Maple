import XCTest
@testable import MapleUI

final class MuiVectorscopeMathTests: XCTestCase {
    func testPureGreyHasZeroChroma() {
        let chroma = MuiVectorscopeMath.chroma(r: 0.5, g: 0.5, b: 0.5)
        XCTAssertEqual(chroma.cb, 0, accuracy: 1e-9)
        XCTAssertEqual(chroma.cr, 0, accuracy: 1e-9)
    }

    func testPureGreyMapsToCanvasCenter() {
        let chroma = MuiVectorscopeMath.chroma(r: 0.5, g: 0.5, b: 0.5)
        let center = CGPoint(x: 32, y: 32)
        let point = MuiVectorscopeMath.canvasPoint(cb: chroma.cb, cr: chroma.cr, center: center, radius: 28)
        XCTAssertEqual(point.x, center.x, accuracy: 1e-9)
        XCTAssertEqual(point.y, center.y, accuracy: 1e-9)
    }

    func testPureBluePushesCbPositive() {
        let chroma = MuiVectorscopeMath.chroma(r: 0, g: 0, b: 1)
        XCTAssertGreaterThan(chroma.cb, 0)
    }

    func testPureRedPushesCrPositive() {
        let chroma = MuiVectorscopeMath.chroma(r: 1, g: 0, b: 0)
        XCTAssertGreaterThan(chroma.cr, 0)
    }

    func testCanvasPointCbGrowsRightCrGrowsUp() {
        let center = CGPoint(x: 50, y: 50)
        let right = MuiVectorscopeMath.canvasPoint(cb: 0.2, cr: 0, center: center, radius: 40)
        XCTAssertGreaterThan(right.x, center.x)

        let up = MuiVectorscopeMath.canvasPoint(cb: 0, cr: 0.2, center: center, radius: 40)
        XCTAssertLessThan(up.y, center.y)
    }
}
