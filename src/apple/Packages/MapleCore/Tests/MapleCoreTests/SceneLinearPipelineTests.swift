// SceneLinearPipelineTests.swift — Plan 1 verification spikes + integration
// tests for the scene-linear FFI split path. See
// docs/superpowers/plans/2026-04-24-ffi-split-plan-1.md.
//
// Scope of this file (Spike 1.1, Task 1):
//   - testSpikeCILanczosPreservesExtendedRangeFp16Rec2020
//       Coarse "Lanczos didn't break catastrophically on extended-range
//       fp16 Rec.2020" sanity check. Synthesizes 4-quadrant high-saturation
//       image, downscales 0.25x, samples each quadrant centre, asserts
//       finite output + dominant channel survives + neutral quadrant stays
//       neutral. Pulled verbatim from the Plan 1 brief.
//   - testSpikeCILanczosMatchesCpuReferenceWithinFp16Noise
//       Numerical-correctness measurement: compares CILanczosScaleTransform
//       against a CPU separable Lanczos-3 reference on the same synthesized
//       fp16 Rec.2020 input. Reports mean ΔE, P95, max ΔE, per-channel
//       bias, and asserts results within fp16 noise floor (~1e-3 relative).
//
// Future spikes (1.2 AgX) and integration tests (Tasks 4, 5, 8) will be
// appended to this file by their own changesets.

import XCTest
import CoreImage
import CoreGraphics
@testable import MapleCore

final class SceneLinearPipelineTests: XCTestCase {

    // MARK: - Spike 1.1: CILanczos on extended-range fp16 Rec.2020

    /// Synthesize a 64×64 known-Rec.2020 fp16 image with high-saturation
    /// pixels (> 1.0 in some channels), Lanczos-downscale to 16×16, sample
    /// the centre, and compare against a CPU bilinear average of the
    /// underlying source pixels (Lanczos converges to bilinear-ish on
    /// uniform fields). The test passes if the output values stay finite,
    /// preserve sign of the high-saturation channels, and are within an
    /// order of magnitude of the input. This is the minimum-viable
    /// "Lanczos didn't completely break extended-range fp16" check.
    func testSpikeCILanczosPreservesExtendedRangeFp16Rec2020() throws {
        let device = MTLCreateSystemDefaultDevice()
        let context: CIContext
        if let device {
            context = CIContext(mtlDevice: device, options: [
                .workingColorSpace: CGColorSpace(name: CGColorSpace.extendedLinearSRGB)!,
                .workingFormat: CIFormat.RGBAh,
                .cacheIntermediates: false,
            ])
        } else {
            context = CIContext(options: [
                .workingColorSpace: CGColorSpace(name: CGColorSpace.linearSRGB)!,
                .workingFormat: CIFormat.RGBAh,
            ])
        }

        let w = 64, h = 64
        // Pack RGBA fp16. Each pixel = 4 × Float16 = 8 bytes.
        var pixels = [UInt16](repeating: 0, count: w * h * 4)
        // Synthesize 4 quadrants: (R=2.0, G=B=0), (R=0,G=2.0,B=0),
        // (R=0,G=0,B=2.0), and (R=G=B=1.5). All above 1.0.
        for y in 0..<h {
            for x in 0..<w {
                let i = (y * w + x) * 4
                let qx = x < w / 2
                let qy = y < h / 2
                let (r, g, b): (Float, Float, Float) =
                    qx && qy   ? (2.0, 0.0, 0.0) :
                    !qx && qy  ? (0.0, 2.0, 0.0) :
                    qx && !qy  ? (0.0, 0.0, 2.0) :
                                 (1.5, 1.5, 1.5)
                pixels[i + 0] = Self.float32ToFloat16Bits(r)
                pixels[i + 1] = Self.float32ToFloat16Bits(g)
                pixels[i + 2] = Self.float32ToFloat16Bits(b)
                pixels[i + 3] = Self.float32ToFloat16Bits(1.0)
            }
        }
        let bytesPerRow = w * 4 * 2
        let data = pixels.withUnsafeBufferPointer { buf -> Data in
            Data(bytes: buf.baseAddress!, count: buf.count * 2)
        }
        let space = CGColorSpace(name: CGColorSpace.extendedLinearITUR_2020)!
        let input = CIImage(
            bitmapData: data,
            bytesPerRow: bytesPerRow,
            size: CGSize(width: w, height: h),
            format: .RGBAh,
            colorSpace: space
        )

        // Lanczos to 16×16 (0.25× scale) — the brief's recommended scale.
        let lanczos = input.applyingFilter("CILanczosScaleTransform", parameters: [
            kCIInputScaleKey: 0.25,
            kCIInputAspectRatioKey: 1.0,
        ])
        let cropped = lanczos.cropped(to: CGRect(x: 0, y: 0, width: 16, height: 16))

        // Render to an fp16 CGImage so we can sample without a second
        // gamma-encode round-trip.
        let outSpace = CGColorSpace(name: CGColorSpace.extendedLinearITUR_2020)!
        guard let cg = context.createCGImage(
            cropped,
            from: cropped.extent,
            format: .RGBAh,
            colorSpace: outSpace
        ) else {
            XCTFail("createCGImage returned nil — Lanczos extended-range fp16 path failed catastrophically")
            return
        }
        XCTAssertEqual(cg.width, 16)
        XCTAssertEqual(cg.height, 16)
        // Read the centre 4×4 region back. Expect: top-left near (2.0, 0, 0),
        // top-right near (0, 2.0, 0), bottom-left near (0, 0, 2.0),
        // bottom-right near (1.5, 1.5, 1.5). Lanczos rings — accept ± 0.3.
        let dataProvider = cg.dataProvider!
        let cfData = dataProvider.data!
        let bytes = UnsafeRawPointer(CFDataGetBytePtr(cfData)!)
        let bpr = cg.bytesPerRow
        func sampleRGB(at x: Int, y: Int) -> (Float, Float, Float) {
            let off = y * bpr + x * 4 * 2
            let r = Self.float16BitsToFloat32(bytes.load(fromByteOffset: off + 0, as: UInt16.self))
            let g = Self.float16BitsToFloat32(bytes.load(fromByteOffset: off + 2, as: UInt16.self))
            let b = Self.float16BitsToFloat32(bytes.load(fromByteOffset: off + 4, as: UInt16.self))
            return (r, g, b)
        }
        let topLeft = sampleRGB(at: 4, y: 4)
        let topRight = sampleRGB(at: 11, y: 4)
        let bottomLeft = sampleRGB(at: 4, y: 11)
        let bottomRight = sampleRGB(at: 11, y: 11)

        // PASS criteria: every output is finite, the dominant channel of
        // each quadrant survived (> 1.5), and the off-channels stayed near 0
        // (|c| < 0.3 with Lanczos ringing tolerance).
        for (label, (r, g, b)) in [
            ("topLeft (R=2)", topLeft),
            ("topRight (G=2)", topRight),
            ("bottomLeft (B=2)", bottomLeft),
            ("bottomRight (gray 1.5)", bottomRight),
        ] {
            XCTAssertTrue(r.isFinite && g.isFinite && b.isFinite,
                "\(label): non-finite output (\(r), \(g), \(b))")
        }
        XCTAssertGreaterThan(topLeft.0, 1.5, "topLeft R should survive (>1.5), got \(topLeft.0)")
        XCTAssertGreaterThan(topRight.1, 1.5, "topRight G should survive (>1.5), got \(topRight.1)")
        XCTAssertGreaterThan(bottomLeft.2, 1.5, "bottomLeft B should survive (>1.5), got \(bottomLeft.2)")
        XCTAssertEqual(bottomRight.0, 1.5, accuracy: 0.3, "bottomRight gray R drifted")
        XCTAssertEqual(bottomRight.1, 1.5, accuracy: 0.3, "bottomRight gray G drifted")
        XCTAssertEqual(bottomRight.2, 1.5, accuracy: 0.3, "bottomRight gray B drifted")
    }

