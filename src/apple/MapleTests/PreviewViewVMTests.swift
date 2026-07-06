// PreviewViewVMTests.swift — unit tests for the pure helpers in
// `Maple/Views/PreviewView+VM.swift` (Fast Preview epic, design doc
// 2026-07-06-fast-preview-and-phone-card-editor-design.md §4 / §6).
//
// Lives in the MapleTests Xcode target (not MapleCore) because `PreviewViewVM`
// is declared in the app target — that's where the view + its VM sibling live
// (per the `+VM.swift` co-location pattern, same as FullImageViewVMTests /
// InfoPanelVMTests). MapleTests is host-targeted on Maple Exposure.app, so
// `@testable import Maple_Exposure` reaches app-target types (the module name
// replaces the space with an underscore).
//
// Focus: prev/next selection (wrap + clamp edge cases), swipe classification
// (threshold + horizontal dominance), and the image-source selection. UI
// wiring (gestures, layout) is verified by building, not here.

import MapleCore
import XCTest

@testable import Maple_Exposure

final class PreviewViewVMTests: XCTestCase {

  // MARK: - Fixtures

  /// Four assets with stable ids, in a known order.
  private func makeAssets(_ n: Int) -> [AssetRef] {
    (0..<n).map { AssetRef.preview(displayName: "IMG_000\($0).dng") }
  }

  // MARK: - nextID

  func testNextIDAdvancesToTheFollowingAsset() {
    let assets = makeAssets(4)
    let ids = assets.map(\.id)
    XCTAssertEqual(
      PreviewViewVM.nextID(after: ids[0], in: ids),
      ids[1])
    XCTAssertEqual(
      PreviewViewVM.nextID(after: ids[2], in: ids),
      ids[3])
  }

  func testNextIDWrapsPastTheEndByDefault() {
    let ids = makeAssets(3).map(\.id)
    XCTAssertEqual(
      PreviewViewVM.nextID(after: ids[2], in: ids),
      ids[0], "stepping off the end should wrap to the first asset")
  }

  func testNextIDClampsPastTheEndWhenWrapsIsFalse() {
    let ids = makeAssets(3).map(\.id)
    XCTAssertNil(
      PreviewViewVM.nextID(after: ids[2], in: ids, wraps: false),
      "with wraps:false the last asset has no next")
  }

  func testNextIDReturnsFirstWhenNoSelection() {
    let ids = makeAssets(3).map(\.id)
    XCTAssertEqual(
      PreviewViewVM.nextID(after: nil, in: ids),
      ids[0], "no current selection starts at the front")
  }

  func testNextIDReturnsNilForEmptyList() {
    XCTAssertNil(PreviewViewVM.nextID(after: nil, in: []))
    XCTAssertNil(PreviewViewVM.nextID(after: UUID(), in: []))
  }

  func testNextIDReturnsNilWhenCurrentNotPresent() {
    let ids = makeAssets(3).map(\.id)
    // A stale/foreign id has no anchor in the list — no defined "next".
    XCTAssertNil(PreviewViewVM.nextID(after: UUID(), in: ids))
  }

  // MARK: - previousID

  func testPreviousIDStepsBack() {
    let ids = makeAssets(4).map(\.id)
    XCTAssertEqual(
      PreviewViewVM.previousID(before: ids[3], in: ids),
      ids[2])
    XCTAssertEqual(
      PreviewViewVM.previousID(before: ids[1], in: ids),
      ids[0])
  }

  func testPreviousIDWrapsPastTheFrontByDefault() {
    let ids = makeAssets(3).map(\.id)
    XCTAssertEqual(
      PreviewViewVM.previousID(before: ids[0], in: ids),
      ids[2], "stepping off the front should wrap to the last asset")
  }

  func testPreviousIDClampsPastTheFrontWhenWrapsIsFalse() {
    let ids = makeAssets(3).map(\.id)
    XCTAssertNil(
      PreviewViewVM.previousID(before: ids[0], in: ids, wraps: false),
      "with wraps:false the first asset has no previous")
  }

