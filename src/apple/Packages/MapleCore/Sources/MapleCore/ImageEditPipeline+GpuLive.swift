// ImageEditPipeline+GpuLive.swift — the f32-readback bridge that feeds the wgpu
// live render path (epic #925, P4b-apple / #1028).
//
// Always compiled (the GPU FFI is in the default xcframework now); reached only
// when the runtime flag is on (`GpuLiveFlag.isEnabled`). Split out of
// `ImageEditPipeline.swift` (an already large, budget-allowlisted orchestrator)
// so the GPU concern is isolated and the orchestrator doesn't grow.
//
// The wgpu chain uploads a GPU-resident f32 RGBA image ONCE per decode; these two
// helpers turn the editor's decoded `CIImage` into that buffer (and its dims)
// without paying a readback on the per-tick path.

import CoreImage
import Foundation
import os

extension ImageEditPipeline {
  /// Materialise a decoded scene-linear CIImage (Rec.2020 fp16, as produced by
  /// `decodeSceneLinear*`) into the interleaved `width·height·4` f32 RGBA buffer
  /// the wgpu `GpuLiveSession` uploads ONCE per decode. Prescales to
  /// `targetSize` first (the viewport-sized fast pass) so the uploaded image —
  /// and therefore the `CAMetalLayer` it presents into — is at the display
  /// resolution the present samples 1:1. Reuses the exact `context.render(
  /// toBitmap:)` path `applySceneLinearChainViaFFI` already uses to hand pixels
  /// to the Rust FFI, in the SAME `extendedLinearITUR_2020` space, so the GPU
  /// chain sees the canonical post-DCP D65 buffer (the decode-boundary contract:
  /// AE + capture-sharpening already baked, WB landed at 6500/0).
  ///
  /// This is a per-DECODE cost (called when the driver opens a session for a new
  /// buffer/dims), NOT per slider tick — the live render loop then runs entirely
  /// on the GPU-resident upload with no further readback. Returns `nil` on a
  /// degenerate extent or a `CIContext.render` failure (the caller then falls
  /// back to the CPU + Metal present path).
  nonisolated func sceneLinearFloats(
    from decoded: CIImage,
    targetSize: CGSize?
  ) -> (pixels: [Float], width: Int, height: Int)? {
    let scaled = Self.prescaleForDisplay(decoded, targetSize: targetSize)
    let extent = scaled.extent
    let w = Int(extent.width.rounded())
    let h = Int(extent.height.rounded())
    guard w > 0, h > 0 else {
      ImageEditPipeline.gpuLiveLog.error("sceneLinearFloats: degenerate extent \(w)x\(h)")
      return nil
    }
    let lanes = w * h * 4
    let bytesPerPixel = 16  // 4 f32 lanes
    let rowBytes = w * bytesPerPixel
    let space = CGColorSpace(name: CGColorSpace.extendedLinearITUR_2020)!

    var pixels = [Float](repeating: 0, count: lanes)
    let ok: Bool = pixels.withUnsafeMutableBytes { buf -> Bool in
      guard let base = buf.baseAddress else { return false }
      context.render(
        scaled,
        toBitmap: base,
        rowBytes: rowBytes,
        bounds: CGRect(x: 0, y: 0, width: w, height: h),
        format: .RGBAf,
        colorSpace: space
      )
      return true
    }
    guard ok else {
      ImageEditPipeline.gpuLiveLog.error("sceneLinearFloats: CIContext.render failed for \(w)x\(h)")
      return nil
    }
    return (pixels, w, h)
  }

  /// The extent `sceneLinearFloats` would produce for `decoded` at `targetSize`
  /// — i.e. the post-`prescaleForDisplay` extent — computed from dimensions
  /// without constructing a CoreImage filter graph. The GPU driver decides whether its
  /// upload-once session is already at the right dims (a cheap no-op check that
  /// avoids a per-tick readback). `nonisolated` + pure (no actor state), so the
  /// call site needs no actor hop.
  nonisolated func prescaledExtent(of decoded: CIImage, targetSize: CGSize?) -> CGRect {
    let extent = decoded.extent
    guard let targetSize, extent.width > 0, extent.height > 0 else { return extent }
    let scale = min(targetSize.width / extent.width, targetSize.height / extent.height, 1.0)
    guard scale < 0.99 else { return extent }
    // Match prescaleForDisplay's explicit crop, including its floor and
    // no-upscale cutoff. Equivalence tests gate this against the CI graph.
    let scaled = CGRect(
      x: 0, y: 0,
      width: floor(extent.width * scale),
      height: floor(extent.height * scale)
    ).standardized
    return scale != 0 && scaled.isEmpty ? .null : scaled
  }
}

extension ImageEditPipeline {
  /// Logger for the gpu-live readback bridge (the orchestrator's own `logger`
  /// is file-private to `ImageEditPipeline.swift`).
  fileprivate static let gpuLiveLog = Logger(
    subsystem: "app.justmaple.aperture", category: "ImageEditPipeline.GpuLive")
}