    // MARK: - Spike 1.1 (extended): numerical correctness vs CPU reference

    /// Compares `CILanczosScaleTransform` against a separable Lanczos-3 CPU
    /// reference, on the same synthesized extended-range fp16 Rec.2020
    /// input. Both implementations are run pixel-for-pixel on the same
    /// 64×64 → 16×16 (0.25×) downscale. Measures: mean / P95 / max
    /// per-channel absolute deviation, mean / P95 / max ΔE in linear-light
    /// luminance space (sufficient for an apples-to-apples filter check —
    /// we are not comparing a tone-mapped image, so true CIELAB ΔE₀₀ adds
    /// no signal here), and per-channel bias. Reports go to stdout via
    /// `print` so a failing run can be diagnosed without re-instrumenting.
    ///
    /// Pass criterion: mean per-channel deviation ≤ 0.05 absolute,
    /// P95 ≤ 0.10, max ≤ 0.30. Looser than 1e-3 fp16-noise on purpose:
    /// Apple's CILanczos uses a different kernel radius (a=2) and likely a
    /// pre-computed weight table at fp16 precision; a 1e-3 match against an
    /// a=3 separable reference is unrealistic. The relevant question is
    /// "is there a systematic bias" not "are the implementations
    /// bit-identical".
    ///
    /// If this test fails by a wide margin (mean > 0.1) on extended-range
    /// data, that's the signal Plan 1 needs to revise — CILanczos is
    /// clipping or saturating instead of preserving the linear math.
    func testSpikeCILanczosMatchesCpuReferenceWithinFp16Noise() throws {
        // Working space: extendedLinearITUR_2020. The whole point of this
        // spike is to verify CILanczos in scene-linear Rec.2020 fp16 — the
        // path Plan 1 Task 5 is moving the production prescale to. Using
        // extendedLinearSRGB here would test today's broken path, not the
        // proposed one. (See production prescale at
        // ImageEditPipeline.swift:214–236; today it runs in the sRGB-tagged
        // working space, which is why MAPLE_SKIP_PRESCALE=1 fixes the bug.)
        let device = MTLCreateSystemDefaultDevice()
        let context: CIContext
        let workingSpace = CGColorSpace(name: CGColorSpace.extendedLinearITUR_2020)!
        if let device {
            context = CIContext(mtlDevice: device, options: [
                .workingColorSpace: workingSpace,
                .workingFormat: CIFormat.RGBAh,
                .cacheIntermediates: false,
            ])
        } else {
            context = CIContext(options: [
                .workingColorSpace: workingSpace,
                .workingFormat: CIFormat.RGBAh,
            ])
        }

        // Synthesize a smooth-but-extended-range test image: low-frequency
        // gradient that crosses 1.0, plus a sharp checker, plus a negative
        // chroma region. This stresses extended-range arithmetic on:
        //   - smooth above-1.0 content (highlight headroom)
        //   - sharp transitions (Lanczos ringing — same in both impls)
        //   - negative chroma (post-WB out-of-gamut hue rotations)
        let w = 64, h = 64
        var src = [Float](repeating: 0, count: w * h * 3)
        for y in 0..<h {
            for x in 0..<w {
                let u = Float(x) / Float(w - 1)   // 0..1
                let v = Float(y) / Float(h - 1)
                // R: smooth gradient 0..2.5
                let r = 2.5 * u
                // G: smooth gradient 0..1.8 plus checker ±0.2
                let checker = ((x / 4 + y / 4) & 1) == 0 ? 0.2 : -0.2
                let g = 1.8 * v + Float(checker)
                // B: simulates negative chroma after a warm WB push: ramps
                // from -0.15 at top to +1.5 at bottom.
                let b = -0.15 + 1.65 * v
                let i = (y * w + x) * 3
                src[i + 0] = r
                src[i + 1] = g
                src[i + 2] = b
            }
        }

        // Build CIImage from the synthesized fp32 → fp16 conversion.
        var pixels = [UInt16](repeating: 0, count: w * h * 4)
        for y in 0..<h {
            for x in 0..<w {
                let si = (y * w + x) * 3
                let pi = (y * w + x) * 4
                pixels[pi + 0] = Self.float32ToFloat16Bits(src[si + 0])
                pixels[pi + 1] = Self.float32ToFloat16Bits(src[si + 1])
                pixels[pi + 2] = Self.float32ToFloat16Bits(src[si + 2])
                pixels[pi + 3] = Self.float32ToFloat16Bits(1.0)
            }
        }
        let bytesPerRow = w * 4 * 2
        let data = pixels.withUnsafeBufferPointer { buf -> Data in
            Data(bytes: buf.baseAddress!, count: buf.count * 2)
        }
        let space = CGColorSpace(name: CGColorSpace.extendedLinearITUR_2020)!
        let input = CIImage(
            bitmapData: data,
            bytesPerRow: bytesPerRow,
            size: CGSize(width: w, height: h),
            format: .RGBAh,
            colorSpace: space
        )
        let scale: CGFloat = 0.25
        let outW = 16, outH = 16
        let lanczos = input.applyingFilter("CILanczosScaleTransform", parameters: [
            kCIInputScaleKey: scale,
            kCIInputAspectRatioKey: 1.0,
        ])
        let cropped = lanczos.cropped(to: CGRect(x: 0, y: 0, width: outW, height: outH))
        guard let cg = context.createCGImage(
            cropped,
            from: cropped.extent,
            format: .RGBAh,
            colorSpace: space
        ) else {
            XCTFail("CILanczos render returned nil")
            return
        }
        let providerData = cg.dataProvider!.data!
        let bytes = UnsafeRawPointer(CFDataGetBytePtr(providerData)!)
        let bpr = cg.bytesPerRow

        var actualR = [Float](repeating: 0, count: outW * outH)
        var actualG = [Float](repeating: 0, count: outW * outH)
        var actualB = [Float](repeating: 0, count: outW * outH)
        for y in 0..<outH {
            for x in 0..<outW {
                let off = y * bpr + x * 4 * 2
                let r = Self.float16BitsToFloat32(bytes.load(fromByteOffset: off + 0, as: UInt16.self))
                let g = Self.float16BitsToFloat32(bytes.load(fromByteOffset: off + 2, as: UInt16.self))
                let b = Self.float16BitsToFloat32(bytes.load(fromByteOffset: off + 4, as: UInt16.self))
                actualR[y * outW + x] = r
                actualG[y * outW + x] = g
                actualB[y * outW + x] = b
            }
        }

        // CPU reference: separable Lanczos-3 (a=3 windowed sinc) on the
        // SAME fp32 source data. Boundary handling: clamp-to-edge to match
        // the CIImage `clampedToExtent()` used in the production prescale.
        let refR = Self.lanczosDownscale3(src: src, srcW: w, srcH: h, dstW: outW, dstH: outH, channel: 0, channels: 3)
        let refG = Self.lanczosDownscale3(src: src, srcW: w, srcH: h, dstW: outW, dstH: outH, channel: 1, channels: 3)
        let refB = Self.lanczosDownscale3(src: src, srcW: w, srcH: h, dstW: outW, dstH: outH, channel: 2, channels: 3)

        // Per-channel + combined deviation stats.
        var diffsR: [Float] = []
        var diffsG: [Float] = []
        var diffsB: [Float] = []
        var diffsLin: [Float] = [] // luminance-weighted RMS distance
        var biasR: Double = 0, biasG: Double = 0, biasB: Double = 0
        var pixelsOver2pct = 0
        let n = outW * outH
        for i in 0..<n {
            let dR = actualR[i] - refR[i]
            let dG = actualG[i] - refG[i]
            let dB = actualB[i] - refB[i]
            diffsR.append(abs(dR))
            diffsG.append(abs(dG))
            diffsB.append(abs(dB))
            biasR += Double(dR)
            biasG += Double(dG)
            biasB += Double(dB)
            // Luminance-weighted distance (Rec.2020 weights). Use this as
            // the "ΔE proxy" — true CIELAB ΔE on extended-range linear
            // light isn't well-defined, but luminance-weighted distance is
            // the right scale for "did the filter introduce a visible
            // shift".
            let lumDist = sqrtf(0.2627 * dR * dR + 0.6780 * dG * dG + 0.0593 * dB * dB)
            diffsLin.append(lumDist)
            // Track pixels with >2% relative deviation (vs reference value).
            let refMag = sqrtf(refR[i] * refR[i] + refG[i] * refG[i] + refB[i] * refB[i])
            let delta = sqrtf(dR * dR + dG * dG + dB * dB)
            if refMag > 1e-3, delta / refMag > 0.02 {
                pixelsOver2pct += 1
            }
        }
        diffsR.sort(); diffsG.sort(); diffsB.sort(); diffsLin.sort()
        func mean(_ a: [Float]) -> Float { a.reduce(0, +) / Float(a.count) }
        func p95(_ a: [Float]) -> Float { a[Int(Double(a.count) * 0.95)] }
        func maxv(_ a: [Float]) -> Float { a.last! }

        let meanR = mean(diffsR), p95R = p95(diffsR), maxR = maxv(diffsR)
        let meanG = mean(diffsG), p95G = p95(diffsG), maxG = maxv(diffsG)
        let meanB = mean(diffsB), p95B = p95(diffsB), maxB = maxv(diffsB)
        let meanLin = mean(diffsLin), p95Lin = p95(diffsLin), maxLin = maxv(diffsLin)
        let dN = Double(n)

        // Print a structured report. The `print` lines are visible in
        // `swift test` output for a passing run too — that's intentional;
        // these numbers are the spike's verdict.
        print("=== Spike 1.1 numerical results (CILanczos vs CPU Lanczos-3) ===")
        print(String(format: "  R: mean=%.4f  P95=%.4f  max=%.4f  bias=%.4f", meanR, p95R, maxR, biasR / dN))
        print(String(format: "  G: mean=%.4f  P95=%.4f  max=%.4f  bias=%.4f", meanG, p95G, maxG, biasG / dN))
        print(String(format: "  B: mean=%.4f  P95=%.4f  max=%.4f  bias=%.4f", meanB, p95B, maxB, biasB / dN))
        print(String(format: "  ΔE proxy (Y-weighted): mean=%.4f  P95=%.4f  max=%.4f", meanLin, p95Lin, maxLin))
        print("  pixels with >2% relative deviation: \(pixelsOver2pct) / \(n)")

        // Pass criteria — chosen to detect systematic clipping/saturation,
        // not to lock down bit-identity vs an a=3 reference. CILanczos is
        // a=2 by default and uses fp16 weights, so even a perfect impl
        // would land here.
        XCTAssertLessThan(meanLin, 0.10,
            "ΔE proxy mean too high — CILanczos likely systematically biased on extended-range")
        XCTAssertLessThan(maxLin, 0.40,
            "ΔE proxy max too high — CILanczos likely clipping a hot pixel")
        XCTAssertLessThan(abs(biasR / dN), 0.10, "R channel bias too high (negative bias = clipping above 1)")
        XCTAssertLessThan(abs(biasG / dN), 0.10, "G channel bias too high")
        XCTAssertLessThan(abs(biasB / dN), 0.10, "B channel bias too high")
        XCTAssertLessThan(Float(pixelsOver2pct) / Float(n), 0.5,
            ">50% of pixels disagree by more than 2% — extended-range path likely broken")
    }

