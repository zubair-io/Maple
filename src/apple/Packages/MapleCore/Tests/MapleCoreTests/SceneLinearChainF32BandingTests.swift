// SceneLinearChainF32BandingTests.swift — banding gate for the f32
// per-tick scene-linear chain (#487 Apple side / #482 Rust side).
//
// Companion to the Rust-side
// `neutral_ramp_view_transform_produces_no_banding_at_high_resolution`
// in `raw-core/src/pipeline/render/tests.rs`. That test guards the
// Rust f32 pipeline against accidental fp16 round-trips in the scene
// buffer. This file does the same for Apple's per-tick chain:
//
//   * Synthesise a 4096-wide neutral 0→1 ramp as f32 RGBA bytes.
//   * Hand it to `PipelineRenderer.applySceneLinearChain` with
//     `skip_agx = 1` (isolates storage precision from the view
//     transform's nonlinearity).
//   * Verify the round-trip output preserves the input precisely —
//     default model is identity on every cheap stage at scene-linear
//     domain. fp16 storage would introduce visible banding near the
//     mantissa-precision floor (~3-bit truncation drop on the [0,1]
//     ramp); f32 preserves the input to <1 LSB equivalent.

import XCTest
@testable import MapleCore

final class SceneLinearChainF32BandingTests: XCTestCase {

    /// Round-trip a 4096-px f32 neutral ramp through the per-tick chain
    /// with default model + `skip_agx`. Output must equal input to within
    /// floating-point noise — proves the f32 FFI is doing what its name
    /// claims (no silent fp16 quantisation hiding inside the chain).
    func testF32ChainSkipAgxPreservesNeutralRampPrecision() throws {
        let width = 4096
        let height = 1
        let pixelCount = width * height
        let lanes = pixelCount * 4

        // Synthesise a neutral 0→1 ramp directly as f32 RGBA. R == G == B
        // = i / (width - 1); alpha = 1.0.
        var input = [Float](repeating: 0, count: lanes)
        for x in 0..<width {
            let v = Float(x) / Float(width - 1)
            input[x * 4 + 0] = v
            input[x * 4 + 1] = v
            input[x * 4 + 2] = v
            input[x * 4 + 3] = 1.0
        }
        let inputBytes = input.withUnsafeBufferPointer { buf in
            Data(bytes: buf.baseAddress!, count: buf.count * MemoryLayout<Float>.size)
        }

        // Build chain params: every slider at its default (identity) and
        // `skip_agx = 1` so the assertion targets the FFI's f32 storage,
        // not the AgX nonlinearity.
        var model = AdjustmentModel.default
        // (defaults are already identity for every cheap stage; explicit
        // for documentation.)
        model.temperature = 6500.0
        model.tint = 0.0
        model.exposure = 0.0
        model.contrast = 0.0
        model.highlights = 0.0
        model.shadows = 0.0
        model.whites = 0.0
        model.blacks = 0.0
        model.vibrance = 0.0
        model.saturation = 0.0
        model.clarity = 0.0
        model.texture = 0.0
        model.dehaze = 0.0
        model.nrLuminance = 0.0
        // Sharpen / nr_color are NOT identity at their model defaults
        // (40 / 25) and the chain runs both since #1043 — a spatial pass
        // over the ramp's endpoints would show up here as ~3.6e-5 of
        // drift and be mistaken for the fp16 fingerprint this test hunts
        // (~1e-3). Zero them like every other slider above.
        model.sharpenAmount = 0.0
        model.nrColor = 0.0
        let params = PipelineRenderer.makeParams(
            from: model,
            decodedTemperature: 6500.0,
            decodedTint: 0.0,
            skipAgX: true
        )

        // Run the FFI chain.
        let outBytes = try PipelineRenderer.applySceneLinearChain(
            inputBytes: inputBytes,
            width: width,
            height: height,
            params: params
        )
        XCTAssertEqual(
            outBytes.count, inputBytes.count,
            "output bytes must match input bytes (f32 RGBA, 16 B/px)"
        )

        // Decode the output back into [Float] and assert two things:
        //
        //   1. Round-trip noise on the ramp midpoint is tiny — every
        //      sample is within 1e-5 of the input. fp16 storage would
        //      introduce ~1e-3 drift here (11-bit mantissa floor in the
        //      [0.4, 0.6] band).
        //   2. Adjacent samples step by exactly 1/(width-1) within the
        //      same tolerance — no plateaus, no skipped values. The fp16
        //      banding fingerprint is "jump-then-plateau"; f32 produces a
        //      uniform staircase.
        var out = [Float](repeating: 0, count: lanes)
        outBytes.withUnsafeBytes { rawBuf in
            let src = rawBuf.bindMemory(to: Float.self)
            for i in 0..<lanes { out[i] = src[i] }
        }

        let expectedStep = 1.0 / Float(width - 1)
        var maxAbsError: Float = 0
        var maxStepError: Float = 0
        for x in 0..<width {
            let expected = Float(x) / Float(width - 1)
            let got = out[x * 4 + 1] // green channel
            maxAbsError = max(maxAbsError, abs(got - expected))
            if x > 0 {
                let prev = out[(x - 1) * 4 + 1]
                let stepError = abs((got - prev) - expectedStep)
                maxStepError = max(maxStepError, stepError)
            }
        }

        // f32 storage easily clears 1e-5 across [0,1]. fp16 storage in
        // the chain would show ~1e-3 absolute error and similar step
        // error — the smallest fp16 representable step in [0.5, 1.0] is
        // 2^-11 ≈ 0.000488, well above the 4096-px ramp's 1/4095 ≈
        // 0.000244 step.
        XCTAssertLessThan(
            maxAbsError, 1e-5,
            "f32 chain must preserve neutral ramp to <1e-5 (got \(maxAbsError)). " +
            "Larger drift indicates a silent fp16 round-trip in the chain."
        )
        XCTAssertLessThan(
            maxStepError, 1e-5,
            "f32 chain must produce uniform step (got max step error \(maxStepError) — " +
            "expected step \(expectedStep)). Non-uniform steps indicate fp16 banding."
        )
    }

