// CanvasZoomStopsTests.swift — #5710.
//
// The below-fit floor, the fill stop, the pinch detents at fit and fill,
// and the badge's fit → fill → 100% cycle. Pure value-type tests.

import CoreGraphics
import XCTest

@testable import MapleCore

final class CanvasZoomStopsTests: XCTestCase {

    /// 1000×800pt @2× over a square 6000×6000 image: viewportPx 2000×1600,
    /// fit = 1600/6000 = 0.2667, fill = 2000/6000 = 0.3333 — far enough
    /// apart that the detent bands do not overlap. Fill frame 1000×1000pt
    /// overflows the viewport vertically only.
    private let square = CanvasZoomContext(
        viewportPoints: CGSize(width: 1000, height: 800),
        nativeImageSize: CGSize(width: 6000, height: 6000),
        displayScale: 2
    )
    private var fit: CGFloat { 1600.0 / 6000.0 }
    private var fill: CGFloat { 2000.0 / 6000.0 }

    /// The 8000×6000 fixture of `CanvasZoomModelTests`: fit 0.25, fill
    /// 0.2667, so the two detent bands overlap.
    private let landscape = CanvasZoomContext(
        viewportPoints: CGSize(width: 1000, height: 800),
        nativeImageSize: CGSize(width: 8000, height: 6000),
        displayScale: 2
    )

    // MARK: - Geometry

    func testFillScaleCoversTheViewport() {
        XCTAssertEqual(square.fillScale, fill, accuracy: 1e-9)
        XCTAssertEqual(landscape.fillScale, 1600.0 / 6000.0, accuracy: 1e-9)
        let frame = try! XCTUnwrap(square.displayFrameInPoints(at: square.fillScale))
        XCTAssertGreaterThanOrEqual(frame.width, square.viewportPoints.width - 1e-9)
        XCTAssertGreaterThanOrEqual(frame.height, square.viewportPoints.height - 1e-9)
    }

    func testFillScaleIsCappedAtMaxZoom() {
        let sliver = CanvasZoomContext(
            viewportPoints: CGSize(width: 1000, height: 800),
            nativeImageSize: CGSize(width: 20000, height: 100),
            displayScale: 2
        )
        XCTAssertEqual(sliver.fillScale, CanvasZoomModel.maxPixelScale)
    }

    func testMinScaleIsHalfOfFit() {
        XCTAssertEqual(square.minScale, fit * 0.5, accuracy: 1e-9)
    }

    // MARK: - Below fit

    func testPinchReleaseBelowFitStaysBelowFitCentred() {
        var model = CanvasZoomModel()
        model.pinchChanged(magnification: 0.7, location: CGPoint(x: 100, y: 100), context: square)
        model.pinchEnded(magnification: 0.7, context: square)
        XCTAssertEqual(model.pixelScale, fit * 0.7, accuracy: 1e-9)
        XCTAssertEqual(model.panOffset, .zero, "an image smaller than the viewport stays centred")
        XCTAssertTrue(model.isZoomedIn)
        XCTAssertNil(model.currentStop)
    }

    func testPinchReleaseAtFloorStaysAtFloor() {
        var model = CanvasZoomModel()
        model.pinchChanged(magnification: 0.1, location: .zero, context: square)
        model.pinchEnded(magnification: 0.1, context: square)
        XCTAssertEqual(model.pixelScale, square.minScale, accuracy: 1e-9)
    }

    func testBelowFitInputsBelongToTheEditingSurface() {
        var model = CanvasZoomModel()
        model.pinchChanged(magnification: 0.6, location: .zero, context: square)
        model.pinchEnded(magnification: 0.6, context: square)
        XCTAssertEqual(model.dragIntent(context: square), .editing)
        XCTAssertEqual(model.wheelIntent(commandHeld: false, context: square), .editing)
        XCTAssertEqual(model.wheelIntent(commandHeld: true, context: square), .zoom)
        XCTAssertFalse(
            model.dragChanged(translation: CGSize(width: 300, height: -200), context: square))
        XCTAssertEqual(model.panOffset, .zero)
        model.wheelPan(by: CGSize(width: 50, height: 50), context: square)
        XCTAssertEqual(model.panOffset, .zero)
    }

