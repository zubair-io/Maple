// ImageEditPipeline.swift — 11-stage filter chain (spec § 02).
//
// On Apple platforms, this runs as CIFilter + custom CIColorKernel stages.
// Two-phase render: fast (≤ 50ms, downscaled) → refine (full-res, ≤ 300ms).
//
// Stage order (spec § 02):
//   1. RAW decode              → via PipelineRenderer (Rust raw-ffi)
//   2. Exposure                → CIExposureAdjust
//   3. White balance           → CITemperatureAndTint
//   4. Tone controls           → SceneToneControls (custom Metal kernel)
//   5. Vibrance / saturation   → CIVibrance + CISaturationBlendMode workaround
//   6. Clarity / Texture       → CIUnsharpMask (two radii)
//   7. Sharpening              → CIUnsharpMask (detail + masking)
//   8. Noise reduction         → CINoiseReduction
//   9. Dehaze                  → custom CIColorKernel (stub → linear bias)
//  10. View transform (AgX)    → AgXViewTransform (custom Metal kernel)
//  11. sRGB encode             → CIColorPrimariesITUR_709 (implicit)

import Foundation
import CoreImage
import CoreImage.CIFilterBuiltins
import Metal
import os

private let logger = Logger(subsystem: "app.justmaple.maple", category: "ImageEditPipeline")

// MARK: - ImageEditPipeline

