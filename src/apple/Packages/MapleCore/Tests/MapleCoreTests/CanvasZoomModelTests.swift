// CanvasZoomModelTests.swift — #1099 (spec §5.0).
//
// Pure-function tests for the shared zoom/pan/gesture state machine:
// the fit-vs-zoomed arbitration routing, the snap-to-fit threshold, the
// pinch start-capture (compounding guard), anchored-zoom pan math, pan
// clamping, and the wheel-nudge detent accumulator. No SwiftUI, no
// MainActor.

import XCTest
import CoreGraphics
@testable import MapleCore

final class CanvasZoomModelTests: XCTestCase {

    // MARK: - Fixtures

    /// 1000×800pt viewport on a 2× display hosting an 8000×6000 image:
    /// viewportPx = 2000×1600, fit = min(2000/8000, 1600/6000) = 0.25.
    /// Display frame at fit = 1000×750pt; at 100% = 4000×3000pt with
    /// max pan (1500, 1100)pt.
    private let context = CanvasZoomContext(
        viewportPoints: CGSize(width: 1000, height: 800),
        nativeImageSize: CGSize(width: 8000, height: 6000),
        displayScale: 2
    )

    // MARK: - Context geometry

    func testFitScaleAndEffectiveScale() {
        XCTAssertEqual(context.fitScale, 0.25, accuracy: 1e-9)
        XCTAssertEqual(context.effectiveScale(for: 0), 0.25, accuracy: 1e-9)
        XCTAssertEqual(context.effectiveScale(for: 1.0), 1.0, accuracy: 1e-9)
    }

    func testDisplayFrameInPoints() {
        XCTAssertEqual(context.displayFrameInPoints(at: 0),
                       CGSize(width: 1000, height: 750))
        XCTAssertEqual(context.displayFrameInPoints(at: 1.0),
                       CGSize(width: 4000, height: 3000))
    }

    func testMaxPanIsZeroAtFitAndPositiveZoomedIn() {
        // Fit: image (1000×750) ≤ viewport (1000×800) → locked centered.
        XCTAssertEqual(context.maxPanOffset(at: 0), .zero)
        // 100%: (4000−1000)/2 × (3000−800)/2.
        XCTAssertEqual(context.maxPanOffset(at: 1.0),
                       CGSize(width: 1500, height: 1100))
    }

    func testClampedPanBoundsSymmetrically() {
        let clamped = context.clampedPan(CGSize(width: 9000, height: -9000), at: 1.0)
        XCTAssertEqual(clamped, CGSize(width: 1500, height: -1100))
        // Inside the bounds passes through untouched.
        XCTAssertEqual(context.clampedPan(CGSize(width: 100, height: 50), at: 1.0),
                       CGSize(width: 100, height: 50))
    }

    // MARK: - Arbitration routing (fit vs zoomed — the spec §5.0 table)

    func testDragIntentRoutesEditingAtFitAndPanWhenZoomed() {
        var model = CanvasZoomModel()
        XCTAssertFalse(model.isZoomedIn)
        XCTAssertEqual(model.dragIntent, .editing)

        model.zoomToScale(1.0)
        XCTAssertTrue(model.isZoomedIn)
        XCTAssertEqual(model.dragIntent, .pan)

        model.resetToFit()
        XCTAssertEqual(model.dragIntent, .editing)
    }

    func testWheelIntentMatrix() {
        var model = CanvasZoomModel()
        // At fit: Cmd → zoom; plain → editing (armed-tool nudge).
        XCTAssertEqual(model.wheelIntent(commandHeld: true), .zoom)
        XCTAssertEqual(model.wheelIntent(commandHeld: false), .editing)
        // Zoomed in: Cmd → zoom (same); plain → pan.
        model.zoomToScale(2.0)
        XCTAssertEqual(model.wheelIntent(commandHeld: true), .zoom)
        XCTAssertEqual(model.wheelIntent(commandHeld: false), .pan)
    }

