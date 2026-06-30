// EditSession+GpuPreviewPersist.swift — populate the rendered-preview disk cache
// from the GPU-live path (#1665).
//
// The GPU live present (`presentViaGpuLive`) goes f32 storage → CAMetalLayer with
// NO CIImage, so it skips the CPU path's `renderedPreview =` publish AND the
// `persistCurrentPreviewToCache()` that rides it. Net: GPU-live images (every
// large RAW since the #1647 gate-lift) never write a full-quality preview to
// disk, so every cold open misses `RenderedPreviewCache` and re-runs the full
// Rust decode (~15-20s for 100 MP) — the cache works for exactly the assets
// where it matters least.
//
// Fix (#1665 option 1): on a cold open, after the first full-quality GPU frame
// lands, read that EXACT frame back once (`maple_gpu_live_render` via
// `GpuLiveDriver.renderCurrentFrameBytes`), wrap it as a CIImage, and store it to
// `RenderedPreviewCache` — so the next cold open paints from disk instantly. This
// is a ONE-SHOT per cold open (NOT per slider tick): the readback re-runs the
// chain with a CPU readback, the cost the per-tick present deliberately avoids.

import Foundation
import CoreImage

@MainActor
extension EditSession {
    /// One-shot: read back the just-presented GPU frame and persist it to the
    /// rendered-preview disk cache so a future cold open paints instantly (#1665).
    /// Called once per cold open from `presentViaGpuLive`'s first-full-quality-
    /// frame branch. No-op without a driver / asset URL, or if the readback fails
    /// (the cache simply stays unpopulated — no worse than today).
    func persistGpuFrameToPreviewCache() async {
        guard let driver = gpuLiveDriver, let url = asset.primaryURL else { return }
        // Snapshot the MainActor inputs up front: the cold-open model (so the
        // cached frame reflects the on-disk sidecar even if the user starts
        // editing mid-readback) and `previewSize.width` — the same size bucket the
        // CPU path stores under (`persistCurrentPreviewToCache`) and the cold-open
        // hydration reads with, so the reopen lookup hits this entry.
        let coldOpenModel = model
        let screenWidth = Int(max(previewSize.width, 1))
        guard let frame = await driver.renderCurrentFrameBytes(model: coldOpenModel) else { return }
        // Expand + JPEG-encode + store OFF the MainActor (the readback already
        // hopped to the session actor; keep the editor's actor free).
        await Self.storeGpuFrame(
            frame.bytes, width: frame.width, height: frame.height,
            url: url, screenWidth: screenWidth)
    }

    /// Build the CIImage and store it — `nonisolated` so the RGBA expansion + JPEG
    /// encode run on the cooperative pool, not the MainActor editor.
    nonisolated private static func storeGpuFrame(
        _ bytes: [UInt8], width: Int, height: Int, url: URL, screenWidth: Int
    ) async {
        guard let image = ciImageFromGpuRgb(bytes, width: width, height: height) else { return }
        await RenderedPreviewCache.shared.storePreview(image, for: url, screenWidth: screenWidth)
    }

    /// Wrap the GPU chain's `width·height·3` u8 RGB readback (the canonical
    /// `dither_and_quantize` layout — sRGB-primary gamma-encoded, since the live
    /// params hardcode `target_primaries = 0`) into a CIImage for the preview
    /// cache. Expands RGB→RGBA (CIImage has no 3-channel bitmap format; alpha is
    /// opaque) and tags **sRGB** to match the chain output, so the cache's sRGB
    /// JPEG encode is an identity colour conversion. Pure → unit-testable; returns
    /// `nil` on a degenerate size or a `count != width·height·3` mismatch.
    nonisolated static func ciImageFromGpuRgb(_ rgb: [UInt8], width: Int, height: Int) -> CIImage? {
        let pixelCount = width * height
        guard width > 0, height > 0, rgb.count == pixelCount * 3,
              let space = CGColorSpace(name: CGColorSpace.sRGB) else { return nil }
        // CIImage has no 3-channel bitmap format — expand RGB → opaque RGBA.
        var rgba = [UInt8](repeating: 255, count: pixelCount * 4)
        for i in 0..<pixelCount {
            rgba[i * 4 + 0] = rgb[i * 3 + 0]
            rgba[i * 4 + 1] = rgb[i * 3 + 1]
            rgba[i * 4 + 2] = rgb[i * 3 + 2]
            // alpha stays 255 (the chain output is opaque)
        }
        return CIImage(
            bitmapData: Data(rgba),
            bytesPerRow: width * 4,
            size: CGSize(width: width, height: height),
            format: .RGBA8,
            colorSpace: space
        )
    }
}
