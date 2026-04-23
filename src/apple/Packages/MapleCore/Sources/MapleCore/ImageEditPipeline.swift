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

// MARK: - ImageEditPipeline

/// Thread-safe pipeline that converts a RAW asset + AdjustmentModel to a CIImage.
public actor ImageEditPipeline {
    private let context: CIContext

    public init() {
        // Use a Metal-backed context where available; fall back to CPU.
        self.context = CIContext(options: [.workingColorSpace: CGColorSpace(name: CGColorSpace.linearSRGB)!])
    }

    // MARK: Render

    /// Render the asset through the pipeline.
    /// - fast phase: scales the RAW decode result to ≤ 2MP before filtering.
    /// - refine phase: full-resolution.
    ///
    /// Dispatch: filesystem-shaped assets (`asset.primaryURL != nil`) use the
    /// path-based FFI call so the Rust decoder can mmap the file. Sourceless
    /// assets (PhotoKit, self-hosted API) pull bytes via
    /// `asset.bytesProvider` and hand them to `maple_render_bytes`.
    nonisolated public func render(
        asset: AssetRef,
        model: AdjustmentModel,
        phase: RenderPhase
    ) async -> CIImage? {
        // Stage 1: RAW decode via Rust FFI (produces sRGB u8).
        let imageData: MapleImageData
        do {
            if let url = asset.primaryURL {
                imageData = try PipelineRenderer.render(
                    rawPath: url,
                    xmpPath: nil   // we apply adjustments via CIFilter below
                )
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
            return nil
        }

        guard let ciImage = ciImage(from: imageData, phase: phase) else { return nil }

        // Stages 2–10: CIFilter chain.
        return applyFilters(to: ciImage, model: model)
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

    nonisolated private func applyFilters(to input: CIImage, model: AdjustmentModel) -> CIImage {
        var img = input

        // Stage 3: White balance (temperature + tint)
        // CITemperatureAndTint neutral point is ~6500K / 0 tint.
        let wb = CIFilter.temperatureAndTint()
        wb.inputImage = img
        wb.neutral = CIVector(x: CGFloat(model.temperature), y: CGFloat(model.tint))
        wb.targetNeutral = CIVector(x: 6500, y: 0)
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
