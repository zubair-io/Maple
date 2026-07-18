// SceneLinearPipelineTests.swift — base class for scene-linear pipeline
// verification spikes and integration tests.
//
// In refs #134 (file-budget burndown, slice 1 of N) the original 3316-LOC
// file was split by adjustment category into sibling extension files:
// SceneLinearPipelineTests+Lanczos.swift, +AgX.swift, +Integration.swift,
// +Tone.swift, +WhiteBalance.swift, +VibranceSaturation.swift,
// +ComputeSpikes.swift, +GaussianBlur.swift, +ClarityTexture.swift,
// +NoiseReduction.swift, +Sharpen.swift, +Dehaze.swift.
//
// This base file retains the class declaration and every shared helper
// (Float16<->Float32, Lanczos CPU reference, AgX LUT mirror, scene-linear
// CIImage builders, Oklab scalar helpers, Gaussian/box blur mirrors,
// sharpen + dehaze scalar mirrors). The category extensions hold ONLY
// the test functions; they call helpers via Self.foo as before.
//
// Original Plan 1/2 milestone notes were dropped to fit the file budget.
// They remain reachable via git history (pre-split: lines 1-362).
import XCTest
import CoreImage
import CoreGraphics
@testable import MapleCore

final class SceneLinearPipelineTests: XCTestCase {

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

    // MARK: - LUT mirror helpers (port of view/agx.rs:34-77)

