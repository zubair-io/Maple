// PreviewCanvasZoomTests.swift — #5762.
//
// Preview hosts the editor's canvas zoom but renders nothing until the photo
// is zoomed past its still's resolution: opening, paging and every gesture
// at fit stay decode-free. Zoomed in, a pan that reaches the photo's edge
// hands the rest of the drag to paging.

import CoreGraphics
import XCTest

@testable import MapleCore

@MainActor
final class PreviewCanvasZoomTests: XCTestCase {

  /// An iPhone 17 Pro in portrait: 402×874pt at 3×.
  private let phone = CGSize(width: 402, height: 874)
  private let realSize = CGSize(width: 6000, height: 4000)
  private let previewStillLongEdge: CGFloat = 1280

  private func makeHeldCanvas(viewport: CGSize? = nil, scale: CGFloat = 3) -> (
    CanvasZoomController, EditSession
  ) {
    let session = EditSession.preview()
    let controller = CanvasZoomController(session: session, rendersSession: false)
    controller.viewportChanged(points: viewport ?? phone, displayScale: scale)
    controller.setProvisionalImageSize(
      EditorCanvasSeed.provisionalImageSize(forSeedOfPixelSize: CGSize(width: 1280, height: 853)))
    return (controller, session)
  }

  /// A page revisited after its session learned the photo's size.
  private func makeHeldCanvasOfKnownSize() -> (CanvasZoomController, EditSession) {
    let session = EditSession.preview()
    session.nativeImageSize = realSize
    let controller = CanvasZoomController(session: session, rendersSession: false)
    controller.viewportChanged(points: phone, displayScale: 3)
    return (controller, session)
  }

  private var centre: CGPoint { CGPoint(x: phone.width / 2, y: phone.height / 2) }

  private func pinch(_ controller: CanvasZoomController, to magnification: CGFloat) {
    controller.pinchChanged(magnification: 1, location: centre)
    controller.pinchChanged(magnification: magnification, location: centre)
    controller.pinchEnded(magnification: magnification)
  }

  private func assertUntouched(
    _ session: EditSession, file: StaticString = #filePath, line: UInt = #line
  ) {
    XCTAssertEqual(session.previewSize, .zero, "no viewport, so no render", file: file, line: line)
    XCTAssertEqual(session.pixelScale, 0, file: file, line: line)
    XCTAssertFalse(session.renderRequested, file: file, line: line)
  }

  // MARK: - No decode while opening and paging

  func testAHeldCanvasNeverReachesTheSessionWhileOpeningAndPaging() {
    let (controller, session) = makeHeldCanvas()
    controller.dragBegan()
    controller.dragChanged(translation: CGSize(width: -260, height: 6))
    controller.dragEnded()
    controller.assetChanged()
    controller.viewportChanged(points: CGSize(width: 874, height: 402), displayScale: 3)
    controller.viewportInsetsChanged(CanvasViewportInsets(top: 0, left: 0, bottom: 96, right: 0))
    assertUntouched(session)
  }

  func testAHeldCanvasOfKnownSizeStillNeverReachesTheSession() {
    let (controller, session) = makeHeldCanvasOfKnownSize()
    controller.nativeImageSizeChanged()
    pinch(controller, to: 1.02)
    assertUntouched(session)
  }

  // MARK: - Double-tap

  func testDoubleTapTogglesFitAnd100AsInTheEditor() {
    let (controller, session) = makeHeldCanvasOfKnownSize()
    controller.doubleTap(at: centre, behavior: .toggleFitAnd100)
    XCTAssertTrue(controller.isZoomedIn)
    XCTAssertEqual(controller.effectivePixelScale, 1, accuracy: 1e-12)
    controller.doubleTap(at: centre, behavior: .toggleFitAnd100)
    XCTAssertFalse(controller.isZoomedIn)
    XCTAssertEqual(controller.effectivePixelScale, controller.context.fitScale, accuracy: 1e-12)
    assertUntouched(session)
  }

  func testADoubleTapOnTheStillZoomsPastItsResolution() {
    let (controller, _) = makeHeldCanvas()
    XCTAssertFalse(controller.showsMoreThanStill(ofLongEdge: previewStillLongEdge))
    controller.doubleTap(at: centre, behavior: .toggleFitAnd100)
    XCTAssertTrue(controller.showsMoreThanStill(ofLongEdge: previewStillLongEdge))
  }

  // MARK: - The RAW renders only past the still's resolution

  func testFitNeverRendersEvenWhereTheScreenOutresolvesTheStill() {
    let (controller, _) = makeHeldCanvas(viewport: CGSize(width: 1376, height: 1032), scale: 2)
    let fitted = controller.displayFrameInPoints?.width ?? 0
    XCTAssertGreaterThan(fitted * 2, previewStillLongEdge, "the iPad shows more than the still")
    XCTAssertFalse(controller.showsMoreThanStill(ofLongEdge: previewStillLongEdge))
  }

  func testZoomWithinTheStillsResolutionKeepsShowingTheStill() {
    let (controller, _) = makeHeldCanvasOfKnownSize()
    let fittedPixels = (controller.displayFrameInPoints?.width ?? 0) * 3
    XCTAssertEqual(fittedPixels, 1206, accuracy: 1e-6)
    pinch(controller, to: 1.05)
    XCTAssertTrue(controller.isZoomedIn)
    XCTAssertFalse(controller.showsMoreThanStill(ofLongEdge: previewStillLongEdge))
    pinch(controller, to: 1.1)
    XCTAssertTrue(controller.showsMoreThanStill(ofLongEdge: previewStillLongEdge))
  }

