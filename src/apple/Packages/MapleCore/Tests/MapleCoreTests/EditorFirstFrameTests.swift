// EditorFirstFrameTests.swift — #5769.
//
// The editor's chrome (header, filmstrip, controls) reports its frames a
// layout pass after the canvas measures its viewport. The photo is drawn only
// once those frames have reached the zoom, so its first frame is where it
// rests and the chrome's first report never animates it there.

import CoreGraphics
import XCTest

@testable import MapleCore

@MainActor
final class EditorFirstFrameTests: XCTestCase {

  /// An 11-inch iPad in portrait: 834×1194pt at 2×.
  private let pad = CGSize(width: 834, height: 1194)
  private let realSize = CGSize(width: 6000, height: 4000)
  /// The full-bleed canvas before the chrome reports: the system bars only.
  private let systemBars = CanvasViewportInsets(top: 24, left: 0, bottom: 20, right: 0)
  /// Header pill, filmstrip rail and the controls dock.
  private let chrome = CanvasViewportInsets(top: 167, left: 152, bottom: 380, right: 0)
  private var viewport: CGRect { CGRect(origin: .zero, size: pad) }

  private func makeSession() -> EditSession {
    let session = EditSession.preview()
    session.nativeImageSize = realSize
    return session
  }

  /// Where the photo rests once the editor's chrome is known.
  private func restingRect(_ session: EditSession) -> CGRect? {
    let settled = CanvasZoomController(session: session)
    settled.viewportChanged(points: pad, displayScale: 2, insets: chrome)
    return settled.shownRect(inViewport: viewport)
  }

  /// The host's open: the viewport first, the chrome's frames a pass later.
  @discardableResult
  private func open(_ zoom: CanvasZoomController) -> Bool {
    zoom.viewportChanged(points: pad, displayScale: 2, insets: systemBars, chromeMeasured: false)
    XCTAssertFalse(zoom.isChromeMeasured, "nothing is drawn before the chrome reports")
    return zoom.viewportInsetsChanged(chrome, chromeMeasured: true)
  }

  private func assertSameRect(
    _ a: CGRect?, _ b: CGRect?, file: StaticString = #filePath, line: UInt = #line
  ) {
    guard let a, let b else { return XCTFail("no rect", file: file, line: line) }
    XCTAssertEqual(a.minX, b.minX, accuracy: 0.5, file: file, line: line)
    XCTAssertEqual(a.minY, b.minY, accuracy: 0.5, file: file, line: line)
    XCTAssertEqual(a.width, b.width, accuracy: 0.5, file: file, line: line)
    XCTAssertEqual(a.height, b.height, accuracy: 0.5, file: file, line: line)
  }

  func testTheEditorWaitsForItsChromeBeforeDrawing() {
    let state = EditorState(session: makeSession())
    XCTAssertFalse(state.zoom.isChromeMeasured)
    let animates = open(state.zoom)
    XCTAssertTrue(state.zoom.isChromeMeasured)
    XCTAssertFalse(animates, "the chrome's first report is not a move on screen")
  }

  func testTheFirstFrameDrawnIsWhereThePhotoRests() {
    let session = makeSession()
    let state = EditorState(session: session)
    open(state.zoom)
    assertSameRect(state.zoom.shownRect(inViewport: viewport), restingRect(session))
  }

  /// Preview fits the photo to the whole screen; the editor's first frame
  /// fits it to what its chrome leaves visible, not Preview's rect.
  func testAnOpenFromPreviewAtFitIsFirstDrawnFittedToTheEditorsVisibleArea() {
    let session = makeSession()
    let preview = CanvasZoomController(session: session, rendersSession: false)
    preview.viewportChanged(points: pad, displayScale: 2)
    session.canvasHandoff = preview.handoff(still: nil)

    let state = EditorState(session: session)
    XCTAssertFalse(state.zoom.isChromeMeasured, "Preview's geometry is never drawn")
    XCTAssertFalse(open(state.zoom))
    assertSameRect(state.zoom.shownRect(inViewport: viewport), restingRect(session))
  }

  func testAChromeChangeAfterThePhotoIsDrawnAnimates() {
    let state = EditorState(session: makeSession())
    open(state.zoom)
    let hidden = CanvasViewportInsets(top: 167, left: 0, bottom: 380, right: 0)
    XCTAssertTrue(state.zoom.viewportInsetsChanged(hidden))
    XCTAssertFalse(state.zoom.viewportInsetsChanged(hidden), "no change, no move")
  }

  /// Preview has no chrome reporting late: it draws as soon as it measures.
  func testACanvasWithoutLateChromeDrawsAtOnce() {
    let preview = CanvasZoomController(session: makeSession(), rendersSession: false)
    XCTAssertTrue(preview.isChromeMeasured)
    preview.viewportChanged(points: pad, displayScale: 2)
    XCTAssertTrue(preview.isChromeMeasured)
  }
}
