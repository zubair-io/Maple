import XCTest
@testable import MapleUI

final class MuiImageCanvasMathTests: XCTestCase {
    func testClampScaleClampsIntoRange() {
        XCTAssertEqual(MuiImageCanvasMath.clampScale(0.01), MuiImageCanvasMath.minScale)
        XCTAssertEqual(MuiImageCanvasMath.clampScale(100), MuiImageCanvasMath.maxScale)
        XCTAssertEqual(MuiImageCanvasMath.clampScale(2), 2)
    }

    func testZoomToPointKeepsAnchorFixedUnderCursor() {
        let transform = MuiImageTransform(x: 0, y: 0, scale: 1)
        let next = MuiImageCanvasMath.zoomToPoint(transform: transform, anchorX: 50, anchorY: 50, nextScale: 2)
        // newOffset = anchor - (anchor - oldOffset) * ratio = 50 - 50*2 = -50
        XCTAssertEqual(next.x, -50)
        XCTAssertEqual(next.y, -50)
        XCTAssertEqual(next.scale, 2)
    }

    func testZoomToPointAtOriginIsUnaffectedByAnchor() {
        let transform = MuiImageTransform(x: 0, y: 0, scale: 1)
        let next = MuiImageCanvasMath.zoomToPoint(transform: transform, anchorX: 0, anchorY: 0, nextScale: 4)
        XCTAssertEqual(next.x, 0)
        XCTAssertEqual(next.y, 0)
    }

    func testPannedAddsDeltaToStartTransform() {
        let start = MuiImageTransform(x: 10, y: 20, scale: 1.5)
        let next = MuiImageCanvasMath.panned(startTransform: start, dx: 5, dy: -5)
        XCTAssertEqual(next.x, 15)
        XCTAssertEqual(next.y, 15)
        XCTAssertEqual(next.scale, 1.5)
    }
}
