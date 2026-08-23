import XCTest
@testable import MapleUI

final class MuiCropOverlayMathTests: XCTestCase {
    private let container = CGSize(width: 300, height: 200)

    func testApplyHandleDeltaSouthEastGrowsWidthAndHeight() {
        let start = MuiCropRect(x: 20, y: 20, width: 100, height: 80)
        let next = MuiCropOverlayMath.applyHandleDelta(handle: .se, startRect: start, dx: 20, dy: 10, minSize: 24, containerSize: container)
        XCTAssertEqual(next.x, 20)
        XCTAssertEqual(next.y, 20)
        XCTAssertEqual(next.width, 120)
        XCTAssertEqual(next.height, 90)
    }

    func testApplyHandleDeltaNorthWestMovesOriginWithoutMovingOppositeEdges() {
        let start = MuiCropRect(x: 40, y: 40, width: 100, height: 80)
        let next = MuiCropOverlayMath.applyHandleDelta(handle: .nw, startRect: start, dx: -10, dy: -10, minSize: 24, containerSize: container)
        XCTAssertEqual(next.x, 30)
        XCTAssertEqual(next.y, 30)
        // Right/bottom edges are the nw handle's anchor — unmoved.
        XCTAssertEqual(next.x + next.width, start.x + start.width)
        XCTAssertEqual(next.y + next.height, start.y + start.height)
    }

    func testApplyHandleDeltaNeverShrinksBelowMinSize() {
        let start = MuiCropRect(x: 20, y: 20, width: 30, height: 30)
        let next = MuiCropOverlayMath.applyHandleDelta(handle: .e, startRect: start, dx: -100, dy: 0, minSize: 24, containerSize: container)
        XCTAssertEqual(next.width, 24)
    }

    func testApplyHandleDeltaNeverLeavesContainerBounds() {
        let start = MuiCropRect(x: 20, y: 20, width: 100, height: 80)
        let next = MuiCropOverlayMath.applyHandleDelta(handle: .se, startRect: start, dx: 500, dy: 500, minSize: 24, containerSize: container)
        XCTAssertEqual(next.x + next.width, container.width)
        XCTAssertEqual(next.y + next.height, container.height)
    }

    func testNudgeDeltaMapsArrowKeysToIndependentAxes() {
        XCTAssertEqual(MuiCropOverlayMath.nudgeDelta(key: "ArrowLeft", step: 1)?.dx, -1)
        XCTAssertEqual(MuiCropOverlayMath.nudgeDelta(key: "ArrowRight", step: 1)?.dx, 1)
        XCTAssertEqual(MuiCropOverlayMath.nudgeDelta(key: "ArrowUp", step: 1)?.dy, -1)
        XCTAssertEqual(MuiCropOverlayMath.nudgeDelta(key: "ArrowDown", step: 1)?.dy, 1)
        XCTAssertNil(MuiCropOverlayMath.nudgeDelta(key: "Escape", step: 1))
    }

    func testHandlePositionCornersAndMidpoints() {
        let rect = MuiCropRect(x: 10, y: 10, width: 100, height: 60)
        XCTAssertEqual(MuiCropOverlayMath.handlePosition(handle: .nw, rect: rect), CGPoint(x: 10, y: 10))
        XCTAssertEqual(MuiCropOverlayMath.handlePosition(handle: .se, rect: rect), CGPoint(x: 110, y: 70))
        XCTAssertEqual(MuiCropOverlayMath.handlePosition(handle: .n, rect: rect), CGPoint(x: 60, y: 10))
    }
}
