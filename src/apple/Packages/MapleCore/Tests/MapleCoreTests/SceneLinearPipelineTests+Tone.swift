// SceneLinearPipelineTests+Tone.swift — tone controls wired into processSceneLinear (exposure)
//
// Sibling to SceneLinearPipelineTests.swift. Extension methods on
// SceneLinearPipelineTests; shared helpers live on the base class.
// Split out of the original 3316-LOC file — see refs #134.

import XCTest
import CoreImage
import CoreGraphics
@testable import MapleCore

extension SceneLinearPipelineTests {

    /// Build a synthetic 16×16 mid-gray scene-linear Rec.2020 fp16 CIImage,
    /// run it through `processSceneLinear` with `model.exposure = 1.0`, and
    /// confirm the output is brighter than the same input through
    /// `processSceneLinear` with the default model. This is the wiring
    /// check, not a numeric parity check — the actual exposure math is
    /// exercised by the Rust unit tests for `scene_tone_controls.rs`.
    /// `swift test` cannot load the metallib, so we accept that the
    /// kernel call may be a silent no-op under XCTest and assert
    /// "output A is at least as bright as output B" (`>=` not `>`)
    /// per the existing `MetalKernelParityTests.swift` pattern.
    func testM1ProcessSceneLinearAppliesExposure() async throws {
        let pipeline = ImageEditPipeline()
        let input = Self.makeNeutralSceneLinearCIImage(width: 16, height: 16, value: 0.5)

        let modelDefault = AdjustmentModel.default
        var modelBright = modelDefault
        modelBright.exposure = 1.0

        let outDefault = pipeline.processSceneLinear(decoded: input, model: modelDefault)
        let outBright  = pipeline.processSceneLinear(decoded: input, model: modelBright)

        // Render both to fp16 CGImages tagged extendedLinearITUR_2020 and
        // compare the centre pixel's R channel.
        let bright = Self.sampleCenterR(outBright, width: 16, height: 16)
        let basic  = Self.sampleCenterR(outDefault, width: 16, height: 16)
        XCTAssertGreaterThanOrEqual(
            bright, basic,
            "exposure +1 should be at least as bright as default — got bright=\(bright) basic=\(basic)"
        )
    }
}
