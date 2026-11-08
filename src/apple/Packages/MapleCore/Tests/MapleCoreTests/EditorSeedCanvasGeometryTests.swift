// EditorSeedCanvasGeometryTests.swift — #5755.
//
// The editor lays its canvas out from the seed thumbnail's aspect until a
// Maple Cloud RAW's real size is known, and draws the seed in the same frame
// the final image uses. Whatever the user did on the seed, the real size
// landing changes only the pixels: the photo's rect on screen stays put.
// Driven the way the editor drives it: the seed's aspect through
// `EditorCanvasSeed.provisionalImageSize`, the landing through the session.

import CoreGraphics
import XCTest

@testable import MapleCore

@MainActor
final class EditorSeedCanvasGeometryTests: XCTestCase {

  /// The owner's iPad: 1376×1032pt at 2×, under the top bar, the filmstrip
  /// and the inspector, opening a 6000×4000 RAW.
  private let viewport = CGSize(width: 1376, height: 1032)
  private let chrome = CanvasViewportInsets(top: 64, left: 294, bottom: 0, right: 153)
  private let realSize = CGSize(width: 6000, height: 4000)

  private struct ShownRect: Equatable {
    let size: CGSize
    let pan: CGSize
  }

  /// A 3:2 seed, the photo's own aspect. A real 512px thumbnail rounds its
  /// short edge; the rounded-aspect test below covers that.
  private func makeSeededCanvas(seedPixels: CGSize = CGSize(width: 768, height: 512)) -> (
    CanvasZoomController, EditSession
  ) {
    let session = EditSession.preview()
    let controller = CanvasZoomController(session: session)
    controller.viewportChanged(points: viewport, displayScale: 2)
    controller.viewportInsetsChanged(chrome)
    controller.setProvisionalImageSize(
      EditorCanvasSeed.provisionalImageSize(forSeedOfPixelSize: seedPixels))
    return (controller, session)
  }

  private func shown(_ controller: CanvasZoomController) -> ShownRect {
    ShownRect(size: controller.displayFrameInPoints ?? .zero, pan: controller.panOffset)
  }

  private func landRealSize(
    _ controller: CanvasZoomController, _ session: EditSession
  ) {
    session.nativeImageSize = realSize
    controller.nativeImageSizeChanged()
  }

  private func assertSame(
    _ actual: ShownRect, _ expected: ShownRect, file: StaticString = #filePath, line: UInt = #line
  ) {
    XCTAssertEqual(actual.size.width, expected.size.width, accuracy: 1e-6, file: file, line: line)
    XCTAssertEqual(actual.size.height, expected.size.height, accuracy: 1e-6, file: file, line: line)
    XCTAssertEqual(actual.pan.width, expected.pan.width, accuracy: 1e-6, file: file, line: line)
    XCTAssertEqual(actual.pan.height, expected.pan.height, accuracy: 1e-6, file: file, line: line)
  }

  // MARK: - The stand-in extent

  func testProvisionalSizeKeepsTheSeedsAspectAtTheNominalLongEdge() throws {
    let landscape = try XCTUnwrap(
      EditorCanvasSeed.provisionalImageSize(forSeedOfPixelSize: CGSize(width: 512, height: 341)))
    XCTAssertEqual(landscape.width, EditorCanvasSeed.provisionalLongEdge)
    XCTAssertEqual(landscape.width / landscape.height, 512.0 / 341.0, accuracy: 1e-12)
    let portrait = try XCTUnwrap(
      EditorCanvasSeed.provisionalImageSize(forSeedOfPixelSize: CGSize(width: 341, height: 512)))
    XCTAssertEqual(portrait.height, EditorCanvasSeed.provisionalLongEdge)
    XCTAssertNil(EditorCanvasSeed.provisionalImageSize(forSeedOfPixelSize: .zero))
  }

  // MARK: - Seed geometry is the final geometry

  func testSeedIsFittedWhereTheFinalImageIsFitted() {
    let (controller, session) = makeSeededCanvas(seedPixels: CGSize(width: 600, height: 400))
    let seed = shown(controller)
    XCTAssertEqual(seed.size.width, 929, accuracy: 1e-6, "fit in the 929pt-wide visible area")
    landRealSize(controller, session)
    assertSame(shown(controller), seed)
    XCTAssertFalse(controller.isZoomedIn, "an untouched seed stays at fit")
    XCTAssertEqual(controller.effectivePixelScale, controller.context.fitScale, accuracy: 1e-12)
  }

