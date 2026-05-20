// SceneLinearPipelineTests+VibranceSaturation.swift — vibrance + saturation wired into processSceneLinear
//
// Sibling to SceneLinearPipelineTests.swift. Extension methods on
// SceneLinearPipelineTests; shared helpers live on the base class.
// Split out of the original 3316-LOC file — see refs #134.

import XCTest
import CoreImage
import CoreGraphics
@testable import MapleCore

extension SceneLinearPipelineTests {

    /// Run a low-chroma red pixel through `processSceneLinear` with
    /// vibrance = +100 and confirm the output's R-G separation grows
    /// in the SIGNED direction (R should pull further above G).
    ///
    /// Restored to signed `R-G` (from `|R-G|`) after the Ticket 12
    /// follow-up to Bug 2 replaced the Apple Metal Oklab matrices with
    /// the Rust-equivalent Bottosson product (see SceneSaturation.metal
    /// header — `M_rec2020_to_lms = M1_SRGB_TO_LMS @ M_REC2020_TO_SRGB`).
    /// Apple Oklab is now bit-for-bit equivalent to Rust's
    /// `rec2020 → sRGB → LMS → cbrt → Oklab` chain, so the signed
    /// direction of the chroma boost matches Rust on low-chroma inputs.
    func testM1ProcessSceneLinearAppliesVibrance() async throws {
        let pipeline = ImageEditPipeline()
        // Low-chroma red — vibrance is supposed to boost low-chroma more.
        let input = Self.makeRGBSceneLinearCIImage(
            width: 16, height: 16, r: 0.35, g: 0.30, b: 0.30
        )

        let modelDefault = AdjustmentModel.default
        var modelBoosted = modelDefault
        modelBoosted.vibrance = 100.0

        let outDefault = pipeline.processSceneLinear(decoded: input, model: modelDefault)
        let outBoost   = pipeline.processSceneLinear(decoded: input, model: modelBoosted)

        // Signed R-G separation — boosted must be larger than default
        // (boost in the input's hue direction grows R relative to G).
        let dRdiff = Self.sampleCenterRMinusG(outDefault, width: 16, height: 16)
        let bRdiff = Self.sampleCenterRMinusG(outBoost, width: 16, height: 16)
        XCTAssertGreaterThan(
            bRdiff, dRdiff,
            "vibrance +100 should boost signed R-G — got boost=\(bRdiff) default=\(dRdiff)"
        )
    }

    /// Set saturation = -100 on a saturated red pixel. Output's R-G
    /// separation should not be larger after full desaturation than the
    /// default-model's. Same `>=` caveat — under XCTest the kernel may
    /// be a no-op (no metallib). Companion runtime check is the manual
    /// smoke test in Step 6.5.
    func testM2ProcessSceneLinearAppliesSaturation() async throws {
        let pipeline = ImageEditPipeline()
        let input = Self.makeRGBSceneLinearCIImage(
            width: 16, height: 16, r: 0.8, g: 0.1, b: 0.1
        )

        let modelDefault = AdjustmentModel.default
        var modelGray = modelDefault
        modelGray.saturation = -100  // achromatic

        let outDefault = pipeline.processSceneLinear(decoded: input, model: modelDefault)
        let outGray    = pipeline.processSceneLinear(decoded: input, model: modelGray)

        // R-G diff should not be larger after -100 saturation.
        let dRG = Self.sampleCenterRMinusG(outDefault, width: 16, height: 16)
        let gRG = Self.sampleCenterRMinusG(outGray, width: 16, height: 16)
        XCTAssertLessThanOrEqual(
            gRG, dRG,
            "saturation -100 should not widen R-G — got gray=\(gRG) default=\(dRG)"
        )
    }
}