    func testDragAtFitIsNotConsumedAndMovesNothing() {
        var model = CanvasZoomModel()
        let consumed = model.dragChanged(
            translation: CGSize(width: 120, height: -40), context: context
        )
        XCTAssertFalse(consumed, "fit-mode drags belong to the editing surface")
        XCTAssertEqual(model.panOffset, .zero)
        XCTAssertFalse(model.dragEnded())
    }

    func testDragWhenZoomedPansAndCommitsOnEnd() {
        var model = CanvasZoomModel()
        model.zoomToScale(1.0)
        XCTAssertTrue(model.dragChanged(translation: CGSize(width: 100, height: 50),
                                        context: context))
        XCTAssertEqual(model.panOffset, CGSize(width: 100, height: 50))
        XCTAssertTrue(model.dragEnded())
        // Next drag accumulates on the committed base.
        model.dragChanged(translation: CGSize(width: 10, height: 5), context: context)
        XCTAssertEqual(model.panOffset, CGSize(width: 110, height: 55))
    }

    func testDragPanIsClampedToViewportAttachment() {
        var model = CanvasZoomModel()
        model.zoomToScale(1.0)
        model.dragChanged(translation: CGSize(width: 99999, height: 99999), context: context)
        XCTAssertEqual(model.panOffset, CGSize(width: 1500, height: 1100))
    }

    // MARK: - Pinch (start-capture compounding guard)

    func testPinchAnchorsAgainstStartCapturedScaleNotLiveScale() {
        var model = CanvasZoomModel()
        // First frame captures the start (fit = 0.25).
        model.pinchChanged(magnification: 2.0, location: CGPoint(x: 500, y: 400),
                           context: context)
        XCTAssertEqual(model.pixelScale, 0.5, accuracy: 1e-9)
        // Cumulative magnification 3.0 → 0.25 × 3 = 0.75, NOT 0.5 × 3.
        model.pinchChanged(magnification: 3.0, location: CGPoint(x: 500, y: 400),
                           context: context)
        XCTAssertEqual(model.pixelScale, 0.75, accuracy: 1e-9)
    }

    func testPinchClampsAtMaxAndAtHalfFit() {
        var model = CanvasZoomModel()
        model.pinchChanged(magnification: 1000, location: .zero, context: context)
        XCTAssertEqual(model.pixelScale, CanvasZoomModel.maxPixelScale, accuracy: 1e-9)

        var out = CanvasZoomModel()
        out.pinchChanged(magnification: 0.01, location: .zero, context: context)
        XCTAssertEqual(out.pixelScale, context.fitScale * 0.5, accuracy: 1e-9)
    }

    func testPinchEndWithinToleranceSnapsToFit() {
        var model = CanvasZoomModel()
        // 1.01× fit lands inside the 1.02 snap threshold.
        model.pinchChanged(magnification: 1.01, location: .zero, context: context)
        model.pinchEnded(magnification: 1.01, context: context)
        XCTAssertEqual(model.pixelScale, 0, "should reset to fit sentinel")
        XCTAssertEqual(model.panOffset, .zero)
        XCTAssertNil(model.pinchStartScale)
    }

    func testPinchEndAboveToleranceKeepsScale() {
        var model = CanvasZoomModel()
        model.pinchChanged(magnification: 2.0, location: .zero, context: context)
        model.pinchEnded(magnification: 2.0, context: context)
        XCTAssertEqual(model.pixelScale, 0.5, accuracy: 1e-9)
        XCTAssertNil(model.pinchStartScale, "start capture must clear on end")
    }

    func testSnapToFitThresholdBoundary() {
        let fit: CGFloat = 0.25
        XCTAssertTrue(CanvasZoomModel.shouldSnapToFit(fit * 1.02, fit: fit))
        XCTAssertFalse(CanvasZoomModel.shouldSnapToFit(fit * 1.021, fit: fit))
    }

    // MARK: - Anchored zoom math

