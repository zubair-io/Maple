// DecodeStripsLocalAdjustmentsTests.swift — #3369.
//
// The RAW decode must not carry the mask stack: raw-core's develop applies
// local adjustments itself, and the live chain applies them again on the
// decoded buffer. `stripAppleGPUStages` is the one place that keeps the
// decode single-purpose, and it forgot this stage.

import XCTest

@testable import MapleCore

final class DecodeStripsLocalAdjustmentsTests: XCTestCase {
    private func modelWithMask() -> AdjustmentModel {
        var m = AdjustmentModel()
        m.localAdjustments = [
            LocalAdjustment(
                mask: .bitmap(
                    recipe: BitmapRecipe(
                        person: 0, facialSkin: true, bodySkin: true,
                        model: "apple-vision-person-instance/1", digest: "154aea553187b31c"),
                    rasterId: 7),
                range: .skinTone,
                adjustments: PartialAdjustments(exposure: 100, hue: 100))
        ]
        return m
    }

    func testStrippedModelHasNoLocalAdjustments() {
        let stripped = RawCoreBridge.stripAppleGPUStages(modelWithMask())
        XCTAssertTrue(
            stripped.localAdjustments.isEmpty,
            "the decode must not see the mask stack — the live chain owns it (#3369)")
    }

    /// The temp XMP the decode is actually handed carries no mask block, so
    /// raw-ffi has nothing to resolve by digest and raw-core's develop has
    /// nothing to apply.
    func testDecodeXMPCarriesNoMaskBlock() {
        let stripped = RawCoreBridge.stripAppleGPUStages(modelWithMask())
        let xmp = XMPSerializer.serialize(model: stripped, culling: CullingState())
        XCTAssertFalse(xmp.contains("MaskGroupBasedCorrections"), "decode XMP must not carry masks")
        XCTAssertFalse(xmp.contains("LocalExposure"), "decode XMP must not carry per-mask sliders")
    }

    /// Stripping must not disturb what the decode DOES own — the sanity
    /// check that this is a targeted strip, not a reset.
    func testStripLeavesDecodeOwnedFieldsAlone() {
        var m = modelWithMask()
        m.profile = .neutral
        let stripped = RawCoreBridge.stripAppleGPUStages(m)
        XCTAssertEqual(stripped.profile, .neutral)
    }
}
