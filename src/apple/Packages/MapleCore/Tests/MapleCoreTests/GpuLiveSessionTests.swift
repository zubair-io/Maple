// GpuLiveSessionTests.swift — the autonomous A3 gates (epic #925, P4b-apple /
// #1028).
//
// These tests exercise the GPU FFI surface (`MapleGpuLiveParams`,
// `maple_gpu_live_*`), which is now in the default xcframework (gpu is the default
// xcframework build per #1064), so they run in the standard `swift test`.
//
// Two layers, per the A3 plan:
//  1. PARAM-MAPPING (deterministic, no GPU) — the decode-boundary contract is the
//     highest-risk item (a wrong WB/AE/capture-sharpening mapping reproduces the
//     #871/#894 blowout). Asserting the mapped `MapleGpuLiveParams` fields directly
//     catches that WITHOUT running the GPU.
//  2. WIRING / NON-VACUITY — drive `maple_gpu_live_open` → `renderToBuffer` on a
//     synthetic scene-linear buffer; assert the Swift→FFI plumbing links and the
//     output is a real (non-flat) image. (This is NOT a flag-on-vs-flag-off pixel
//     parity test: the decode-boundary contract GUARANTEES the GPU path diverges
//     from `processSceneLinear` — sharpen + nr_color move into the scene-linear
//     chain, Auto Profile goes cube→passes. The color-correctness proof is the
//     raw-gpu host present-parity gate, ≤1 LSB vs the CPU oracle.)

import Foundation
import XCTest
@testable import MapleCore

final class GpuLiveSessionTests: XCTestCase {

    /// A model with every relevant field perturbed away from defaults so a missing
    /// or wrong mapping is detectable (not masked by a coincidental default).
    private func perturbedModel() -> AdjustmentModel {
        AdjustmentModel(
            temperature: 5200,
            tint: 8,
            exposure: 1.5,
            contrast: 25,
            highlights: -40,
            shadows: 30,
            whites: 12,
            blacks: -15,
            parametricHighlights: 7,
            parametricLights: 11,
            parametricDarks: -9,
            parametricShadows: 13,
            vibrance: 20,
            saturation: -10,
            clarity: 35,
            texture: 12,
            dehaze: 18,
            sharpenAmount: 70,
            sharpenRadius: 1.4,
            sharpenDetail: 33,
            sharpenMasking: 22,
            captureSharpeningAmount: 55, // MUST be ignored (baked at decode)
            captureSharpeningSigma: 1.3,
            nrLuminance: 17,
            nrColor: 41,
            profile: .auto
        )
    }

    // MARK: - Param-mapping (the decode-boundary contract)

    /// THE DECODE-BOUNDARY CONTRACT GATE: `makeGpuLiveParams` maps the model so the
    /// live wgpu chain matches canonical `render` on the AE-baked / capture-
    /// sharpened decoded buffer — capture-sharpening OFF, ABSOLUTE WB, real
    /// sharpen/nr passed through. A regression here is the #871/#894 blowout.
    func test_makeGpuLiveParams_honors_decode_boundary_contract() {
        let model = perturbedModel()
        let p = PipelineRenderer.makeGpuLiveParams(from: model)

        // (1) CAPTURE SHARPENING DISABLED — already baked into the decoded buffer.
        //     Including it would double-apply (zero harness coverage). This is the
        //     single most load-bearing assertion in the file.
        XCTAssertEqual(p.capture_sharpening_enabled, 0,
                       "capture_sharpening MUST be disabled — it is baked at decode")

        // (2) ABSOLUTE WB — temp/tint passed straight through (the FFI derives
        //     wb_cat16_matrix(temp,tint), matching develop's absolute apply). NOT a
        //     delta vs as-shot (that's the Apple CPU path's per-platform divergence).
        XCTAssertEqual(p.temperature, Float(model.temperature),
                       "WB temperature must be the ABSOLUTE live value (not an as-shot delta)")
        XCTAssertEqual(p.tint, Float(model.tint),
                       "WB tint must be the ABSOLUTE live value")
        XCTAssertEqual(p.wb_method, 0, "WB method must default to CAT16")

        // (3) REAL sharpen + NR — they run IN the scene-linear chain (replacing the
        //     post-AgX Metal kernels). This is the sanctioned convergence divergence.
        XCTAssertEqual(p.sharpen_amount, Float(model.sharpenAmount))
        XCTAssertEqual(p.sharpen_radius, Float(model.sharpenRadius))
        XCTAssertEqual(p.sharpen_detail, Float(model.sharpenDetail))
        XCTAssertEqual(p.sharpen_masking, Float(model.sharpenMasking))
        XCTAssertEqual(p.nr_luminance, Float(model.nrLuminance))
        XCTAssertEqual(p.nr_color, Float(model.nrColor),
                       "nr_color must be passed through (runs in-chain, not a post-AgX kernel)")

        // (4) The remaining scene + tone fields are straight float copies.
        XCTAssertEqual(p.exposure, Float(model.exposure))
        XCTAssertEqual(p.contrast, Float(model.contrast))
        XCTAssertEqual(p.highlights, Float(model.highlights))
        XCTAssertEqual(p.shadows, Float(model.shadows))
        XCTAssertEqual(p.whites, Float(model.whites))
        XCTAssertEqual(p.blacks, Float(model.blacks))
        XCTAssertEqual(p.vibrance, Float(model.vibrance))
        XCTAssertEqual(p.saturation, Float(model.saturation))
        XCTAssertEqual(p.clarity, Float(model.clarity))
        XCTAssertEqual(p.texture, Float(model.texture))
        XCTAssertEqual(p.dehaze, Float(model.dehaze))
        XCTAssertEqual(p.parametric_shadows, Float(model.parametricShadows))
        XCTAssertEqual(p.parametric_darks, Float(model.parametricDarks))
        XCTAssertEqual(p.parametric_lights, Float(model.parametricLights))
        XCTAssertEqual(p.parametric_highlights, Float(model.parametricHighlights))

        // (5) Point tone curves are not mirrored on Swift yet → empty (NULL/0). The
        //     parametric fields above carry the user's tone-region edits.
        XCTAssertNil(p.tone_curve_luma_ptr)
        XCTAssertEqual(p.tone_curve_luma_len, 0)
        XCTAssertNil(p.tone_curve_red_ptr)
        XCTAssertNil(p.tone_curve_green_ptr)
        XCTAssertNil(p.tone_curve_blue_ptr)

        // (6) The Auto Profile arrays are wired at the render call (in a live
        //     `withUnsafe…` scope), NOT here — so they're NULL/0 in the scalar map.
        XCTAssertNil(p.profile_curve_ptr)
        XCTAssertEqual(p.profile_curve_len, 0)
        XCTAssertNil(p.residual_lut_ptr)
        XCTAssertEqual(p.residual_lut_size, 0)
    }

