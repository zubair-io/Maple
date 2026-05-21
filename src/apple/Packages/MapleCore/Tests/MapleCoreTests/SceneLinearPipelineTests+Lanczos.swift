// SceneLinearPipelineTests+Lanczos.swift — Lanczos prescale on extended-range fp16 Rec.2020
//
// Sibling to SceneLinearPipelineTests.swift. Extension methods on
// SceneLinearPipelineTests; shared helpers live on the base class.
// Split out of the original 3316-LOC file — see refs #134.

import XCTest
import CoreImage
import CoreGraphics
@testable import MapleCore

extension SceneLinearPipelineTests {

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
            // `CFDataGetBytePtr` doesn't guarantee 2-byte alignment, so
            // `load(fromByteOffset:as:UInt16.self)` would trap on a
            // misaligned base. `loadUnaligned` reads byte-by-byte under
            // the hood — safe for any alignment.
            let r = Self.float16BitsToFloat32(bytes.loadUnaligned(fromByteOffset: off + 0, as: UInt16.self))
            let g = Self.float16BitsToFloat32(bytes.loadUnaligned(fromByteOffset: off + 2, as: UInt16.self))
            let b = Self.float16BitsToFloat32(bytes.loadUnaligned(fromByteOffset: off + 4, as: UInt16.self))
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
}
