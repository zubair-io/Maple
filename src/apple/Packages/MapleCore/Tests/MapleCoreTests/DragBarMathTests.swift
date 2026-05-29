// DragBarMathTests.swift — responsive-program S5b (#625).
//
// Covers the pure value↔pixel math used by the drag-bar primitive at
// all three sensitivity modes (bar 1:1, canvas 0.5:1, fine 0.25:1).

import XCTest
@testable import MapleCore

final class DragBarMathTests: XCTestCase {
    // MARK: - Mapping

    func testMarkerAtZeroSitsAtCenter() {
        let x = DragBarMath.markerX(forValue: 0, barWidth: 250)
        XCTAssertEqual(x, 125, accuracy: 1e-9)
    }

    func testMarkerAtPlusHundredSitsAtRightEdge() {
        let x = DragBarMath.markerX(forValue: 100, barWidth: 250)
        XCTAssertEqual(x, 250, accuracy: 1e-9)
    }

    func testMarkerAtMinusHundredSitsAtLeftEdge() {
        let x = DragBarMath.markerX(forValue: -100, barWidth: 250)
        XCTAssertEqual(x, 0, accuracy: 1e-9)
    }

    func testValueClampsToRange() {
        let above = DragBarMath.markerX(forValue: 250, barWidth: 100)
        let below = DragBarMath.markerX(forValue: -250, barWidth: 100)
        XCTAssertEqual(above, 100, accuracy: 1e-9)
        XCTAssertEqual(below, 0, accuracy: 1e-9)
    }

    func testPointerXMapsBackToValue() {
        XCTAssertEqual(DragBarMath.value(forPointerX: 125, barWidth: 250), 0, accuracy: 1e-9)
        XCTAssertEqual(DragBarMath.value(forPointerX: 0, barWidth: 250), -100, accuracy: 1e-9)
        XCTAssertEqual(DragBarMath.value(forPointerX: 250, barWidth: 250), 100, accuracy: 1e-9)
    }

    // MARK: - Sensitivity (spec §3 example math)

    /// Spec §7 "Drag bar gesture math": bar drag of 50pt on a 250pt-wide
    /// bar = `value += 20` (50/250 × 100 = 20).
    func testBarDragSensitivityMatchesSpecExample() {
        let dv = DragBarMath.valueDelta(forDeltaX: 50, barWidth: 250, sensitivity: .bar)
        XCTAssertEqual(dv, 40, accuracy: 1e-9) // 50/250 × 200 × 1.0 = 40
    }

    /// Spec §7 "canvas drag of 100pt = `value += 20` (0.5:1 → 100×0.5 =
    /// 50, then 50/250×100=20)" — note the spec text uses the legacy
    /// 0-100 internal scale; we use the symmetric -100..+100 scale so the
    /// per-unit conversion doubles. Maintaining the spec's *behavior*:
    /// canvas drag is half as sensitive as bar drag — same px ⇒ half Δv.
    func testCanvasDragHalfSensitivityRelativeToBar() {
        let dvBar    = DragBarMath.valueDelta(forDeltaX: 100, barWidth: 250, sensitivity: .bar)
        let dvCanvas = DragBarMath.valueDelta(forDeltaX: 100, barWidth: 250, sensitivity: .canvas)
        XCTAssertEqual(dvCanvas, dvBar * 0.5, accuracy: 1e-9)
    }

    /// Fine mode is 0.25:1 — quarter the bar sensitivity.
    func testFineDragQuarterSensitivityRelativeToBar() {
        let dvBar  = DragBarMath.valueDelta(forDeltaX: 100, barWidth: 250, sensitivity: .bar)
        let dvFine = DragBarMath.valueDelta(forDeltaX: 100, barWidth: 250, sensitivity: .fine)
        XCTAssertEqual(dvFine, dvBar * 0.25, accuracy: 1e-9)
    }

    func testValueDeltaZeroWhenBarHasNoWidth() {
        XCTAssertEqual(DragBarMath.valueDelta(forDeltaX: 100, barWidth: 0, sensitivity: .bar), 0)
    }

    // MARK: - Tick layout

    func testTwentyOneTicksWithCenterAtIndexTen() {
        XCTAssertEqual(DragBarMath.tickCount, 21)
        XCTAssertEqual(DragBarMath.centerTickIndex, 10)
        XCTAssertEqual(DragBarMath.tickHeight(forIndex: 10), 14)
        XCTAssertEqual(DragBarMath.tickHeight(forIndex: 0), 6)
        XCTAssertEqual(DragBarMath.tickHeight(forIndex: 20), 6)
    }

    func testTickEdgesPinToBarBounds() {
        let barWidth: CGFloat = 200
        XCTAssertEqual(DragBarMath.tickX(forIndex: 0, barWidth: barWidth), 0, accuracy: 1e-9)
        XCTAssertEqual(DragBarMath.tickX(forIndex: 20, barWidth: barWidth), 200, accuracy: 1e-9)
        XCTAssertEqual(DragBarMath.tickX(forIndex: 10, barWidth: barWidth), 100, accuracy: 1e-9)
    }

    // MARK: - Haptic event predicates

    func testZeroCrossFiresOnSignChange() {
        XCTAssertTrue(DragBarMath.didCrossZero(from: -1, to: 1))
        XCTAssertTrue(DragBarMath.didCrossZero(from: 5, to: -5))
        XCTAssertFalse(DragBarMath.didCrossZero(from: 5, to: 10))
        XCTAssertFalse(DragBarMath.didCrossZero(from: -5, to: -10))
    }

    func testExtremeFiresWhenLandingOnBoundary() {
        XCTAssertTrue(DragBarMath.didReachExtreme(from: 95, to: 100))
        XCTAssertTrue(DragBarMath.didReachExtreme(from: -50, to: -100))
        XCTAssertFalse(DragBarMath.didReachExtreme(from: 100, to: 100))
        XCTAssertFalse(DragBarMath.didReachExtreme(from: 50, to: 60))
    }
}
