// CanvasZoomPinchRebaseTests.swift — #5732.
//
// Drives the controller the way the iOS `CanvasZoomHost` does: a capture
// frame, compositor-only `gestureTransform` frames, and on release the last
// shown frame committed through `pinchChanged` + `pinchEnded`. The fingers
// lift one at a time, so between the two lifts the recognizer reports the
// remaining finger as the centroid; the host re-anchors with `pinchRebased`.

import CoreGraphics
import XCTest

@testable import MapleCore

@MainActor
final class CanvasZoomPinchRebaseTests: XCTestCase {

  /// 8000×6000 in a 1000×800pt viewport @2×: fit 0.25.
  private func makeController() -> CanvasZoomController {
    let session = EditSession.preview()
    session.nativeImageSize = CGSize(width: 8000, height: 6000)
    let controller = CanvasZoomController(session: session)
    controller.viewportChanged(points: CGSize(width: 1000, height: 800), displayScale: 2)
    controller.zoomToScale(1.0)
    controller.wheelPan(delta: CGSize(width: -120, height: 60))
    return controller
  }

  /// The image's on-screen frame size and centre offset under the host's
  /// `.frame(displayFrame).scaleEffect(zoom).offset(pan)`.
  private struct Placement: Equatable {
    var width: CGFloat
    var height: CGFloat
    var offset: CGSize
  }

  private func liveView(
    _ controller: CanvasZoomController, magnification: CGFloat, centroid: CGPoint
  ) -> Placement {
    let frame = controller.displayFrameInPoints ?? .zero
    let transform = controller.gestureTransform(
      magnification: magnification, liveCentroid: centroid)
    return Placement(
      width: frame.width * transform.zoom, height: frame.height * transform.zoom,
      offset: transform.committedPan)
  }

  private func committedView(_ controller: CanvasZoomController) -> Placement {
    let frame = controller.displayFrameInPoints ?? .zero
    return Placement(width: frame.width, height: frame.height, offset: controller.panOffset)
  }

  private func assertSame(
    _ actual: Placement, _ expected: Placement, file: StaticString = #filePath, line: UInt = #line
  ) {
    XCTAssertEqual(actual.width, expected.width, accuracy: 1e-6, file: file, line: line)
    XCTAssertEqual(actual.height, expected.height, accuracy: 1e-6, file: file, line: line)
    XCTAssertEqual(
      actual.offset.width, expected.offset.width, accuracy: 1e-6, file: file, line: line)
    XCTAssertEqual(
      actual.offset.height, expected.offset.height, accuracy: 1e-6, file: file, line: line)
  }

  func testOneFingerLiftingFirstDoesNotMoveTheImage() {
    let controller = makeController()
    controller.pinchChanged(magnification: 1, location: CGPoint(x: 300, y: 200))
    let shown = liveView(controller, magnification: 1.6, centroid: CGPoint(x: 320, y: 210))

    let remainingFinger = CGPoint(x: 420, y: 210)
    controller.pinchRebased(
      shownMagnification: 1.6, shownLocation: CGPoint(x: 320, y: 210),
      magnification: 1.6, location: remainingFinger)
    assertSame(liveView(controller, magnification: 1.6, centroid: remainingFinger), shown)

    controller.pinchChanged(magnification: 1.6, location: remainingFinger)
    controller.pinchEnded(magnification: 1.6)
    assertSame(committedView(controller), shown)
  }

  func testAScaleStepAtTheLiftIsAbsorbed() {
    let controller = makeController()
    controller.pinchChanged(magnification: 1, location: CGPoint(x: 300, y: 200))
    let shown = liveView(controller, magnification: 1.6, centroid: CGPoint(x: 320, y: 210))

    let remainingFinger = CGPoint(x: 420, y: 210)
    controller.pinchRebased(
      shownMagnification: 1.6, shownLocation: CGPoint(x: 320, y: 210),
      magnification: 1.42, location: remainingFinger)
    assertSame(liveView(controller, magnification: 1.42, centroid: remainingFinger), shown)

    controller.pinchChanged(magnification: 1.42, location: remainingFinger)
    controller.pinchEnded(magnification: 1.42)
    assertSame(committedView(controller), shown)
  }

  func testTheRemainingFingerPansWithoutAJump() {
    let controller = makeController()
    controller.pinchChanged(magnification: 1, location: CGPoint(x: 300, y: 200))
    let shown = liveView(controller, magnification: 1.6, centroid: CGPoint(x: 320, y: 210))

    controller.pinchRebased(
      shownMagnification: 1.6, shownLocation: CGPoint(x: 320, y: 210),
      magnification: 1.6, location: CGPoint(x: 420, y: 210))
    let moved = liveView(controller, magnification: 1.6, centroid: CGPoint(x: 400, y: 200))
    XCTAssertEqual(moved.width, shown.width, accuracy: 1e-6)
    XCTAssertEqual(moved.offset.width - shown.offset.width, -20, accuracy: 1e-6)
    XCTAssertEqual(moved.offset.height - shown.offset.height, -10, accuracy: 1e-6)
  }

  func testAFingerLandingAgainDoesNotMoveTheImage() {
    let controller = makeController()
    controller.pinchChanged(magnification: 1, location: CGPoint(x: 300, y: 200))
    let shown = liveView(controller, magnification: 1.6, centroid: CGPoint(x: 320, y: 210))

    let remainingFinger = CGPoint(x: 420, y: 210)
    controller.pinchRebased(
      shownMagnification: 1.6, shownLocation: CGPoint(x: 320, y: 210),
      magnification: 1.6, location: remainingFinger)
    let bothFingers = CGPoint(x: 330, y: 215)
    controller.pinchRebased(
      shownMagnification: 1.6, shownLocation: remainingFinger,
      magnification: 1.0, location: bothFingers)
    assertSame(liveView(controller, magnification: 1.0, centroid: bothFingers), shown)
  }

  func testBothFingersLiftingTogetherIsUnchanged() {
    let controller = makeController()
    controller.pinchChanged(magnification: 1, location: CGPoint(x: 300, y: 200))
    let shown = liveView(controller, magnification: 1.6, centroid: CGPoint(x: 320, y: 210))
    controller.pinchChanged(magnification: 1.6, location: CGPoint(x: 320, y: 210))
    controller.pinchEnded(magnification: 1.6)
    assertSame(committedView(controller), shown)
  }
}