/// Thread-safe pipeline that converts a RAW asset + AdjustmentModel to a CIImage.
///
/// Two-entry-point design (ported from Maple reference `ImageEditPipeline`):
///
///   • `decode(asset:)` runs the Rust FFI once per asset open and returns a
///     **neutral** CIImage (no WB, no exposure — all adjustments applied
///     post-decode). EditSession caches this result so slider ticks don't
///     re-decode.
///   • `process(decoded:model:targetSize:)` applies the CIFilter / Metal-kernel
///     chain on top of a pre-decoded CIImage. When `targetSize` is provided
///     and smaller than the decoded extent, a `CILanczosScaleTransform` pass
///     is fused in front of the chain so every intermediate runs at display
///     resolution — CoreImage's render planner auto-tiles when the Metal
///     device can't hold the output in a single pass, so 100MP previews fit
///     in the 16 ms budget.
///
/// `render(asset:model:phase:)` is kept as a thin convenience that does both
/// steps sequentially — used by export / thumbnails where there's no cached
/// decoded image to reuse.
public actor ImageEditPipeline {
    /// As-shot white balance derived from the RAW's metadata. Passed into
    /// `process(...)` so `CITemperatureAndTint`'s `neutral` reflects the
    /// camera's metered white point — the slider then behaves as a scene
    /// white-point selector (Lightroom semantics), not a delta from 6500 K.
    public struct AsShotWB: Sendable, Equatable {
        public var temperature: Double
        public var tint: Double
        public init(temperature: Double, tint: Double) {
            self.temperature = temperature
            self.tint = tint
        }
    }

    private let context: CIContext

    public init() {
        // Metal-backed context where available; `cacheIntermediates: false`
        // + fp16 working format keeps memory bounded enough that CoreImage
        // can tile internally on a 100MP input. Mirrors the reference
        // pipeline's settings.
        if let device = MTLCreateSystemDefaultDevice() {
            self.context = CIContext(mtlDevice: device, options: [
                .workingColorSpace: CGColorSpace(name: CGColorSpace.extendedLinearSRGB)!,
                .workingFormat: CIFormat.RGBAh,
                .cacheIntermediates: false,
            ])
        } else {
            self.context = CIContext(options: [
                .workingColorSpace: CGColorSpace(name: CGColorSpace.linearSRGB)!,
                .workingFormat: CIFormat.RGBAh,
                .cacheIntermediates: false,
            ])
        }
    }

    // MARK: Decode (cached path)

    /// Decode the RAW into a neutral CIImage via the Rust FFI. Call once per
    /// asset open; cache the result in `EditSession` so slider ticks skip the
    /// decode entirely.
    ///
    /// Security scope is claimed on the asset URL and its parent folder for
    /// the duration of the FFI call — the Rust decoder mmaps the file and
    /// without an active scope the read fails on sandboxed builds.
    nonisolated public func decode(asset: AssetRef) async -> CIImage? {
        let imageData: MapleImageData
        do {
            if let url = asset.primaryURL {
                // Scope claim MUST be on the bookmark-resolved ancestor URL
                // — `url.deletingLastPathComponent()` is a plain path URL
                // with no scope token and `startAccessing` silently no-ops,
                // so the Rust FFI's `std::fs::read(path)` would hit EPERM
                // under the sandbox. `asset.scopeParentURL` is populated by
                // `FilesystemSource` / `BrowseViewModel.currentScopeRoot`.
                let scope = asset.scopeParentURL ?? url.deletingLastPathComponent()
                let accessing = scope.startAccessingSecurityScopedResource()
                defer { if accessing { scope.stopAccessingSecurityScopedResource() } }
                imageData = try PipelineRenderer.render(rawPath: url, xmpPath: nil)
            } else if let provider = asset.bytesProvider {
                let bytes = try await provider()
                let hint = asset.hintExtension ?? ""
                imageData = try PipelineRenderer.render(
                    rawBytes: bytes,
                    hint: hint,
                    xmpPath: nil
                )
            } else {
                return nil
            }
        } catch {
            logger.error("decode failed for \(asset.displayName, privacy: .public): \(error.localizedDescription, privacy: .public)")
            return nil
        }
        return ciImage(from: imageData, phase: .refine)
    }

    // MARK: Process (on top of a cached decode)

    /// Apply the filter chain to a pre-decoded CIImage. `targetSize`, if
    /// provided and smaller than the decoded extent, fuses a Lanczos pre-
    /// scale into the chain so every intermediate runs at display resolution.
    /// Pass `nil` for export / full-resolution rendering.
    ///
    /// `asShot`, when provided, is used as `CITemperatureAndTint.neutral`
    /// — i.e. the image is told "you were shot at this WB" and the
    /// filter adapts to the user's target (`model.temperature/tint`). When
    /// `nil`, the neutral defaults to 6500 K / 0, which matches the
    /// pipeline's historical behaviour.
    nonisolated public func process(
        decoded: CIImage,
        model: AdjustmentModel,
        targetSize: CGSize? = nil,
        asShot: AsShotWB? = nil
    ) -> CIImage {
        let prescaled = Self.prescaleForDisplay(decoded, targetSize: targetSize)
        return applyFilters(to: prescaled, model: model, asShot: asShot)
    }

    // MARK: Render preview (processed CIImage → CGImage)

    /// Materialise a processed CIImage into a CGImage at (at most) the given
    /// target size. Used by the on-demand export path and by diagnostic
    /// tools; the live slider path currently publishes CIImage directly
    /// (see `EditSession.renderedPreview`) and lets SwiftUI's `CIImageView`
    /// handle the final raster.
    ///
    /// Target-size math matches the reference — never upscale, use
    /// Lanczos-style downscale via a lazy transform so the CoreImage render
    /// planner can fuse it with the filter chain and auto-tile.
    nonisolated public func renderPreview(_ ciImage: CIImage, targetSize: CGSize) -> CGImage? {
        let extent = ciImage.extent
        guard extent.width > 0, extent.height > 0 else { return nil }

        let sx = targetSize.width / extent.width
        let sy = targetSize.height / extent.height
        let scale = min(sx, sy, 1.0)

        let scaled: CIImage = scale < 1.0
            ? ciImage.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
            : ciImage

        return context.createCGImage(scaled, from: scaled.extent)
    }

    // MARK: Render (convenience — decode + process)

    /// Render the asset through the pipeline in one call. Used by export and
    /// by the thumbnail path — neither benefits from a cached decode.
    /// EditSession prefers the `decode(asset:)` + `process(decoded:...)`
    /// split so slider ticks stay off the FFI.
    ///
    /// - fast phase: scales the RAW decode result to ≤ 2MP before filtering.
    /// - refine phase: full-resolution.
    nonisolated public func render(
        asset: AssetRef,
        model: AdjustmentModel,
        phase: RenderPhase
    ) async -> CIImage? {
        guard let decoded = await decode(asset: asset) else { return nil }
        let target: CGSize? = phase == .fast
            ? Self.fastTargetSize(for: decoded.extent.size)
            : nil
        return process(decoded: decoded, model: model, targetSize: target)
    }

    // MARK: Prescale helper (tiling-friendly)

    /// Lanczos-downscale `input` to fit within `targetSize` (aspect
    /// preserved). Never upscales; returns `input` unchanged when the ratio
    /// would be ≥ 0.99. Ported from Maple reference — the CIImage returned
    /// is lazy, so the downscale and the filter chain fuse into a single
    /// render plan and the full-res intermediate never materialises.
    nonisolated private static func prescaleForDisplay(
        _ input: CIImage,
        targetSize: CGSize?
    ) -> CIImage {
        guard let targetSize else { return input }
        let extent = input.extent
        guard extent.width > 0, extent.height > 0 else { return input }
        let sx = targetSize.width / extent.width
        let sy = targetSize.height / extent.height
        let scale = min(sx, sy, 1.0)
        guard scale < 0.99 else { return input }

        let clamped = input.clampedToExtent()
        let lanczos = clamped.applyingFilter("CILanczosScaleTransform", parameters: [
            kCIInputScaleKey: scale,
            kCIInputAspectRatioKey: 1.0,
        ])
        return lanczos.cropped(to: CGRect(
            x: 0, y: 0,
            width: floor(extent.width * scale),
            height: floor(extent.height * scale)
        ))
    }

    /// Target size for the fast phase — caps the decoded extent at ≤ 2MP.
    nonisolated private static func fastTargetSize(for native: CGSize) -> CGSize {
        let pixels = native.width * native.height
        let maxPixels: CGFloat = 2_000_000
        if pixels <= maxPixels { return native }
        let scale = sqrt(maxPixels / pixels)
        return CGSize(
            width: floor(native.width * scale),
            height: floor(native.height * scale)
        )
    }

    // MARK: Private helpers

    nonisolated private func ciImage(from data: MapleImageData, phase: RenderPhase) -> CIImage? {
        guard data.pixels.count == data.width * data.height * 3 else { return nil }
        let w = data.width, h = data.height

        // Build a CIImage from the packed sRGB u8 buffer.
        let bitmapInfo = CGImageAlphaInfo.none.rawValue
        // Copy the pixel bytes so the data provider doesn't outlive `data`.
        let copy = data.pixels
        let dp = CGDataProvider(data: copy as CFData)!

        let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!
        guard let cgImg = CGImage(
            width: w, height: h,
            bitsPerComponent: 8, bitsPerPixel: 24,
            bytesPerRow: w * 3,
            space: colorSpace,
            bitmapInfo: CGBitmapInfo(rawValue: bitmapInfo),
            provider: dp,
            decode: nil,
            shouldInterpolate: true,
            intent: .defaultIntent
        ) else { return nil }

        var ci = CIImage(cgImage: cgImg)

        if phase == .fast {
            // Downscale to ≤ 2MP for fast phase.
            let maxPixels: Int = 2_000_000
            let pixels = w * h
            if pixels > maxPixels {
                let scale = sqrt(Double(maxPixels) / Double(pixels))
                ci = ci.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
            }
        }
        return ci
    }

    nonisolated private func applyFilters(to input: CIImage, model: AdjustmentModel, asShot: AsShotWB? = nil) -> CIImage {
        var img = input

        // Stage 3: White balance (temperature + tint).
        //
        // CITemperatureAndTint semantics:
        //   • `neutral`       = the temperature/tint the image *is*
        //   • `targetNeutral` = the temperature/tint the user *wants*
        //
        // When `asShot` is provided (RAWs opened via filesystem), neutral
        // reflects the camera's metered WB and the slider acts as a scene
        // white-point selector — default (slider = asShotCCT) is identity,
        // moving higher warms the image, lower cools it. Matches Lightroom.
        //
        // When absent (PhotoKit / sourceless / non-RAW), fall back to the
        // old 6500 K convention so existing behaviour is preserved.
        let neutralTemp = asShot?.temperature ?? 6500
        let neutralTint = asShot?.tint ?? 0
        let wb = CIFilter.temperatureAndTint()
        wb.inputImage = img
        wb.neutral = CIVector(x: CGFloat(neutralTemp), y: CGFloat(neutralTint))
        wb.targetNeutral = CIVector(x: CGFloat(model.temperature), y: CGFloat(model.tint))
        img = wb.outputImage ?? img

        // Stage 4: Scene tone controls (exposure + H/S/W/B) via Metal kernel.
        // Exposure is handled here (not separately above) to match the Rust stage order.
        img = MetalKernels.applySceneToneControls(
            to: img,
            exposure: Float(model.exposure),
            highlights: Float(model.highlights),
            shadows: Float(model.shadows),
            whites: Float(model.whites),
            blacks: Float(model.blacks)
        )

        // Stage 5: Vibrance (Metal kernel) + Saturation
        if model.vibrance != 0 {
            img = MetalKernels.applySceneVibrance(to: img, vibrance: Float(model.vibrance))
        }
        if model.saturation != 0 {
            let f = CIFilter.colorControls()
            f.inputImage = img
            f.saturation = Float(1.0 + model.saturation / 100.0)
            f.brightness = 0
            f.contrast = 1
            img = f.outputImage ?? img
        }

        // Stage 6: Clarity (radius 40) + Texture (radius 3) via unsharp mask
        if model.clarity != 0 {
            let strength = Float(model.clarity / 100.0) * 0.5
            let f = CIFilter.unsharpMask()
            f.inputImage = img
            f.radius = 40.0
            f.intensity = strength
            img = f.outputImage ?? img
        }
        if model.texture != 0 {
            let strength = Float(model.texture / 100.0) * 0.8
            let f = CIFilter.unsharpMask()
            f.inputImage = img
            f.radius = 3.0
            f.intensity = strength
            img = f.outputImage ?? img
        }

        // Stage 7: Sharpening
        if model.sharpenAmount > 0 {
            let f = CIFilter.unsharpMask()
            f.inputImage = img
            f.radius = Float(model.sharpenRadius)
            f.intensity = Float(model.sharpenAmount / 100.0)
            img = f.outputImage ?? img
        }

        // Stage 8: Noise reduction
        if model.nrLuminance > 0 || model.nrColor > 25 {
            let f = CIFilter.noiseReduction()
            f.inputImage = img
            f.noiseLevel = Float(max(model.nrLuminance, model.nrColor) / 100.0) * 0.05
            f.sharpness = 0.4
            img = f.outputImage ?? img
        }

        // Stage 9: Dehaze (linear bias stub — full impl in P5 Metal kernel)
        if model.dehaze != 0 {
            img = applyDehaze(img, amount: model.dehaze)
        }

        // Stage 10: AgX view transform (Metal kernel).
        img = MetalKernels.applyAgXViewTransform(to: img, contrast: Float(model.contrast))

        return img
    }

    // MARK: - Dehaze stub (linear brightness boost in midtones)

    nonisolated private func applyDehaze(_ input: CIImage, amount: Double) -> CIImage {
        // Very simple dehaze stub: positive amount → reduce blacks and boost midtones;
        // negative amount → add haze effect. Full Oklab implementation in P5.
        let v = Float(amount / 100.0)
        let f = CIFilter.colorControls()
        f.inputImage = input
        f.brightness = v * 0.05
        f.contrast = 1.0 + v * 0.1
        f.saturation = 1.0 + v * 0.05
        return f.outputImage ?? input
    }

}
