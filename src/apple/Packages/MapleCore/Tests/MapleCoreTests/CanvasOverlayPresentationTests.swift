// CanvasOverlayPresentationTests.swift — #5743, #5744.
//
// Every canvas overlay is placed through the exact transform the photo is
// shown with, in the same frame: the live iOS pinch, a settle animation and
// a commanded zoom. The crop overlay is fit-only, so zoom is held at fit
// while the Crop tool is armed.

import CoreGraphics
import XCTest

@testable import MapleCore

@MainActor
final class CanvasOverlayPresentationTests: XCTestCase {

  private let viewport = CGSize(width: 1000, height: 800)

  /// 4000×2000 at 1×: fit 0.25, fill 0.4.
  private func makeController() -> CanvasZoomController {
    let session = EditSession.preview()
    session.nativeImageSize = CGSize(width: 4000, height: 2000)
    let controller = CanvasZoomController(session: session)
    controller.viewportChanged(points: viewport, displayScale: 1)
    return controller
  }

  /// Where the canvas leaf lands: framed at the committed display frame,
  /// centred, scaled about its centre and offset (`CanvasSettleTransform`).
  private func photoRect(_ controller: CanvasZoomController, at date: Date) -> CGRect {
    let frame = controller.displayFrameInPoints ?? .zero
    let shown = controller.presentedTransform(at: date)
    let size = CGSize(width: frame.width * shown.zoom, height: frame.height * shown.zoom)
    return CGRect(
      x: viewport.width / 2 + shown.pan.width - size.width / 2,
      y: viewport.height / 2 + shown.pan.height - size.height / 2,
      width: size.width, height: size.height)
  }

  /// Where an overlay places the photo (`MaskOverlay`, `RetouchOverlay`).
  private func overlayRect(_ controller: CanvasZoomController, at date: Date) -> CGRect? {
    controller.presentedGeometry(at: date).map {
      MaskOverlayGeometry.displayRect(
        containerSize: viewport, displayFrame: $0.displayFrame, panOffset: $0.panOffset)
    }
  }

  private func assertRect(
    _ actual: CGRect?, _ expected: CGRect, file: StaticString = #filePath, line: UInt = #line
  ) {
    guard let actual else { return XCTFail("no overlay geometry", file: file, line: line) }
    XCTAssertEqual(actual.minX, expected.minX, accuracy: 1e-6, file: file, line: line)
    XCTAssertEqual(actual.minY, expected.minY, accuracy: 1e-6, file: file, line: line)
    XCTAssertEqual(actual.width, expected.width, accuracy: 1e-6, file: file, line: line)
    XCTAssertEqual(actual.height, expected.height, accuracy: 1e-6, file: file, line: line)
  }

  /// The photo's rect at a drawn scale and pan.
  private func rect(scale: CGFloat, pan: CGSize) -> CGRect {
    let size = CGSize(width: 4000 * scale, height: 2000 * scale)
    return CGRect(
      x: viewport.width / 2 + pan.width - size.width / 2,
      y: viewport.height / 2 + pan.height - size.height / 2,
      width: size.width, height: size.height)
  }

  // MARK: - #5744: the live iOS pinch

  func testOverlaysFollowTheLivePinchNotTheFrozenFrame() {
    let controller = makeController()
    let start = CGPoint(x: 300, y: 300)
    let live = CGPoint(x: 340, y: 320)
    controller.pinchChanged(magnification: 1, location: start)
    let transform = controller.gestureTransform(magnification: 2.4, liveCentroid: live)
    let now = Date()

    let frozen = controller.displayFrameInPoints ?? .zero
    let shown = rect(
      scale: controller.effectivePixelScale * transform.zoom, pan: transform.committedPan)
    XCTAssertEqual(frozen.width, 1000, accuracy: 1e-9, "the committed frame stays frozen")
    assertRect(overlayRect(controller, at: now), shown)
    assertRect(photoRect(controller, at: now), shown)

    // The release commits exactly the frame the overlays drew.
    controller.pinchChanged(magnification: 2.4, location: live)
    controller.pinchEnded(magnification: 2.4)
    XCTAssertNil(controller.presentation.livePinch)
    assertRect(overlayRect(controller, at: now), shown)
  }