    func testDoubleTapFromBelowFitReturnsToFit() {
        var model = CanvasZoomModel()
        model.stepZoomOut(context: square)
        model.doubleTap(at: .zero, behavior: .toggleFitAnd100, context: square)
        XCTAssertEqual(model.pixelScale, 0)
    }

    func testStepZoomOutFromFitGoesBelowFitToTheFloor() {
        var model = CanvasZoomModel()
        model.stepZoomOut(context: square)
        XCTAssertEqual(model.pixelScale, fit / 1.25, accuracy: 1e-9)
        (0..<10).forEach { _ in model.stepZoomOut(context: square) }
        XCTAssertEqual(model.pixelScale, square.minScale, accuracy: 1e-9)
    }

    func testStepZoomInFromBelowFitSettlesOnFit() {
        var model = CanvasZoomModel()
        model.stepZoomOut(context: square)
        model.stepZoomIn(context: square)
        XCTAssertEqual(model.pixelScale, 0, "crossing fit lands in fit mode")
        model.stepZoomIn(context: square)
        XCTAssertEqual(model.pixelScale, fit * 1.25, accuracy: 1e-9)
    }

    func testStepZoomInThatWouldJumpPastFitSettlesOnFit() {
        var model = CanvasZoomModel()
        model.zoomToScale(fit * 0.88)
        model.stepZoomIn(context: square)
        XCTAssertEqual(model.pixelScale, 0, "1.1 × fit would skip fit; it settles there")
    }

    func testStepZoomOutFromJustAboveFitSettlesOnFit() {
        XCTAssertEqual(CanvasZoomModel.zoomOutTarget(current: 0.255, fit: 0.25), .snapToFit)
        var model = CanvasZoomModel()
        model.zoomToScale(fit * 1.02)
        model.stepZoomOut(context: square)
        XCTAssertEqual(model.pixelScale, 0)
    }

    func testWheelZoomOutFromFitReachesTheFloorAndBackThroughFit() {
        var model = CanvasZoomModel()
        let centre = CGPoint(x: 500, y: 400)
        model.wheelZoom(normalizedDeltaY: -1000, location: centre, context: square)
        XCTAssertEqual(model.pixelScale, square.minScale, accuracy: 1e-9)
        XCTAssertEqual(model.panOffset, .zero)
        model.wheelZoom(normalizedDeltaY: 1000, location: centre, context: square)
        XCTAssertEqual(model.pixelScale, 0, "zooming in across fit stops at fit once")
        model.wheelZoom(normalizedDeltaY: 10, location: centre, context: square)
        XCTAssertGreaterThan(model.pixelScale, fit)
    }

    func testCrossesFit() {
        XCTAssertTrue(CanvasZoomModel.crossesFit(from: 0.3, to: 0.2, fit: 0.25))
        XCTAssertTrue(CanvasZoomModel.crossesFit(from: 0.2, to: 0.25, fit: 0.25))
        XCTAssertFalse(CanvasZoomModel.crossesFit(from: 0.25, to: 0.2, fit: 0.25))
        XCTAssertFalse(CanvasZoomModel.crossesFit(from: 0.25, to: 0.3, fit: 0.25))
        XCTAssertFalse(CanvasZoomModel.crossesFit(from: 0.3, to: 0.4, fit: 0.25))
        XCTAssertTrue(CanvasZoomModel.crossesFit(from: 0.2, to: 0.241, fit: 0.25))
        XCTAssertTrue(CanvasZoomModel.crossesFit(from: 0.26, to: 0.258, fit: 0.25))
        XCTAssertFalse(
            CanvasZoomModel.crossesFit(from: 0.2525, to: 0.255, fit: 0.25),
            "a small step away from fit is never pulled back to it")
    }

    // MARK: - Pinch detents

