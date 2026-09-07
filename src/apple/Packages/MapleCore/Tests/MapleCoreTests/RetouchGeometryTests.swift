// RetouchGeometryTests.swift — the heal overlay's pure geometry (#3409),
// pinned at the same analytic points the web `retouch-geometry.spec.ts`
// checks so the two platforms cannot drift.

import CoreGraphics
import XCTest

@testable import MapleCore

final class RetouchGeometryTests: XCTestCase {
    private let full = CGRect(x: 100, y: 50, width: 600, height: 400)

    private var spot: RetouchSpot {
        RetouchSpot(
            kind: .heal,
            center: RetouchPoint(x: 0.25, y: 0.5),
            source: RetouchPoint(x: 0.75, y: 0.5),
            radius: 0.05, feather: 0.5, opacity: 1)
    }

    func testScreenPointPlacesAPointAtItsFractionOfTheFrame() {
        let p = RetouchOverlayGeometry.screenPoint(spot.center, fullFrame: full)
        XCTAssertEqual(p.x, 100 + 0.25 * 600, accuracy: 1e-6)
        XCTAssertEqual(p.y, 50 + 0.5 * 400, accuracy: 1e-6)
    }

    /// The radius is a fraction of the image WIDTH and drives both axes, so
    /// the disc is a circle in pixels rather than in normalised space.
    func testRadiusIsScaledByWidthOnBothAxes() {
        XCTAssertEqual(
            RetouchOverlayGeometry.radiusPoints(0.05, fullFrame: full), 30, accuracy: 1e-6)
    }

    func testNormalizedPointInvertsScreenPointAtEveryAngle() {
        for angle in [0.0, 2.5, -7.25, 45.0] {
            let screen = RetouchOverlayGeometry.screenPoint(
                spot.center, fullFrame: full, angleDegrees: angle)
            let back = RetouchOverlayGeometry.normalizedPoint(
                from: screen, fullFrame: full, angleDegrees: angle)
            XCTAssertEqual(back.x, spot.center.x, accuracy: 1e-9, "angle \(angle)")
            XCTAssertEqual(back.y, spot.center.y, accuracy: 1e-9, "angle \(angle)")
        }
    }

    func testNormalizedPointClampsOutsideTheFrame() {
        let p = RetouchOverlayGeometry.normalizedPoint(
            from: CGPoint(x: -500, y: 5000), fullFrame: full, angleDegrees: 0)
        XCTAssertEqual(p.x, 0)
        XCTAssertEqual(p.y, 1)
    }

    func testHitTestGrabsEitherDiscAndMissesOutside() {
        XCTAssertEqual(
            RetouchOverlayGeometry.hitTest(
                RetouchPoint(x: 0.26, y: 0.5), spot: spot, fullFrame: full), .destination)
        XCTAssertEqual(
            RetouchOverlayGeometry.hitTest(
                RetouchPoint(x: 0.75, y: 0.51), spot: spot, fullFrame: full), .source)
        XCTAssertNil(
            RetouchOverlayGeometry.hitTest(
                RetouchPoint(x: 0.0, y: 0.0), spot: spot, fullFrame: full))
    }

    /// A tiny spot must still be grabbable — the tolerance is a floor, not a
    /// replacement for the disc.
    func testHitTestNeverGrabsLessThanTheTolerance() {
        var tiny = spot
        tiny.radius = 0.0005
        // 6 points to the right of the destination, well inside the 14pt floor.
        XCTAssertEqual(
            RetouchOverlayGeometry.hitTest(
                RetouchPoint(x: 0.26, y: 0.5), spot: tiny, fullFrame: full), .destination)
    }

    func testDraggingTheDestinationCarriesTheSource() {
        let moved = RetouchOverlayGeometry.drag(
            spot, handle: .destination, to: RetouchPoint(x: 0.35, y: 0.6),
            anchor: RetouchPoint(x: 0.25, y: 0.5))
        XCTAssertEqual(moved.center.x, 0.35, accuracy: 1e-9)
        XCTAssertEqual(moved.center.y, 0.6, accuracy: 1e-9)
        XCTAssertEqual(moved.source.x, 0.85, accuracy: 1e-9)
        XCTAssertEqual(moved.source.y, 0.6, accuracy: 1e-9)
    }

    func testDraggingTheSourceMovesItAlone() {
        let moved = RetouchOverlayGeometry.drag(
            spot, handle: .source, to: RetouchPoint(x: 0.65, y: 0.4),
            anchor: RetouchPoint(x: 0.75, y: 0.5))
        XCTAssertEqual(moved.center, spot.center)
        XCTAssertEqual(moved.source.x, 0.65, accuracy: 1e-9)
        XCTAssertEqual(moved.source.y, 0.4, accuracy: 1e-9)
    }

    func testDragClampsToTheFrame() {
        let moved = RetouchOverlayGeometry.drag(
            spot, handle: .source, to: RetouchPoint(x: 1.4, y: -0.3),
            anchor: RetouchPoint(x: 0.75, y: 0.5))
        XCTAssertEqual(moved.source, RetouchPoint(x: 1, y: 0))
    }

    func testDefaultSourceSamplesRightThenMirrorsAtTheEdge() {
        XCTAssertEqual(
            RetouchOverlayGeometry.defaultSource(
                for: RetouchPoint(x: 0.2, y: 0.5), radius: 0.05),
            RetouchPoint(x: 0.275, y: 0.5))
        XCTAssertEqual(
            RetouchOverlayGeometry.defaultSource(
                for: RetouchPoint(x: 0.98, y: 0.5), radius: 0.05
            ).x, 0.905, accuracy: 1e-9)
    }

    func testDegenerateSpotsAreIneffective() {
        var zeroRadius = spot
        zeroRadius.radius = 0
        XCTAssertFalse(zeroRadius.isEffective)
        var notMoved = spot
        notMoved.source = spot.center
        XCTAssertFalse(notMoved.isEffective)
        XCTAssertTrue(spot.isEffective)
    }
}
