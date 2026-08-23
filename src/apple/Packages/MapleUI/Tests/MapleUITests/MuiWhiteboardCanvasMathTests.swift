import XCTest
@testable import MapleUI

final class MuiWhiteboardCanvasMathTests: XCTestCase {
    func testStrokeHitTrueWhenAnyPointWithinRadius() {
        let stroke = MuiWhiteboardStroke(points: [CGPoint(x: 0, y: 0), CGPoint(x: 100, y: 100)])
        XCTAssertTrue(MuiWhiteboardCanvasMath.strokeHit(stroke, at: CGPoint(x: 5, y: 5), radius: 12))
    }

    func testStrokeHitFalseWhenNoPointWithinRadius() {
        let stroke = MuiWhiteboardStroke(points: [CGPoint(x: 0, y: 0), CGPoint(x: 100, y: 100)])
        XCTAssertFalse(MuiWhiteboardCanvasMath.strokeHit(stroke, at: CGPoint(x: 50, y: 50), radius: 12))
    }

    func testErasingRemovesOnlyHitStrokes() {
        let hit = MuiWhiteboardStroke(id: "hit", points: [CGPoint(x: 0, y: 0)])
        let miss = MuiWhiteboardStroke(id: "miss", points: [CGPoint(x: 500, y: 500)])
        let remaining = MuiWhiteboardCanvasMath.erasing([hit, miss], at: CGPoint(x: 1, y: 1))
        XCTAssertEqual(remaining.map(\.id), ["miss"])
    }

    func testErasingEmptyStrokesReturnsEmpty() {
        XCTAssertTrue(MuiWhiteboardCanvasMath.erasing([], at: .zero).isEmpty)
    }
}
