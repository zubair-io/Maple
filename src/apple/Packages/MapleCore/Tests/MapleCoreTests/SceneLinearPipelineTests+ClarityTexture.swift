// SceneLinearPipelineTests+ClarityTexture.swift — clarity + texture wired into processSceneLinear
//
// Sibling to SceneLinearPipelineTests.swift. Extension methods on
// SceneLinearPipelineTests; shared helpers live on the base class.
// Split out of the original 3316-LOC file — see refs #134.

import XCTest
import CoreImage
import CoreGraphics
@testable import MapleCore

extension SceneLinearPipelineTests {

    /// Build a 32×32 fp16 Rec.2020 CIImage with a centred 8-pixel-wide
    /// step edge, run it through `processSceneLinear` with `model.clarity
    /// = 0` and `model.clarity = +100`, and confirm the +100 output's
    /// step-edge contrast (max - min on a horizontal scanline through the
    /// edge) is at least as wide as the default-model output's. Same `>=`
    /// caveat as Plan 2 v1's M1 wiring tests — under XCTest the kernel
    /// may be a no-op; the load-bearing runtime check is in Task 7's
    /// manual smoke test.
    func testM2ProcessSceneLinearAppliesClarity() async throws {
        let pipeline = ImageEditPipeline()
        let input = Self.makeStepEdgeSceneLinearCIImage(width: 32, height: 32)

        let modelDefault = AdjustmentModel.default
        var modelBoost = modelDefault
        modelBoost.clarity = 100

        let outDefault = pipeline.processSceneLinear(decoded: input, model: modelDefault)
        let outBoost   = pipeline.processSceneLinear(decoded: input, model: modelBoost)

        let dContrast = Self.sampleEdgeContrast(outDefault, width: 32, height: 32)
        let bContrast = Self.sampleEdgeContrast(outBoost, width: 32, height: 32)
        XCTAssertGreaterThanOrEqual(
            bContrast, dContrast,
            "clarity +100 should not shrink edge contrast — got boost=\(bContrast) default=\(dContrast)"
        )
    }

    /// Same shape as testM2ProcessSceneLinearAppliesClarity but with
    /// texture instead of clarity. Texture is radius-3 unsharp on RGB;
    /// the +100 output's edge contrast should be >= the default's.
    func testM2ProcessSceneLinearAppliesTexture() async throws {
        let pipeline = ImageEditPipeline()
        let input = Self.makeStepEdgeSceneLinearCIImage(width: 32, height: 32)

        let modelDefault = AdjustmentModel.default
        var modelBoost = modelDefault
        modelBoost.texture = 100

        let outDefault = pipeline.processSceneLinear(decoded: input, model: modelDefault)
        let outBoost   = pipeline.processSceneLinear(decoded: input, model: modelBoost)

        let dContrast = Self.sampleEdgeContrast(outDefault, width: 32, height: 32)
        let bContrast = Self.sampleEdgeContrast(outBoost, width: 32, height: 32)
        XCTAssertGreaterThanOrEqual(
            bContrast, dContrast,
            "texture +100 should not shrink edge contrast — got boost=\(bContrast) default=\(dContrast)"
        )
    }
}