  /// A 512px thumbnail of a 3:2 photo is 512×341, so the seed's aspect is
  /// off by at most half a thumbnail pixel. The landing keeps the rect, but
  /// the real aspect differs, so its size moves by at most that much.
  func testAThumbnailsRoundedAspectMovesTheRectByUnderHalfAThumbnailPixel() {
    let (controller, session) = makeSeededCanvas(seedPixels: CGSize(width: 512, height: 341))
    let seed = shown(controller)
    landRealSize(controller, session)
    let landed = shown(controller)
    let halfAThumbnailPixel = seed.size.height / 341 / 2
    XCTAssertEqual(landed.size.width, seed.size.width, accuracy: halfAThumbnailPixel)
    XCTAssertEqual(landed.size.height, seed.size.height, accuracy: halfAThumbnailPixel)
    XCTAssertLessThan(halfAThumbnailPixel, 1, "under a point at fit on the owner's iPad")
  }

  /// The host learns of the new size only after its body re-evaluated with
  /// it; that frame must still draw the seed's rect, not the provisional
  /// scale applied to the real extent.
  func testTheFrameBeforeTheHostHearsOfTheLandingDrawsTheSameRect() {
    let (controller, session) = makeSeededCanvas()
    controller.doubleTap(at: CGPoint(x: 900, y: 500), behavior: .toggleFitAnd100)
    let zoomed = shown(controller)
    session.nativeImageSize = realSize
    assertSame(shown(controller), zoomed)
    controller.nativeImageSizeChanged()
    assertSame(shown(controller), zoomed)
  }

  func testGesturesOnTheSeedNeverReachTheSessionInStandInUnits() {
    let (controller, session) = makeSeededCanvas()
    controller.doubleTap(at: CGPoint(x: 900, y: 500), behavior: .toggleFitAnd100)
    XCTAssertEqual(session.pixelScale, 0, "the stand-in scale is not a source scale")
    session.nativeImageSize = realSize
    controller.viewportInsetsChanged(
      CanvasViewportInsets(top: 64, left: 294, bottom: 10, right: 153))
    XCTAssertEqual(session.pixelScale, 0, "nor before the landing is carried")
    controller.nativeImageSizeChanged()
    XCTAssertEqual(session.pixelScale, controller.effectivePixelScale, accuracy: 1e-12)
  }

  // MARK: - Gestures on the seed survive the landing

  func testADoubleTapOnTheSeedSurvivesTheLanding() {
    let (controller, session) = makeSeededCanvas()
    controller.doubleTap(at: CGPoint(x: 900, y: 500), behavior: .toggleFitAnd100)
    XCTAssertTrue(controller.isZoomedIn)
    let zoomed = shown(controller)
    landRealSize(controller, session)
    assertSame(shown(controller), zoomed)
  }

  func testAPanOnTheZoomedSeedSurvivesTheLanding() {
    let (controller, session) = makeSeededCanvas()
    controller.doubleTap(at: CGPoint(x: 900, y: 500), behavior: .toggleFitAnd100)
    controller.dragChanged(translation: CGSize(width: 120, height: -80))
    controller.dragEnded()
    let panned = shown(controller)
    landRealSize(controller, session)
    assertSame(shown(controller), panned)
  }

  func testAPanSpanningTheLandingCarriesOn() {
    let (controller, session) = makeSeededCanvas()
    controller.doubleTap(at: CGPoint(x: 900, y: 500), behavior: .toggleFitAnd100)
    controller.dragChanged(translation: CGSize(width: 60, height: 0))
    let midDrag = shown(controller)
    landRealSize(controller, session)
    assertSame(shown(controller), midDrag)
    controller.dragChanged(translation: CGSize(width: 60, height: 0))
    assertSame(shown(controller), midDrag)
    controller.dragEnded()
  }

  func testAPinchedSeedSurvivesTheLanding() {
    let (controller, session) = makeSeededCanvas()
    controller.pinchChanged(magnification: 1, location: CGPoint(x: 900, y: 500))
    controller.pinchChanged(magnification: 2.5, location: CGPoint(x: 950, y: 480))
    controller.pinchEnded(magnification: 2.5)
    XCTAssertTrue(controller.isZoomedIn)
    let pinched = shown(controller)
    landRealSize(controller, session)
    assertSame(shown(controller), pinched)
  }

  /// The 39% regression (#5755): a pinch begun on the seed, the RAW landing
  /// under the fingers, then a release below fit. It used to commit the
  /// stand-in scale as a real one: 39%, larger than fit and pushed under
  /// the inspector.
  func testAPinchSpanningTheLandingReleasesAtFitNotAt39Percent() {
    let (controller, session) = makeSeededCanvas()
    controller.pinchChanged(magnification: 1, location: CGPoint(x: 900, y: 500))
    controller.pinchChanged(magnification: 0.7, location: CGPoint(x: 950, y: 500))
    let underFingers = shown(controller)
    landRealSize(controller, session)
    assertSame(shown(controller), underFingers)
    controller.pinchChanged(magnification: 0.39, location: CGPoint(x: 1000, y: 500))
    controller.pinchEnded(magnification: 0.39)
    XCTAssertFalse(controller.isZoomedIn)
    XCTAssertEqual(controller.effectivePixelScale, 1858.0 / 6000.0, accuracy: 1e-12)
    XCTAssertEqual(controller.panOffset, controller.context.homePan)
  }
}