    func testPinchScaleSettlesOnFitAndFillInsideTheirBands() {
        let start = fit
        XCTAssertEqual(
            CanvasZoomModel.pinchScale(start: start, magnification: 1.03, fit: fit, fill: fill), fit)
        XCTAssertEqual(
            CanvasZoomModel.pinchScale(
                start: start, magnification: fill / fit * 0.97, fit: fit, fill: fill),
            fill)
        XCTAssertEqual(
            CanvasZoomModel.pinchScale(start: start, magnification: 1.12, fit: fit, fill: fill),
            fit * 1.12, accuracy: 1e-9, "between the bands the pinch is continuous")
        XCTAssertEqual(
            CanvasZoomModel.pinchScale(start: start, magnification: 0.8, fit: fit, fill: fill),
            fit * 0.8, accuracy: 1e-9)
    }

    func testOverlappingBandsPickTheNearerStopAndFitWinsATie() {
        let fit: CGFloat = 0.25
        let fill: CGFloat = 0.26
        XCTAssertEqual(CanvasZoomModel.detent(for: 0.252, fit: fit, fill: fill), .fit)
        XCTAssertEqual(CanvasZoomModel.detent(for: 0.259, fit: fit, fill: fill), .fill)
        XCTAssertEqual(CanvasZoomModel.detent(for: 0.25, fit: 0.25, fill: 0.25), .fit)
    }

    func testPinchReleaseNearFillSettlesOnFill() {
        var model = CanvasZoomModel()
        let magnification = fill / fit * 1.02
        model.pinchChanged(magnification: magnification, location: CGPoint(x: 500, y: 400), context: square)
        XCTAssertEqual(model.pixelScale, fill, accuracy: 1e-9, "the live frame sits on the detent")
        model.pinchEnded(magnification: magnification, context: square)
        XCTAssertEqual(model.pixelScale, fill, accuracy: 1e-9)
        XCTAssertTrue(model.fillsViewport)
        XCTAssertEqual(model.currentStop, .fill)
        XCTAssertEqual(model.basePan, model.panOffset)
    }

    func testPinchAwayFromFillClearsTheFillStop() {
        var model = CanvasZoomModel()
        model.zoomToFill(context: square)
        model.pinchChanged(magnification: 2, location: CGPoint(x: 500, y: 400), context: square)
        model.pinchEnded(magnification: 2, context: square)
        XCTAssertFalse(model.fillsViewport)
        XCTAssertEqual(model.pixelScale, fill * 2, accuracy: 1e-9)
    }

    func testPinchJustBelowFitSettlesOnFitLiveAndOnRelease() {
        var model = CanvasZoomModel()
        model.pinchChanged(magnification: 0.97, location: CGPoint(x: 300, y: 200), context: square)
        XCTAssertEqual(model.pixelScale, fit, accuracy: 1e-12)
        model.pinchEnded(magnification: 0.97, context: square)
        XCTAssertEqual(model.pixelScale, 0)
        XCTAssertEqual(model.panOffset, .zero)
    }

    func testPinchReleaseWithoutAChangeFrameNearFillSettlesOnFill() {
        var model = CanvasZoomModel()
        model.zoomToScale(fill * 1.01)
        model.pinchEnded(magnification: 1, context: square)
        XCTAssertEqual(model.pixelScale, fill, accuracy: 1e-12)
        XCTAssertEqual(model.currentStop, .fill)
        XCTAssertEqual(model.panOffset, square.clampedPan(model.panOffset, at: fill))
    }

    func testPinchReleaseWithoutAChangeFrameStillHonoursTheFitDetent() {
        var model = CanvasZoomModel()
        model.zoomToScale(fit * 1.01)
        model.pinchEnded(magnification: 1, context: square)
        XCTAssertEqual(model.pixelScale, 0)
    }

    // MARK: - Fill