  func testAFingerChangeMidPinchMovesOverlaysWithThePhoto() {
    let controller = makeController()
    controller.pinchChanged(magnification: 1, location: CGPoint(x: 500, y: 400))
    _ = controller.gestureTransform(magnification: 2, liveCentroid: CGPoint(x: 500, y: 400))
    controller.pinchRebased(
      shownMagnification: 2, shownLocation: CGPoint(x: 500, y: 400),
      magnification: 2.1, location: CGPoint(x: 560, y: 380))
    _ = controller.gestureTransform(magnification: 2.3, liveCentroid: CGPoint(x: 580, y: 390))
    let now = Date()
    assertRect(overlayRect(controller, at: now), photoRect(controller, at: now))
  }

  // MARK: - Settle animations

  func testOverlaysFollowTheSettleAnimationFrameByFrame() throws {
    let controller = makeController()
    controller.zoomToScale(0.6)
    controller.wheelPan(delta: CGSize(width: 300, height: 100))
    let shownBefore = controller.restingFrame
    controller.resetToFit()
    let start = Date()
    let settle = try XCTUnwrap(
      CanvasSettleAnimation(from: shownBefore, to: controller.restingFrame, start: start))
    controller.showSettle(settle)

    for elapsed in [0, 0.05, 0.12, 0.2, 0.3, CanvasSettleAnimation.duration] {
      let date = start.addingTimeInterval(elapsed)
      let frame = settle.shown(at: date)
      let expected = rect(scale: frame.scale, pan: frame.pan)
      assertRect(overlayRect(controller, at: date), expected)
      assertRect(photoRect(controller, at: date), expected)
    }
    assertRect(overlayRect(controller, at: start), rect(scale: 0.6, pan: shownBefore.pan))
  }

  func testAFinishedSettleClearsItself() async throws {
    let controller = makeController()
    controller.zoomToScale(0.6)
    let shownBefore = controller.restingFrame
    controller.resetToFit()
    controller.showSettle(
      CanvasSettleAnimation(from: shownBefore, to: controller.restingFrame, start: Date()))
    XCTAssertNotNil(controller.presentation.settle)
    try await Task.sleep(for: .seconds(CanvasSettleAnimation.duration + 0.25))
    XCTAssertNil(controller.presentation.settle)
    assertRect(overlayRect(controller, at: Date()), rect(scale: 0.25, pan: .zero))
  }

  // MARK: - Commanded zooms

  func testACommandedZoomMovesOverlaysFromTheShownFrame() throws {
    let controller = makeController()
    controller.stepZoomIn()
    let move = try XCTUnwrap(controller.commandedMove)
    let start = Date()
    // The host animates the command from the frame shown before it.
    controller.showSettle(
      CanvasSettleAnimation(from: move.from, to: controller.restingFrame, start: start))

    assertRect(overlayRect(controller, at: start), rect(scale: 0.25, pan: .zero))
    let mid = start.addingTimeInterval(0.1)
    assertRect(overlayRect(controller, at: mid), photoRect(controller, at: mid))
    let end = start.addingTimeInterval(CanvasSettleAnimation.duration)
    assertRect(
      overlayRect(controller, at: end),
      rect(scale: controller.effectivePixelScale, pan: controller.panOffset))
  }

  func testACommandDuringALivePinchKeepsOverlaysOnTheLiveFrame() {
    let controller = makeController()
    let fingers = CGPoint(x: 400, y: 400)
    controller.pinchChanged(magnification: 1, location: fingers)
    _ = controller.gestureTransform(magnification: 2, liveCentroid: fingers)
    controller.stepZoomIn()
    let transform = controller.gestureTransform(magnification: 2, liveCentroid: fingers)
    let now = Date()
    assertRect(
      overlayRect(controller, at: now),
      rect(scale: controller.effectivePixelScale * transform.zoom, pan: transform.committedPan))
  }

  func testAnAssetChangeDropsThePresentation() throws {
    let controller = makeController()
    controller.pinchChanged(magnification: 1, location: CGPoint(x: 500, y: 400))
    _ = controller.gestureTransform(magnification: 2, liveCentroid: CGPoint(x: 500, y: 400))
    controller.showSettle(
      CanvasSettleAnimation(
        from: CanvasShownFrame(scale: 0.5, pan: .zero), to: controller.restingFrame,
        start: Date()))
    controller.assetChanged()
    XCTAssertEqual(controller.presentation, CanvasPresentation())
  }

  // MARK: - #5743: zoom is held at fit while cropping