    func testAnchoredPanKeepsImagePointUnderAnchor() {
        // Zooming fit (0.25) → 100% anchored at (250, 200): the image
        // point under the anchor must stay put. Derivation in the model
        // docs: p₁ = (q−C) − ((q−C) − p₀)·(s₁/s₀) = −3·(q−C) here.
        let pan = CanvasZoomModel.anchoredPan(
            anchor: CGPoint(x: 250, y: 200),
            viewportPoints: context.viewportPoints,
            startPan: .zero,
            startScale: 0.25,
            newScale: 1.0
        )
        XCTAssertEqual(pan.width, 750, accuracy: 1e-9)
        XCTAssertEqual(pan.height, 600, accuracy: 1e-9)

        // Cross-check: map the anchor through the start state to image
        // coords, then forward through the new state — same screen point.
        let ds: CGFloat = 2
        let ux = (250.0 - 500.0 - 0.0) * ds / 0.25
        let backX = 500.0 + pan.width + ux * 1.0 / ds
        XCTAssertEqual(backX, 250, accuracy: 1e-9)
    }

    func testAnchoredPanAtViewportCenterScalesExistingPan() {
        // q = C degenerates to p₁ = p₀ × ratio.
        let pan = CanvasZoomModel.anchoredPan(
            anchor: CGPoint(x: 500, y: 400),
            viewportPoints: context.viewportPoints,
            startPan: CGSize(width: 100, height: -50),
            startScale: 1.0,
            newScale: 2.0
        )
        XCTAssertEqual(pan.width, 200, accuracy: 1e-9)
        XCTAssertEqual(pan.height, -100, accuracy: 1e-9)
    }

    // MARK: - Double-tap

    func testDoubleTapTogglesFitAnd100InEditorBehavior() {
        var model = CanvasZoomModel()
        // Fit → 100%, anchored at the tap point.
        model.doubleTap(at: CGPoint(x: 250, y: 200),
                        behavior: .toggleFitAnd100, context: context)
        XCTAssertEqual(model.pixelScale, 1.0, accuracy: 1e-9)
        XCTAssertEqual(model.panOffset.width, 750, accuracy: 1e-9)
        XCTAssertEqual(model.panOffset.height, 600, accuracy: 1e-9)
        // Any zoomed state → back to fit.
        model.doubleTap(at: CGPoint(x: 500, y: 400),
                        behavior: .toggleFitAnd100, context: context)
        XCTAssertEqual(model.pixelScale, 0)
        XCTAssertEqual(model.panOffset, .zero)
    }

    func testDoubleTapLegacyBehaviorAlwaysResetsToFit() {
        var model = CanvasZoomModel()
        model.zoomToScale(4.0)
        model.doubleTap(at: CGPoint(x: 100, y: 100),
                        behavior: .resetToFit, context: context)
        XCTAssertEqual(model.pixelScale, 0)

        // At fit it stays at fit (no toggle).
        model.doubleTap(at: CGPoint(x: 100, y: 100),
                        behavior: .resetToFit, context: context)
        XCTAssertEqual(model.pixelScale, 0)
    }

    // MARK: - Explicit zoom + steps

    func testZoomToScaleClampsAndClearsPan() {
        var model = CanvasZoomModel()
        model.zoomToScale(1.0)
        model.dragChanged(translation: CGSize(width: 100, height: 100), context: context)
        model.zoomToScale(9.0)
        XCTAssertEqual(model.pixelScale, CanvasZoomModel.maxPixelScale)
        XCTAssertEqual(model.panOffset, .zero)

        model.zoomToScale(0.001)
        XCTAssertEqual(model.pixelScale, CanvasZoomModel.minExplicitZoom)
    }

    func testStepZoomInFromFitMovesOffTheFitScale() {
        var model = CanvasZoomModel()
        model.stepZoomIn(context: context)
        XCTAssertEqual(model.pixelScale, 0.25 * 1.25, accuracy: 1e-9)
    }

    func testStepZoomOutSnapsToFitWithinTolerance() {
        var model = CanvasZoomModel()
        model.zoomToScale(0.3)
        // 0.3 / 1.25 = 0.24 ≤ 0.25 × 1.02 → snap.
        model.stepZoomOut(context: context)
        XCTAssertEqual(model.pixelScale, 0)
        XCTAssertEqual(model.panOffset, .zero)
    }

