// CanvasVisibleAreaTests.swift — #5749.
//
// The editor canvas fits and centres the photo in the area its chrome leaves
// visible, keeps a below-fit pinch under the fingers, and settles a release
// by animating from the frame it showed. Drives the controller the way the
// iOS `CanvasZoomHost` does.

import CoreGraphics
import XCTest

@testable import MapleCore

@MainActor
final class CanvasVisibleAreaTests: XCTestCase {

  private let viewport = CGSize(width: 1000, height: 800)
  /// A 100pt navigation bar over the top and a 300pt inspector on the right:
  /// the visible area is 700×700 at (0, 100).
  private let chrome = CanvasViewportInsets(top: 100, left: 0, bottom: 0, right: 300)
  private let home = CGSize(width: -150, height: 50)

  /// 6000×6000 at 2×: without chrome fit is 800pt (0.2667), with it 700pt.
  private func makeController(insets: CanvasViewportInsets) -> CanvasZoomController {
    let session = EditSession.preview()
    session.nativeImageSize = CGSize(width: 6000, height: 6000)
    let controller = CanvasZoomController(session: session)
    controller.viewportChanged(points: viewport, displayScale: 2, insets: insets)
    return controller
  }

  private func imageRect(_ controller: CanvasZoomController) -> CGRect {
    let frame = controller.displayFrameInPoints ?? .zero
    let pan = controller.panOffset
    return CGRect(
      x: viewport.width / 2 + pan.width - frame.width / 2,
      y: viewport.height / 2 + pan.height - frame.height / 2,
      width: frame.width, height: frame.height)
  }

  private func assertRect(
    _ actual: CGRect, _ expected: CGRect, file: StaticString = #filePath, line: UInt = #line
  ) {
    XCTAssertEqual(actual.minX, expected.minX, accuracy: 1e-6, file: file, line: line)
    XCTAssertEqual(actual.minY, expected.minY, accuracy: 1e-6, file: file, line: line)
    XCTAssertEqual(actual.width, expected.width, accuracy: 1e-6, file: file, line: line)
    XCTAssertEqual(actual.height, expected.height, accuracy: 1e-6, file: file, line: line)
  }

  // MARK: - Fit and centre use the visible area

  func testFitIsCentredInTheVisibleAreaNotTheViewport() {
    let controller = makeController(insets: chrome)
    XCTAssertEqual(controller.context.fitScale, 1400.0 / 6000.0, accuracy: 1e-12)
    XCTAssertEqual(controller.panOffset, home)
    assertRect(imageRect(controller), CGRect(x: 0, y: 100, width: 700, height: 700))
  }

  func testZoomCommandsCentreInTheVisibleArea() {
    let controller = makeController(insets: chrome)
    controller.zoomToScale(1)
    XCTAssertEqual(controller.panOffset, home)
    controller.resetToFit()
    XCTAssertEqual(controller.panOffset, home)
  }

  // MARK: - Showing and hiding the navigation bar

  func testShowingTheBarAtFitRefitsInTheNewVisibleArea() {
    let controller = makeController(insets: .zero)
    assertRect(imageRect(controller), CGRect(x: 100, y: 0, width: 800, height: 800))
    let barShown = CanvasViewportInsets(top: 100, left: 0, bottom: 0, right: 0)
    controller.viewportInsetsChanged(barShown)
    assertRect(imageRect(controller), CGRect(x: 150, y: 100, width: 700, height: 700))
    controller.viewportInsetsChanged(.zero)
    assertRect(imageRect(controller), CGRect(x: 100, y: 0, width: 800, height: 800))
  }

  func testTogglingTheBarWhileZoomedLeavesThePhotoWhereItIs() {
    let controller = makeController(insets: .zero)
    controller.zoomToScale(1)
    controller.wheelPan(delta: CGSize(width: 200, height: -150))
    let before = imageRect(controller)
    controller.viewportInsetsChanged(CanvasViewportInsets(top: 100, left: 0, bottom: 0, right: 0))
    assertRect(imageRect(controller), before)
    controller.viewportInsetsChanged(.zero)
    assertRect(imageRect(controller), before)
  }

  // MARK: - Below fit

