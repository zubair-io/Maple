// CanvasZoomContinuityTests.swift — #5717 audit (#5736–#5742).
//
// Only finger or pointer motion moves the photo. A command, a geometry
// change or a lost gesture end continues from exactly what is on screen, and
// a deliberate zoom is reported to the host as a move to animate. Drives the
// controller the way the iOS `CanvasZoomHost` does: a capture frame, then
// `gestureTransform` per finger frame with the committed frame frozen.

import CoreGraphics
import XCTest

@testable import MapleCore

@MainActor
final class CanvasZoomContinuityTests: XCTestCase {

  private let viewport = CGSize(width: 1000, height: 800)

  /// 4000×2000 at 1×: fit 0.25.
  private func makeController(displayScale: CGFloat = 1) -> CanvasZoomController {
    let session = EditSession.preview()
    session.nativeImageSize = CGSize(width: 4000, height: 2000)
    let controller = CanvasZoomController(session: session)
    controller.viewportChanged(points: viewport, displayScale: displayScale)
    return controller
  }

  private func assertFrame(
    _ actual: (zoom: CGFloat, committedPan: CGSize), scale: CGFloat, pan: CGSize,
    on controller: CanvasZoomController, file: StaticString = #filePath, line: UInt = #line
  ) {
    XCTAssertEqual(
      controller.effectivePixelScale * actual.zoom, scale, accuracy: 1e-9, file: file, line: line)
    XCTAssertEqual(actual.committedPan.width, pan.width, accuracy: 1e-9, file: file, line: line)
    XCTAssertEqual(actual.committedPan.height, pan.height, accuracy: 1e-9, file: file, line: line)
  }

  // MARK: - #5736: geometry changes mid-pinch

  func testAViewportChangeMidPinchKeepsTheLiveFrame() {
    let controller = makeController()
    controller.zoomToScale(0.5)
    let fingers = CGPoint(x: 300, y: 400)
    controller.pinchChanged(magnification: 1, location: fingers)
    let shown = controller.gestureTransform(magnification: 2, liveCentroid: fingers)
    assertFrame(shown, scale: 1, pan: CGSize(width: 200, height: 0), on: controller)

    controller.viewportChanged(points: CGSize(width: 700, height: 800), displayScale: 1)
    let next = controller.gestureTransform(magnification: 2, liveCentroid: fingers)
    assertFrame(next, scale: 1, pan: CGSize(width: 200, height: 0), on: controller)
  }

  // MARK: - #5737: commands mid-pinch

  func testFitDuringAPinchIsNotUndoneByTheNextFrame() {
    let controller = makeController()
    let fingers = CGPoint(x: 500, y: 400)
    controller.pinchChanged(magnification: 1, location: fingers)
    _ = controller.gestureTransform(magnification: 2, liveCentroid: fingers)
    controller.resetToFit()
    let next = controller.gestureTransform(magnification: 2.01, liveCentroid: fingers)
    assertFrame(next, scale: 0.25 * 2.01 / 2, pan: .zero, on: controller)
  }

  // MARK: - #5738, #5739: drags

  func testAWheelPanDuringADragDoesNotDoubleTheDrag() {
    let controller = makeController()
    controller.zoomToFill()
    controller.dragBegan()
    controller.dragChanged(translation: CGSize(width: -100, height: 0))
    controller.wheelPan(delta: CGSize(width: -48, height: 0))
    controller.dragChanged(translation: CGSize(width: -101, height: 0))
    XCTAssertEqual(controller.panOffset.width, -149, accuracy: 1e-9)
  }

  func testADragAfterACancelledDragContinuesFromTheScreen() {
    let controller = makeController()
    controller.zoomToScale(1)
    controller.dragBegan()
    controller.dragChanged(translation: CGSize(width: 100, height: 0))
    controller.dragBegan()
    controller.dragChanged(translation: CGSize(width: 1, height: 0))
    XCTAssertEqual(controller.panOffset.width, 101, accuracy: 1e-9)
  }

  func testACancelledDragCommitsWhereItIs() {
    let controller = makeController()
    controller.zoomToScale(1)
    controller.dragBegan()
    controller.dragChanged(translation: CGSize(width: 100, height: 0))
    controller.gesturesCancelled()
    XCTAssertEqual(controller.model.basePan.width, 100, accuracy: 1e-9)
    XCTAssertNil(controller.model.dragLastTranslation)
  }