    func testStepZoomOutAboveToleranceSteps() {
        var model = CanvasZoomModel()
        model.zoomToScale(1.0)
        model.stepZoomOut(context: context)
        XCTAssertEqual(model.pixelScale, 0.8, accuracy: 1e-9)
    }

    func testZoomOutTargetFloorsAtHalfFit() {
        XCTAssertEqual(
            CanvasZoomModel.zoomOutTarget(current: 8.0, fit: 0.25),
            .scale(8.0 / 1.25)
        )
        XCTAssertEqual(
            CanvasZoomModel.zoomOutTarget(current: 0.26, fit: 0.25),
            .snapToFit
        )
    }

    // MARK: - Wheel zoom / pan

    func testWheelZoomInFromFitZoomsAnchored() {
        var model = CanvasZoomModel()
        model.wheelZoom(normalizedDeltaY: 100, location: CGPoint(x: 250, y: 200),
                        context: context)
        let expected = min(0.25 * exp2(100 * CanvasZoomModel.wheelZoomSensitivity), 8)
        XCTAssertEqual(model.pixelScale, expected, accuracy: 1e-9)
        XCTAssertTrue(model.isZoomedIn)
    }

    func testWheelZoomOutSnapsToFitAtThreshold() {
        var model = CanvasZoomModel()
        model.zoomToScale(0.26)
        model.wheelZoom(normalizedDeltaY: -1000, location: CGPoint(x: 500, y: 400),
                        context: context)
        XCTAssertEqual(model.pixelScale, 0, "wheel zoom-out lands back in fit mode")
        XCTAssertEqual(model.panOffset, .zero)
    }

    func testWheelPanOnlyActsWhenZoomed() {
        var model = CanvasZoomModel()
        model.wheelPan(by: CGSize(width: 40, height: 40), context: context)
        XCTAssertEqual(model.panOffset, .zero)

        model.zoomToScale(1.0)
        model.wheelPan(by: CGSize(width: 40, height: -20), context: context)
        XCTAssertEqual(model.panOffset, CGSize(width: 40, height: -20))
    }

    // MARK: - Re-clamp on geometry change

    func testReclampPanPullsPanInsideNewGeometry() {
        var model = CanvasZoomModel()
        model.zoomToScale(1.0)
        model.dragChanged(translation: CGSize(width: 1500, height: 1100), context: context)
        model.dragEnded()
        // Shrink the viewport — wait, a smaller viewport GROWS the legal
        // pan range ((frame − viewport)/2). Use a LARGER viewport so the
        // old pan overshoots the new, smaller range.
        let bigger = CanvasZoomContext(
            viewportPoints: CGSize(width: 3000, height: 2400),
            nativeImageSize: context.nativeImageSize,
            displayScale: 2
        )
        model.reclampPan(context: bigger)
        // At 100%: frame 4000×3000, viewport 3000×2400 → max (500, 300).
        XCTAssertEqual(model.panOffset, CGSize(width: 500, height: 300))
    }

    // MARK: - Wheel-nudge detents

    func testNudgeAccumulatorPreciseDeltasAccumulateToDetents() {
        var acc = CanvasWheelNudgeAccumulator()
        XCTAssertEqual(acc.steps(deltaY: 6, precise: true), 0)
        XCTAssertEqual(acc.steps(deltaY: 6, precise: true), 1, "12pt total = one detent")
        XCTAssertEqual(acc.steps(deltaY: 30, precise: true), 2, "carries the 6pt remainder")
        XCTAssertEqual(acc.steps(deltaY: 6, precise: true), 1)
    }

    func testNudgeAccumulatorLineWheelsPassThroughAsDetents() {
        var acc = CanvasWheelNudgeAccumulator()
        XCTAssertEqual(acc.steps(deltaY: 1, precise: false), 1)
        XCTAssertEqual(acc.steps(deltaY: -3, precise: false), -3)
        XCTAssertEqual(acc.steps(deltaY: 0.4, precise: false), 1,
                       "a physical detent always nudges at least one step")
        XCTAssertEqual(acc.steps(deltaY: 0, precise: false), 0)
    }