    /// Alpha lane should always read back as 1.0 — the f32 chain forces
    /// it (per `apply_scene_linear_chain_f32` contract). This guards
    /// against an accidental "leave alpha alone" code path that would
    /// surface as transparency on a CIImage tagged for premultiplied
    /// alpha rendering.
    func testF32ChainAlphaIsAlwaysOne() throws {
        let width = 32
        let height = 32
        let pixelCount = width * height
        let lanes = pixelCount * 4
        var input = [Float](repeating: 0, count: lanes)
        for i in 0..<pixelCount {
            input[i * 4 + 0] = 0.18
            input[i * 4 + 1] = 0.18
            input[i * 4 + 2] = 0.18
            input[i * 4 + 3] = 0.25 // deliberately non-1 — must be forced back
        }
        let inputBytes = input.withUnsafeBufferPointer { buf in
            Data(bytes: buf.baseAddress!, count: buf.count * MemoryLayout<Float>.size)
        }
        let params = PipelineRenderer.makeParams(
            from: AdjustmentModel.default,
            decodedTemperature: 6500.0,
            decodedTint: 0.0,
            skipAgX: true
        )
        let outBytes = try PipelineRenderer.applySceneLinearChain(
            inputBytes: inputBytes, width: width, height: height, params: params
        )
        outBytes.withUnsafeBytes { rawBuf in
            let src = rawBuf.bindMemory(to: Float.self)
            for i in 0..<pixelCount {
                XCTAssertEqual(src[i * 4 + 3], 1.0, accuracy: 1e-6,
                    "alpha lane at pixel \(i) must be 1.0, got \(src[i * 4 + 3])")
            }
        }
    }
}
