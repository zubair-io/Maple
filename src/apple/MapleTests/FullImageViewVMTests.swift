// FullImageViewVMTests.swift — unit tests for the canvas-path-selection helper
// in `Maple/Views/FullImageView+VM.swift`.
//
// Lives in the MapleTests Xcode target (not MapleCore) because `FullImageViewVM`
// is declared in the app target — that's where the view + its VM sibling live
// (per the `+VM.swift` co-location pattern). MapleTests is host-targeted on
// Maple Exposure.app, so `@testable import Maple_Exposure` is the standard way
// to reach app-target types from a test bundle. The app target's product name
// is "Maple Exposure", so its Swift module name is `Maple_Exposure` (spaces
// become underscores).
//
// Focus: the GPU-live canvas branch must gate on `asset.isRaw`. Before the fix,
// `canvasContent` showed the opaque `GpuLiveCanvasView` whenever the flag was on
// and we weren't showing the original — with NO `isRaw` check — while
// `EditSession.presentViaGpuLive` bailed at its own `guard asset.isRaw` and
// never presented into the layer. The result for a non-RAW asset (JPEG / HEIC /
// PNG) was a permanently blank `CAMetalLayer`: the CPU `renderedPreview` was
// published but never displayed. These cases lock the corrected truth table so
// that regression can't silently return.

import XCTest

@testable import Maple_Exposure

final class FullImageViewVMTests: XCTestCase {
  // MARK: - shouldPresentViaGpuCanvas

  func testRawAssetUsesGpuCanvasWhenFlagOnAndNotShowingOriginal() {
    // The canonical GPU live case: flag on + RAW + edited view → present via
    // the wgpu `CAMetalLayer`.
    XCTAssertTrue(
      FullImageViewVM.shouldPresentViaGpuCanvas(
        flagEnabled: true, isRaw: true, showingOriginal: false))
  }

  func testNonRawAssetFallsToCpuCanvasEvenWhenFlagOn() {
    // The regression under test (the blank-canvas bug): a non-RAW asset must
    // NOT take the GPU branch. `presentViaGpuLive` returns false for non-RAW
    // and never presents, so the opaque layer would stay blank forever. It
    // must fall through to the CPU `CIImageView` path that rasters
    // `renderedPreview`.
    XCTAssertFalse(
      FullImageViewVM.shouldPresentViaGpuCanvas(
        flagEnabled: true, isRaw: false, showingOriginal: false))
  }

  func testShowingOriginalAlwaysUsesCpuCanvas() {
    // Before/after "original" has no edited GPU frame to present — the CPU
    // path renders the before-image. True for RAW and non-RAW alike.
    XCTAssertFalse(
      FullImageViewVM.shouldPresentViaGpuCanvas(
        flagEnabled: true, isRaw: true, showingOriginal: true))
    XCTAssertFalse(
      FullImageViewVM.shouldPresentViaGpuCanvas(
        flagEnabled: true, isRaw: false, showingOriginal: true))
  }

  func testFlagOffAlwaysUsesCpuCanvas() {
    // Kill-switch (`MAPLE_GPU_LIVE=0`) → CPU + Metal + CIColorCube path
    // byte-for-byte, RAW or not.
    XCTAssertFalse(
      FullImageViewVM.shouldPresentViaGpuCanvas(
        flagEnabled: false, isRaw: true, showingOriginal: false))
    XCTAssertFalse(
      FullImageViewVM.shouldPresentViaGpuCanvas(
        flagEnabled: false, isRaw: false, showingOriginal: false))
  }
}