  func testStartingTheRenderPushesTheViewportAndZoom() {
    let (controller, session) = makeHeldCanvasOfKnownSize()
    controller.doubleTap(at: centre, behavior: .toggleFitAnd100)
    controller.startRenderingSession()
    XCTAssertTrue(controller.rendersSession)
    XCTAssertEqual(session.previewSize, controller.context.viewportPx)
    XCTAssertEqual(session.pixelScale, 1, accuracy: 1e-12)
  }

  /// The editor pushed over Preview drives the shared session; Preview's
  /// canvas beneath it must not steer it.
  func testAStoppedCanvasNoLongerSteersTheSession() {
    let (controller, session) = makeHeldCanvasOfKnownSize()
    controller.doubleTap(at: centre, behavior: .toggleFitAnd100)
    controller.startRenderingSession()
    controller.stopRenderingSession()
    let steered = (session.previewSize, session.pixelScale)
    controller.doubleTap(at: centre, behavior: .toggleFitAnd100)
    controller.viewportChanged(points: CGSize(width: 874, height: 402), displayScale: 3)
    XCTAssertEqual(session.previewSize, steered.0)
    XCTAssertEqual(session.pixelScale, steered.1)
  }

  func testTheRealSizeLandingAfterTheRenderStartsKeepsTheRect() {
    let (controller, session) = makeHeldCanvas()
    controller.doubleTap(at: CGPoint(x: 300, y: 500), behavior: .toggleFitAnd100)
    let frame = CGRect(origin: .zero, size: phone)
    let before = controller.shownRect(inViewport: frame)
    controller.startRenderingSession()
    session.nativeImageSize = realSize
    controller.nativeImageSizeChanged()
    let after = controller.shownRect(inViewport: frame)
    XCTAssertEqual(after?.minX ?? 0, before?.minX ?? 1, accuracy: 0.5)
    XCTAssertEqual(after?.minY ?? 0, before?.minY ?? 1, accuracy: 0.5)
    XCTAssertEqual(after?.width ?? 0, before?.width ?? 1, accuracy: 0.5)
    XCTAssertEqual(session.pixelScale, controller.effectivePixelScale, accuracy: 1e-12)
  }

  // MARK: - A pan at the photo's edge hands off to paging

  private func drag(
    _ controller: CanvasZoomController, to width: CGFloat, _ overflow: inout CanvasDragOverflow
  ) {
    controller.dragChanged(translation: CGSize(width: width, height: 0), tracking: &overflow)
  }

  func testAtFitTheWholeSidewaysDragIsThePages() {
    let (controller, _) = makeHeldCanvasOfKnownSize()
    var overflow = CanvasDragOverflow()
    controller.dragBegan()
    drag(controller, to: -40, &overflow)
    drag(controller, to: -120, &overflow)
    XCTAssertEqual(overflow.horizontal, -120)
  }

  func testZoomedInThePhotoPansUntilItsEdgeThenTheDragTurnsThePage() {
    let (controller, _) = makeHeldCanvasOfKnownSize()
    controller.doubleTap(at: centre, behavior: .toggleFitAnd100)
    var overflow = CanvasDragOverflow()
    controller.dragBegan()
    let startPan = controller.panOffset.width

    drag(controller, to: 200, &overflow)
    XCTAssertEqual(controller.panOffset.width, startPan + 200, accuracy: 1e-9)
    XCTAssertEqual(overflow.horizontal, 0, accuracy: 1e-9)

    drag(controller, to: 1100, &overflow)
    let edgePan = controller.panOffset.width
    let pastTheEdge = overflow.horizontal
    XCTAssertLessThan(edgePan - startPan, 1100, "the photo stopped at its edge")
    XCTAssertEqual(pastTheEdge, 1100 - (edgePan - startPan), accuracy: 1e-9)
    XCTAssertGreaterThan(pastTheEdge, 0)

    drag(controller, to: 1100 - pastTheEdge / 2, &overflow)
    XCTAssertEqual(controller.panOffset.width, edgePan, accuracy: 1e-9, "the page goes back first")
    XCTAssertEqual(overflow.horizontal, pastTheEdge / 2, accuracy: 1e-9)
  }

  /// A sharper still landing mid-swipe re-bases the zoom model's drag; the
  /// page must carry on from where it is rather than snap back.
  func testAGeometryChangeMidSwipeDoesNotMoveThePage() {
    let (controller, _) = makeHeldCanvas()
    var overflow = CanvasDragOverflow()
    controller.dragBegan()
    drag(controller, to: -150, &overflow)
    controller.setProvisionalImageSize(
      EditorCanvasSeed.provisionalImageSize(forSeedOfPixelSize: CGSize(width: 512, height: 341)))
    drag(controller, to: -160, &overflow)
    XCTAssertEqual(overflow.horizontal, -160, accuracy: 1e-9)
  }

  func testAPinchIsNeverAPageSwipe() {
    let (controller, _) = makeHeldCanvasOfKnownSize()
    var overflow = CanvasDragOverflow()
    controller.pinchChanged(magnification: 1, location: centre)
    controller.dragBegan()
    drag(controller, to: -300, &overflow)
    XCTAssertEqual(overflow.horizontal, 0)
  }

  // MARK: - The photo's rect

  func testTheShownRectIsTheFitRectInTheViewportsFrame() throws {
    let (controller, _) = makeHeldCanvasOfKnownSize()
    let frame = CGRect(x: 0, y: 60, width: phone.width, height: phone.height)
    let rect = try XCTUnwrap(controller.shownRect(inViewport: frame))
    XCTAssertEqual(rect.width, 402, accuracy: 1e-9)
    XCTAssertEqual(rect.height, 268, accuracy: 1e-9)
    XCTAssertEqual(rect.midY, frame.midY, accuracy: 1e-9)
  }
}
