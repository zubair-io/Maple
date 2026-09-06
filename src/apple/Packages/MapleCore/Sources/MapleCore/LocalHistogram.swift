// LocalHistogram.swift — on-device RGB histogram for local & PhotoKit assets.
//
// The S6 Info panel's HistogramBlock shows live RGB curves. For Self-Hosted
// assets it fetches `GET /api/assets/:id/histogram` (CloudHistogramClient);
// for filesystem and PhotoKit assets — which have no server-minted asset id —
// this computes the SAME 3×256 histogram on device via the Rust core, so the
// histogram works on every platform (Mac / iPad / iPhone) regardless of where
// the asset lives.
//
// The histogram reflects the live in-memory edit: the current `AdjustmentModel`
// + `CullingState` are serialised to an XMP document and handed to the bytes
// FFI (`maple_histogram_bytes`), which develops the RAW under those adjustments
// and bins the result. Preview quality keeps the on-edit-settle recompute light
// (a histogram is a statistical reduction — the half-res demosaic is visually
// identical to full quality and ~4× cheaper).

import CoreImage
import Foundation
import os

/// On-device RGB histogram computation for local sources. Heavy work is bounded
/// across all views and asset types; Swift task cancellation cannot preempt a
/// synchronous native develop, so the next request must wait for it to finish.
public enum LocalHistogram {
  private static let computeSlot = BoundedAsyncSemaphore(value: 1)

  /// Acquire before reading bytes, not just before entering the native renderer.
  /// Cancelled slider updates leave the queue without loading another RAW. An
  /// already-running native call retains the permit until it actually returns.
  private static func withComputeSlot(
    _ operation: () async throws -> CloudHistogram
  ) async throws -> CloudHistogram {
    try await computeSlot.acquire()
    do {
      try Task.checkCancellation()
      let result = try await operation()
      try Task.checkCancellation()
      await computeSlot.release()
      return result
    } catch {
      await computeSlot.release()
      throw error
    }
  }

  /// Compute an RGB histogram for `asset` under the given edit state, on device.
  ///
  /// Reads the RAW bytes (filesystem URL or PhotoKit bytes provider), serialises
  /// `model` + `culling` to an XMP document so the histogram reflects the live
  /// edit, and develops at preview quality.
  ///
  /// Safe to call off the main actor — it does no UI work and only touches
  /// `Sendable` inputs. Throws `PipelineError.noByteSource` when the asset has
  /// neither a URL nor a bytes provider, and `PipelineError.renderFailed` when
  /// the FFI decode/render fails (e.g. a non-RAW image, which the Rust decoder
  /// does not handle); callers fall back to the placeholder on any throw.
  public static func compute(
    asset: AssetRef,
    model: AdjustmentModel,
    culling: CullingState
  ) async throws -> CloudHistogram {
    try await withComputeSlot {
      try await computeRaw(asset: asset, model: model, culling: culling)
    }
  }

  private static func computeRaw(
    asset: AssetRef, model: AdjustmentModel, culling: CullingState
  ) async throws -> CloudHistogram {
    let operation = UUID().uuidString
    let log = Logger(subsystem: "app.justmaple.aperture", category: "HistogramDiagnostic")
    log.notice(
      "histogram begin id=\(operation, privacy: .public) cancelled=\(Task.isCancelled) deepDenoise=\(model.deepDenoise) crop=\(String(describing: model.crop), privacy: .public)"
    )
    defer {
      log.notice("histogram end id=\(operation, privacy: .public) cancelled=\(Task.isCancelled)")
    }
    // Serialise the live model so the histogram tracks the current edit. A
    // sourceless asset has no `.xmp` on disk, so we hand the document text
    // straight to the FFI rather than a path.
    let xmpDocument = XMPSerializer.serialize(model: model, culling: culling)

    let rawBytes: Data
    let hint: String
    if let url = asset.primaryURL {
      // Security-scoped read mirrors `ImageEditPipeline`'s FFI reads: the scope
      // claim MUST be on the bookmark-resolved ancestor (`scopeParentURL`), not
      // a path-reconstructed parent — the latter carries no scope token and
      // `startAccessing` silently no-ops, so the read would hit EPERM under the
      // sandbox.
      let scope = asset.scopeParentURL ?? url.deletingLastPathComponent()
      let accessing = scope.startAccessingSecurityScopedResource()
      defer { if accessing { scope.stopAccessingSecurityScopedResource() } }
      rawBytes = try Data(contentsOf: url)
      hint = url.pathExtension
    } else if let provider = asset.bytesProvider {
      rawBytes = try await provider()
      hint = asset.hintExtension ?? ""
    } else {
      throw PipelineError.noByteSource
    }

    try Task.checkCancellation()
    return try PipelineRenderer.histogram(
      rawBytes: rawBytes,
      hint: hint,
      xmpDocument: xmpDocument,
      quality: .preview
    )
  }