    func testNudgeAccumulatorResetDropsRemainder() {
        var acc = CanvasWheelNudgeAccumulator()
        _ = acc.steps(deltaY: 10, precise: true)
        acc.reset()
        XCTAssertEqual(acc.steps(deltaY: 6, precise: true), 0,
                       "remainder from before reset must not carry")
    }

    // MARK: - Degenerate geometry

    func testTransitionsAreSafeWithoutNativeSize() {
        let empty = CanvasZoomContext(
            viewportPoints: CGSize(width: 1000, height: 800),
            nativeImageSize: .zero,
            displayScale: 2
        )
        var model = CanvasZoomModel()
        model.pinchChanged(magnification: 2, location: .zero, context: empty)
        model.pinchEnded(magnification: 2, context: empty)
        model.dragChanged(translation: CGSize(width: 50, height: 50), context: empty)
        // No native size → no display frame → pan stays pinned at zero.
        XCTAssertEqual(model.panOffset, .zero)
        XCTAssertNil(empty.displayFrameInPoints(at: model.pixelScale))
    }

    // MARK: - Live-centroid pinch pan (focal point + pan-while-pinch)

    func testLivePinchPanPureScaleAnchorsAtCentroid() {
        // Centroid fixed at the top-left quadrant; scale doubles. The image
        // point under the centroid must stay put: with a 200×200 viewport,
        // a = centroid − centre = (−50,−50); pan = a − a·2 = −a = (50,50).
        let pan = CanvasZoomModel.livePinchPan(
            liveCentroid: CGPoint(x: 50, y: 50),
            startCentroid: CGPoint(x: 50, y: 50),
            startPan: .zero,
            startScale: 1,
            newScale: 2,
            viewportPoints: CGSize(width: 200, height: 200)
        )
        XCTAssertEqual(pan.width, 50, accuracy: 0.001)
        XCTAssertEqual(pan.height, 50, accuracy: 0.001)
    }

    func testDragResumingAfterPinchDoesNotJumpByPinchTravel() {
        // The simultaneous DragGesture reports `translation` cumulative from
        // the touch-sequence start and does NOT reset when the pinch ends. When
        // a finger keeps dragging after the pinch, the drag must resume from a
        // fresh origin (delta since the pinch ended), not slam the pan by the
        // whole pinch-time finger travel.
        var model = CanvasZoomModel()
        let center = CGPoint(x: 500, y: 400)
        // Pinch in around the centre (→ no pan), while the simultaneous drag
        // fires (suppressed) and accumulates translation to (100, 0).
        model.pinchChanged(magnification: 2.0, location: center, context: context)
        XCTAssertFalse(
            model.dragChanged(translation: CGSize(width: 100, height: 0), context: context),
            "drag must not pan while a pinch owns the gesture"
        )
        model.pinchEnded(magnification: 2.0, context: context)
        let panAfterPinch = model.panOffset
        // One finger keeps dragging: cumulative translation is now (110, 0).
        model.dragChanged(translation: CGSize(width: 110, height: 0), context: context)
        // Pan moved by the 10pt delta since the pinch ended — not the full 110.
        XCTAssertEqual(model.panOffset.width - panAfterPinch.width, 10, accuracy: 1e-6)
        XCTAssertEqual(model.panOffset.height - panAfterPinch.height, 0, accuracy: 1e-6)
    }

    func testLivePinchPanPureCentroidDriftPansByDelta() {
        // No scale change; the centroid drifts by (+30,−20). The pan follows
        // by exactly that delta (pan-while-pinch), regardless of position.
        let pan = CanvasZoomModel.livePinchPan(
            liveCentroid: CGPoint(x: 130, y: 80),
            startCentroid: CGPoint(x: 100, y: 100),
            startPan: CGSize(width: 10, height: 10),
            startScale: 2,
            newScale: 2,
            viewportPoints: CGSize(width: 200, height: 200)
        )
        XCTAssertEqual(pan.width, 40, accuracy: 0.001)
        XCTAssertEqual(pan.height, -10, accuracy: 0.001)
    }
}