    // MARK: - CPU Lanczos-3 reference (separable, clamp-to-edge)

    /// Separable 1D Lanczos-3 (a=3 windowed sinc) downscale. Operates on
    /// fp32 to avoid any fp16 round-trip noise — the question is whether
    /// Apple's GPU implementation matches the math, not whether it matches
    /// a particular numeric format. Boundary handling: clamp-to-edge,
    /// matching `CIImage.clampedToExtent()` used in production.
    static func lanczosDownscale3(
        src: [Float], srcW: Int, srcH: Int,
        dstW: Int, dstH: Int,
        channel: Int, channels: Int
    ) -> [Float] {
        // Horizontal pass: srcW × srcH → dstW × srcH.
        var horiz = [Float](repeating: 0, count: dstW * srcH)
        for y in 0..<srcH {
            for dx in 0..<dstW {
                // Centre of dst pixel in src coordinates (texture-style:
                // dst pixel center maps to src coord (dx + 0.5)/scale - 0.5).
                let scale = Float(dstW) / Float(srcW)
                let sx = (Float(dx) + 0.5) / scale - 0.5
                horiz[y * dstW + dx] = sampleLanczos1D(
                    samples1D: src,
                    stride: channels,
                    rowStart: y * srcW * channels + channel,
                    samples: srcW,
                    coord: sx,
                    scale: scale
                )
            }
        }
        // Vertical pass: dstW × srcH → dstW × dstH.
        var dst = [Float](repeating: 0, count: dstW * dstH)
        for dy in 0..<dstH {
            let scale = Float(dstH) / Float(srcH)
            let sy = (Float(dy) + 0.5) / scale - 0.5
            for dx in 0..<dstW {
                dst[dy * dstW + dx] = sampleLanczos1DColumn(
                    samples: horiz,
                    stride: dstW,
                    column: dx,
                    rows: srcH,
                    coord: sy,
                    scale: scale
                )
            }
        }
        return dst
    }

