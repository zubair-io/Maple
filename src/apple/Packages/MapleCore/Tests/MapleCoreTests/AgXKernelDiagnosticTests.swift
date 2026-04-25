// AgXKernelDiagnosticTests.swift — diagnostic for the brightness investigation
// (2026-04-25 keen-gould-063563).
//
// Purpose: determine whether `MetalKernels.agxKernel()` actually loads on
// this branch (which lacks the `[[stitchable]]` attribute and the inline
// AgX sigmoid fix from main commit 8ff4142). If the kernel load fails,
// `applyAgXViewTransform` silently returns its input unchanged
// (MetalKernels.swift:206-241), and the rest of `processSceneLinear` ships
// scene-linear Rec.2020 fp16 to the CIContext, which sRGB-encodes it for
// PNG. That produces midtone u8 values around 105-110 on this fixture —
// exactly what the committed golden test_0017-default.png shows.
//
// This test does NOT modify production code. It only probes:
//
//   1. Does `MetalKernels.agxKernel()` return non-nil?
//   2. Does `MetalKernels.agxLUTImage()` return non-nil?
//   3. Apply AgX to a synthetic mid-gray (0.18) Rec.2020 input. Render
//      to sRGB u8. Expected u8 with working AgX: ~187. Observed if AgX
//      silently no-ops: ~117 (scene 0.18 Rec.2020 -> sRGB encoded).
//
// The test asserts diagnostic information loudly via XCTContext.
//
// Cross-links:
//   docs/tickets/08-agx-metal-kernel-lut-sampler.md
//   src/apple/Packages/MapleCore/Sources/MapleCore/Metal/AgXViewTransform.metal
//   src/apple/Packages/MapleCore/Sources/MapleCore/MetalKernels.swift:202-242

import XCTest
import CoreImage
import CoreGraphics
import AppKit
@testable import MapleCore

final class AgXKernelDiagnosticTests: XCTestCase {

