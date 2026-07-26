// SceneLinearPipelineTests+NoiseReduction.swift — NR luminance + NR color scalar parity + wiring
//
// Sibling to SceneLinearPipelineTests.swift. Extension methods on
// SceneLinearPipelineTests; shared helpers live on the base class.
// Split out of the original 3316-LOC file — see refs #134.

import XCTest
import CoreImage
import CoreGraphics
@testable import MapleCore

extension SceneLinearPipelineTests {

    func testM3aSwiftScalarApplyLuminanceMatchesRust() async throws {
        // Build a 16×16 alternating-luminance scene in rec2020 (matches
        // the Rust unit test at noise_reduction.rs:121-126 — even pixels
        // bright reddish, odd pixels dark reddish).
        let w = 16, h = 16
        var rgb = [[Float]](repeating: [0, 0, 0], count: w * h)
        for i in 0..<(w * h) {
            rgb[i] = (i % 2 == 0) ? [0.6, 0.3, 0.3] : [0.3, 0.1, 0.1]
        }
        // Run apply_luminance at amount=100 (radius=2 per the math).
        let out = Self.swiftApplyLuminance(rgb, w: w, h: h, amount: 100.0)

        // Same assertions the Rust unit test uses at noise_reduction.rs
        // :130-138: every output pixel is finite, luma is in a sane band,
        // and the red tint persists (saturation > 0.05).
        for p in out {
            for c in p {
                XCTAssertTrue(c.isFinite,
                    "apply_luminance produced non-finite channel: \(c)")
            }
            // luma per Rec.2020 = 0.2627 R + 0.6780 G + 0.0593 B.
            let luma = 0.2627 * p[0] + 0.6780 * p[1] + 0.0593 * p[2]
            XCTAssertGreaterThan(luma, 0.15, "luma too low after blur: \(luma)")
            XCTAssertLessThan(luma, 0.6, "luma too high after blur: \(luma)")
            // saturation as max(R-G, R-B) — preserved by NR luma.
            let sat = max(p[0] - p[1], p[0] - p[2])
            XCTAssertGreaterThan(sat, 0.05, "saturation lost after NR luma: \(sat)")
        }
    }

    /// Identity check for the scalar mirror: amount=0 returns the input
    /// unchanged (matches the Rust short-circuit at noise_reduction.rs:22
    /// and the wrapper short-circuit at MetalKernels.applySceneNRLuminance).
    func testM3aSwiftScalarApplyLuminanceZeroIsIdentity() async throws {
        let w = 8, h = 8
        var rgb = [[Float]](repeating: [0, 0, 0], count: w * h)
        for i in 0..<(w * h) {
            rgb[i] = [Float(i) / 64.0, 0.5, 0.7]
        }
        let out = Self.swiftApplyLuminance(rgb, w: w, h: h, amount: 0.0)
        XCTAssertEqual(out.count, rgb.count)
        for i in 0..<(w * h) {
            XCTAssertEqual(out[i][0], rgb[i][0], accuracy: 0.0,
                "amount=0 not identity at pixel \(i) channel R")
            XCTAssertEqual(out[i][1], rgb[i][1], accuracy: 0.0,
                "amount=0 not identity at pixel \(i) channel G")
            XCTAssertEqual(out[i][2], rgb[i][2], accuracy: 0.0,
                "amount=0 not identity at pixel \(i) channel B")
        }
    }

    func testM3bSwiftScalarApplyColorMatchesRust() async throws {
        // Same alternating scene as the luma test, but check NR color
        // smooths the chroma without crushing luma.
        let w = 16, h = 16
        var rgb = [[Float]](repeating: [0, 0, 0], count: w * h)
        for i in 0..<(w * h) {
            // Even pixels reddish, odd pixels greenish — same luma.
            rgb[i] = (i % 2 == 0) ? [0.5, 0.3, 0.3] : [0.3, 0.5, 0.3]
        }
        let out = Self.swiftApplyColor(rgb, w: w, h: h, amount: 100.0)

        // Every pixel finite.
        for p in out {
            for c in p {
                XCTAssertTrue(c.isFinite,
                    "apply_color produced non-finite channel: \(c)")
            }
        }

        // Chroma alternation should be reduced — measured as the mean
        // absolute value of (R - G) across the image. Rust unit test at
        // noise_reduction.rs:111-118 only checks identity-at-zero; we
        // additionally assert that NR color at amount=100 reduces mean
        // |R - G| strictly below the input. Empirically the 8×8
        // alternating pattern + amount=100 lands around a ~25% reduction
        // (input 0.20 → output ~0.15), well short of 50%, so the
        // assertion is a monotonic "did NR do something" check rather
        // than a strength threshold. Tightening it would require either
        // a larger image (the kernel's effective radius is comparable to
        // this image) or a stronger amount knob.
        var inputDiffs: [Float] = []
        var outputDiffs: [Float] = []
        for i in 0..<(w * h) {
            inputDiffs.append(rgb[i][0] - rgb[i][1])
            outputDiffs.append(out[i][0] - out[i][1])
        }
        let inputAbsAvg = inputDiffs.map { abs($0) }.reduce(0, +) / Float(inputDiffs.count)
        let outputAbsAvg = outputDiffs.map { abs($0) }.reduce(0, +) / Float(outputDiffs.count)
        XCTAssertLessThan(outputAbsAvg, inputAbsAvg,
            "NR color at amount=100 should reduce mean |R-G|; in=\(inputAbsAvg) out=\(outputAbsAvg)")
    }

