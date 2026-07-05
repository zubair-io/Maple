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
// Focus: the GPU-live canvas branch gates on `flagEnabled && !showingOriginal`
// only. Both RAW and non-RAW assets take the GPU branch — #1331 extended the
// wgpu chain to handle non-RAW `InputShape::LinearRec2020Fp16` (JPEG / HEIF /
// pano PNG) AND #1362 dropped the `isRaw` term from the canvas-mount predicate.
// Previously a non-RAW asset would mount the CPU canvas, so `driver.register`
// never fired and every `presentViaGpuLive` tick rejected `no-layer` — caught
// on iPad with a pano export. The cases below lock the corrected truth table.

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

  func testNonRawAssetUsesGpuCanvasWhenFlagOn() {
    // #1331/#1362: the wgpu live chain handles non-RAW input shapes too, and
    // the canvas-mount predicate no longer gates on `isRaw`. A non-RAW asset
    // with the flag on (and not showing the original) must take the GPU
    // branch — otherwise `driver.register(layer:)` never fires, every
    // `presentViaGpuLive` tick rejects `no-layer`, and the chain falls back
    // to CPU. (Caught on iPad with a pano PNG export.)
    XCTAssertTrue(
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

  func testPresentFailureUnmountsGpuCanvas() {
    // #1769: once a GPU present has THROWN (`EditSession.gpuPresentFailed`),
    // the GPU canvas must unmount so the CPU fallback preview is visible — a
    // torn drawable has no GPU repaint path of its own.
    XCTAssertFalse(
      FullImageViewVM.shouldPresentViaGpuCanvas(
        flagEnabled: true, isRaw: true, showingOriginal: false,
        presentFailed: true))
    // And the default (no failure) keeps the GPU branch.
    XCTAssertTrue(
      FullImageViewVM.shouldPresentViaGpuCanvas(
        flagEnabled: true, isRaw: true, showingOriginal: false,
        presentFailed: false))
  }
}