  func testPinchBelowFitKeepsTheAnchorAndReleasesToTheVisibleCentre() throws {
    let controller = makeController(insets: chrome)
    let fingers = CGPoint(x: 600, y: 200)
    controller.pinchChanged(magnification: 1, location: fingers)
    let frame = controller.displayFrameInPoints ?? .zero
    let live = controller.gestureTransform(magnification: 0.5, liveCentroid: fingers)
    XCTAssertEqual(live.zoom, 0.5, accuracy: 1e-12)
    // The fingers' image point: from (600 − 0, 200 − 100) inside the 700pt
    // fit square to the same fraction of the 350pt live square.
    let liveMinX = viewport.width / 2 + live.committedPan.width - frame.width * 0.25
    let liveMinY = viewport.height / 2 + live.committedPan.height - frame.height * 0.25
    XCTAssertEqual((fingers.x - liveMinX) / 350, 600.0 / 700.0, accuracy: 1e-9)
    XCTAssertEqual((fingers.y - liveMinY) / 350, 100.0 / 700.0, accuracy: 1e-9)

    let shown = CanvasShownFrame(
      scale: controller.effectivePixelScale * live.zoom, pan: live.committedPan)
    controller.pinchChanged(magnification: 0.5, location: fingers)
    controller.pinchEnded(magnification: 0.5)
    XCTAssertEqual(controller.model.pixelScale, 0)
    XCTAssertEqual(controller.panOffset, home)

    let start = Date()
    let settle = try XCTUnwrap(
      CanvasSettleAnimation(from: shown, to: controller.restingFrame, start: start))
    XCTAssertEqual(settle.shown(at: start), shown, "the spring-back starts from what was shown")
    XCTAssertEqual(settle.shown(at: start + 1), controller.restingFrame)
  }

  // MARK: - Settle animation

  func testSettleTransformReproducesTheShownFrameOverTheSettledOne() throws {
    let from = CanvasShownFrame(scale: 0.12, pan: CGSize(width: 200, height: -90))
    let to = CanvasShownFrame(scale: 0.24, pan: CGSize(width: -150, height: 50))
    let start = Date()
    let settle = try XCTUnwrap(CanvasSettleAnimation(from: from, to: to, start: start))
    for t in stride(from: 0.0, through: CanvasSettleAnimation.duration, by: 0.05) {
      let date = start + t
      let shown = settle.shown(at: date)
      let transform = settle.transform(at: date)
      XCTAssertEqual(to.scale * transform.zoom, shown.scale, accuracy: 1e-12)
      XCTAssertEqual(to.pan.width + transform.offset.width, shown.pan.width, accuracy: 1e-9)
      XCTAssertEqual(to.pan.height + transform.offset.height, shown.pan.height, accuracy: 1e-9)
    }
    XCTAssertEqual(settle.transform(at: start).zoom, 0.5, accuracy: 1e-12)
    XCTAssertTrue(settle.isFinished(at: start + CanvasSettleAnimation.duration))
    XCTAssertEqual(settle.transform(at: start + 5).zoom, 1)
  }

  func testSettleProgressIsMonotonicAndContinuous() throws {
    let settle = try XCTUnwrap(
      CanvasSettleAnimation(
        from: CanvasShownFrame(scale: 1, pan: .zero),
        to: CanvasShownFrame(scale: 2, pan: CGSize(width: 300, height: 0)), start: Date()))
    let samples = stride(from: 0.0, through: CanvasSettleAnimation.duration + 0.01, by: 0.004)
      .map { settle.progress(at: settle.start + $0) }
    for (previous, next) in zip(samples, samples.dropFirst()) {
      XCTAssertGreaterThanOrEqual(next, previous)
      XCTAssertLessThan(next - previous, 0.05, "no visible jump between frames")
    }
    XCTAssertEqual(samples.first, 0)
    XCTAssertEqual(samples.last, 1)
  }

  func testNothingToSettleIsNoAnimation() {
    let frame = CanvasShownFrame(scale: 0.5, pan: CGSize(width: 10, height: 10))
    XCTAssertNil(CanvasSettleAnimation(from: frame, to: frame, start: Date()))
    XCTAssertNil(
      CanvasSettleAnimation(
        from: CanvasShownFrame(scale: .nan, pan: .zero), to: frame, start: Date()))
  }

  func testAnInterruptedSettleHoldsWhatIsOnScreen() {
    let controller = makeController(insets: chrome)
    let midway = CanvasShownFrame(scale: 0.18, pan: CGSize(width: -100, height: 20))
    controller.holdShownFrame(midway)
    XCTAssertEqual(controller.restingFrame, midway)
    XCTAssertFalse(controller.model.fillsViewport)
  }

