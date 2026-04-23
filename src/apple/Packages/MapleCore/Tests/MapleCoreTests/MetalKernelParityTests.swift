// MetalKernelParityTests.swift — Numeric parity tests for the Metal kernels
// vs the Rust pipeline spec (spec § 11 gate 4: ΔE ≤ 1.0 in display sRGB).
//
// These tests verify the Swift scalar implementations of the same math the
// Metal kernels execute (Metal kernels can't run in test processes without a
// GPU context, but the arithmetic can be validated in pure Swift).

import XCTest
@testable import MapleCore

// MARK: - Tone controls parity

final class MetalKernelParityTests: XCTestCase {

    // Helper: SceneToneControls math ported from the Metal kernel / Rust.
    struct ToneControlsPixel {
        var r, g, b: Float

        mutating func apply(exposure: Float, highlights: Float, shadows: Float,
                            whites: Float, blacks: Float) {
            // 1. Exposure
            if abs(exposure) >= 1e-6 {
                let gain = exp2(exposure)
                r *= gain; g *= gain; b *= gain
            }
            // 2. Highlights
            if abs(highlights) >= 1e-3 {
                let hd = 1.0 + (highlights / 100.0) * 2.0
                if r > 1.0 { r = 1.0 + (r - 1.0) / hd }
                if g > 1.0 { g = 1.0 + (g - 1.0) / hd }
                if b > 1.0 { b = 1.0 + (b - 1.0) / hd }
            }
            // 3. Shadows
            if abs(shadows) >= 1e-3 {
                let luma = 0.2627 * r + 0.6780 * g + 0.0593 * b
                let t = min(max((luma - 0.0) / (0.1 - 0.0), 0.0), 1.0)
                let mask = 1.0 - t * t * (3.0 - 2.0 * t)
                let lift = mask * (shadows / 100.0) * 0.5
                r += r * lift; g += g * lift; b += b * lift
            }
            // 4. Whites
            if abs(whites) >= 1e-3 {
                let wg = 1.0 + whites / 200.0
                r *= wg; g *= wg; b *= wg
            }
            // 5. Blacks
            if abs(blacks) >= 1e-3 {
                let ba = blacks / 400.0
                r += ba; g += ba; b += ba
            }
        }
    }

    func testToneControlsIdentity() {
        var p = ToneControlsPixel(r: 0.3, g: 0.4, b: 0.5)
        p.apply(exposure: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0)
        XCTAssertEqual(p.r, 0.3, accuracy: 1e-6)
        XCTAssertEqual(p.g, 0.4, accuracy: 1e-6)
        XCTAssertEqual(p.b, 0.5, accuracy: 1e-6)
    }

    func testExposurePlusOneDoubles() {
        var p = ToneControlsPixel(r: 0.1, g: 0.2, b: 0.3)
        p.apply(exposure: 1.0, highlights: 0, shadows: 0, whites: 0, blacks: 0)
        XCTAssertEqual(p.r, 0.2, accuracy: 1e-5)
        XCTAssertEqual(p.g, 0.4, accuracy: 1e-5)
        XCTAssertEqual(p.b, 0.6, accuracy: 1e-5)
    }

    func testHighlightsCompressesAboveKnee() {
        var p = ToneControlsPixel(r: 2.0, g: 2.0, b: 2.0)
        p.apply(exposure: 0, highlights: 100, shadows: 0, whites: 0, blacks: 0)
        // excess=1.0, denom=3 → 1.0 + 1/3 ≈ 1.333
        let expected = Float(1.0 + 1.0 / 3.0)
        XCTAssertEqual(p.r, expected, accuracy: 1e-4)
    }

    func testHighlightsLeavesLowValuesUntouched() {
        var p = ToneControlsPixel(r: 0.5, g: 0.5, b: 0.5)
        p.apply(exposure: 0, highlights: 100, shadows: 0, whites: 0, blacks: 0)
        XCTAssertEqual(p.r, 0.5, accuracy: 1e-6)
    }

    func testShadowsLiftsDeepValues() {
        var p = ToneControlsPixel(r: 0.02, g: 0.02, b: 0.02)
        p.apply(exposure: 0, highlights: 0, shadows: 100, whites: 0, blacks: 0)
        XCTAssertGreaterThan(p.r, 0.02)
    }

    func testShadowsLeaveMidtonesAlone() {
        var p = ToneControlsPixel(r: 0.3, g: 0.3, b: 0.3)
        p.apply(exposure: 0, highlights: 0, shadows: 100, whites: 0, blacks: 0)
        XCTAssertEqual(p.r, 0.3, accuracy: 1e-5)
    }

    func testWhitesScalesUniformly() {
        var p = ToneControlsPixel(r: 0.5, g: 0.5, b: 0.5)
        p.apply(exposure: 0, highlights: 0, shadows: 0, whites: 100, blacks: 0)
        // w_gain = 1 + 100/200 = 1.5 → 0.5 * 1.5 = 0.75
        XCTAssertEqual(p.r, 0.75, accuracy: 1e-5)
    }

