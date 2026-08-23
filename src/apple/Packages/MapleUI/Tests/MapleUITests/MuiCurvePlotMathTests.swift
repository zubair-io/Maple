import XCTest
@testable import MapleUI

final class MuiCurvePlotMathTests: XCTestCase {
    // MARK: point <-> canvas conversion

    func testToCanvasPointFlipsYAxis() {
        let p = MuiCurvePlotMath.toCanvasPoint(MuiCurvePoint(x: 0, y: 0), width: 100, height: 100)
        XCTAssertEqual(p, CGPoint(x: 0, y: 100))

        let top = MuiCurvePlotMath.toCanvasPoint(MuiCurvePoint(x: 1, y: 1), width: 100, height: 100)
        XCTAssertEqual(top, CGPoint(x: 100, y: 0))
    }

    func testFromCanvasPointIsInverseOfToCanvasPoint() {
        let original = MuiCurvePoint(x: 0.3, y: 0.7)
        let canvas = MuiCurvePlotMath.toCanvasPoint(original, width: 160, height: 120)
        let roundTripped = MuiCurvePlotMath.fromCanvasPoint(canvas, width: 160, height: 120)
        XCTAssertEqual(roundTripped.x, original.x, accuracy: 1e-9)
        XCTAssertEqual(roundTripped.y, original.y, accuracy: 1e-9)
    }

    func testFromCanvasPointClampsOutOfBounds() {
        let p = MuiCurvePlotMath.fromCanvasPoint(CGPoint(x: -50, y: 500), width: 100, height: 100)
        XCTAssertEqual(p.x, 0)
        XCTAssertEqual(p.y, 0)
    }

    func testFromCanvasPointZeroSizeReturnsOrigin() {
        let p = MuiCurvePlotMath.fromCanvasPoint(CGPoint(x: 10, y: 10), width: 0, height: 0)
        XCTAssertEqual(p, MuiCurvePoint(x: 0, y: 0))
    }

    // MARK: hitTest

    func testHitTestFindsNearestPointWithinRadius() {
        let points = [MuiCurvePoint(x: 0, y: 0), MuiCurvePoint(x: 1, y: 1)]
        let index = MuiCurvePlotMath.hitTest(points, location: CGPoint(x: 2, y: 98), width: 100, height: 100)
        XCTAssertEqual(index, 0)
    }

    func testHitTestReturnsNilWhenNoPointIsClose() {
        let points = [MuiCurvePoint(x: 0, y: 0)]
        let index = MuiCurvePlotMath.hitTest(points, location: CGPoint(x: 50, y: 50), width: 100, height: 100)
        XCTAssertNil(index)
    }

    // MARK: nudge

    func testNudgedClampsIntoUnitRange() {
        let nudged = MuiCurvePlotMath.nudged(MuiCurvePoint(x: 0, y: 1), dx: -0.5, dy: 0.5)
        XCTAssertEqual(nudged.x, 0)
        XCTAssertEqual(nudged.y, 1)
    }

    func testNudgedAppliesDeltaWithinRange() {
        let nudged = MuiCurvePlotMath.nudged(MuiCurvePoint(x: 0.5, y: 0.5), dx: 0.02, dy: -0.02)
        XCTAssertEqual(nudged.x, 0.52, accuracy: 1e-9)
        XCTAssertEqual(nudged.y, 0.48, accuracy: 1e-9)
    }

    // MARK: monotonicity — the property that actually matters for a tone
    // curve: x must never run backwards as the curve is traced start to
    // end, regardless of how many interior control points bend it.

    func testSegmentsAreEmptyForTwoPoints() {
        let sorted = MuiCurvePlotMath.sortedCanvasPoints(MuiCurvePoint.defaultPoints.filter { $0.x != 0.5 }, width: 100, height: 100)
        XCTAssertEqual(MuiCurvePlotMath.segments(forSortedCanvasPoints: sorted).count, 0)
    }

    func testAssembledPathIsMonotoneInXForOrderedPoints() {
        let points = [
            MuiCurvePoint(x: 0, y: 0.1),
            MuiCurvePoint(x: 0.2, y: 0.6),
            MuiCurvePoint(x: 0.55, y: 0.4),
            MuiCurvePoint(x: 0.8, y: 0.9),
            MuiCurvePoint(x: 1, y: 0.95),
        ]
        let width: CGFloat = 200
        let height: CGFloat = 150
        let sorted = MuiCurvePlotMath.sortedCanvasPoints(points, width: width, height: height)
        let segments = MuiCurvePlotMath.segments(forSortedCanvasPoints: sorted)
        XCTAssertEqual(segments.count, points.count - 2)

        var sampledXs: [CGFloat] = [sorted[0].x]
        var start = sorted[0]
        for segment in segments {
            for step in 1...20 {
                let t = Double(step) / 20
                let sample = MuiCurvePlotMath.quadraticBezierPoint(start: start, control: segment.control, end: segment.end, t: t)
                sampledXs.append(sample.x)
            }
            start = segment.end
        }
        sampledXs.append(sorted.last!.x)

        for i in 1..<sampledXs.count {
            XCTAssertGreaterThanOrEqual(sampledXs[i], sampledXs[i - 1] - 1e-6, "x regressed at sample \(i)")
        }
    }

    func testQuadraticBezierPointAtEndpointsMatchesControlPoints() {
        let start = CGPoint(x: 0, y: 0)
        let control = CGPoint(x: 10, y: 20)
        let end = CGPoint(x: 20, y: 0)
        XCTAssertEqual(MuiCurvePlotMath.quadraticBezierPoint(start: start, control: control, end: end, t: 0), start)
        XCTAssertEqual(MuiCurvePlotMath.quadraticBezierPoint(start: start, control: control, end: end, t: 1), end)
    }
}