  /// Codex on #5754: a pinch that interrupts the settle after the chrome
  /// appears starts from the frame drawn halfway, though that frame lies
  /// outside the new geometry's range.
  func testAPinchInterruptingAChromeSettleStartsWhereThePhotoIs() throws {
    let controller = makeController(insets: .zero)
    let before = controller.restingFrame
    controller.viewportInsetsChanged(chrome)
    let start = Date()
    let settle = try XCTUnwrap(
      CanvasSettleAnimation(from: before, to: controller.restingFrame, start: start))
    let halfway = try XCTUnwrap(
      stride(from: 0.0, through: CanvasSettleAnimation.duration, by: 0.0005)
        .map { start + $0 }
        .first { settle.progress(at: $0) >= 0.5 })
    let shown = settle.shown(at: halfway)

    controller.holdShownFrame(shown)
    XCTAssertEqual(controller.restingFrame, shown)
    let fingers = CGPoint(x: 400, y: 300)
    controller.pinchChanged(magnification: 1, location: fingers)
    let live = controller.gestureTransform(magnification: 1, liveCentroid: fingers)
    XCTAssertEqual(live.zoom, 1, accuracy: 1e-12)
    XCTAssertEqual(live.committedPan.width, shown.pan.width, accuracy: 1e-9)
    XCTAssertEqual(live.committedPan.height, shown.pan.height, accuracy: 1e-9)
  }

  func testHoldingRefusesFramesItCannotDrawOrBeforeTheImageIsKnown() {
    let controller = makeController(insets: chrome)
    let atFit = controller.restingFrame
    controller.holdShownFrame(CanvasShownFrame(scale: .nan, pan: .zero))
    controller.holdShownFrame(CanvasShownFrame(scale: 0, pan: .zero))
    XCTAssertEqual(controller.restingFrame, atFit)
    XCTAssertEqual(controller.model.pixelScale, 0)

    let session = EditSession.preview()
    session.nativeImageSize = .zero
    let unsized = CanvasZoomController(session: session)
    unsized.viewportChanged(points: viewport, displayScale: 2, insets: chrome)
    unsized.holdShownFrame(CanvasShownFrame(scale: 1, pan: .zero))
    XCTAssertEqual(unsized.model.pixelScale, 0, "an unknown image never locks at 100%")
  }

  // MARK: - Chrome → insets

  func testChromeIsAttributedToTheEdgeItCovers() {
    let screen = CGRect(x: 0, y: 0, width: 1000, height: 800)
    let insets = CanvasViewportInsets.covering(
      viewport: screen,
      safeArea: CGRect(x: 0, y: 24, width: 1000, height: 756),
      frames: [
        CGRect(x: 350, y: 32, width: 300, height: 44),  // header pill
        CGRect(x: 600, y: 88, width: 396, height: 700),  // trailing inspector
        CGRect(x: 12, y: 250, width: 80, height: 300),  // filmstrip rail
        CGRect(x: 2000, y: 0, width: 100, height: 100),  // off screen
      ])
    XCTAssertEqual(insets, CanvasViewportInsets(top: 76, left: 92, bottom: 20, right: 400))
  }

  func testASafeAreaClearOfTheCanvasAddsNothing() {
    let insets = CanvasViewportInsets.covering(
      viewport: CGRect(x: 0, y: 0, width: 800, height: 600),
      safeArea: CGRect(x: 900, y: 0, width: 100, height: 100), frames: [])
    XCTAssertEqual(insets, .zero)
  }

  func testABottomDockIsABottomInset() {
    let insets = CanvasViewportInsets.covering(
      viewport: CGRect(x: 0, y: 0, width: 800, height: 1100), safeArea: nil,
      frames: [CGRect(x: 12, y: 700, width: 776, height: 400)])
    XCTAssertEqual(insets, CanvasViewportInsets(top: 0, left: 0, bottom: 400, right: 0))
  }

  func testInsetsAreRelativeToTheCanvasFrame() {
    let insets = CanvasViewportInsets.covering(
      viewport: CGRect(x: 0, y: 59, width: 402, height: 815), safeArea: nil,
      frames: [
        CGRect(x: 0, y: 59, width: 402, height: 56), CGRect(x: 0, y: 600, width: 402, height: 300),
      ])
    XCTAssertEqual(insets, CanvasViewportInsets(top: 56, left: 0, bottom: 274, right: 0))
  }
}
