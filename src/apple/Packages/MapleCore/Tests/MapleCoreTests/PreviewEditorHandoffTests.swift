// PreviewEditorHandoffTests.swift — #5764.
//
// Opening the editor from Preview hands it the canvas: the zoom and the still
// on screen. The editor's first frame draws the photo in the rect Preview
// showed, and going back to Preview keeps where the editor left it.

import CoreGraphics
import XCTest

@testable import MapleCore

@MainActor
final class PreviewEditorHandoffTests: XCTestCase {

  /// An iPhone 17 Pro in portrait: 402×874pt at 3×.
  private let phone = CGSize(width: 402, height: 874)
  private let realSize = CGSize(width: 6000, height: 4000)
  /// The editor's header and tool panel over the same full-bleed canvas.
  private let editorInsets = CanvasViewportInsets(top: 96, left: 0, bottom: 300, right: 0)
  private var viewport: CGRect { CGRect(origin: .zero, size: phone) }

  private func makeSession(knowingSize: Bool = true) -> EditSession {
    let session = EditSession.preview()
    if knowingSize { session.nativeImageSize = realSize }
    return session
  }

  private func makePreview(_ session: EditSession) -> CanvasZoomController {
    let controller = CanvasZoomController(session: session, rendersSession: false)
    controller.viewportChanged(points: phone, displayScale: 3)
    return controller
  }

