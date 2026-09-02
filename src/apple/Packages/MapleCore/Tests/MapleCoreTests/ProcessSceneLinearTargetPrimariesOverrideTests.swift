// ProcessSceneLinearTargetPrimariesOverrideTests.swift — #3190 review
// follow-up.
//
// `FilmLookCube` (like the Auto Profile cube) is baked/fit assuming an
// sRGB-gamma-encoded input. Before this fix, `processSceneLinear` /
// `processSceneLinearNonRaw` derived their encode's target primaries
// purely from `profileLUT != nil ? .srgb : CanvasColorSpace.current`, with
// no way for a caller compositing a film-look cube afterward to pin the
// encode to sRGB — so a P3 canvas + an active film look + `Profile::Neutral`
// would hand the cube P3-gamma bytes it silently misinterpreted as
// sRGB-gamma. `targetPrimariesOverride` closes that gap. This file locks
// in the override actually taking effect, independent of the canvas
// setting — fixture-free (a synthetic 16x16 scene-linear CIImage), runs
// everywhere.

import CoreImage
import XCTest
@testable import MapleCore

final class ProcessSceneLinearTargetPrimariesOverrideTests: XCTestCase {

    private func withCanvasColorSpace(_ cs: CanvasColorSpace, _ body: () -> Void) {
        let saved = UserDefaults.standard.object(forKey: CanvasColorSpace.defaultsKey)
        UserDefaults.standard.set(cs.rawValue, forKey: CanvasColorSpace.defaultsKey)
        defer {
            if let saved {
                UserDefaults.standard.set(saved, forKey: CanvasColorSpace.defaultsKey)
            } else {
                UserDefaults.standard.removeObject(forKey: CanvasColorSpace.defaultsKey)
            }
        }
        body()
    }

    func testTargetPrimariesOverrideSRGBWinsOverP3Canvas() throws {
        let pipeline = ImageEditPipeline()
        let input = SceneLinearPipelineTests.makeNeutralSceneLinearCIImage(
            width: 16, height: 16, value: 0.5
        )

        withCanvasColorSpace(.displayP3) {
            // No override, no Auto Profile cube: honors the P3 canvas —
            // this is the exact behavior #3190 introduced.
            let noOverride = pipeline.processSceneLinear(
                decoded: input, model: AdjustmentModel.default
            )
            XCTAssertEqual(
                noOverride.colorSpace?.name as String?,
                CGColorSpace.displayP3 as String,
                "no override + P3 canvas + no profile LUT must encode Display P3"
            )

            // Override to sRGB (what a caller compositing an active film
            // look must pass): must win over the P3 canvas setting.
            let overridden = pipeline.processSceneLinear(
                decoded: input, model: AdjustmentModel.default,
                targetPrimariesOverride: .srgb
            )
            XCTAssertEqual(
                overridden.colorSpace?.name as String?,
                CGColorSpace.sRGB as String,
                "targetPrimariesOverride: .srgb must win over the P3 canvas setting"
            )
        }
    }

    func testNonRawTargetPrimariesOverrideSRGBWinsOverP3Canvas() throws {
        let pipeline = ImageEditPipeline()
        let input = SceneLinearPipelineTests.makeNeutralSceneLinearCIImage(
            width: 16, height: 16, value: 0.5
        )

        withCanvasColorSpace(.displayP3) {
            let noOverride = pipeline.processSceneLinearNonRaw(
                decoded: input, model: AdjustmentModel.default
            )
            XCTAssertEqual(
                noOverride.colorSpace?.name as String?,
                CGColorSpace.displayP3 as String,
                "non-RAW: no override + P3 canvas must encode Display P3"
            )

            let overridden = pipeline.processSceneLinearNonRaw(
                decoded: input, model: AdjustmentModel.default,
                targetPrimariesOverride: .srgb
            )
            XCTAssertEqual(
                overridden.colorSpace?.name as String?,
                CGColorSpace.sRGB as String,
                "non-RAW: targetPrimariesOverride: .srgb must win over the P3 canvas setting"
            )
        }
    }
}