    func testZoomToFillCentresAndPansOnlyTheOverflowingAxis() {
        var model = CanvasZoomModel()
        model.zoomToFill(context: square)
        XCTAssertEqual(model.pixelScale, fill, accuracy: 1e-9)
        XCTAssertEqual(model.panOffset, .zero)
        XCTAssertEqual(square.maxPanOffset(at: model.pixelScale).width, 0, accuracy: 1e-9)
        XCTAssertEqual(square.maxPanOffset(at: model.pixelScale).height, 100, accuracy: 1e-9)
        model.dragChanged(translation: CGSize(width: 400, height: 400), context: square)
        XCTAssertEqual(model.panOffset.width, 0, accuracy: 1e-9)
        XCTAssertEqual(model.panOffset.height, 100, accuracy: 1e-9)
    }

    func testFillFollowsAViewportRotation() {
        var model = CanvasZoomModel()
        model.zoomToFill(context: square)
        model.dragChanged(translation: CGSize(width: 0, height: 100), context: square)
        model.dragEnded()
        XCTAssertEqual(model.panOffset, CGSize(width: 0, height: 100))
        let portrait = CanvasZoomContext(
            viewportPoints: CGSize(width: 800, height: 1000),
            nativeImageSize: CGSize(width: 6000, height: 6000),
            displayScale: 2
        )
        model.reclampPan(context: portrait)
        XCTAssertEqual(model.pixelScale, portrait.fillScale, accuracy: 1e-9)
        XCTAssertTrue(model.fillsViewport)
        XCTAssertEqual(model.panOffset, .zero, "portrait fill overflows horizontally only")
        XCTAssertEqual(model.basePan, .zero)
    }

    func testFillThatComesToMatchFitOnResizeBecomesFit() {
        var model = CanvasZoomModel()
        model.zoomToFill(context: square)
        let matching = CanvasZoomContext(
            viewportPoints: CGSize(width: 900, height: 900),
            nativeImageSize: CGSize(width: 6000, height: 6000),
            displayScale: 2
        )
        model.reclampPan(context: matching)
        XCTAssertEqual(model.pixelScale, 0)
        XCTAssertEqual(model.currentStop, .fit)
        model.advanceStop(context: matching)
        XCTAssertEqual(model.currentStop, .actualSize)
    }

    func testFillChosenBeforeTheImageSizeIsKnownResolvesOnceItLands() {
        let unsized = CanvasZoomContext(
            viewportPoints: CGSize(width: 1000, height: 800),
            nativeImageSize: .zero,
            displayScale: 2
        )
        var model = CanvasZoomModel()
        model.zoomToFill(context: unsized)
        XCTAssertEqual(model.pixelScale, 1)
        model.reclampPan(context: square)
        XCTAssertEqual(model.pixelScale, fill, accuracy: 1e-9)
        XCTAssertTrue(model.fillsViewport)
    }

    func testAScaleRelativeToFillIsNotReResolvedOnResize() {
        var model = CanvasZoomModel()
        model.zoomToFill(context: square)
        model.pinchChanged(magnification: 2, location: CGPoint(x: 500, y: 400), context: square)
        model.pinchEnded(magnification: 2, context: square)
        model.reclampPan(context: landscape)
        XCTAssertEqual(model.pixelScale, fill * 2, accuracy: 1e-9)
    }

    func testFreeScaleIsNotReResolvedOnResize() {
        var model = CanvasZoomModel()
        model.zoomToScale(0.5)
        model.reclampPan(context: landscape)
        XCTAssertEqual(model.pixelScale, 0.5)
        XCTAssertFalse(model.fillsViewport)
    }

    func testEveryOtherTransitionClearsTheFillStop() {
        let transitions: [(inout CanvasZoomModel) -> Void] = [
            { $0.resetToFit() },
            { $0.zoomToScale(1) },
            { $0.stepZoomIn(context: self.square) },
            { $0.stepZoomOut(context: self.square) },
            { $0.wheelZoom(normalizedDeltaY: 50, location: .zero, context: self.square) },
            { $0.doubleTap(at: .zero, behavior: .toggleFitAnd100, context: self.square) },
        ]
        transitions.forEach { transition in
            var model = CanvasZoomModel()
            model.zoomToFill(context: square)
            transition(&model)
            XCTAssertFalse(model.fillsViewport)
        }
    }