    /// Sanity probe: does the AgX kernel load, does the LUT load, and what
    /// does AgX produce on synthetic scene-linear 0.18 mid-gray?
    ///
    /// Expected with working AgX: u8 ~= 187 (Blender 4.x polynomial @ MID_NORM).
    /// Expected when AgX no-ops:  u8 ~= 117 (scene 0.18 Rec.2020 -> sRGB encoded).
    func testAgXKernelOnMidGray() throws {
        // (1) Probe kernel load.
        let kernel = MetalKernels.agxKernel()
        XCTContext.runActivity(named: "AgX kernel load") { _ in
            if kernel == nil {
                XCTFail(
                    "AgX kernel failed to load. " +
                    "applyAgXViewTransform will silently return input. " +
                    "processSceneLinear ships scene-linear Rec.2020 to CIContext, " +
                    "and the canvas displays a gamma-curved scene-linear render."
                )
            }
        }

        // (2) Probe LUT image load.
        let lut = MetalKernels.agxLUTImage()
        XCTContext.runActivity(named: "AgX LUT load") { _ in
            if lut == nil {
                XCTFail("AgX LUT image failed to load.")
            }
        }

        // (3) Synthetic mid-gray probe — independent of the kernel-load
        // outcome. Build a 4x4 fp16 RGBA Rec.2020 image with all pixels at
        // (0.18, 0.18, 0.18). Apply `applyAgXViewTransform`. Render to sRGB
        // u8 via the same CIContext shape `processSceneLinear`'s caller
        // uses. Inspect the output's centre pixel.
        let w = 4, h = 4
        var pixels = [UInt16](repeating: 0, count: w * h * 4)
        let halfOnePoint18 = float32_to_half(0.18)
        let halfOne = float32_to_half(1.0)
        for i in 0..<(w * h) {
            pixels[i * 4 + 0] = halfOnePoint18
            pixels[i * 4 + 1] = halfOnePoint18
            pixels[i * 4 + 2] = halfOnePoint18
            pixels[i * 4 + 3] = halfOne
        }
        let rec2020 = CGColorSpace(name: CGColorSpace.extendedLinearITUR_2020)!
        let bytesPerRow = w * 8
        let inputCI = pixels.withUnsafeBufferPointer { buf -> CIImage in
            let data = Data(buffer: buf)
            return CIImage(
                bitmapData: data,
                bytesPerRow: bytesPerRow,
                size: CGSize(width: w, height: h),
                format: .RGBAh,
                colorSpace: rec2020
            )
        }

        let outCI = MetalKernels.applyAgXViewTransform(
            to: inputCI, contrast: 0
        )

        // Render outCI to RGBA8 sRGB and read the centre pixel.
        let outSpace = CGColorSpace(name: CGColorSpace.sRGB)!
        let workingSpace = CGColorSpace(name: CGColorSpace.extendedLinearSRGB)!
        let ciCtx: CIContext
        if let device = MTLCreateSystemDefaultDevice() {
            ciCtx = CIContext(mtlDevice: device, options: [
                .workingColorSpace: workingSpace,
                .workingFormat: CIFormat.RGBAh,
                .cacheIntermediates: false,
            ])
        } else {
            ciCtx = CIContext(options: [
                .workingColorSpace: workingSpace,
                .workingFormat: CIFormat.RGBAh,
                .cacheIntermediates: false,
            ])
        }
        guard let cg = ciCtx.createCGImage(
            outCI,
            from: CGRect(x: 0, y: 0, width: w, height: h),
            format: .RGBA8,
            colorSpace: outSpace
        ) else {
            XCTFail("createCGImage returned nil")
            return
        }
        let centre = readCentrePixelU8(cg)
        let r = centre.0, g = centre.1, b = centre.2
        print("AGX_PROBE: centre pixel u8 = (\(r), \(g), \(b))")
        print("AGX_PROBE: expected with working AgX = ~187 (188 +/- 1)")
        print("AGX_PROBE: expected with AgX silently no-op = ~117 (scene 0.18 -> sRGB encode)")

        // Hard assertion: a working AgX produces u8 ~187.
        // A no-op produces u8 ~117 (scene 0.18 Rec.2020 directly sRGB-encoded).
        // Everything else is "kernel ran but wrong" (e.g. all-zero LUT bug
        // from ticket #08).
        let isWorking = abs(Int(r) - 187) <= 4
        let isNoOp = abs(Int(r) - 117) <= 4
        XCTContext.runActivity(named: "AgX behaviour classification") { _ in
            if isWorking {
                print("AGX_PROBE: VERDICT = AgX kernel ran correctly.")
            } else if isNoOp {
                XCTFail(
                    "AgX silently no-op'd: midtone u8 = (\(r), \(g), \(b)) ~ scene 0.18 " +
                    "Rec.2020 directly sRGB-encoded (no AgX). " +
                    "applyAgXViewTransform is returning its input unchanged. " +
                    "Likely cause: AgXViewTransform.metal lacks `[[stitchable]]` " +
                    "(commit 1102c16 added it on `main` — this branch is behind)."
                )
            } else {
                XCTFail(
                    "AgX produced unexpected output: u8 = (\(r), \(g), \(b)). " +
                    "Not the expected 187 (working) and not 117 (no-op). " +
                    "Likely a different bug — check AgX LUT, contrast modulation, " +
                    "or per-channel transfer."
                )
            }
        }
    }

    // MARK: - Helpers

    private func readCentrePixelU8(_ cg: CGImage) -> (UInt8, UInt8, UInt8) {
        let w = cg.width, h = cg.height
        let bytesPerRow = w * 4
        var buf = [UInt8](repeating: 0, count: w * h * 4)
        let space = CGColorSpace(name: CGColorSpace.sRGB)!
        let ctx = CGContext(
            data: &buf,
            width: w, height: h,
            bitsPerComponent: 8,
            bytesPerRow: bytesPerRow,
            space: space,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        )!
        ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
        let cy = h / 2, cx = w / 2
        let i = (cy * w + cx) * 4
        return (buf[i], buf[i + 1], buf[i + 2])
    }

    /// Convert f32 to half-precision (IEEE 754 binary16). Mirrors
    /// `f32_to_f16_bits` from raw-core/src/pipeline.rs:f32_to_f16_bits.
    private func float32_to_half(_ f: Float) -> UInt16 {
        let bits = f.bitPattern
        let sign = UInt16((bits >> 31) & 0x1) << 15
        let exp = Int((bits >> 23) & 0xff) - 127 + 15
        let mant = (bits >> 13) & 0x3ff
        if exp <= 0 {
            return sign
        } else if exp >= 0x1f {
            return sign | (0x1f << 10)
        }
        return sign | (UInt16(exp) << 10) | UInt16(mant)
    }
}