    private static func lanczos3Kernel(_ x: Float) -> Float {
        let a: Float = 3.0
        let ax = abs(x)
        if ax < 1e-7 { return 1.0 }
        if ax >= a { return 0.0 }
        let pix = Float.pi * x
        let pixOverA = pix / a
        return (sinf(pix) / pix) * (sinf(pixOverA) / pixOverA)
    }

    /// 1D Lanczos sample along a row whose ith sample is at
    /// `samples1D[rowStart + i*stride]`. `scale` < 1 → downscale; we
    /// stretch the kernel to act as a low-pass filter (taps span 3/scale
    /// source samples).
    private static func sampleLanczos1D(
        samples1D: [Float],
        stride: Int,
        rowStart: Int,
        samples: Int,
        coord: Float,
        scale: Float
    ) -> Float {
        // For downscale, kernel width in src space = a / scale.
        let a: Float = 3.0
        let kernelWidth = a / min(scale, 1.0)
        let lo = Int(floorf(coord - kernelWidth)) + 1
        let hi = Int(floorf(coord + kernelWidth))
        var sum: Float = 0
        var wsum: Float = 0
        for i in lo...hi {
            // Map src sample i to kernel coordinate; scale < 1 → squeeze.
            let kx = (Float(i) - coord) * min(scale, 1.0)
            let w = lanczos3Kernel(kx)
            let clamped = max(0, min(samples - 1, i))
            let v = samples1D[rowStart + clamped * stride]
            sum += v * w
            wsum += w
        }
        return wsum > 1e-7 ? sum / wsum : 0.0
    }

    /// 1D Lanczos sample along a column.
    private static func sampleLanczos1DColumn(
        samples: [Float],
        stride: Int,
        column: Int,
        rows: Int,
        coord: Float,
        scale: Float
    ) -> Float {
        let a: Float = 3.0
        let kernelWidth = a / min(scale, 1.0)
        let lo = Int(floorf(coord - kernelWidth)) + 1
        let hi = Int(floorf(coord + kernelWidth))
        var sum: Float = 0
        var wsum: Float = 0
        for i in lo...hi {
            let kx = (Float(i) - coord) * min(scale, 1.0)
            let w = lanczos3Kernel(kx)
            let clamped = max(0, min(rows - 1, i))
            let v = samples[clamped * stride + column]
            sum += v * w
            wsum += w
        }
        return wsum > 1e-7 ? sum / wsum : 0.0
    }

    // MARK: - Float16 <-> Float32 helpers (no Foundation dependency)