  /// Compute an RGB histogram for a NON-RAW `asset` (a stitched panorama PNG,
  /// JPEG, HEIF, screenshot) under the given edit, on device.
  ///
  /// The Rust decoder behind `compute(...)` is RAW-only, so a non-RAW asset
  /// can't use it. Instead we develop the image through the SAME CoreImage
  /// non-RAW pipeline that renders it on the canvas
  /// (`decodeSceneLinearNonRaw` → `processSceneLinearNonRaw`) and bin the
  /// displayed pixels with `CIAreaHistogram`. Two properties matter:
  ///
  ///   • **Render-path-independent** — it does its OWN develop rather than
  ///     reading the live preview, so it works whether the canvas is on the
  ///     CPU path or the wgpu GPU live path (the GPU path emits no CIImage to
  ///     read back). This mirrors how the RAW path bins via a separate FFI
  ///     develop instead of the on-screen image.
  ///   • **Reflects exactly what's shown** — it bins the display-encoded
  ///     output of the non-RAW chain, so the curves match the canvas.
  ///
  /// Develops at reduced resolution (~1 MP): a histogram is a statistical
  /// reduction, so the down-sampled develop is visually identical to full and
  /// far cheaper — and it never decodes the full 100MP+ panorama canvas, so it
  /// is memory-safe on device. `culling` crop is intentionally NOT applied
  /// here (the non-RAW canvas applies crop at the view layer; panoramas are
  /// uncropped), so the histogram bins the full developed frame.
  ///
  /// Throws `PipelineError.noByteSource` when the asset has neither a URL nor
  /// a bytes provider, and `PipelineError.renderFailed` when the decode or the
  /// bin fails; callers fall back to the placeholder on any throw.
  public static func computeNonRaw(
    asset: AssetRef,
    model: AdjustmentModel
  ) async throws -> CloudHistogram {
    try await withComputeSlot {
      try await computeNonRawImage(asset: asset, model: model)
    }
  }

  private static func computeNonRawImage(
    asset: AssetRef, model: AdjustmentModel
  ) async throws -> CloudHistogram {
    guard asset.primaryURL != nil || asset.bytesProvider != nil else {
      throw PipelineError.noByteSource
    }

    // A fresh pipeline carries its own Metal-backed CIContext. The histogram
    // is debounced (computed on edit-settle, not per slider tick), so the
    // per-call context setup is not on the hot path.
    let pipeline = ImageEditPipeline()

    // ~1 MP develop — statistically identical to full-res for a histogram and
    // OOM-safe on the panorama case (a thumbnail decode, never the full canvas).
    let target = CGSize(width: 1024, height: 1024)
    guard let decoded = await pipeline.decodeSceneLinearNonRaw(asset: asset, targetSize: target)
    else {
      throw PipelineError.renderFailed(code: -1, message: "non-RAW histogram decode failed")
    }
    try Task.checkCancellation()
    let developed = pipeline.processSceneLinearNonRaw(
      decoded: decoded,
      model: model,
      targetSize: nil,
      assetID: asset.id
    )
    return try binDisplayedHistogram(developed, context: pipeline.context)
  }

  /// Bin a developed (display-encoded) CIImage into a 3×256 RGB histogram via
  /// `CIAreaHistogram`. The `HistogramBlock` view normalises each channel by
  /// its own max before drawing, so absolute counts don't matter — we scale
  /// the per-bin fractions back up by the developed pixel area so the returned
  /// integers read like real counts.
  private static func binDisplayedHistogram(
    _ image: CIImage,
    context: CIContext
  ) throws -> CloudHistogram {
    let extent = image.extent
    guard extent.width >= 1, extent.height >= 1, extent.width.isFinite, extent.height.isFinite
    else {
      throw PipelineError.renderFailed(code: -2, message: "degenerate histogram extent")
    }

    // CIAreaHistogram → a `bins`×1 image; each pixel's RGBA holds the
    // per-channel fraction of pixels falling in that bin (inputScale = 1 keeps
    // the values in [0, 1] regardless of pixel count).
    let bins = 256
    let histogramImage = image.applyingFilter(
      "CIAreaHistogram",
      parameters: [
        kCIInputExtentKey: CIVector(cgRect: extent),
        "inputCount": bins,
        "inputScale": 1.0,
      ]
    )

    var floats = [Float](repeating: 0, count: bins * 4)  // RGBA per bin
    // Hand CoreImage the array's contiguous storage explicitly — passing
    // `&floats` to a raw-pointer parameter is not a sound way to expose an
    // Array's buffer. The render writes the bin counts into `floats` in-place.
    floats.withUnsafeMutableBytes { raw in
      context.render(
        histogramImage,
        toBitmap: raw.baseAddress!,
        rowBytes: bins * 4 * MemoryLayout<Float>.size,
        bounds: CGRect(x: 0, y: 0, width: bins, height: 1),
        format: .RGBAf,
        colorSpace: nil
      )
    }

    let area = Double(max(1, Int(extent.width.rounded()) * Int(extent.height.rounded())))
    func channel(_ offset: Int) -> [Int] {
      (0..<bins).map { i in Int((max(0, Double(floats[i * 4 + offset])) * area).rounded()) }
    }
    return CloudHistogram(r: channel(0), g: channel(1), b: channel(2))
  }
}