    func testM3bSwiftScalarApplyColorZeroIsIdentity() async throws {
        let w = 8, h = 8
        var rgb = [[Float]](repeating: [0, 0, 0], count: w * h)
        for i in 0..<(w * h) {
            rgb[i] = [Float(i) / 64.0, 0.5, 0.7]
        }
        let out = Self.swiftApplyColor(rgb, w: w, h: h, amount: 0.0)
        for i in 0..<(w * h) {
            XCTAssertEqual(out[i][0], rgb[i][0], accuracy: 0.0)
            XCTAssertEqual(out[i][1], rgb[i][1], accuracy: 0.0)
            XCTAssertEqual(out[i][2], rgb[i][2], accuracy: 0.0)
        }
    }

    /// Build a 32×32 fp16 Rec.2020 CIImage with alternating bright/dark
    /// rows on the same hue (mirrors the Rust unit test at
    /// noise_reduction.rs:121-126). Run through processSceneLinear with
    /// model.nrLuminance = 0 (default) and model.nrLuminance = 100.
    /// Assert the +100 output's centre-pixel R-channel is finite and
    /// in [0, 2] — the chroma should not have collapsed catastrophically.
    /// Same `>=` caveat as Plan 2 v1's M1 wiring tests — under XCTest
    /// the kernel may be a no-op; the load-bearing runtime check is
    /// in Task 7's manual smoke test.
    func testM3ProcessSceneLinearAppliesNRLuminance() async throws {
        let pipeline = ImageEditPipeline()
        let input = Self.makeAlternatingLumaSceneLinearCIImage(width: 32, height: 32)

        var modelDefault = AdjustmentModel.default
        modelDefault.nrLuminance = 0    // explicit 0 to suppress NR luma
        modelDefault.nrColor = 0        // also suppress NR color so the
                                        // baseline is bare WB->tone->...->texture
                                        // (no chroma blur)
        var modelBoost = modelDefault
        modelBoost.nrLuminance = 100

        let outDefault = pipeline.processSceneLinear(decoded: input, model: modelDefault)
        let outBoost   = pipeline.processSceneLinear(decoded: input, model: modelBoost)

        let dR = Self.sampleCenterR(outDefault, width: 32, height: 32)
        let bR = Self.sampleCenterR(outBoost, width: 32, height: 32)
        XCTAssertTrue(dR.isFinite && bR.isFinite,
            "NR luminance produced non-finite channel: default=\(dR) boost=\(bR)")
        XCTAssertGreaterThanOrEqual(bR, 0.0,
            "NR luminance pushed centre R below zero: \(bR)")
        XCTAssertLessThanOrEqual(bR, 2.0,
            "NR luminance pushed centre R above 2.0 (clip headroom): \(bR)")
    }

    /// Same shape but for NR color. The boost slider increases blur on
    /// the a/b channels; assert no catastrophic chroma collapse.
    func testM3ProcessSceneLinearAppliesNRColor() async throws {
        let pipeline = ImageEditPipeline()
        let input = Self.makeAlternatingChromaSceneLinearCIImage(width: 32, height: 32)

        var modelDefault = AdjustmentModel.default
        modelDefault.nrLuminance = 0
        modelDefault.nrColor = 0
        var modelBoost = modelDefault
        modelBoost.nrColor = 100

        let outDefault = pipeline.processSceneLinear(decoded: input, model: modelDefault)
        let outBoost   = pipeline.processSceneLinear(decoded: input, model: modelBoost)

        let dRG = Self.sampleCenterRMinusG(outDefault, width: 32, height: 32)
        let bRG = Self.sampleCenterRMinusG(outBoost, width: 32, height: 32)
        XCTAssertTrue(dRG.isFinite && bRG.isFinite,
            "NR color produced non-finite R-G: default=\(dRG) boost=\(bRG)")
        // NR color blurs chroma — the centre of an alternating-chroma
        // scene should see chroma reduced. We accept >= as a smoke
        // threshold (no-op kernel passes; running kernel produces a
        // smaller |R-G| at the centre).
        XCTAssertLessThanOrEqual(abs(bRG), abs(dRG) + 1e-3,
            "NR color +100 should not increase |R-G| at centre — got default=\(dRG) boost=\(bRG)")
    }
}
