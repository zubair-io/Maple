// PreviewCanvasPagingTests.swift — #5762: how a touch on a Preview page is
// split between dismissing and paging, where a released swipe goes, and what
// the render may draw over the still (#5768).

import CoreGraphics
import XCTest

@testable import MapleCore

final class PreviewCanvasPagingTests: XCTestCase {

  // MARK: - Pull or page

  func testATouchIsUndecidedUntilItHasTravelled() {
    var route = PreviewDragRoute()
    XCTAssertEqual(
      route.classify(translation: CGSize(width: 3, height: 9), pullAllowed: true), .undecided)
  }

  func testADownwardTouchAtFitIsAPull() {
    var route = PreviewDragRoute()
    XCTAssertEqual(
      route.classify(translation: CGSize(width: 9, height: 12), pullAllowed: true), .pull)
  }

  func testASidewaysOrUpwardTouchAtFitPages() {
    var sideways = PreviewDragRoute()
    XCTAssertEqual(
      sideways.classify(translation: CGSize(width: -14, height: 3), pullAllowed: true), .page)
    var upward = PreviewDragRoute()
    XCTAssertEqual(
      upward.classify(translation: CGSize(width: 0, height: -20), pullAllowed: true), .page)
  }

  func testZoomedInEveryTouchPansAndPagesFromItsFirstPoint() {
    var route = PreviewDragRoute()
    XCTAssertEqual(
      route.classify(translation: CGSize(width: 0, height: 2), pullAllowed: false), .page)
  }

  func testAPullOnlyHasToBeAsVerticalAsItIsHorizontal() {
    XCTAssertTrue(PreviewDragRoute.beginsPull(translation: CGSize(width: -6, height: 10)))
    XCTAssertTrue(PreviewDragRoute.beginsPull(translation: CGSize(width: 10, height: 11)))
    XCTAssertTrue(PreviewDragRoute.beginsPull(translation: CGSize(width: 10, height: 10)))
    XCTAssertFalse(PreviewDragRoute.beginsPull(translation: CGSize(width: 11, height: 10)))
    XCTAssertFalse(PreviewDragRoute.beginsPull(translation: CGSize(width: 0, height: -12)))
    XCTAssertFalse(PreviewDragRoute.beginsPull(translation: .zero))
  }

  func testTheDecisionHoldsForTheRestOfTheTouch() {
    var route = PreviewDragRoute()
    route.classify(translation: CGSize(width: 2, height: 30), pullAllowed: true)
    XCTAssertEqual(
      route.classify(translation: CGSize(width: 300, height: 30), pullAllowed: true), .pull)
  }

  // MARK: - Turning the page

  private func turn(_ offset: CGFloat, predicted: CGFloat? = nil, canTurn: Bool = true)
    -> PreviewPageTurn
  {
    PreviewPageTurn.decide(
      offset: offset, predictedOffset: predicted ?? offset, pageWidth: 402, canTurn: canTurn)
  }

  func testPastHalfThePageTurnsIt() {
    XCTAssertEqual(turn(-202), .next)
    XCTAssertEqual(turn(202), .previous)
  }

  func testAShortSlowSwipeSpringsBack() {
    XCTAssertEqual(turn(-120), .stay)
  }

  func testAFlickTurnsThePage() {
    XCTAssertEqual(turn(-60, predicted: -420), .next)
  }

  func testAFlickBackAgainstTheDragStays() {
    XCTAssertEqual(turn(-150, predicted: 260), .stay)
  }

  func testATapsJitterIsNotAFlick() {
    XCTAssertEqual(turn(-4, predicted: -400), .stay)
  }

  func testASinglePhotoNeverTurns() {
    XCTAssertEqual(turn(-380, canTurn: false), .stay)
  }

  // MARK: - When the RAW renders

  func testTheRawRendersOnlyZoomedInPastTheStill() {
    XCTAssertFalse(
      PreviewCanvasRender.shouldRender(
        isZoomedIn: false, shownLongEdgePixels: 2752, stillLongEdgePixels: 1280))
    XCTAssertFalse(
      PreviewCanvasRender.shouldRender(
        isZoomedIn: true, shownLongEdgePixels: 1280, stillLongEdgePixels: 1280))
    XCTAssertTrue(
      PreviewCanvasRender.shouldRender(
        isZoomedIn: true, shownLongEdgePixels: 1281, stillLongEdgePixels: 1280))
  }

  func testWithNoStillYetNothingRenders() {
    XCTAssertFalse(
      PreviewCanvasRender.shouldRender(
        isZoomedIn: true, shownLongEdgePixels: 8000, stillLongEdgePixels: 0))
  }

  // MARK: - What covers the still once rendering (#5768)

  private func cover(
    usesGpu: Bool = true, gpuPresented: Bool = false, gpuLongEdge: CGFloat = 0,
    decoding: Bool = false, cpuLongEdge: CGFloat = 0, still: CGFloat = 1280
  ) -> PreviewCanvasCover {
    PreviewCanvasRender.cover(
      usesGpu: usesGpu, gpuFramePresented: gpuPresented, gpuFrameLongEdgePixels: gpuLongEdge,
      isFullQualityDecoding: decoding, cpuFrameLongEdgePixels: cpuLongEdge,
      stillLongEdgePixels: still)
  }

  func testTheGridThumbnailSeedNeverCoversASharperStill() {
    XCTAssertEqual(cover(decoding: true, cpuLongEdge: 512), .still)
  }

  func testAGpuFrameDevelopedFromASeedWaitsOutTheDecode() {
    XCTAssertEqual(cover(gpuPresented: true, gpuLongEdge: 4000, decoding: true), .still)
  }

  func testAFastPassSofterThanTheStillLeavesTheStillShowing() {
    XCTAssertEqual(
      cover(gpuPresented: true, gpuLongEdge: 1290, cpuLongEdge: 512, still: 2048), .still)
  }

  func testTheRawReplacesASofterStill() {
    XCTAssertEqual(cover(gpuPresented: true, gpuLongEdge: 2580, cpuLongEdge: 512), .gpuFrame)
  }

  func testTheRawReplacesAStillOfItsOwnSize() {
    XCTAssertEqual(cover(gpuPresented: true, gpuLongEdge: 1280), .gpuFrame)
  }

  func testAGpuFrameOnlyCoversOnceItHasPresented() {
    XCTAssertEqual(cover(gpuPresented: false, gpuLongEdge: 4000), .still)
  }

  func testACpuFrameAsSharpAsTheStillCoversIt() {
    XCTAssertEqual(cover(decoding: true, cpuLongEdge: 2796), .cpuFrame)
    XCTAssertEqual(
      cover(usesGpu: false, gpuPresented: true, gpuLongEdge: 4000, cpuLongEdge: 3000), .cpuFrame)
  }

  func testWithoutAFrameTheStillShows() {
    XCTAssertEqual(cover(), .still)
  }
}