  private func makeStill() -> CGImage {
    let context = CGContext(
      data: nil, width: 12, height: 8, bitsPerComponent: 8, bytesPerRow: 0,
      space: CGColorSpaceCreateDeviceRGB(),
      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    return context.makeImage()!
  }

  private func assertSameRect(
    _ a: CGRect?, _ b: CGRect?, _ message: String = "", file: StaticString = #filePath,
    line: UInt = #line
  ) {
    guard let a, let b else { return XCTFail("no rect. \(message)", file: file, line: line) }
    XCTAssertEqual(a.minX, b.minX, accuracy: 0.5, message, file: file, line: line)
    XCTAssertEqual(a.minY, b.minY, accuracy: 0.5, message, file: file, line: line)
    XCTAssertEqual(a.width, b.width, accuracy: 0.5, message, file: file, line: line)
    XCTAssertEqual(a.height, b.height, accuracy: 0.5, message, file: file, line: line)
  }

  // MARK: - The round trip keeps the rect

  /// Zoomed in Preview, then handed to a new editor canvas.
  private func zoomedInEditor(_ session: EditSession) -> (
    preview: CanvasZoomController, editor: CanvasZoomController, shownInPreview: CGRect?
  ) {
    let preview = makePreview(session)
    preview.doubleTap(at: CGPoint(x: 120, y: 300), behavior: .toggleFitAnd100)
    XCTAssertTrue(preview.isZoomedIn)
    let shownInPreview = preview.shownRect(inViewport: viewport)
    let editor = CanvasZoomController(session: session)
    editor.receive(preview.handoff(still: nil)!)
    return (preview, editor, shownInPreview)
  }

  private func pan(_ controller: CanvasZoomController, by translation: CGSize) {
    controller.dragBegan()
    controller.dragChanged(translation: translation)
    controller.dragEnded()
  }

  func testTheEditorsFirstFrameDrawsThePhotoWherePreviewDid() {
    let session = makeSession()
    let (_, editor, shownInPreview) = zoomedInEditor(session)
    assertSameRect(
      editor.shownRect(inViewport: viewport), shownInPreview,
      "before the editor measures its own viewport")
    XCTAssertEqual(session.previewSize, .zero, "nothing reaches the session before it measures")
    editor.viewportChanged(points: phone, displayScale: 3, insets: editorInsets)
    assertSameRect(editor.shownRect(inViewport: viewport), shownInPreview, "after it measures")
  }

  /// iPhone: Preview stays mounted under the editor and picks its zoom up.
  func testClosingTheEditorKeepsWhereItWasInTheMountedPreview() {
    let session = makeSession()
    let (preview, editor, shownInPreview) = zoomedInEditor(session)
    editor.viewportChanged(points: phone, displayScale: 3, insets: editorInsets)
    pan(editor, by: CGSize(width: 140, height: -60))
    let shownInEditor = editor.shownRect(inViewport: viewport)
    XCTAssertNotEqual(shownInEditor, shownInPreview, "the editor moved the photo")

    preview.receive(editor.handoff(still: nil)!)
    assertSameRect(preview.shownRect(inViewport: viewport), shownInEditor)
  }

  /// iPad and Mac: Preview is rebuilt with a new canvas when the editor closes.
  func testClosingTheEditorKeepsWhereItWasInANewPreview() {
    let session = makeSession()
    let (_, editor, _) = zoomedInEditor(session)
    editor.viewportChanged(points: phone, displayScale: 3, insets: editorInsets)
    pan(editor, by: CGSize(width: -90, height: -40))
    let shownInEditor = editor.shownRect(inViewport: viewport)

    let preview = CanvasZoomController(session: session, rendersSession: false)
    preview.receive(editor.handoff(still: nil)!)
    assertSameRect(preview.shownRect(inViewport: viewport), shownInEditor, "first frame")
    preview.viewportChanged(points: phone, displayScale: 3)
    assertSameRect(preview.shownRect(inViewport: viewport), shownInEditor, "measured")
    XCTAssertTrue(preview.isZoomedIn)
  }

  func testADragInProgressIsHandedOverAsItsCancelSettlesIt() {
    let session = makeSession()
    let preview = makePreview(session)
    preview.zoomToScale(1)
    preview.dragBegan()
    preview.dragChanged(translation: CGSize(width: 9_000, height: 0))
    let handoff = preview.handoff(still: nil)!
    preview.dragCancelled()

    let editor = CanvasZoomController(session: session)
    editor.receive(handoff)
    assertSameRect(editor.shownRect(inViewport: viewport), preview.shownRect(inViewport: viewport))
  }

  /// Preview laid the photo out at its still's aspect; by the time the editor
  /// opens, the session knows the real size. The rect must not move.
  func testAProvisionalLayoutHandedToASessionThatKnowsItsSizeKeepsTheRect() {
    let session = makeSession(knowingSize: false)
    let preview = makePreview(session)
    preview.setProvisionalImageSize(
      EditorCanvasSeed.provisionalImageSize(forSeedOfPixelSize: CGSize(width: 1280, height: 853)))
    preview.pinchChanged(magnification: 1, location: CGPoint(x: 201, y: 437))
    preview.pinchChanged(magnification: 2.5, location: CGPoint(x: 150, y: 400))
    preview.pinchEnded(magnification: 2.5)
    XCTAssertTrue(preview.isZoomedIn)
    let shownInPreview = preview.shownRect(inViewport: viewport)
    let handoff = preview.handoff(still: nil)!

    session.nativeImageSize = realSize
    let editor = CanvasZoomController(session: session)
    editor.receive(handoff)
    XCTAssertNil(editor.provisionalImageSize)
    editor.viewportChanged(points: phone, displayScale: 3)
    assertSameRect(editor.shownRect(inViewport: viewport), shownInPreview)
  }

  // MARK: - Who renders

  func testPreviewReceivingTheEditorsZoomStaysHeld() {
    let session = makeSession()
    let editor = CanvasZoomController(session: session)
    editor.viewportChanged(points: phone, displayScale: 3, insets: editorInsets)
    editor.zoomToScale(1)
    let rendered = session.previewSize

    let preview = makePreview(session)
    session.previewSize = .zero
    preview.receive(editor.handoff(still: nil)!)
    XCTAssertFalse(preview.rendersSession)
    XCTAssertEqual(session.previewSize, .zero, "the held canvas does not steer the session")
    XCTAssertNotEqual(rendered, .zero)
  }

  func testAHandoffTakenMidPinchSettlesIt() {
    let session = makeSession()
    let preview = makePreview(session)
    preview.pinchChanged(magnification: 1, location: CGPoint(x: 201, y: 437))
    preview.pinchChanged(magnification: 3, location: CGPoint(x: 201, y: 437))
    let editor = CanvasZoomController(session: session)
    editor.receive(preview.handoff(still: nil)!)
    XCTAssertNil(editor.model.pinchStartScale)
  }

  func testACanvasThatNeverMeasuredHandsNothing() {
    let controller = CanvasZoomController(session: makeSession(), rendersSession: false)
    XCTAssertNil(controller.handoff(still: nil))
  }

  // MARK: - The editor takes it once

  func testTheEditorTakesTheHandoffOnceAndShowsItsStill() {
    let session = makeSession()
    let preview = makePreview(session)
    preview.doubleTap(at: CGPoint(x: 120, y: 300), behavior: .toggleFitAnd100)
    let still = makeStill()
    session.canvasHandoff = preview.handoff(
      still: CanvasHandoffStill(image: still, isDisplayPreview: true))

    let state = EditorState(session: session)
    XCTAssertNil(session.canvasHandoff, "taken, so a later open starts at fit")
    XCTAssertTrue(state.zoom.isZoomedIn)
    XCTAssertTrue(state.seed.image(for: session.asset.id) === still)
    XCTAssertTrue(state.seed.hasDisplayPreview(for: session.asset.id))

    let reopened = EditorState(session: session)
    XCTAssertFalse(reopened.zoom.isZoomedIn)
    XCTAssertNil(reopened.seed.image(for: session.asset.id))
  }
}

@MainActor
final class EditorCanvasHandBackTests: XCTestCase {
  func testClosingTheEditorLeavesItsZoomAndStillForPreview() {
    let session = EditSession.preview()
    session.nativeImageSize = CGSize(width: 6000, height: 4000)
    let state = EditorState(session: session)
    state.zoom.viewportChanged(points: CGSize(width: 402, height: 874), displayScale: 3)
    state.zoom.zoomToScale(1)
    let still = CGContext(
      data: nil, width: 4, height: 4, bitsPerComponent: 8, bytesPerRow: 0,
      space: CGColorSpaceCreateDeviceRGB(),
      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!.makeImage()!
    state.seed.begin(session.asset.id)
    state.seed.publish(still, for: session.asset.id, isDisplayPreview: false)

    state.handOffCanvas()
    let preview = CanvasZoomController(session: session, rendersSession: false)
    let handoff = session.takeCanvasHandoff()
    XCTAssertTrue(handoff?.still?.image === still)
    XCTAssertEqual(handoff?.still?.isDisplayPreview, false)
    preview.receive(handoff!)
    XCTAssertEqual(preview.effectivePixelScale, 1, accuracy: 0.0001)
  }

  func testClosingTheEditorWithCropArmedHandsPreviewTheCroppedPhoto() {
    let session = EditSession.preview()
    session.nativeImageSize = CGSize(width: 6000, height: 4000)
    session.model.crop.left = 0.25
    session.model.crop.right = 0.75
    let state = EditorState(session: session)
    state.zoom.viewportChanged(points: CGSize(width: 402, height: 874), displayScale: 3)
    state.arm(tool: .crop)
    XCTAssertEqual(state.zoom.context.nativeImageSize.width, 6000, accuracy: 0.5)

    state.handOffCanvas()
    XCTAssertFalse(session.cropEditingActive)
    let preview = CanvasZoomController(session: session, rendersSession: false)
    preview.receive(session.takeCanvasHandoff()!)
    XCTAssertEqual(preview.context.nativeImageSize.width, 3000, accuracy: 0.5)
    XCTAssertFalse(preview.isZoomLocked)
  }
}