    /// Load `agx_lut.bin` for the LUT-mirror tests. The byte source is
    /// the Rust LUT at `src/raw-pipeline/raw-core/src/view/agx_lut.bin`,
    /// resolved relative to this test file at compile time. Reasoning:
    /// the Rust reference outputs in `rustReferenceOutputs` were generated
    /// from THAT exact LUT (AGX_VERSION 7 per agx_coeffs.rs, via the
    /// per-channel kernel — see fixture header). As of the
    /// Spike 1.2 follow-up, the MapleCore-bundled `Metal/agx_lut.bin` is
    /// byte-identical to the Rust LUT (enforced by
    /// `testAppleBundledAgxLUTMatchesRustLUT`); this helper still loads
    /// the Rust bytes directly so the LUT-mirror tests stay independent
    /// of SwiftPM's resource-bundling layout, and so a future bundling
    /// regression doesn't masquerade as a per-channel-math regression.
    func loadAgxLUT() throws -> [Float] {
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
    func sampleLUT(_ x: Float, lut: [Float]) -> Float {
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
    func agxPerChannelLUT(_ scene: Float, lut: [Float], slope: Float) -> Float {
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

    // MARK: - Rust reference fixture (AGX_VERSION 7, per-channel LUT path)

    /// Generated by `src/raw-pipeline/raw-core/examples/spike_1_2_refs.rs`.
    /// Re-run that example after any AGX_VERSION bump and replace this
    /// fixture. Each entry: (label, scene-linear Rec.2020 input, Rust
    /// per-channel AgX kernel output at contrast=0).
    ///
    /// NOTE: these references are deliberately from the **per-channel LUT
    /// kernel only**, not from `view::agx::apply`. At AGX_VERSION 7 (#263),
    /// the `apply` wrapper became a full Sobotka pipeline:
    /// luma-coupled toe → INSET matrix → per-channel sigmoid LUT → OUTSET
    /// matrix → clamp. The Swift mirror `agxPerChannelLUT` only models the
    /// per-channel sigmoid stage (log-encode → LUT sample) so the fixture
    /// targets the same per-channel stage on the Rust side for a fair
    /// apples-to-apples comparison. Cross-platform parity for the full
    /// pipeline (matrices included) is gated by `examples/agx_parity.rs`
    /// + the GLSL self-consistency vitest + Rust `glsl_port_matches_rust_lut`.
    static let rustReferenceOutputs: [(label: String, scene: SIMD3<Float>, display: SIMD3<Float>)] = [
        (label: "mid_gray",
         scene: SIMD3<Float>(0.18, 0.18, 0.18),
         display: SIMD3<Float>(0.1800001, 0.1800001, 0.1800001)),
        (label: "highlight_neutral",
         scene: SIMD3<Float>(5, 5, 5),
         display: SIMD3<Float>(0.8363404, 0.8363404, 0.8363404)),
        (label: "deep_shadow",
         scene: SIMD3<Float>(0.001, 0.001, 0.001),
         display: SIMD3<Float>(0.00015643505, 0.00015643505, 0.00015643505)),
        (label: "near_zero",
         scene: SIMD3<Float>(0.000001, 0.000001, 0.000001),
         display: SIMD3<Float>(0, 0, 0)),
        (label: "saturated_red",
         scene: SIMD3<Float>(3.6000001, 0.18, 0.18),
         display: SIMD3<Float>(0.78119063, 0.1800001, 0.1800001)),
        (label: "saturated_green",
         scene: SIMD3<Float>(0.18, 3.6000001, 0.18),
         display: SIMD3<Float>(0.1800001, 0.78119063, 0.1800001)),
        (label: "saturated_blue",
         scene: SIMD3<Float>(0.18, 0.18, 3.6000001),
         display: SIMD3<Float>(0.1800001, 0.1800001, 0.78119063)),
        (label: "near_max_ev",
         scene: SIMD3<Float>(15.200732, 15.200732, 15.200732),
         display: SIMD3<Float>(0.99196005, 0.99196005, 0.99196005)),
        (label: "at_min_ev",
         scene: SIMD3<Float>(0.00017578126, 0.00017578126, 0.00017578126),
         display: SIMD3<Float>(0, 0, 0)),
        (label: "ungamuty_red_only",
         scene: SIMD3<Float>(2.5, 0, 0),
         display: SIMD3<Float>(0.71580404, 0, 0)),
        (label: "hot_specular_R",
         scene: SIMD3<Float>(50, 0.18, 0.18),
         display: SIMD3<Float>(1, 0.1800001, 0.1800001)),
        (label: "low_R_high_BG",
         scene: SIMD3<Float>(0.01, 2, 2),
         display: SIMD3<Float>(0.0014315548, 0.6739248, 0.6739248)),
        (label: "near_one_neutral",
         scene: SIMD3<Float>(1, 1, 1),
         display: SIMD3<Float>(0.5370691, 0.5370691, 0.5370691)),
        (label: "blackish",
         scene: SIMD3<Float>(0, 0, 0),
         display: SIMD3<Float>(0, 0, 0)),
    ]

    // MARK: - Plan 2 M1: SceneToneControls wired into processSceneLinear

    /// Build a 16×16 fp16 Rec.2020 CIImage of one constant value. Used by
    /// the M1 wiring tests so they don't depend on a fixture.
    static func makeNeutralSceneLinearCIImage(width w: Int, height h: Int, value v: Float) -> CIImage {
        var pixels = [UInt16](repeating: 0, count: w * h * 4)
        let one = Self.float32ToFloat16Bits(1.0)
        let val = Self.float32ToFloat16Bits(v)
        for i in stride(from: 0, to: pixels.count, by: 4) {
            pixels[i + 0] = val
            pixels[i + 1] = val
            pixels[i + 2] = val
            pixels[i + 3] = one
        }
        let bytesPerRow = w * 4 * 2
        let data = pixels.withUnsafeBufferPointer { Data(bytes: $0.baseAddress!, count: $0.count * 2) }
        let space = CGColorSpace(name: CGColorSpace.extendedLinearITUR_2020)!
        return CIImage(
            bitmapData: data,
            bytesPerRow: bytesPerRow,
            size: CGSize(width: w, height: h),
            format: .RGBAh,
            colorSpace: space
        )
    }

    /// Render the centre pixel of a CIImage to fp16 R, return the f32 value.
    static func sampleCenterR(_ ci: CIImage, width w: Int, height h: Int) -> Float {
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
        let outSpace = CGColorSpace(name: CGColorSpace.extendedLinearITUR_2020)!
        guard let cg = context.createCGImage(
            ci, from: CGRect(x: 0, y: 0, width: w, height: h),
            format: .RGBAh, colorSpace: outSpace
        ), let cfData = cg.dataProvider?.data
        else { return Float.nan }
        let bytes = UnsafeRawPointer(CFDataGetBytePtr(cfData)!)
        let bpr = cg.bytesPerRow
        let cx = w / 2, cy = h / 2
        let off = cy * bpr + cx * 4 * 2
        return Self.float16BitsToFloat32(bytes.load(fromByteOffset: off, as: UInt16.self))
    }

    /// Deterministic blur-test input (#2043): a `w`×`h` fp16 Rec.2020
    /// CIImage that is zero everywhere except a single bright RGBA=1 pixel
    /// at the centre. Shared by the sequential and concurrent shared-blur-
    /// context tests in `SceneLinearPipelineTests+GaussianBlur.swift` —
    /// each caller (including each concurrent TaskGroup child) builds its
    /// own instance from this recipe, so the only state shared across
    /// calls is what's actually under test in `MetalKernels`.
    static func makeCenterDeltaRGBAhCIImage(width w: Int, height h: Int) -> CIImage {
        var pixels = [UInt16](repeating: 0, count: w * h * 4)
        let zero = Self.float32ToFloat16Bits(0.0)
        let one  = Self.float32ToFloat16Bits(1.0)
        for i in stride(from: 0, to: pixels.count, by: 4) {
            pixels[i + 0] = zero
            pixels[i + 1] = zero
            pixels[i + 2] = zero
            pixels[i + 3] = one
        }
        let centerIdx = ((h / 2) * w + (w / 2)) * 4
        pixels[centerIdx + 0] = one
        pixels[centerIdx + 1] = one
        pixels[centerIdx + 2] = one
        pixels[centerIdx + 3] = one
        let bytesPerRow = w * 4 * 2
        let data = pixels.withUnsafeBufferPointer { buf -> Data in
            Data(bytes: buf.baseAddress!, count: buf.count * 2)
        }
        let space = CGColorSpace(name: CGColorSpace.extendedLinearITUR_2020)!
        return CIImage(
            bitmapData: data,
            bytesPerRow: bytesPerRow,
            size: CGSize(width: w, height: h),
            format: .RGBAh,
            colorSpace: space
        )
    }

    /// Render the FULL pixel buffer of a CIImage to fp16 RGBA, returned as
    /// raw `Data` for byte-for-byte comparison across two independent
    /// renders (see `testSeparableGaussianBlurSharedContextIsStableAcrossCalls`
    /// — #2043). Uses its own throwaway `CIContext`, deliberately NOT the
    /// shared one under test in `MetalKernels`, so this helper's own
    /// rendering can't mask a real divergence between the two blur calls.
    static func renderFullBufferRGBAh(_ ci: CIImage, width w: Int, height h: Int) -> Data? {
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
        let outSpace = CGColorSpace(name: CGColorSpace.extendedLinearITUR_2020)!
        guard let cg = context.createCGImage(
            ci, from: CGRect(x: 0, y: 0, width: w, height: h),
            format: .RGBAh, colorSpace: outSpace
        ), let cfData = cg.dataProvider?.data else { return nil }
        return cfData as Data
    }

    /// Build a 16×16 fp16 Rec.2020 CIImage of one constant RGB triple.
    static func makeRGBSceneLinearCIImage(width w: Int, height h: Int,
                                          r: Float, g: Float, b: Float) -> CIImage {
        var pixels = [UInt16](repeating: 0, count: w * h * 4)
        let one = Self.float32ToFloat16Bits(1.0)
        let R = Self.float32ToFloat16Bits(r)
        let G = Self.float32ToFloat16Bits(g)
        let B = Self.float32ToFloat16Bits(b)
        for i in stride(from: 0, to: pixels.count, by: 4) {
            pixels[i + 0] = R
            pixels[i + 1] = G
            pixels[i + 2] = B
            pixels[i + 3] = one
        }
        let bytesPerRow = w * 4 * 2
        let data = pixels.withUnsafeBufferPointer { Data(bytes: $0.baseAddress!, count: $0.count * 2) }
        let space = CGColorSpace(name: CGColorSpace.extendedLinearITUR_2020)!
        return CIImage(
            bitmapData: data,
            bytesPerRow: bytesPerRow,
            size: CGSize(width: w, height: h),
            format: .RGBAh,
            colorSpace: space
        )
    }

    /// Returns center-pixel R minus G. Positive = redder than green.
    static func sampleCenterRMinusG(_ ci: CIImage, width w: Int, height h: Int) -> Float {
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
        let outSpace = CGColorSpace(name: CGColorSpace.extendedLinearITUR_2020)!
        guard let cg = context.createCGImage(
            ci, from: CGRect(x: 0, y: 0, width: w, height: h),
            format: .RGBAh, colorSpace: outSpace
        ), let cfData = cg.dataProvider?.data
        else { return Float.nan }
        let bytes = UnsafeRawPointer(CFDataGetBytePtr(cfData)!)
        let bpr = cg.bytesPerRow
        let cx = w / 2, cy = h / 2
        let off = cy * bpr + cx * 4 * 2
        let r = Self.float16BitsToFloat32(bytes.load(fromByteOffset: off + 0, as: UInt16.self))
        let g = Self.float16BitsToFloat32(bytes.load(fromByteOffset: off + 2, as: UInt16.self))
        return r - g
    }

    // MARK: - Plan 2 M2: WhiteBalance wired into processSceneLinear

    /// Returns center-pixel R minus B. Positive = redder than blue.
    static func sampleCenterRMinusB(_ ci: CIImage, width w: Int, height h: Int) -> Float {
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
        let outSpace = CGColorSpace(name: CGColorSpace.extendedLinearITUR_2020)!
        guard let cg = context.createCGImage(
            ci, from: CGRect(x: 0, y: 0, width: w, height: h),
            format: .RGBAh, colorSpace: outSpace
        ), let cfData = cg.dataProvider?.data
        else { return Float.nan }
        let bytes = UnsafeRawPointer(CFDataGetBytePtr(cfData)!)
        let bpr = cg.bytesPerRow
        let cx = w / 2, cy = h / 2
        let off = cy * bpr + cx * 4 * 2
        let r = Self.float16BitsToFloat32(bytes.load(fromByteOffset: off + 0, as: UInt16.self))
        let b = Self.float16BitsToFloat32(bytes.load(fromByteOffset: off + 4, as: UInt16.self))
        return r - b
    }

    // MARK: - Plan 2 v2 Task 3: SeparableGaussianBlur scalar parity vs Rust

    /// Pure-Swift mirror of `gaussian_blur_plane` from
    /// raw-core/src/stages/blur.rs:77-87. Matches the Rust implementation
    /// byte-for-byte: r_box = max(1, radius/3), 3 successive box passes,
    /// running-sum window with edge clamp.
    ///
    /// `buf` is row-major w*h fp32; returns a fresh row-major fp32
    /// vector of the same shape.
    static func swiftGaussianBlurPlane(
        _ buf: [Float], w: Int, h: Int, radius: Int
    ) -> [Float] {
        if radius == 0 { return buf }
        let rBox = max(1, radius / 3)
        var plane = buf
        for _ in 0..<3 {
            plane = swiftBoxBlurChannel(plane, w: w, h: h, r: rBox)
        }
        return plane
    }

    /// Pure-Swift mirror of `box_blur_channel` at blur.rs:26-70. Performs
    /// one full separable box-blur pass (H sweep + V sweep) over the
    /// input plane. Edge handling is clamp-to-edge: the running window
    /// is initialised over the visible pixels [0, min(r, w-1)] and the
    /// active count is tracked alongside the running sum so partial
    /// windows at the boundary divide by their actual size.
    static func swiftBoxBlurChannel(
        _ buf: [Float], w: Int, h: Int, r: Int
    ) -> [Float] {
        if r == 0 { return buf }

        // H sweep — write row-major into `tmp` (mirrors blur.rs:31-42).
        var tmp = [Float](repeating: 0, count: buf.count)
        for y in 0..<h {
            let row0 = y * w
            let right0 = min(r, w - 1)
            var acc: Float = 0
            for i in 0...right0 { acc += buf[row0 + i] }
            var count = right0 + 1
            tmp[row0] = acc / Float(count)
            for x in 1..<w {
                if x + r < w {
                    acc += buf[row0 + x + r]
                    count += 1
                }
                if x > r {
                    acc -= buf[row0 + x - r - 1]
                    count -= 1
                }
                tmp[row0 + x] = acc / Float(count)
            }
        }

        // V sweep — column-walk over `tmp`, write row-major into `out`.
        // The Rust source goes via a column-major `tmp_col` + transpose
        // for parallelism; the numerics are identical to a direct column
        // walk that writes back into row-major (blur.rs:50-68).
        var out = [Float](repeating: 0, count: buf.count)
        for x in 0..<w {
            let bot0 = min(r, h - 1)
            var acc: Float = 0
            for i in 0...bot0 { acc += tmp[i * w + x] }
            var count = bot0 + 1
            out[x] = acc / Float(count)
            for y in 1..<h {
                if y + r < h {
                    acc += tmp[(y + r) * w + x]
                    count += 1
                }
                if y > r {
                    acc -= tmp[(y - r - 1) * w + x]
                    count -= 1
                }
                out[y * w + x] = acc / Float(count)
            }
        }
        return out
    }

    // MARK: - Plan 2 v2 M2: SceneClarity wired into processSceneLinear

    /// Build a 32×32 fp16 RGBA CIImage with a vertical step edge at the
    /// horizontal midpoint: left half value 0.3, right half value 0.7.
    /// Used by the clarity / texture wiring tests so they can sample
    /// edge contrast without depending on a fixture.
    static func makeStepEdgeSceneLinearCIImage(width w: Int, height h: Int) -> CIImage {
        var pixels = [UInt16](repeating: 0, count: w * h * 4)
        let one = Self.float32ToFloat16Bits(1.0)
        let lo  = Self.float32ToFloat16Bits(0.3)
        let hi  = Self.float32ToFloat16Bits(0.7)
        for y in 0..<h {
            for x in 0..<w {
                let i = (y * w + x) * 4
                let v = x < w / 2 ? lo : hi
                pixels[i + 0] = v
                pixels[i + 1] = v
                pixels[i + 2] = v
                pixels[i + 3] = one
            }
        }
        let bytesPerRow = w * 4 * 2
        let data = pixels.withUnsafeBufferPointer { Data(bytes: $0.baseAddress!, count: $0.count * 2) }
        let space = CGColorSpace(name: CGColorSpace.extendedLinearITUR_2020)!
        return CIImage(
            bitmapData: data,
            bytesPerRow: bytesPerRow,
            size: CGSize(width: w, height: h),
            format: .RGBAh,
            colorSpace: space
        )
    }

    /// Sample edge contrast: max minus min along the horizontal scanline
    /// through y = h/2. A clarity boost is supposed to increase the
    /// (max - min) span via the unsharp overshoot.
    static func sampleEdgeContrast(_ ci: CIImage, width w: Int, height h: Int) -> Float {
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
        let outSpace = CGColorSpace(name: CGColorSpace.extendedLinearITUR_2020)!
        guard let cg = context.createCGImage(
            ci, from: CGRect(x: 0, y: 0, width: w, height: h),
            format: .RGBAh, colorSpace: outSpace
        ), let cfData = cg.dataProvider?.data
        else { return Float.nan }
        let bytes = UnsafeRawPointer(CFDataGetBytePtr(cfData)!)
        let bpr = cg.bytesPerRow
        let cy = h / 2
        var minV: Float = .infinity, maxV: Float = -.infinity
        for x in 0..<w {
            let off = cy * bpr + x * 4 * 2
            let r = Self.float16BitsToFloat32(bytes.load(fromByteOffset: off, as: UInt16.self))
            if r < minV { minV = r }
            if r > maxV { maxV = r }
        }
        return maxV - minV
    }

    // MARK: - Plan 2 v2 v2 M3a: Oklab scalar helpers (matches SceneVibrance.metal)

    /// Pure-Swift mirror of `rec2020_to_oklab_nrl` from
    /// SceneNRLuminance.metal. The matrices are byte-identical to the
    /// `_sat`-suffixed copies in SceneSaturation.metal:17-38 and the
    /// unsuffixed copies in SceneVibrance.metal:16-26 (the suffix-on-
    /// duplicate pattern only resolves Metal symbol clashes; the values
    /// are the same).
    static let M_REC2020_TO_LMS: [[Float]] = [
        [0.6370481, 0.2657101, 0.0365291],
        [0.3320989, 0.6936245, 0.0374060],
        [0.0002832, 0.0182337, 0.9994374],
    ]
    static let M_LMS_TO_OKLAB: [[Float]] = [
        [0.2104542553, 0.7936177850, -0.0040720468],
        [1.9779984951, -2.4285922050, 0.4505937099],
        [0.0259040371, 0.7827717662, -0.8086757660],
    ]
    static let M_OKLAB_TO_LMS: [[Float]] = [
        [1.0000000000, 0.3963377774, 0.2158037573],
        [1.0000000000, -0.1055613458, -0.0638541728],
        [1.0000000000, -0.0894841775, -1.2914855480],
    ]
    static let M_LMS_TO_REC2020: [[Float]] = [
        [1.6970305, -0.7288047, 0.0413840],
        [-0.5065012, 1.6510782, -0.0577547],
        [-0.0247447, 0.0438581, 1.0759636],
    ]

    /// 3x3 matrix-vector multiply. Matches Metal's `float3x3 * float3`
    /// semantics per https://developer.apple.com/metal/Metal-Shading-
    /// Language-Specification.pdf § 6.5 (column-major storage; the
    /// Metal kernel's float3x3 constructor takes column vectors, but
    /// since both the Rust `Matrix3` and the Metal kernel use the same
    /// math layout the per-pixel result is identical).
    static func mulMV(_ m: [[Float]], _ v: [Float]) -> [Float] {
        return [
            m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
            m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
            m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
        ]
    }

    /// Sign-preserving cube root (matches Metal's `sign(x) * pow(abs(x),
    /// 1/3)` and Rust's `.cbrt()` at oklab.rs:55).
    static func cbrtSigned(_ x: Float) -> Float {
        if x >= 0 { return powf(x, 1.0 / 3.0) }
        return -powf(-x, 1.0 / 3.0)
    }

    static func swiftRec2020ToOklab(_ rgb: [Float]) -> [Float] {
        let lms = mulMV(M_REC2020_TO_LMS, rgb)
        let lmsNl = [cbrtSigned(lms[0]), cbrtSigned(lms[1]), cbrtSigned(lms[2])]
        return mulMV(M_LMS_TO_OKLAB, lmsNl)
    }

    static func swiftOklabToRec2020(_ lab: [Float]) -> [Float] {
        let lmsNl = mulMV(M_OKLAB_TO_LMS, lab)
        let lms = [lmsNl[0] * lmsNl[0] * lmsNl[0],
                   lmsNl[1] * lmsNl[1] * lmsNl[1],
                   lmsNl[2] * lmsNl[2] * lmsNl[2]]
        return mulMV(M_LMS_TO_REC2020, lms)
    }

    // MARK: - Plan 2 v2 v2 M3a: apply_luminance scalar parity vs Rust

    /// Pure-Swift mirror of `noise_reduction::apply_luminance` from
    /// raw-core/src/stages/noise_reduction.rs:20-55. Matches the Rust
    /// implementation byte-for-byte:
    ///   1. amount.abs() < 1e-3 -> identity (line :22)
    ///   2. radius = max(1, ceil((amount / 100) * 2.0)) (lines :24-25)
    ///   3. rec2020 -> oklab via the same matrices (line :33)
    ///   4. L-replicate into (L, L, L) (line :42)
    ///   5. gaussian_blur_plane (the Swift mirror at :1750-1830) at
    ///      integer radius (line :44)
    ///   6. write back blurred L into oklab dst[0] (line :49)
    ///   7. oklab -> rec2020 (line :54)
    ///
    /// The Swift mirror runs the algorithm on a 16×16 fp32 image so we
    /// can compare to a recorded "Rust reference" inline (no fixture
    /// file). A pass here confirms the algorithm is correctly ported;
    /// the live Metal kernel runtime check is in Task 7 manual smoke.
    static func swiftApplyLuminance(
        _ rgbBuf: [[Float]], w: Int, h: Int, amount: Float
    ) -> [[Float]] {
        if abs(amount) < 1e-3 { return rgbBuf }
        let scaled = (amount / 100.0) * 2.0
        let radius = max(1, Int(ceilf(scaled)))

        // 1. rec2020 -> oklab per pixel.
        var oklab = [[Float]](repeating: [0, 0, 0], count: w * h)
        for i in 0..<(w * h) {
            oklab[i] = swiftRec2020ToOklab(rgbBuf[i])
        }
        // 2. Replicate L across all 3 channels of a flat plane buffer.
        // We call `swiftGaussianBlurPlane` per channel — Rust's
        // gaussian_blur_rgb runs the same algorithm on each of the 3
        // channels independently, so blurring just channel 0 of a
        // plane that was built from L is equivalent.
        var lPlane = [Float](repeating: 0, count: w * h)
        for i in 0..<(w * h) { lPlane[i] = oklab[i][0] }
        let blurredL = Self.swiftGaussianBlurPlane(lPlane, w: w, h: h, radius: radius)
        // 3. Writeback: oklab dst[0] = blurredL[i].
        for i in 0..<(w * h) {
            oklab[i][0] = blurredL[i]
        }
        // 4. oklab -> rec2020 per pixel.
        var out = [[Float]](repeating: [0, 0, 0], count: w * h)
        for i in 0..<(w * h) {
            out[i] = swiftOklabToRec2020(oklab[i])
        }
        return out
    }

    // Note: `testM3NRLuminanceShortCircuitsAtZeroAmount` was retired
    // alongside the `applySceneNRLuminance` Apple Metal wrapper — the
    // NR-luminance stage now runs in the Rust FFI's
    // `apply_scene_linear_chain`. The scalar Rust-mirror coverage
    // (`testM3aSwiftScalarApplyLuminance*`) above remains.

    // MARK: - Plan 2 v2 v2 M3b: apply_color scalar parity vs Rust

    /// Pure-Swift mirror of `noise_reduction::apply_color` from
    /// raw-core/src/stages/noise_reduction.rs:61-96. Symmetric with
    /// `swiftApplyLuminance` (Task 3); only the channel routing differs:
    ///   * blur input is the (a, b, 0) plane instead of (L, L, L)
    ///   * radius scale is MAX=4.0 instead of MAX=2.0
    ///   * writeback is dst[1] = blurredA, dst[2] = blurredB (instead
    ///     of dst[0] = blurredL)
    static func swiftApplyColor(
        _ rgbBuf: [[Float]], w: Int, h: Int, amount: Float
    ) -> [[Float]] {
        if abs(amount) < 1e-3 { return rgbBuf }
        let scaled = (amount / 100.0) * 4.0
        let radius = max(1, Int(ceilf(scaled)))

        var oklab = [[Float]](repeating: [0, 0, 0], count: w * h)
        for i in 0..<(w * h) {
            oklab[i] = swiftRec2020ToOklab(rgbBuf[i])
        }
        // Pack a into R, b into G, 0 into B; blur each plane independently.
        var aPlane = [Float](repeating: 0, count: w * h)
        var bPlane = [Float](repeating: 0, count: w * h)
        for i in 0..<(w * h) {
            aPlane[i] = oklab[i][1]
            bPlane[i] = oklab[i][2]
        }
        let blurredA = Self.swiftGaussianBlurPlane(aPlane, w: w, h: h, radius: radius)
        let blurredB = Self.swiftGaussianBlurPlane(bPlane, w: w, h: h, radius: radius)
        // Writeback: dst[1] = blurredA[i], dst[2] = blurredB[i].
        for i in 0..<(w * h) {
            oklab[i][1] = blurredA[i]
            oklab[i][2] = blurredB[i]
        }
        var out = [[Float]](repeating: [0, 0, 0], count: w * h)
        for i in 0..<(w * h) {
            out[i] = swiftOklabToRec2020(oklab[i])
        }
        return out
    }

    // MARK: - Plan 2 v2 v2 M3: NR luminance + NR color wired into processSceneLinear

    /// Build a 32×32 alternating-luma scene: even rows bright reddish
    /// (R, G, B = 0.6, 0.3, 0.3), odd rows dark reddish (0.3, 0.1, 0.1).
    /// Mirrors the Rust unit test at noise_reduction.rs:121-126.
    static func makeAlternatingLumaSceneLinearCIImage(width w: Int, height h: Int) -> CIImage {
        var pixels = [UInt16](repeating: 0, count: w * h * 4)
        let one = Self.float32ToFloat16Bits(1.0)
        let bright = (Self.float32ToFloat16Bits(0.6),
                      Self.float32ToFloat16Bits(0.3),
                      Self.float32ToFloat16Bits(0.3))
        let dark = (Self.float32ToFloat16Bits(0.3),
                    Self.float32ToFloat16Bits(0.1),
                    Self.float32ToFloat16Bits(0.1))
        for y in 0..<h {
            for x in 0..<w {
                let i = (y * w + x) * 4
                let v = (y % 2 == 0) ? bright : dark
                pixels[i + 0] = v.0
                pixels[i + 1] = v.1
                pixels[i + 2] = v.2
                pixels[i + 3] = one
            }
        }
        let bytesPerRow = w * 4 * 2
        let data = pixels.withUnsafeBufferPointer { Data(bytes: $0.baseAddress!, count: $0.count * 2) }
        let space = CGColorSpace(name: CGColorSpace.extendedLinearITUR_2020)!
        return CIImage(
            bitmapData: data,
            bytesPerRow: bytesPerRow,
            size: CGSize(width: w, height: h),
            format: .RGBAh,
            colorSpace: space
        )
    }

    /// Build a 32×32 alternating-chroma scene: even rows reddish (R, G,
    /// B = 0.5, 0.3, 0.3), odd rows greenish (0.3, 0.5, 0.3). Same luma,
    /// different chroma — designed for NR color smoothing.
    static func makeAlternatingChromaSceneLinearCIImage(width w: Int, height h: Int) -> CIImage {
        var pixels = [UInt16](repeating: 0, count: w * h * 4)
        let one = Self.float32ToFloat16Bits(1.0)
        let red = (Self.float32ToFloat16Bits(0.5),
                   Self.float32ToFloat16Bits(0.3),
                   Self.float32ToFloat16Bits(0.3))
        let green = (Self.float32ToFloat16Bits(0.3),
                     Self.float32ToFloat16Bits(0.5),
                     Self.float32ToFloat16Bits(0.3))
        for y in 0..<h {
            for x in 0..<w {
                let i = (y * w + x) * 4
                let v = (y % 2 == 0) ? red : green
                pixels[i + 0] = v.0
                pixels[i + 1] = v.1
                pixels[i + 2] = v.2
                pixels[i + 3] = one
            }
        }
        let bytesPerRow = w * 4 * 2
        let data = pixels.withUnsafeBufferPointer { Data(bytes: $0.baseAddress!, count: $0.count * 2) }
        let space = CGColorSpace(name: CGColorSpace.extendedLinearITUR_2020)!
        return CIImage(
            bitmapData: data,
            bytesPerRow: bytesPerRow,
            size: CGSize(width: w, height: h),
            format: .RGBAh,
            colorSpace: space
        )
    }

    // MARK: - Plan 2 v2 v3 M4: Swift scalar mirror of apply_sharpen

    /// Pure-Swift mirror of `gaussian_blur_plane_sigma` from
    /// raw-core/src/stages/blur.rs (#1083): a TRUE separable Gaussian at
    /// float `sigma` — windowed/renormalized taps from
    /// `MetalKernels.gaussianKernel1D` (the same builder the production
    /// Metal path uploads), clamp-to-edge sample indices, H sweep then V
    /// sweep. Per-pixel tap order matches the Rust loop exactly.
    static func swiftGaussianBlurPlaneSigma(
        _ buf: [Float], w: Int, h: Int, sigma: Float
    ) -> [Float] {
        let kernel = MetalKernels.gaussianKernel1D(sigma: sigma)
        let half = kernel.count / 2

        var tmp = [Float](repeating: 0, count: buf.count)
        for y in 0..<h {
            for x in 0..<w {
                var acc: Float = 0
                for (kIdx, k) in kernel.enumerated() {
                    let xi = max(0, min(w - 1, x + kIdx - half))
                    acc += k * buf[y * w + xi]
                }
                tmp[y * w + x] = acc
            }
        }
        var out = [Float](repeating: 0, count: buf.count)
        for y in 0..<h {
            for x in 0..<w {
                var acc: Float = 0
                for (kIdx, k) in kernel.enumerated() {
                    let yi = max(0, min(h - 1, y + kIdx - half))
                    acc += k * tmp[yi * w + x]
                }
                out[y * w + x] = acc
            }
        }
        return out
    }

    /// Pure-Swift mirror of `sharpen::apply` from
    /// raw-core/src/stages/sharpen.rs — the CURRENT luma-only USM
    /// implementation (#439 replaced the per-channel Richardson-Lucy this
    /// mirror used to track), with the sigma-faithful true-Gaussian unsharp
    /// blur of #1083:
    ///   1. amount.abs() < 1e-3 -> identity
    ///   2. sigma = clamp(radius, 0.5, 3.0) — FLOAT, no integer rounding
    ///      (the old round-to-radius_px conversion was the #1083 no-op)
    ///   3. luma = BT.2020 dot product; luma_blur = trueGaussian(luma, sigma)
    ///   4. per-pixel luma USM: scale = 1 + smoothstepShadowGuard *
    ///      (clamp(luma_out / safe_luma, 0, 4) - 1), applied to ALL three
    ///      channels (chroma ratios preserved by construction)
    ///   5. edge-aware final mix (amount/detail/masking; central-difference
    ///      gradient on the ORIGINAL luma plane)
    /// Constants stay in lockstep with sharpen.rs / SharpenLumaUSM.metal.
    static func swiftApplySharpen(
        _ rgbBuf: [[Float]],
        w: Int, h: Int,
        amount: Float, radius: Float, detail: Float, masking: Float
    ) -> [[Float]] {
        if abs(amount) < 1e-3 { return rgbBuf }
        let sigma = max(Float(0.5), min(Float(3.0), radius))
        let observed = rgbBuf

        // Luma plane (BT.2020 weights) and its true-Gaussian blur.
        var luma = [Float](repeating: 0, count: w * h)
        for i in 0..<(w * h) {
            luma[i] = 0.2627 * observed[i][0] + 0.6780 * observed[i][1] + 0.0593 * observed[i][2]
        }
        let lumaBlur = Self.swiftGaussianBlurPlaneSigma(luma, w: w, h: h, sigma: sigma)

        // Per-pixel luma USM with the smoothstep shadow guard.
        let SHADOW_EPSILON: Float = 1e-4
        let SHADOW_BAND: Float = 4.0
        let MAX_SCALE: Float = 4.0
        let MIN_SCALE: Float = 0.0
        func smoothstep(_ e0: Float, _ e1: Float, _ x: Float) -> Float {
            let t = max(Float(0.0), min(Float(1.0), (x - e0) / (e1 - e0)))
            return t * t * (3.0 - 2.0 * t)
        }
        var sharpened = [[Float]](repeating: [0, 0, 0], count: w * h)
        for i in 0..<(w * h) {
            let li = luma[i]
            let lb = lumaBlur[i]
            let lo = li + (li - lb)
            let weight = smoothstep(SHADOW_EPSILON, SHADOW_BAND * SHADOW_EPSILON, li)
            let safeLuma = max(li, SHADOW_EPSILON)
            let bounded = max(MIN_SCALE, min(MAX_SCALE, lo / safeLuma))
            let scale = 1.0 + weight * (bounded - 1.0)
            let o = observed[i]
            sharpened[i] = [o[0] * scale, o[1] * scale, o[2] * scale]
        }

        // Edge-aware final mix.
        let overallMix = max(Float(0.0), min(Float(1.5), amount / 100.0))
        let detailAtten = max(Float(0.0), min(Float(1.0), detail / 100.0))
        let maskingThreshold = max(Float(0.0), min(Float(1.0), masking / 100.0))

        // Helper: clamped index.
        func idxAt(_ x: Int, _ y: Int) -> Int {
            let xc = max(0, min(w - 1, x))
            let yc = max(0, min(h - 1, y))
            return yc * w + xc
        }

        var out = [[Float]](repeating: [0, 0, 0], count: w * h)
        for y in 0..<h {
            for x in 0..<w {
                let i = y * w + x
                let edge: Float
                if maskingThreshold > 1e-3 {
                    let gx = luma[idxAt(x + 1, y)] - luma[idxAt(x - 1, y)]
                    let gy = luma[idxAt(x, y + 1)] - luma[idxAt(x, y - 1)]
                    let g = sqrtf(gx * gx + gy * gy)
                    let gNorm = max(Float(0.0), min(Float(1.0), g / 0.2))
                    edge = (gNorm >= maskingThreshold) ? 1.0 : detailAtten
                } else {
                    edge = 1.0
                }
                let mix = overallMix * edge
                let o = observed[i]
                let s = sharpened[i]
                out[i] = [
                    o[0] + (s[0] - o[0]) * mix,
                    o[1] + (s[1] - o[1]) * mix,
                    o[2] + (s[2] - o[2]) * mix,
                ]
            }
        }
        return out
    }

    // MARK: - Plan 2 v2 v4 M5a: Dehaze scalar mirrors (matches DehazeDarkChannel.metal etc.)

    static let DARK_RADIUS: Int = 7

    /// Pure-Swift mirror of `dark_channel` from raw-core/src/stages/
    /// dehaze.rs:5-25. Per output pixel, scan the 15x15 RGB neighborhood
    /// (DARK_RADIUS=7, clamp-to-edge), compute min-of-3-channels per
    /// neighbor, take the min across the kernel.
    static func swiftDarkChannel(
        _ rgbBuf: [[Float]], w: Int, h: Int
    ) -> [Float] {
        var out = [Float](repeating: 0, count: w * h)
        for y in 0..<h {
            for x in 0..<w {
                var m = Float.infinity
                for dy in -Self.DARK_RADIUS...Self.DARK_RADIUS {
                    for dx in -Self.DARK_RADIUS...Self.DARK_RADIUS {
                        let ux = max(0, min(w - 1, x + dx))
                        let uy = max(0, min(h - 1, y + dy))
                        let p = rgbBuf[uy * w + ux]
                        let localMin = min(min(p[0], p[1]), p[2])
                        if localMin < m { m = localMin }
                    }
                }
                out[y * w + x] = m
            }
        }
        return out
    }

    /// Pure-Swift mirror of `atmospheric_light` from raw-core/src/stages/
    /// dehaze.rs:29-41. Returns the per-channel mean over the top-0.1%
    /// brightest dark-channel positions of the original RGB.
    static func swiftAtmosphericLight(
        _ rgbBuf: [[Float]], dc: [Float]
    ) -> [Float] {
        let n = dc.count
        let topN = max(1, n / 1000)
        var idx = Array(0..<n)
        idx.sort { dc[$0] > dc[$1] }   // descending
        var sumR: Float = 0, sumG: Float = 0, sumB: Float = 0
        for i in 0..<topN {
            let p = rgbBuf[idx[i]]
            sumR += p[0]; sumG += p[1]; sumB += p[2]
        }
        let k = Float(topN)
        return [sumR / k, sumG / k, sumB / k]
    }

    // MARK: - Plan 2 v2 v4 M5b: Dehaze transmission/box-blur/guided-filter mirrors

    /// Pure-Swift mirror of `transmission` from raw-core/src/stages/
    /// dehaze.rs:43-68.
    static func swiftTransmission(
        _ rgbBuf: [[Float]], a: [Float], w: Int, h: Int
    ) -> [Float] {
        let omega: Float = 0.95
        var out = [Float](repeating: 0, count: w * h)
        let aR = max(a[0], 1e-6)
        let aG = max(a[1], 1e-6)
        let aB = max(a[2], 1e-6)
        for y in 0..<h {
            for x in 0..<w {
                var m: Float = .infinity
                for dy in -Self.DARK_RADIUS...Self.DARK_RADIUS {
                    for dx in -Self.DARK_RADIUS...Self.DARK_RADIUS {
                        let ux = max(0, min(w - 1, x + dx))
                        let uy = max(0, min(h - 1, y + dy))
                        let p = rgbBuf[uy * w + ux]
                        let scaled = min(min(p[0] / aR, p[1] / aG), p[2] / aB)
                        if scaled < m { m = scaled }
                    }
                }
                out[y * w + x] = 1.0 - omega * m
            }
        }
        return out
    }

    /// Pure-Swift mirror of `box_blur` from raw-core/src/stages/dehaze.rs
    /// :72-105. Single-pass running-sum with truncated-window normalization.
    /// **Distinct from `swiftGaussianBlurPlane` (which is 3-pass).**
    static func swiftDehazeBoxBlur(
        _ buf: [Float], w: Int, h: Int, r: Int
    ) -> [Float] {
        // Horizontal pass
        var tmp = [Float](repeating: 0, count: buf.count)
        for y in 0..<h {
            let row = Array(buf[(y * w)..<((y + 1) * w)])
            var outRow = [Float](repeating: 0, count: w)
            let right0 = min(r, w - 1)
            var acc: Float = (0...right0).map { row[$0] }.reduce(0, +)
            var count = right0 + 1
            outRow[0] = acc / Float(count)
            for x in 1..<w {
                if x + r < w { acc += row[x + r]; count += 1 }
                if x > r     { acc -= row[x - r - 1]; count -= 1 }
                outRow[x] = acc / Float(count)
            }
            for x in 0..<w { tmp[y * w + x] = outRow[x] }
        }
        // Vertical pass
        var out = [Float](repeating: 0, count: buf.count)
        for x in 0..<w {
            var outCol = [Float](repeating: 0, count: h)
            let bot0 = min(r, h - 1)
            var acc: Float = (0...bot0).map { tmp[$0 * w + x] }.reduce(0, +)
            var count = bot0 + 1
            outCol[0] = acc / Float(count)
            for y in 1..<h {
                if y + r < h { acc += tmp[(y + r) * w + x]; count += 1 }
                if y > r     { acc -= tmp[(y - r - 1) * w + x]; count -= 1 }
                outCol[y] = acc / Float(count)
            }
            for y in 0..<h { out[y * w + x] = outCol[y] }
        }
        return out
    }

    /// Pure-Swift mirror of `guided_filter` from raw-core/src/stages/
    /// dehaze.rs:109-135.
    static func swiftGuidedFilter(
        guide: [Float], p: [Float], w: Int, h: Int, r: Int, eps: Float
    ) -> [Float] {
        precondition(guide.count == p.count)
        let n = guide.count
        let meanI  = swiftDehazeBoxBlur(guide, w: w, h: h, r: r)
        let meanP  = swiftDehazeBoxBlur(p,     w: w, h: h, r: r)
        var ip     = [Float](repeating: 0, count: n)
        for i in 0..<n { ip[i] = guide[i] * p[i] }
        let meanIp = swiftDehazeBoxBlur(ip, w: w, h: h, r: r)
        var covIp  = [Float](repeating: 0, count: n)
        for i in 0..<n { covIp[i] = meanIp[i] - meanI[i] * meanP[i] }
        var ii     = [Float](repeating: 0, count: n)
        for i in 0..<n { ii[i] = guide[i] * guide[i] }
        let meanII = swiftDehazeBoxBlur(ii, w: w, h: h, r: r)
        var varI   = [Float](repeating: 0, count: n)
        for i in 0..<n { varI[i] = meanII[i] - meanI[i] * meanI[i] }
        var a      = [Float](repeating: 0, count: n)
        for i in 0..<n { a[i] = covIp[i] / (varI[i] + eps) }
        var b      = [Float](repeating: 0, count: n)
        for i in 0..<n { b[i] = meanP[i] - a[i] * meanI[i] }
        let meanA  = swiftDehazeBoxBlur(a, w: w, h: h, r: r)
        let meanB  = swiftDehazeBoxBlur(b, w: w, h: h, r: r)
        var out    = [Float](repeating: 0, count: n)
        for i in 0..<n { out[i] = meanA[i] * guide[i] + meanB[i] }
        return out
    }

    // MARK: - Plan 2 v2 v4 M5c: Dehaze full-pipeline mirror + wrapper smoke

    /// Pure-Swift mirror of `apply` from raw-core/src/stages/dehaze.rs:
    /// 144-179. Composes swiftDarkChannel -> swiftAtmosphericLight ->
    /// swiftTransmission -> Rec.2020 luma guide -> swiftGuidedFilter
    /// at radius 60, eps 1e-3 -> per-pixel reconstruction with slider
    /// mapping.
    static func swiftApplyDehaze(
        _ rgbBuf: [[Float]], w: Int, h: Int, dehaze: Float
    ) -> [[Float]] {
        if abs(dehaze) < 1e-3 { return rgbBuf }
        let dc    = swiftDarkChannel(rgbBuf, w: w, h: h)
        let a     = swiftAtmosphericLight(rgbBuf, dc: dc)
        let tRaw  = swiftTransmission(rgbBuf, a: a, w: w, h: h)
        var guide = [Float](repeating: 0, count: w * h)
        for i in 0..<(w * h) {
            let p = rgbBuf[i]
            guide[i] = 0.2627 * p[0] + 0.6780 * p[1] + 0.0593 * p[2]
        }
        let tRefined = swiftGuidedFilter(
            guide: guide, p: tRaw, w: w, h: h, r: 60, eps: 1e-3)
        let t0: Float = 0.1
        let scale = max(-1.0, min(1.0, dehaze / 100.0))
        var out = [[Float]](repeating: [0, 0, 0], count: w * h)
        for i in 0..<(w * h) {
            let p = rgbBuf[i]
            let t = max(0.0, min(1.0, tRefined[i]))
            let tEff: Float
            if scale >= 0 {
                tEff = max(t + (1.0 - t) * (1.0 - scale), t0)
            } else {
                let inner = min(t + (1.0 - t) * (-scale), 1.0)
                tEff = max(inner, t0)
            }
            out[i] = [
                (p[0] - a[0]) / tEff + a[0],
                (p[1] - a[1]) / tEff + a[1],
                (p[2] - a[2]) / tEff + a[2],
            ]
        }
        return out
    }

    // Note: `testM5DehazeShortCircuitsAtZeroAmount` was retired alongside
    // the `applySceneDehaze` Apple Metal wrapper — the dehaze stage now
    // runs in the Rust FFI's `apply_scene_linear_chain`. The scalar
    // Rust-mirror coverage above (`testM5SwiftScalarApplyDehaze*`)
    // remains.

}