  // MARK: - #5740: display density

  func testMovingToADenserDisplayKeepsTheCentredImagePoint() {
    let session = EditSession.preview()
    session.nativeImageSize = CGSize(width: 6000, height: 4000)
    let controller = CanvasZoomController(session: session)
    controller.viewportChanged(points: viewport, displayScale: 1)
    controller.zoomToScale(1)
    controller.keyboardPan(delta: CGSize(width: 1000, height: 0))
    controller.viewportChanged(points: viewport, displayScale: 2)
    XCTAssertEqual(controller.model.pixelScale, 1)
    XCTAssertEqual(controller.panOffset.width, 500, accuracy: 1e-9)
  }

  // MARK: - #5741, #5742: deliberate zooms animate from what is shown

  func testCommandsReportAMoveFromTheFrameShownBefore() throws {
    let controller = makeController()
    let atFit = controller.restingFrame
    controller.doubleTap(at: CGPoint(x: 300, y: 400), behavior: .toggleFitAnd100)
    let move = try XCTUnwrap(controller.commandedMove)
    XCTAssertEqual(move.from, atFit)
    XCTAssertEqual(controller.restingFrame.scale, 1)

    controller.zoomToScale(1)
    let recentred = try XCTUnwrap(controller.commandedMove)
    XCTAssertEqual(recentred.serial, move.serial + 1, "⌘1 re-centres the tapped zoom")
    controller.zoomToScale(1)
    XCTAssertEqual(controller.commandedMove, recentred, "no move, nothing to animate")
    controller.stepZoomIn()
    XCTAssertEqual(controller.commandedMove?.serial, recentred.serial + 1)
  }

  func testGestureFramesAreNotCommandedMoves() {
    let controller = makeController()
    controller.zoomToScale(1)
    let move = controller.commandedMove
    controller.dragBegan()
    controller.dragChanged(translation: CGSize(width: 40, height: 0))
    controller.dragEnded()
    controller.pinchChanged(magnification: 1, location: CGPoint(x: 500, y: 400))
    controller.pinchChanged(magnification: 1.3, location: CGPoint(x: 500, y: 400))
    controller.pinchEnded(magnification: 1.3)
    XCTAssertEqual(controller.commandedMove, move)
  }

  func testTheWheelLandingOnFitIsAnimatedButOrdinaryWheelZoomIsNot() {
    let controller = makeController()
    controller.wheelZoom(normalizedDeltaY: 40, location: CGPoint(x: 500, y: 400))
    XCTAssertNil(controller.commandedMove)
    controller.wheelZoom(normalizedDeltaY: -400, location: CGPoint(x: 500, y: 400))
    XCTAssertFalse(controller.isZoomedIn)
    XCTAssertNotNil(controller.commandedMove)
  }

  /// #5742: at fit, double-tap to 100% and pinch halfway through the
  /// animation. The pinch starts from the frame drawn at that instant.
  func testAPinchDuringTheDoubleTapAnimationStartsFromTheShownFrame() throws {
    let controller = makeController()
    controller.doubleTap(at: CGPoint(x: 300, y: 400), behavior: .toggleFitAnd100)
    let move = try XCTUnwrap(controller.commandedMove)
    let start = Date()
    let animation = try XCTUnwrap(
      CanvasSettleAnimation(from: move.from, to: controller.restingFrame, start: start))
    let shown = animation.shown(at: start + CanvasSettleAnimation.duration / 4)
    XCTAssertGreaterThan(shown.scale, 0.25)
    XCTAssertLessThan(shown.scale, 1)

    controller.holdShownFrame(shown)
    let fingers = CGPoint(x: 420, y: 380)
    controller.pinchChanged(magnification: 1, location: fingers)
    let first = controller.gestureTransform(magnification: 1, liveCentroid: fingers)
    assertFrame(first, scale: shown.scale, pan: shown.pan, on: controller)
    let spread = controller.gestureTransform(magnification: 1.0001, liveCentroid: fingers)
    let anchorBefore = (fingers.x - viewport.width / 2 - shown.pan.width) / shown.scale
    let liveScale = controller.effectivePixelScale * spread.zoom
    let anchorAfter = (fingers.x - viewport.width / 2 - spread.committedPan.width) / liveScale
    XCTAssertEqual(anchorAfter, anchorBefore, accuracy: 1e-9)
  }
}