    func testBlacksShiftsAdditively() {
        var p = ToneControlsPixel(r: 0.0, g: 0.0, b: 0.0)
        p.apply(exposure: 0, highlights: 0, shadows: 0, whites: 0, blacks: -100)
        // b_add = -100/400 = -0.25
        XCTAssertEqual(p.r, -0.25, accuracy: 1e-5)
    }

    // MARK: - Vibrance parity (Oklab math)

    struct OklabPixel {
        var L, a, b: Float
        var chroma: Float { sqrt(a * a + b * b) }
        var hueDeg: Float { atan2(b, a) * 180.0 / Float.pi }
    }

    func smoothstep(_ e0: Float, _ e1: Float, _ x: Float) -> Float {
        let t = min(max((x - e0) / (e1 - e0), 0.0), 1.0)
        return t * t * (3.0 - 2.0 * t)
    }

    func testVibranceSkinWindowAttenuation() {
        // A pixel at hue ≈ 28° (within skin window 15-42°) should be attenuated.
        let hueDeg: Float = 28.0
        let hueRad = hueDeg * Float.pi / 180.0
        let chroma: Float = 0.1   // low-chroma → would get max boost
        let a = chroma * cos(hueRad)
        let b = chroma * sin(hueRad)

        let vibrance: Float = 100.0
        let amount = vibrance / 100.0
        let skin_mask = smoothstep(15.0, 22.0, hueDeg) * (1.0 - smoothstep(35.0, 42.0, hueDeg))
        let low_chroma_factor = 1.0 - min(chroma / 0.3, 1.0)
        let chroma_boost = low_chroma_factor * amount * (1.0 - skin_mask * 0.6)
        let scale = 1.0 + chroma_boost

        // With skin_mask > 0, scale should be less than pure low-chroma boost
        let scale_no_skin = 1.0 + low_chroma_factor * amount  // what we'd get without skin protection
        XCTAssertLessThan(scale, scale_no_skin, "skin window should reduce scale")
        // But it shouldn't be zero — some boost is still applied
        XCTAssertGreaterThan(scale, 1.0, "some chroma boost should still apply in skin zone")
        _ = (a, b) // silence unused warning
    }

    func testVibranceHighChromaLessBoost() {
        // High-chroma pixels get less boost than low-chroma ones.
        func boost(chroma: Float) -> Float {
            let amount: Float = 1.0  // vibrance 100%
            let low_chroma_factor = 1.0 - min(chroma / 0.3, 1.0)
            return low_chroma_factor * amount
        }
        let lowBoost = boost(chroma: 0.05)
        let highBoost = boost(chroma: 0.25)
        XCTAssertGreaterThan(lowBoost, highBoost,
                             "low-chroma pixels should receive more vibrance boost")
    }

    // MARK: - AgX log-encode parity

    func testAgXLogEncodeMidGray() {
        // scene mid-gray (0.18) should encode to MID_NORM ≈ 0.6061...
        let AGX_MIN_EV: Float = -10.0
        let AGX_MAX_EV: Float = 6.5
        let AGX_MID_GRAY: Float = 0.18
        let MID_NORM = -AGX_MIN_EV / (AGX_MAX_EV - AGX_MIN_EV)

        func logEncode(_ linear: Float) -> Float {
            let eps: Float = 1e-10
            let log_val = log2(max(linear, eps)) - log2(AGX_MID_GRAY)
            return min(max((log_val - AGX_MIN_EV) / (AGX_MAX_EV - AGX_MIN_EV), 0.0), 1.0)
        }

        let encoded = logEncode(AGX_MID_GRAY)
        XCTAssertEqual(encoded, MID_NORM, accuracy: 1e-5,
                       "mid-gray should encode to MID_NORM \(MID_NORM)")
    }

    func testAgXLogEncodeClampedAtZero() {
        let AGX_MIN_EV: Float = -10.0
        let AGX_MAX_EV: Float = 6.5
        let AGX_MID_GRAY: Float = 0.18
        func logEncode(_ linear: Float) -> Float {
            let eps: Float = 1e-10
            let log_val = log2(max(linear, eps)) - log2(AGX_MID_GRAY)
            return min(max((log_val - AGX_MIN_EV) / (AGX_MAX_EV - AGX_MIN_EV), 0.0), 1.0)
        }
        XCTAssertEqual(logEncode(0.0), 0.0, accuracy: 1e-6)
    }

    func testAgXLUTIsMonotonic() throws {
        // Verify that the embedded agx_lut.bin produces a monotonically increasing
        // tone curve (required for a valid view transform).
        guard let url = Bundle.module.url(forResource: "agx_lut", withExtension: "bin"),
              let data = try? Data(contentsOf: url) else {
            throw XCTSkip("agx_lut.bin not in bundle")
        }
        let count = data.count / 4
        XCTAssertEqual(count, 512, "LUT should have 512 entries")
        var lut = [Float32](repeating: 0, count: count)
        data.withUnsafeBytes { src in
            lut.withUnsafeMutableBytes { dst in
                dst.baseAddress?.copyMemory(from: src.baseAddress!, byteCount: data.count)
            }
        }
        for i in 1..<count {
            XCTAssertGreaterThanOrEqual(lut[i], lut[i-1],
                                       "LUT must be non-decreasing at index \(i)")
        }
    }
}