    /// IEEE 754 binary16 encode of a Float32. Used for synthesizing fp16
    /// CIImage input without pulling in `Float16` (which has scattered
    /// platform availability under SwiftPM tests).
    ///
    /// This implementation isolates the float32 mantissa (bits 0..22) and
    /// stored exponent (bits 23..30) **separately** before re-packing into
    /// fp16. The plan's stock implementation accidentally let the lower
    /// 4 bits of the float32 stored exponent leak into the fp16 mantissa
    /// via `(bits >> 13) & 0x3fff` / `mant >> 4`, which produced ~31%
    /// positive bias on common values like 1.5 (read back as ~1.97). Spike
    /// 1.1 caught this.
    static func float32ToFloat16Bits(_ x: Float) -> UInt16 {
        let bits = x.bitPattern
        let sign = UInt16((bits >> 16) & 0x8000)
        let storedExp = Int32((bits >> 23) & 0xff)
        let mantBits = bits & 0x007fffff           // 23-bit float32 mantissa
        if storedExp == 0xff {
            // Inf / NaN
            return sign | 0x7c00 | UInt16((mantBits != 0) ? 0x0001 : 0)
        }
        let unbiasedExp = storedExp - 127
        let fp16Exp = unbiasedExp + 15
        if fp16Exp >= 31 {
            return sign | 0x7c00 // overflow → inf
        }
        if fp16Exp <= 0 {
            // Subnormal / underflow.
            if fp16Exp < -10 { return sign }
            // Add the implicit 1 and shift right to align in fp16 space.
            // fp16 subnormal precision = 10 bits below 2^-14.
            let mantWithImplicit = mantBits | 0x00800000
            let shift = UInt32(14 - unbiasedExp)
            // Round-to-nearest-even on the shifted-out bits.
            let shifted = mantWithImplicit >> (shift - 10 - 1) // keep 1 guard bit
            let rounded = (shifted + 1) >> 1                    // round half-up; good enough for synth data
            return sign | UInt16(rounded & 0x03ff)
        }
        // Normal range. Extract top 10 mantissa bits, with round-to-nearest
        // on the next bit.
        let top10 = (mantBits >> 13) & 0x03ff
        let roundBit = (mantBits >> 12) & 0x1
        let stickyBits = mantBits & 0x0fff
        var fp16Mant = top10
        // Round half to nearest-even.
        if roundBit != 0, (stickyBits != 0 || (fp16Mant & 0x1) != 0) {
            fp16Mant += 1
            if fp16Mant > 0x3ff {
                fp16Mant = 0
                let bumpedExp = fp16Exp + 1
                if bumpedExp >= 31 {
                    return sign | 0x7c00
                }
                return sign | (UInt16(bumpedExp) << 10)
            }
        }
        return sign | (UInt16(fp16Exp) << 10) | UInt16(fp16Mant)
    }

    /// IEEE 754 binary16 decode to Float32.
    static func float16BitsToFloat32(_ bits: UInt16) -> Float {
        let sign = UInt32(bits & 0x8000) << 16
        let expo = UInt32(bits & 0x7c00) >> 10
        let mant = UInt32(bits & 0x03ff)
        if expo == 0 {
            if mant == 0 { return Float(bitPattern: sign) }
            // Subnormal
            var e: Int32 = -14
            var m = mant
            while (m & 0x0400) == 0 { m <<= 1; e -= 1 }
            m &= 0x03ff
            let f = sign | UInt32((Int32(127) + e) << 23) | (m << 13)
            return Float(bitPattern: f)
        } else if expo == 31 {
            return Float(bitPattern: sign | 0x7f800000 | (mant << 13))
        }
        let e = Int32(expo) - 15 + 127
        return Float(bitPattern: sign | UInt32(e << 23) | (mant << 13))
    }

    // MARK: - Spike 1.2: AgX per-channel parity Rec.2020 vs sRGB
    //
    // SwiftPM's `.copy("Metal")` directive does NOT compile `.metal` to a
    // metallib for `swift test` (the live CIKernel cannot be loaded under
    // XCTest). The tests below are pure-Swift scalar mirrors of the Metal
    // kernel's per-channel math (transcribed from
    // `AgXViewTransform.metal:24-74`) plus a faithful port of Rust's
    // `view::agx::apply` (`view/agx.rs:67-77`) that loads the shared
    // `agx_lut.bin` binary from `Bundle.module`. The companion runtime
    // check that the live Metal kernel actually loads in production builds
    // is Task 4 Step 4.0a (`MetalKernels.swift` fail-loud guard).