    /// A neutral model maps to neutral params (WB at 6500/0, every slider 0,
    /// capture-sharpening off) — so the live chain's gating omits every no-op pass.
    /// Guards against a mapping that accidentally injects a non-zero default.
    func test_makeGpuLiveParams_neutral_model_is_neutral() {
        var model = AdjustmentModel()
        // AdjustmentModel() ships sharpen=40 / nr_color=25 (the import baseline) —
        // zero them so "neutral" means genuinely no-op for this assertion.
        model.sharpenAmount = 0
        model.nrColor = 0
        let p = PipelineRenderer.makeGpuLiveParams(from: model)

        XCTAssertEqual(p.temperature, 6500, "default WB temperature is 6500K")
        XCTAssertEqual(p.tint, 0)
        XCTAssertEqual(p.exposure, 0)
        XCTAssertEqual(p.sharpen_amount, 0)
        XCTAssertEqual(p.nr_color, 0)
        XCTAssertEqual(p.capture_sharpening_enabled, 0)
        XCTAssertEqual(p.dehaze, 0)
        XCTAssertEqual(p.vibrance, 0)
    }

    /// #1747 review fix: the decoded-anchor 0/0 sentinel is an ALL-OR-NOTHING
    /// pair. A caller that (by mistake) supplies only ONE of `asShotCCT` /
    /// `asShotTint` must still get the legacy sentinel (0/0) — NOT a
    /// half-populated anchor (e.g. decoded_temperature = asShotCCT,
    /// decoded_tint = 0), which would corrupt the WB delta math
    /// (`M_net = wb(live) · wb(decoded)⁻¹`) with a decoded anchor that was
    /// never actually observed together.
    func test_makeGpuLiveParams_partial_asShot_anchor_falls_back_to_sentinel() {
        let model = perturbedModel()

        let ccdOnly = PipelineRenderer.makeGpuLiveParams(
            from: model, asShotCCT: 5500.0, asShotTint: nil)
        XCTAssertEqual(ccdOnly.decoded_temperature, 0,
                       "asShotTint=nil must zero the WHOLE anchor, not just leave tint at 0")
        XCTAssertEqual(ccdOnly.decoded_tint, 0)

        let tintOnly = PipelineRenderer.makeGpuLiveParams(
            from: model, asShotCCT: nil, asShotTint: 12.0)
        XCTAssertEqual(tintOnly.decoded_temperature, 0)
        XCTAssertEqual(tintOnly.decoded_tint, 0,
                       "asShotCCT=nil must zero the WHOLE anchor, not just leave temperature at 0")

        // Both supplied — the real paired-anchor path — is unaffected.
        let both = PipelineRenderer.makeGpuLiveParams(
            from: model, asShotCCT: 5500.0, asShotTint: 12.0)
        XCTAssertEqual(both.decoded_temperature, 5500.0)
        XCTAssertEqual(both.decoded_tint, 12.0)
    }

    // MARK: - Wiring / non-vacuity

