// SceneLinearPipelineTests+WhiteBalance.swift — white balance (temperature) wired into processSceneLinear
//
// Sibling to SceneLinearPipelineTests.swift. Extension methods on
// SceneLinearPipelineTests; shared helpers live on the base class.
// Split out of the original 3316-LOC file — see refs #134.

import XCTest
import CoreImage
import CoreGraphics
@testable import MapleCore

extension SceneLinearPipelineTests {

    /// Drag the Temperature slider down to 3000 K on a neutral mid-gray
    /// pixel. The `crs:Temperature` convention: the slider VALUE is the colour
    /// temperature of the light the photo was taken under (see commit
    /// 1580228 "fix(wb): flip slider direction for temperature + tint
    /// across all 3 platforms" — moving the slider warm means "tell the
    /// renderer the source was tungsten" → the renderer applies a
    /// COOLING correction → the image goes BLUER. So R-B for the warm-
    /// slider output must be less than R-B for the 6500 K default.
    ///
    /// Same `>=` / `<=` caveat as the rest of the M-tests — under
    /// XCTest the kernel may be a no-op (no metallib / FFI early-
    /// exit), so we use `<=` rather than strict `<`. The companion
    /// runtime check is the manual smoke test in Step 6.5.
    func testM2ProcessSceneLinearAppliesTemperature() async throws {
        let pipeline = ImageEditPipeline()
        let input = Self.makeNeutralSceneLinearCIImage(width: 16, height: 16, value: 0.5)

        let modelDefault = AdjustmentModel.default
        var modelWarm = modelDefault
        modelWarm.temperature = 3000

        let outDefault = pipeline.processSceneLinear(decoded: input, model: modelDefault)
        let outWarm    = pipeline.processSceneLinear(decoded: input, model: modelWarm)

        let dRmB = Self.sampleCenterRMinusB(outDefault, width: 16, height: 16)
        let wRmB = Self.sampleCenterRMinusB(outWarm, width: 16, height: 16)
        XCTAssertLessThanOrEqual(
            wRmB, dRmB,
            "Temperature slider at 3000 K (warm-source) should COOL the image "
            + "(R-B decreases) — got warm=\(wRmB) default=\(dRmB)"
        )
    }
}