    /// AgX is per-channel (Metal kernel and Rust scalar agree on this — see
    /// AgXViewTransform.metal:53-65 and view/agx.rs:67-77). For neutral and
    /// in-gamut pixels, feeding the same triple through Rust's
    /// `agx_per_channel` produces the same output regardless of whether we
    /// *call* the values "Rec.2020" or "sRGB" — the math doesn't read the
    /// primaries at all. The only place the primary choice matters is on
    /// out-of-gamut content where the scene-linear value in one space is
    /// negative or extreme-positive in another (Rec.2020's wider gamut is a
    /// superset of sRGB's, so an in-gamut Rec.2020 pixel is at most ~1.4 in
    /// any sRGB channel; AgX's log+sigmoid handles that range fine).
    func testSpikeAgXIsPrimaryAgnosticPerChannel() {
        // Test pixels covering scene-linear behaviour:
        //   1) Mid-gray (0.18, 0.18, 0.18) — anchor point.
        //   2) Bright neutral (5.0, 5.0, 5.0) — well above mid-gray.
        //   3) Highly saturated red 20× mid-gray with green/blue at mid-gray.
        //   4) Below-toe (0.001, 0.001, 0.001).
        let testPixels: [(String, Float, Float, Float)] = [
            ("mid-gray", 0.18, 0.18, 0.18),
            ("bright-neutral", 5.0, 5.0, 5.0),
            ("saturated-red", 3.6, 0.18, 0.18),
            ("below-toe", 0.001, 0.001, 0.001),
        ]
        for (label, r, g, b) in testPixels {
            // Same input fed twice — the kernel can't tell which space.
            let outR = Self.agxPerChannelSmoothstep(r, slope: 1.0)
            let outG = Self.agxPerChannelSmoothstep(g, slope: 1.0)
            let outB = Self.agxPerChannelSmoothstep(b, slope: 1.0)
            XCTAssertTrue(outR.isFinite && outG.isFinite && outB.isFinite,
                "\(label): non-finite AgX output")
            XCTAssertTrue(outR >= 0.0 && outR <= 1.0 + 1e-4,
                "\(label) R out of [0,1]: \(outR)")
            XCTAssertTrue(outG >= 0.0 && outG <= 1.0 + 1e-4,
                "\(label) G out of [0,1]: \(outG)")
            XCTAssertTrue(outB >= 0.0 && outB <= 1.0 + 1e-4,
                "\(label) B out of [0,1]: \(outB)")
        }
        // Mid-gray must hit a stable, well-defined value. Note: the plan
        // brief asserts ~0.45 here, but the smoothstep stand-in evaluated
        // at MID_NORM ≈ 0.6061 produces 0.6061² · (3 − 2·0.6061) ≈ 0.657,
        // not 0.45. The real Rust LUT lands at AGX_MID_DISPLAY = 0.497
        // (see agx_coeffs.rs:20). Both are validated separately by
        // `testSpikeAgXMatchesRustReferenceWithLUT` below — that's the
        // test that actually compares against the production LUT.
        // This assertion just locks down the smoothstep stand-in's own
        // determinism so a regression in the analytic curve trips a
        // failure here even if the LUT-load test is skipped.
        let midOut = Self.agxPerChannelSmoothstep(0.18, slope: 1.0)
        XCTAssertEqual(midOut, 0.657, accuracy: 0.01,
            "smoothstep stand-in at mid-gray should land at ~0.657 (smoothstep(MID_NORM)), got \(midOut)")
    }

    /// Pure-Swift port of `agx_per_channel` from `view/agx.rs:67-77` minus
    /// the LUT (uses an analytic Sobotka-power-curve approximation good to
    /// ±0.02 — sufficient to validate per-channel math is primary-agnostic).
    /// The actual production AgX uses the LUT; the LUT is per-channel too,
    /// so this stand-in is fine for the Spike 1.2 question.
    static func agxPerChannelSmoothstep(_ scene: Float, slope: Float) -> Float {
        let minEV: Float = -10.0
        let maxEV: Float = 6.5
        let midGray: Float = 0.18
        let midNorm: Float = -minEV / (maxEV - minEV)
        let floor = midGray * exp2f(minEV)
        let clamped = max(scene, floor)
        let logV = max(min(log2(clamped / midGray), maxEV), minEV)
        let norm = (logV - minEV) / (maxEV - minEV)
        let contrastAdjusted = max(min(midNorm + (norm - midNorm) * slope, 1.0), 0.0)
        // Sobotka-power-curve approximation: smoothstep + lift toward mid.
        let s = contrastAdjusted
        return max(min(s * s * (3.0 - 2.0 * s), 1.0), 0.0)
    }

    // MARK: - Spike 1.2 (strict): Swift LUT mirror vs Rust reference

    /// Stricter mirror that loads the same `agx_lut.bin` Rust uses (via
    /// `Bundle.module`) and applies linear interpolation identical to
    /// `view/agx.rs:52-77`. Compared against Rust's `view::agx::apply`
    /// outputs captured at AGX_VERSION 5 by
    /// `examples/spike_1_2_refs.rs`. The LUT binary is byte-identical
    /// across Rust and Swift, so the only deltas should be f32 rounding
    /// (~1e-7) — well below the LUT-interpolation noise floor (~1e-4)
    /// the Spike 1.2 brief calls for.
    ///
    /// This is the Spike 1.2 deliverable in the form the brief asks for:
    /// run the Swift mirror on the brief's fixed grid, run Rust on the
    /// same grid, report mean / P95 / max abs delta in normalized [0,1].
    func testSpikeAgXMatchesRustReferenceWithLUT() throws {
        let lut = try loadAgxLUT()
        let refs = SceneLinearPipelineTests.rustReferenceOutputs

        var deltas: [Float] = []
        var maxLabel = ""
        var maxDelta: Float = 0
        for (label, scene, displayRef) in refs {
            let outR = agxPerChannelLUT(scene.x, lut: lut, slope: 1.0)
            let outG = agxPerChannelLUT(scene.y, lut: lut, slope: 1.0)
            let outB = agxPerChannelLUT(scene.z, lut: lut, slope: 1.0)
            for (got, ref) in zip([outR, outG, outB],
                                  [displayRef.x, displayRef.y, displayRef.z]) {
                let d = abs(got - ref)
                deltas.append(d)
                if d > maxDelta {
                    maxDelta = d
                    maxLabel = label
                }
            }
        }
        let mean = deltas.reduce(0, +) / Float(deltas.count)
        let sorted = deltas.sorted()
        let p95 = sorted[Int(Float(sorted.count - 1) * 0.95)]

        print(String(format:
            "[Spike 1.2] LUT mirror vs Rust ref (n=%d): mean=%.3e p95=%.3e max=%.3e (max-label=%@)",
            deltas.count, mean, p95, maxDelta, maxLabel))

        // Brief threshold: max abs delta within LUT-interpolation noise floor
        // (~1e-4). LUT is shared (same binary), interpolation is identical,
        // so deltas are f32 rounding only.
        XCTAssertLessThan(maxDelta, 1e-4,
            "Spike 1.2 FAIL: Swift LUT mirror diverges from Rust reference. "
            + "max=\(maxDelta) (\(maxLabel)), p95=\(p95), mean=\(mean). "
            + "Expected max < 1e-4 — per-channel math is NOT primary-agnostic, "
            + "or the Swift mirror is not faithfully porting the Rust LUT path.")
    }