    /// A structured scene-linear Rec.2020 RGBA buffer (the kind the decode produces)
    /// — a gradient + a couple of saturated primaries so the chain output is a real
    /// (non-flat) image, not a constant the non-vacuity check could false-pass on.
    private func syntheticSceneLinear(_ w: Int, _ h: Int) -> [Float] {
        var v = [Float](); v.reserveCapacity(w * h * 4)
        for y in 0..<h {
            for x in 0..<w {
                let i = y * w + x
                let t = Float(i) / Float(w * h)
                var r = 0.05 + t * 1.1
                var g = 0.04 + (1 - t) * 0.8
                var b = 0.03 + t * 0.5
                switch i % 7 {
                case 0: (r, g, b) = (0.8, 0.1, 0.1)
                case 3: (r, g, b) = (0.1, 0.8, 0.1)
                case 5: (r, g, b) = (0.1, 0.1, 0.8)
                default: break
                }
                v.append(r); v.append(g); v.append(b); v.append(1.0)
            }
        }
        return v
    }

    /// WIRING + NON-VACUITY: open a session over a synthetic buffer and render it to
    /// the u8 surface via the FFI. Proves (a) the Swift→`maple_gpu_live_open`/
    /// `_render` plumbing links and runs on Metal, and (b) the output is a real
    /// image (a wide byte spread), not the all-zero buffer or a flat clear colour.
    func test_session_open_and_render_produces_a_real_image() async throws {
        let (w, h) = (48, 48)
        let pixels = syntheticSceneLinear(w, h)
        let session = try GpuLiveSession(pixels: pixels, width: w, height: h)

        var model = AdjustmentModel()
        model.profile = .neutral // no Auto fit needed for the wiring proof
        guard let out = try await session.renderToBuffer(model: model) else {
            return XCTFail("renderToBuffer returned nil (unexpected cancellation)")
        }

        XCTAssertEqual(out.count, w * h * 3, "output is the flat 3·w·h RGB surface")
        let mn = out.min() ?? 0
        let mx = out.max() ?? 0
        // A real developed image spans a wide range; the all-zero buffer (no render)
        // or a flat fill would be a narrow spread.
        XCTAssertGreaterThan(Int(mx) - Int(mn), 80,
                             "rendered surface byte range [\(mn),\(mx)] too narrow — the chain " +
                             "likely didn't run (plumbing or upload failure)")
    }

    /// #1513 + #1516 END-TO-END through the LINKED xcframework: a white scene-linear
    /// pixel rendered with the NON-RAW input shape must come out FULLY white (255) —
    /// the look stages (AgX #1513 + auto-profile/residual #1516) are all skipped —
    /// while the RAW shape is AgX-crushed (white ~193). Exercises the full Swift→FFI→
    /// `build_live_chain` path against the static lib the app actually links, so it
    /// catches a stale `.a` lacking the gates (the deploy bug that rendered non-raw
    /// white at 194, then 248, even with the fixes in source).
    func test_nonraw_white_survives_agx_through_linked_xcframework() async throws {
        let (w, h) = (16, 16)
        let pixels = [Float](repeating: 1.0, count: w * h * 4)  // pure white
        let session = try GpuLiveSession(pixels: pixels, width: w, height: h)
        var model = AdjustmentModel()
        model.sharpenAmount = 0
        model.nrColor = 0
        model.profile = .neutral

        guard let rawOut = try await session.renderToBuffer(model: model, inputShape: 0),
              let nonrawOut = try await session.renderToBuffer(model: model, inputShape: 1)
        else { return XCTFail("renderToBuffer returned nil") }

        let rawWhite = Int(rawOut[0])
        let nonrawWhite = Int(nonrawOut[0])
        print("[#1513/#1516 xcframework] RAW white=\(rawWhite)  NON-RAW white=\(nonrawWhite)")
        XCTAssertLessThan(rawWhite, 210,
            "RAW white must be AgX-compressed (~193); got \(rawWhite)")
        XCTAssertGreaterThan(nonrawWhite, 253,
            "NON-RAW white must be FULLY white (255) — look stages (AgX #1513 + auto-profile/"
            + "residual #1516) skipped; got \(nonrawWhite) (stale .a or a leaked look stage)")
    }

    /// The session rejects a pixel buffer whose length doesn't match the dims (a
    /// caller bug — guards the upload contract before it reaches the FFI).
    func test_session_rejects_mismatched_pixel_count() {
        XCTAssertThrowsError(try GpuLiveSession(pixels: [0, 0, 0], width: 4, height: 4))
    }

    /// Re-rendering the same session with the same model is byte-identical (the
    /// upload-once / pooled invariant survives at the Swift boundary too).
    func test_rerender_same_model_is_byte_identical() async throws {
        let (w, h) = (32, 32)
        let session = try GpuLiveSession(pixels: syntheticSceneLinear(w, h), width: w, height: h)
        var model = AdjustmentModel()
        model.profile = .neutral
        let first = try await session.renderToBuffer(model: model)
        let second = try await session.renderToBuffer(model: model)
        XCTAssertEqual(first, second, "re-render at same model must be byte-identical")
    }
}