  func testPreviousIDReturnsLastWhenNoSelection() {
    let ids = makeAssets(3).map(\.id)
    XCTAssertEqual(
      PreviewViewVM.previousID(before: nil, in: ids),
      ids[2])
  }

  func testPreviousIDReturnsNilForEmptyList() {
    XCTAssertNil(PreviewViewVM.previousID(before: nil, in: []))
  }

  // MARK: - Single-element list

  func testSingleElementWrapsToItself() {
    let ids = makeAssets(1).map(\.id)
    XCTAssertEqual(PreviewViewVM.nextID(after: ids[0], in: ids), ids[0])
    XCTAssertEqual(PreviewViewVM.previousID(before: ids[0], in: ids), ids[0])
  }

  // MARK: - swipeStep

  func testSwipeLeftAdvancesToNext() {
    // Content dragged left (dx negative) reveals the next image.
    XCTAssertEqual(
      PreviewViewVM.swipeStep(dx: -80, dy: 5), .next)
  }

  func testSwipeRightGoesToPrevious() {
    XCTAssertEqual(
      PreviewViewVM.swipeStep(dx: 80, dy: -5), .previous)
  }

  func testSwipeBelowThresholdIsIgnored() {
    XCTAssertNil(
      PreviewViewVM.swipeStep(dx: -30, dy: 2),
      "a 30pt drag is below the 40pt threshold")
  }

  func testSwipeAtExactThresholdRegisters() {
    XCTAssertEqual(
      PreviewViewVM.swipeStep(dx: -40, dy: 0), .next,
      "the threshold is inclusive (>=)")
  }

  func testMostlyVerticalDragIsIgnored() {
    // A vertical drag (|dy| > |dx|) must not flip images — that's a scroll /
    // dismiss gesture, not a page turn.
    XCTAssertNil(
      PreviewViewVM.swipeStep(dx: -50, dy: -120),
      "vertical-dominant drags are not image swipes")
  }

  func testCustomThresholdRespected() {
    XCTAssertNil(PreviewViewVM.swipeStep(dx: -60, dy: 0, threshold: 100))
    XCTAssertEqual(PreviewViewVM.swipeStep(dx: -120, dy: 0, threshold: 100), .next)
  }

  // MARK: - thumbnailSource

  func testThumbnailSourceIsLocalBackendForFilesystemAsset() {
    let asset = AssetRef.preview()
    let src = PreviewViewVM.thumbnailSource(for: asset, source: nil)
    guard case let .local(ref, box) = src else {
      return XCTFail("expected .local ThumbnailSource, got \(src)")
    }
    XCTAssertEqual(ref.id, asset.id)
    // A nil ImageSource still yields a (nil-boxed) source — the loader's
    // local branch resolves off primaryURL in that case.
    XCTAssertNil(box?.source)
  }

  // MARK: - filenameMaxWidth (spec §6)

  func testFilenameMaxWidthIsResponsiveToSizeClass() {
    // Regular (iPad/Mac): the full 200pt ceiling, matching the Web fix's
    // 200px cap. Compact (narrow iPhone): a tighter 150pt so a long name
    // can't crowd the header's icon buttons. Both PillHeader (editor) and
    // PreviewView's header read this, so the two truncate identically.
    XCTAssertEqual(PreviewViewVM.filenameMaxWidth(isCompact: false), 200)
    XCTAssertEqual(PreviewViewVM.filenameMaxWidth(isCompact: true), 150)
  }

  func testFilenameMaxWidthNeverExceedsWebCeiling() {
    // Parity guard: neither size class may exceed the Web §6 200px ceiling.
    XCTAssertLessThanOrEqual(PreviewViewVM.filenameMaxWidth(isCompact: false), 200)
    XCTAssertLessThanOrEqual(PreviewViewVM.filenameMaxWidth(isCompact: true), 200)
  }
}
