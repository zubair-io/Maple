// DecodeStripsDefringeTests.swift — #3411.
//
// The two halves of the profile-free lens corrections sit on opposite sides
// of the decode boundary, and `stripAppleGPUStages` is the only place that
// says so:
//
//   * the six `defringe*` values drive a PER-TICK stage that raw-core's
//     develop applies AND the live chain re-applies on the decoded buffer,
//     so leaving them in the decode model would desaturate every fringe
//     twice;
//   * `autoLateralCa` drives a RAW-DOMAIN stage with no per-tick twin, so
//     it must survive — stripping it would mean the correction never runs
//     at all, and the #950 baked-model cache key would stop re-decoding
//     when the user toggles it.
//
// The strip is written as `m.field = d.field` against a canonical
// `AdjustmentModel()`, which reads as a copy but assigns the DEFAULT. That
// idiom is easy to misread (a review of #3411 did), so these tests pin the
// observable behaviour rather than the spelling: whatever the assignment
// looks like, the stripped model must carry the defaults for the six
// per-tick values and the user's own choice for the decode-product one.

import XCTest

@testable import MapleCore

final class DecodeStripsDefringeTests: XCTestCase {
    /// Every defringe control moved well off its default, so a strip that
    /// silently copied the input instead of resetting it would be visible.
    private func authored() -> AdjustmentModel {
        var m = AdjustmentModel()
        m.defringePurpleAmount = 17
        m.defringePurpleHueLo = 12
        m.defringePurpleHueHi = 88
        m.defringeGreenAmount = 9
        m.defringeGreenHueLo = 21
        m.defringeGreenHueHi = 77
        m.autoLateralCa = .on
        return m
    }

    func testDefringeIsStrippedToItsCanonicalDefaults() {
        let stripped = RawCoreBridge.stripAppleGPUStages(authored())
        let defaults = AdjustmentModel()
        XCTAssertEqual(stripped.defringePurpleAmount, defaults.defringePurpleAmount)
        XCTAssertEqual(stripped.defringePurpleHueLo, defaults.defringePurpleHueLo)
        XCTAssertEqual(stripped.defringePurpleHueHi, defaults.defringePurpleHueHi)
        XCTAssertEqual(stripped.defringeGreenAmount, defaults.defringeGreenAmount)
        XCTAssertEqual(stripped.defringeGreenHueLo, defaults.defringeGreenHueLo)
        XCTAssertEqual(stripped.defringeGreenHueHi, defaults.defringeGreenHueHi)
    }

    /// The amounts specifically must land on zero — that is what makes the
    /// decode's own `defringe` stage short-circuit, so the per-tick chain is
    /// the single application.
    func testStrippedDefringeAmountsAreZeroSoTheDecodeStageSkips() {
        let stripped = RawCoreBridge.stripAppleGPUStages(authored())
        XCTAssertEqual(stripped.defringePurpleAmount, 0)
        XCTAssertEqual(stripped.defringeGreenAmount, 0)
    }

    /// The decode-product half is the opposite case and must survive.
    func testAutoLateralCaSurvivesTheStrip() {
        XCTAssertEqual(RawCoreBridge.stripAppleGPUStages(authored()).autoLateralCa, .on)
        var off = authored()
        off.autoLateralCa = .off
        XCTAssertEqual(RawCoreBridge.stripAppleGPUStages(off).autoLateralCa, .off)
    }

    /// Because it survives, it also stays part of the #950 baked-model decode
    /// cache key: two models differing only in `autoLateralCa` must not strip
    /// to the same thing, or toggling it would reuse a stale decode.
    func testTogglingAutoLateralCaChangesTheStrippedDecodeModel() {
        var on = authored()
        on.autoLateralCa = .on
        var off = authored()
        off.autoLateralCa = .off
        XCTAssertNotEqual(
            RawCoreBridge.stripAppleGPUStages(on), RawCoreBridge.stripAppleGPUStages(off),
            "autoLateralCa must remain part of the decode identity")
    }

    /// The mirror of the above for the per-tick half: two models differing
    /// ONLY in defringe must strip to the SAME decode model, so changing a
    /// defringe slider is a live re-render and never a re-decode.
    func testChangingDefringeAloneDoesNotChangeTheDecodeModel() {
        let plain = AdjustmentModel()
        var fringed = AdjustmentModel()
        fringed.defringePurpleAmount = 20
        fringed.defringeGreenHueHi = 99
        XCTAssertEqual(
            RawCoreBridge.stripAppleGPUStages(plain), RawCoreBridge.stripAppleGPUStages(fringed),
            "a defringe edit must not invalidate the decode")
    }
}
