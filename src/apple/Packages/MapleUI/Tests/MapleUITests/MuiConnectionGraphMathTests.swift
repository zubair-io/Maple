import XCTest
@testable import MapleUI

final class MuiConnectionGraphMathTests: XCTestCase {
    func testZeroNodesProducesEmptyLayout() {
        XCTAssertTrue(MuiConnectionGraphMath.circularLayout(nodeCount: 0).isEmpty)
    }

    func testSingleNodeSitsAtTheTop() {
        let layout = MuiConnectionGraphMath.circularLayout(nodeCount: 1, centerFraction: 0.5, radiusFraction: 0.4)
        XCTAssertEqual(layout.count, 1)
        XCTAssertEqual(layout[0].x, 0.5, accuracy: 1e-9)
        XCTAssertEqual(layout[0].y, 0.1, accuracy: 1e-9)
    }

    func testLayoutIsDeterministicAcrossCalls() {
        let first = MuiConnectionGraphMath.circularLayout(nodeCount: 6)
        let second = MuiConnectionGraphMath.circularLayout(nodeCount: 6)
        XCTAssertEqual(first.count, second.count)
        for (a, b) in zip(first, second) {
            XCTAssertEqual(a.x, b.x)
            XCTAssertEqual(a.y, b.y)
        }
    }

    func testAllPositionsStayWithinCenterPlusMinusRadius() {
        let layout = MuiConnectionGraphMath.circularLayout(nodeCount: 8, centerFraction: 0.5, radiusFraction: 0.4)
        for position in layout {
            XCTAssertGreaterThanOrEqual(position.x, 0.1 - 1e-9)
            XCTAssertLessThanOrEqual(position.x, 0.9 + 1e-9)
            XCTAssertGreaterThanOrEqual(position.y, 0.1 - 1e-9)
            XCTAssertLessThanOrEqual(position.y, 0.9 + 1e-9)
        }
    }

    func testFourNodesLandNearTheFourCardinalPoints() {
        let layout = MuiConnectionGraphMath.circularLayout(nodeCount: 4, centerFraction: 0.5, radiusFraction: 0.4)
        // Node 0: top. Node 1: right. Node 2: bottom. Node 3: left.
        XCTAssertEqual(layout[0].x, 0.5, accuracy: 1e-9)
        XCTAssertEqual(layout[0].y, 0.1, accuracy: 1e-9)
        XCTAssertEqual(layout[1].x, 0.9, accuracy: 1e-9)
        XCTAssertEqual(layout[1].y, 0.5, accuracy: 1e-9)
        XCTAssertEqual(layout[2].x, 0.5, accuracy: 1e-9)
        XCTAssertEqual(layout[2].y, 0.9, accuracy: 1e-9)
        XCTAssertEqual(layout[3].x, 0.1, accuracy: 1e-9)
        XCTAssertEqual(layout[3].y, 0.5, accuracy: 1e-9)
    }

    func testCanvasPointScalesNormalizedPositionByFrameSize() {
        let point = MuiConnectionGraphMath.canvasPoint(x: 0.25, y: 0.75, width: 200, height: 100)
        XCTAssertEqual(point, CGPoint(x: 50, y: 75))
    }
}
