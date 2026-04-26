// AgXKernelDiagnosticTests.swift — regression net for AgX silent-no-op.
//
// Purpose: detect a broken Apple-side AgX kernel load. If the kernel fails
// to compile or `[[stitchable]]` regresses, `applyAgXViewTransform` silently
// returns its input unchanged (MetalKernels.swift), and the canvas displays
// scene-linear-encoded-as-sRGB output instead of view-transformed.
//
// Probe input: scene-linear 1.0 (white). Maple AgX rolls this off to
// display-linear ~0.64, which encodes to sRGB u8 ~211. A no-op AgX would
// pass through to display-linear 1.0, which sRGB-encodes to u8 255 (clipped
// white). A broken kernel returning zero produces u8 ~0. All three are
// distinguishable. Mid-gray (0.18) was the original probe but Maple AgX
// preserves mid-gray on the curve, so working-AgX and no-op produce the
// same u8 there — a brighter probe is required.
//
// Cross-links:
//   src/apple/Packages/MapleCore/Sources/MapleCore/Metal/AgXViewTransform.metal
//   src/apple/Packages/MapleCore/Sources/MapleCore/MetalKernels.swift

import XCTest
import CoreImage
import CoreGraphics
import AppKit
@testable import MapleCore

final class AgXKernelDiagnosticTests: XCTestCase {

    /// Sanity probe: does the AgX kernel load, does the LUT load, and what
    /// does AgX produce on synthetic scene-linear 1.0 (white)?
    ///
    /// Expected with working Maple AgX: u8 ~= 211 (polynomial @ norm 0.756 →
    ///                                  display-linear 0.64 → sRGB ≈ 0.83).
    /// Expected when AgX no-ops:        u8 == 255 (passthrough sRGB-encode of 1.0).
    /// Expected when AgX returns zero:  u8 == 0.
    func testAgXKernelOnHighlight() throws {
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

        // (3) Synthetic scene-linear-1.0 (white) probe — independent of the
        // kernel-load outcome. Build a 4x4 fp16 RGBA Rec.2020 image with all
        // pixels at (1.0, 1.0, 1.0). Apply `applyAgXViewTransform`. Render
        // to sRGB u8 via the same CIContext shape `processSceneLinear`'s
        // caller uses. Inspect the output's centre pixel.
        let w = 4, h = 4
        var pixels = [UInt16](repeating: 0, count: w * h * 4)
        let halfOne = float32_to_half(1.0)
        for i in 0..<(w * h) {
            pixels[i * 4 + 0] = halfOne
            pixels[i * 4 + 1] = halfOne
            pixels[i * 4 + 2] = halfOne
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
        print("AGX_PROBE: expected with working Maple AgX = ~211 (highlight roll-off on scene 1.0)")
        print("AGX_PROBE: expected with AgX silently no-op = 255 (scene 1.0 passthrough → clipped white)")

        // Hard assertion: working Maple AgX rolls scene 1.0 to display ~0.64
        // → sRGB ~0.83 → u8 ~211. A no-op passes through to u8 255 (clipped
        // white). A broken kernel returning zero produces u8 ~0. Tolerance
        // ±8 absorbs Rec.2020→sRGB matrix swing on white plus quantization.
        let isWorking = abs(Int(r) - 211) <= 8
        let isNoOp = r >= 252
        let isZero = r <= 4
        XCTContext.runActivity(named: "AgX behaviour classification") { _ in
            if isWorking {
                print("AGX_PROBE: VERDICT = AgX kernel ran correctly.")
            } else if isNoOp {
                XCTFail(
                    "AgX silently no-op'd: highlight u8 = (\(r), \(g), \(b)) ~ scene 1.0 " +
                    "Rec.2020 passthrough (no AgX). applyAgXViewTransform is returning " +
                    "its input unchanged. Likely cause: AgXViewTransform.metal kernel " +
                    "load failure (check `[[stitchable]]` attribute or kernel compile errors)."
                )
            } else if isZero {
                XCTFail(
                    "AgX returning zero: u8 = (\(r), \(g), \(b)). Kernel ran but " +
                    "output is black — check polynomial coefficients or LUT binding."
                )
            } else {
                XCTFail(
                    "AgX produced unexpected output on scene 1.0: u8 = (\(r), \(g), \(b)). " +
                    "Not the expected 211 (Maple AgX), not 255 (no-op), not 0 (broken). " +
                    "Polynomial coefficients may have drifted from agx_coeffs.rs."
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