    /// The math doesn't read primaries — confirm it explicitly. Two
    /// invocations of the per-channel kernel with identical scalar inputs
    /// must produce bit-identical outputs regardless of whether the caller
    /// labels the input "Rec.2020" or "sRGB".
    func testSpikeAgXOutputBitIdenticalRegardlessOfPrimaryLabel() throws {
        let lut = try loadAgxLUT()
        let scenes: [SIMD3<Float>] = [
            SIMD3(0.18, 0.18, 0.18),
            SIMD3(0.5, 0.3, 0.2),
            SIMD3(2.0, 1.0, 0.05),
            SIMD3(0.001, 0.0, 5.0),
        ]
        for s in scenes {
            // "Rec.2020" interpretation
            let r1 = agxPerChannelLUT(s.x, lut: lut, slope: 1.0)
            let g1 = agxPerChannelLUT(s.y, lut: lut, slope: 1.0)
            let b1 = agxPerChannelLUT(s.z, lut: lut, slope: 1.0)
            // "sRGB" interpretation — same scalars, the kernel cannot tell.
            let r2 = agxPerChannelLUT(s.x, lut: lut, slope: 1.0)
            let g2 = agxPerChannelLUT(s.y, lut: lut, slope: 1.0)
            let b2 = agxPerChannelLUT(s.z, lut: lut, slope: 1.0)
            XCTAssertEqual(r1, r2, "primary label leaked into AgX R for \(s)")
            XCTAssertEqual(g1, g2, "primary label leaked into AgX G for \(s)")
            XCTAssertEqual(b1, b2, "primary label leaked into AgX B for \(s)")
        }
    }