  private func makeCropState() -> EditorState {
    let session = EditSession.preview()
    session.nativeImageSize = CGSize(width: 4000, height: 2000)
    let state = EditorState(session: session)
    state.zoom.viewportChanged(points: viewport, displayScale: 1)
    return state
  }

  func testZoomCommandsDoNothingWhileCropping() {
    let state = makeCropState()
    let router = EditorCommandRouter(state: state)
    state.arm(tool: .crop)
    XCTAssertTrue(state.zoom.isZoomLocked)
    for command: EditorCommandRouter.Command in [.zoomIn, .actualSize] {
      router.perform(command, assetID: state.session.asset.id)
      XCTAssertFalse(state.zoom.isZoomedIn, "\(command) zoomed the photo under the crop overlay")
    }
    state.zoom.zoomToFill()
    state.zoom.advanceZoomStop()
    state.zoom.doubleTap(at: CGPoint(x: 200, y: 200), behavior: .toggleFitAnd100)
    state.zoom.wheelZoom(normalizedDeltaY: 200, location: CGPoint(x: 300, y: 300))
    XCTAssertFalse(state.zoom.isZoomedIn)
    XCTAssertEqual(state.zoom.panOffset, .zero)
    XCTAssertNil(state.zoom.commandedMove)
  }

  func testAPinchDoesNothingWhileCropping() {
    let state = makeCropState()
    state.arm(tool: .crop)
    let fingers = CGPoint(x: 300, y: 300)
    state.zoom.pinchChanged(magnification: 1, location: fingers)
    let transform = state.zoom.gestureTransform(magnification: 3, liveCentroid: fingers)
    XCTAssertEqual(transform.zoom, 1)
    XCTAssertNil(state.zoom.presentation.livePinch)
    state.zoom.pinchChanged(magnification: 3, location: fingers)
    state.zoom.pinchEnded(magnification: 3)
    XCTAssertFalse(state.zoom.isZoomedIn)
    assertRect(overlayRect(state.zoom, at: Date()), rect(scale: 0.25, pan: .zero))
  }

  func testArmingCropMidPinchEndsThePinchAtFit() {
    let state = makeCropState()
    let fingers = CGPoint(x: 300, y: 300)
    state.zoom.pinchChanged(magnification: 1, location: fingers)
    _ = state.zoom.gestureTransform(magnification: 3, liveCentroid: fingers)
    state.arm(tool: .crop)
    XCTAssertNil(state.zoom.model.pinchStartScale)
    XCTAssertNil(state.zoom.presentation.livePinch)
    state.zoom.pinchChanged(magnification: 3.5, location: fingers)
    state.zoom.pinchEnded(magnification: 3.5)
    XCTAssertFalse(state.zoom.isZoomedIn)
  }

  func testArmingCropFromAZoomAnimatesToFitAndHoldsIt() throws {
    let state = makeCropState()
    state.zoom.zoomToScale(1)
    let zoomed = state.zoom.restingFrame
    state.arm(tool: .crop)
    XCTAssertTrue(state.zoom.isZoomLocked)
    XCTAssertFalse(state.zoom.isZoomedIn)
    let move = try XCTUnwrap(state.zoom.commandedMove, "the host animates the move to fit")
    XCTAssertEqual(move.from, zoomed)
  }

  func testASettleInterruptedWhileCroppingDoesNotHoldItsFrame() {
    let state = makeCropState()
    state.arm(tool: .crop)
    state.zoom.holdShownFrame(CanvasShownFrame(scale: 0.6, pan: CGSize(width: 120, height: 0)))
    state.zoom.viewportInsetsChanged(CanvasViewportInsets(top: 40, left: 0, bottom: 0, right: 0))
    XCTAssertFalse(state.zoom.isZoomedIn)
    XCTAssertEqual(state.zoom.effectivePixelScale, state.zoom.context.fitScale, accuracy: 1e-9)
  }

  func testLeavingCropReleasesTheZoomLock() {
    let state = makeCropState()
    state.arm(tool: .crop)
    state.arm(tool: .exposure)
    XCTAssertFalse(state.zoom.isZoomLocked)
    state.zoom.stepZoomIn()
    XCTAssertTrue(state.zoom.isZoomedIn)
  }

  func testMaskKeepsZoomLive() {
    let state = makeCropState()
    state.arm(tool: .mask)
    XCTAssertFalse(state.zoom.isZoomLocked)
    state.zoom.stepZoomIn()
    XCTAssertTrue(state.zoom.isZoomedIn)
  }
}