    // MARK: - Badge cycle

    func testBadgeCyclesFitFillActualSize() {
        var model = CanvasZoomModel()
        XCTAssertEqual(model.currentStop, .fit)
        model.advanceStop(context: square)
        XCTAssertEqual(model.currentStop, .fill)
        XCTAssertEqual(model.pixelScale, fill, accuracy: 1e-9)
        model.advanceStop(context: square)
        XCTAssertEqual(model.currentStop, .actualSize)
        XCTAssertEqual(model.pixelScale, 1)
        XCTAssertEqual(model.panOffset, .zero)
        model.advanceStop(context: square)
        XCTAssertEqual(model.currentStop, .fit)
        XCTAssertEqual(model.pixelScale, 0)
    }

    func testBadgeFromAFreeScaleReturnsToFit() {
        var below = CanvasZoomModel()
        below.stepZoomOut(context: square)
        below.advanceStop(context: square)
        XCTAssertEqual(below.pixelScale, 0)

        var zoomed = CanvasZoomModel()
        zoomed.zoomToScale(3)
        zoomed.advanceStop(context: square)
        XCTAssertEqual(zoomed.pixelScale, 0)
    }

    func testBadgeSkipsAFillThatCoincidesWithFit() {
        let matching = CanvasZoomContext(
            viewportPoints: CGSize(width: 1000, height: 800),
            nativeImageSize: CGSize(width: 5000, height: 4000),
            displayScale: 2
        )
        XCTAssertEqual(CanvasZoomModel.badgeStops(context: matching), [.fit, .actualSize])
        var model = CanvasZoomModel()
        model.advanceStop(context: matching)
        XCTAssertEqual(model.currentStop, .actualSize)
    }

    func testBadgeOnASmallImageKeepsTheTrue100PercentStop() {
        let small = CanvasZoomContext(
            viewportPoints: CGSize(width: 1000, height: 800),
            nativeImageSize: CGSize(width: 400, height: 300),
            displayScale: 2
        )
        XCTAssertEqual(CanvasZoomModel.badgeStops(context: small), [.fit, .fill, .actualSize])
        var model = CanvasZoomModel()
        model.advanceStop(context: small)
        model.advanceStop(context: small)
        XCTAssertEqual(
            model.pixelScale, 1,
            "100% shows true pixels even when that is smaller than the pinch floor")
        model.advanceStop(context: small)
        XCTAssertEqual(model.pixelScale, 0)
    }

    func testDistinctStops() {
        XCTAssertEqual(
            CanvasZoomModel.distinctStops(fit: 0.25, fill: 0.4, actualSize: 1),
            [.fit, .fill, .actualSize])
        XCTAssertEqual(
            CanvasZoomModel.distinctStops(fit: 1.0, fill: 1.5, actualSize: 1),
            [.fit, .fill], "a small image that fits at 100% has no separate 100% stop")
        XCTAssertEqual(
            CanvasZoomModel.distinctStops(fit: 0.5, fill: 1.01, actualSize: 1),
            [.fit, .fill], "100% coinciding with fill is the fill stop")
        XCTAssertEqual(
            CanvasZoomModel.distinctStops(fit: 1, fill: 1.4, actualSize: nil), [.fit, .fill])
    }

    func testNextStopWrapsAndFallsBackToFit() {
        let stops: [CanvasZoomModel.ZoomStop] = [.fit, .fill, .actualSize]
        XCTAssertEqual(CanvasZoomModel.nextStop(after: .fit, in: stops), .fill)
        XCTAssertEqual(CanvasZoomModel.nextStop(after: .actualSize, in: stops), .fit)
        XCTAssertEqual(CanvasZoomModel.nextStop(after: nil, in: stops), .fit)
        XCTAssertEqual(CanvasZoomModel.nextStop(after: .fill, in: [.fit]), .fit)
    }
}