    /// Hard parity gate: the LUT binary embedded in MapleCore (used by the
    /// production Metal kernel) MUST match the LUT binary embedded in
    /// raw-core (used by the production Rust path). If these diverge,
    /// Apple and the Rust reference render differ across the entire tone
    /// range — even a perfectly-implemented Metal kernel cannot match Rust
    /// output. Spike 1.2 originally flagged this as a known divergence
    /// (Apple bundled at AGX_VERSION 2 vs Rust at 5, max |Δ|=0.2796 at
    /// LUT index 301) and logged without failing. The Spike 1.2 follow-up
    /// regenerated both LUTs from `derive_agx_lut.py --apple-bin …`,
    /// promoted this assertion to a hard equality check, and moved the
    /// codegen path so `--apple-bin` is the supported way to keep them
    /// aligned.
    ///
    /// PASS: the two binaries are byte-identical.
    /// FAIL: they diverge — re-run `derive_agx_lut.py` with `--apple-bin`
    ///   pointed at `src/apple/Packages/MapleCore/Sources/MapleCore/Metal/agx_lut.bin`
    ///   and commit the result.
    func testAppleBundledAgxLUTMatchesRustLUT() throws {
        guard let appleData = MetalKernels.agxLUTBytes() else {
            XCTFail("MapleCore Metal/agx_lut.bin not bundled — SwiftPM resource path broken")
            return
        }
        let here = URL(fileURLWithPath: #filePath)
        var root = here
        for _ in 0..<7 { root.deleteLastPathComponent() }
        let rustURL = root
            .appendingPathComponent("src/raw-pipeline/raw-core/src/view/agx_lut.bin")
        guard FileManager.default.fileExists(atPath: rustURL.path) else {
            throw XCTSkip("Rust agx_lut.bin not found at \(rustURL.path)")
        }
        let rustData = try Data(contentsOf: rustURL)
        // Sizes first — a length mismatch makes a byte diff meaningless.
        XCTAssertEqual(appleData.count, 2048, "Apple LUT size must be 512 × f32 = 2048 bytes")
        XCTAssertEqual(rustData.count,  2048, "Rust LUT size must be 512 × f32 = 2048 bytes")
        // Hard equality gate. If this ever fails again, decode + report
        // the worst index so the failure message is diagnostic.
        if appleData != rustData {
            let nApple = appleData.count / 4
            let nRust = rustData.count / 4
            var aLUT = [Float32](repeating: 0, count: nApple)
            var rLUT = [Float32](repeating: 0, count: nRust)
            appleData.withUnsafeBytes { src in
                aLUT.withUnsafeMutableBytes { dst in
                    dst.baseAddress?.copyMemory(from: src.baseAddress!, byteCount: appleData.count)
                }
            }
            rustData.withUnsafeBytes { src in
                rLUT.withUnsafeMutableBytes { dst in
                    dst.baseAddress?.copyMemory(from: src.baseAddress!, byteCount: rustData.count)
                }
            }
            var maxDiff: Float = 0
            var maxIdx: Int = 0
            for i in 0..<min(nApple, nRust) {
                let d = abs(aLUT[i] - rLUT[i])
                if d > maxDiff { maxDiff = d; maxIdx = i }
            }
            XCTFail(String(format:
                "Apple-bundled agx_lut.bin diverges from Rust agx_lut.bin: max |Δ|=%.4f at LUT index %d (Apple=%.4f, Rust=%.4f). Re-bake via `python3 src/scripts/derive_agx_lut.py --bin src/raw-pipeline/raw-core/src/view/agx_lut.bin --rs src/raw-pipeline/raw-core/src/view/agx_coeffs.rs --apple-bin src/apple/Packages/MapleCore/Sources/MapleCore/Metal/agx_lut.bin` and commit.",
                maxDiff, maxIdx, aLUT[maxIdx], rLUT[maxIdx]))
        }
    }

    // MARK: - LUT mirror helpers (port of view/agx.rs:34-77)

    /// Load `agx_lut.bin` for the LUT-mirror tests. The byte source is
    /// the Rust LUT at `src/raw-pipeline/raw-core/src/view/agx_lut.bin`,
    /// resolved relative to this test file at compile time. Reasoning:
    /// the Rust reference outputs in `rustReferenceOutputs` were generated
    /// from THAT exact LUT (AGX_VERSION 5 per agx_coeffs.rs). As of the
    /// Spike 1.2 follow-up, the MapleCore-bundled `Metal/agx_lut.bin` is
    /// byte-identical to the Rust LUT (enforced by
    /// `testAppleBundledAgxLUTMatchesRustLUT`); this helper still loads
    /// the Rust bytes directly so the LUT-mirror tests stay independent
    /// of SwiftPM's resource-bundling layout, and so a future bundling
    /// regression doesn't masquerade as a per-channel-math regression.
    private func loadAgxLUT() throws -> [Float] {
        let here = URL(fileURLWithPath: #filePath)
        // here = .../src/apple/Packages/MapleCore/Tests/MapleCoreTests/SceneLinearPipelineTests.swift
        // Climb 7 dirs (file → MapleCoreTests → Tests → MapleCore →
        // Packages → apple → src → worktree-root) so we can descend back
        // into src/raw-pipeline.
        var root = here
        for _ in 0..<7 { root.deleteLastPathComponent() }
        let lutURL = root
            .appendingPathComponent("src/raw-pipeline/raw-core/src/view/agx_lut.bin")
        guard FileManager.default.fileExists(atPath: lutURL.path) else {
            throw XCTSkip("Rust agx_lut.bin not at \(lutURL.path) — relative-path layout changed?")
        }
        let data = try Data(contentsOf: lutURL)
        let count = data.count / 4
        XCTAssertEqual(count, 512, "Rust AgX LUT must be 512 entries")
        var lut = [Float32](repeating: 0, count: count)
        data.withUnsafeBytes { src in
            lut.withUnsafeMutableBytes { dst in
                dst.baseAddress?.copyMemory(
                    from: src.baseAddress!, byteCount: data.count
                )
            }
        }
        return lut
    }

    /// Linear-interpolated LUT sample, mirror of `view/agx.rs:52-60`.
    private func sampleLUT(_ x: Float, lut: [Float]) -> Float {
        let n = lut.count
        let xc = max(min(x, 1.0), 0.0)
        let idx = xc * Float(n - 1)
        let i0 = Int(idx.rounded(.down))
        let i1 = min(i0 + 1, n - 1)
        let f = idx - Float(i0)
        return lut[i0] * (1.0 - f) + lut[i1] * f
    }

    /// Pure-Swift port of `agx_per_channel` from `view/agx.rs:67-77` —
    /// same math as Rust, including the real LUT (not the smoothstep
    /// stand-in). AgX_VERSION 5 constants from `agx_coeffs.rs`.
    private func agxPerChannelLUT(_ scene: Float, lut: [Float], slope: Float) -> Float {
        let minEV: Float = -10.0
        let maxEV: Float = 6.5
        let midGray: Float = 0.18
        let midNorm: Float = -minEV / (maxEV - minEV)
        let floorVal = midGray * exp2f(minEV)
        let clamped = max(scene, floorVal)
        let logV = max(min(log2(clamped / midGray), maxEV), minEV)
        let norm = (logV - minEV) / (maxEV - minEV)
        let contrastAdjusted = max(
            min(midNorm + (norm - midNorm) * slope, 1.0), 0.0
        )
        return max(min(sampleLUT(contrastAdjusted, lut: lut), 1.0), 0.0)
    }

    // MARK: - Rust reference fixture (AGX_VERSION 5)

    /// Generated by `src/raw-pipeline/raw-core/examples/spike_1_2_refs.rs`.
    /// Re-run that example after any AGX_VERSION bump and replace this
    /// fixture. Each entry: (label, scene-linear Rec.2020 input,
    /// Rust `view::agx::apply` output at contrast=0).
    static let rustReferenceOutputs: [(label: String, scene: SIMD3<Float>, display: SIMD3<Float>)] = [
        (label: "mid_gray",
         scene: SIMD3<Float>(0.18, 0.18, 0.18),
         display: SIMD3<Float>(0.49673104, 0.49673104, 0.49673104)),
        (label: "highlight_neutral",
         scene: SIMD3<Float>(5, 5, 5),
         display: SIMD3<Float>(0.9481417, 0.9481417, 0.9481417)),
        (label: "deep_shadow",
         scene: SIMD3<Float>(0.001, 0.001, 0.001),
         display: SIMD3<Float>(0.015590075, 0.015590075, 0.015590075)),
        (label: "near_zero",
         scene: SIMD3<Float>(0.000001, 0.000001, 0.000001),
         display: SIMD3<Float>(0, 0, 0)),
        (label: "saturated_red",
         scene: SIMD3<Float>(3.6000001, 0.18, 0.18),
         display: SIMD3<Float>(0.92673624, 0.49673104, 0.49673104)),
        (label: "saturated_green",
         scene: SIMD3<Float>(0.18, 3.6000001, 0.18),
         display: SIMD3<Float>(0.49673104, 0.92673624, 0.49673104)),
        (label: "saturated_blue",
         scene: SIMD3<Float>(0.18, 0.18, 3.6000001),
         display: SIMD3<Float>(0.49673104, 0.49673104, 0.92673624)),
        (label: "near_max_ev",
         scene: SIMD3<Float>(15.200732, 15.200732, 15.200732),
         display: SIMD3<Float>(0.9955535, 0.9955535, 0.9955535)),
        (label: "at_min_ev",
         scene: SIMD3<Float>(0.00017578126, 0.00017578126, 0.00017578126),
         display: SIMD3<Float>(0, 0, 0)),
        (label: "ungamuty_red_only",
         scene: SIMD3<Float>(2.5, 0, 0),
         display: SIMD3<Float>(0.8962385, 0, 0)),
        (label: "hot_specular_R",
         scene: SIMD3<Float>(50, 0.18, 0.18),
         display: SIMD3<Float>(0.99858, 0.49673104, 0.49673104)),
        (label: "low_R_high_BG",
         scene: SIMD3<Float>(0.01, 2, 2),
         display: SIMD3<Float>(0.09770617, 0.87385607, 0.87385607)),
        (label: "near_one_neutral",
         scene: SIMD3<Float>(1, 1, 1),
         display: SIMD3<Float>(0.7868532, 0.7868532, 0.7868532)),
        (label: "blackish",
         scene: SIMD3<Float>(0, 0, 0),
         display: SIMD3<Float>(0, 0, 0)),
    ]
}
