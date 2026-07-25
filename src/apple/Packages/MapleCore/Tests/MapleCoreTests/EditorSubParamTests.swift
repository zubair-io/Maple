// EditorSubParamTests.swift — multi-param tool pills (#1108, spec §10.0).
//
// Covers:
//   • Sub-param catalog (noise → Luminance/Color, sharpen →
//     Amount/Radius/Detail/Masking; everything else single-param)
//   • Generated-schema sourcing (ranges + defaults)
//   • Internal↔display mappings, incl. FIRST-sub-param parity with the
//     tool-level `ToolValueMapping` (arming the default sub-param behaves
//     exactly like the pre-#1108 single-param pill)
//   • Arming + per-tool session memory (`ToolSubParamMemory`), incl.
//     persistence across EditorState rebuilds (image switches)
//   • Value pipe / reset acting on the armed (tool, subParam) pair
//   • Wheel-nudge burst breaking on a sub-param switch
//   • Chip value formatting
//
// Every state test injects a FRESH ToolSubParamMemory — the `.shared`
// default is app-session state and must not leak across tests.

import XCTest
@testable import MapleCore

@MainActor
final class EditorSubParamTests: XCTestCase {
    /// Builds a state over a FRESH memory unless one is supplied (the
    /// `nil` sentinel sidesteps Swift 6's nonisolated default-arg rule
    /// for the MainActor `ToolSubParamMemory()` initializer).
    private func makeState(memory: ToolSubParamMemory? = nil) -> EditorState {
        EditorState(
            session: EditSession.preview(),
            subParamMemory: memory ?? ToolSubParamMemory()
        )
    }

    // MARK: - Catalog

    func testNoiseDeclaresLuminanceColorDeepPrefilter() {
        // #1153 — Deep (BM3D, §3.2) and Prefilter (§3.1) joined the Noise
        // pill. Order follows spec §10.0.
        let subs = Tool.noise.subParams
        XCTAssertEqual(subs.map(\.id), ["luminance", "color", "deep", "prefilter"])
        XCTAssertEqual(subs.map(\.label), ["Luminance", "Color", "Deep", "Prefilter"])
        XCTAssertTrue(Tool.noise.isMultiParam)
        XCTAssertEqual(Tool.noise.defaultSubParamId, "luminance")
        XCTAssertEqual(subs[2].range, AdjustmentModel.deepDenoiseRange)
        XCTAssertEqual(subs[3].range, AdjustmentModel.chromaPrefilterRange)
        // Both tiers ship OFF (spec §3.1 / §3.2 default 0).
        XCTAssertEqual(subs[2].defaultDisplayValue, AdjustmentModel().deepDenoise)
        XCTAssertEqual(subs[3].defaultDisplayValue, AdjustmentModel().chromaPrefilter)
    }

    func testOnlyDecodeProductNoiseTiersCommitOnRelease() {
        // The decode-product pair defers its write; every other sub-param on
        // every tool stays on the per-tick path.
        let deferred = Tool.allCases
            .flatMap { tool in
                tool.subParams.filter(\.commitsOnRelease).map { "\(tool.rawValue).\($0.id)" }
            }
        XCTAssertEqual(deferred, ["noise.deep", "noise.prefilter"])
        XCTAssertFalse(Tool.noise.subParams[0].commitsOnRelease)
        XCTAssertFalse(Tool.noise.subParams[1].commitsOnRelease)
    }

    func testSharpenDeclaresAmountRadiusDetailMasking() {
        let subs = Tool.sharpen.subParams
        XCTAssertEqual(subs.map(\.id), ["amount", "radius", "detail", "masking"])
        XCTAssertEqual(Tool.sharpen.defaultSubParamId, "amount")
    }

    func testVignetteDeclaresAmountAndFeather() {
        // #1109 — vignette joined the multi-param set: Amount is the
        // drag-bar default; Feather rides the sub-param row.
        let subs = Tool.vignette.subParams
        XCTAssertEqual(subs.map(\.id), ["amount", "feather"])
        XCTAssertEqual(subs.map(\.label), ["Amount", "Feather"])
        XCTAssertTrue(Tool.vignette.isMultiParam)
        XCTAssertEqual(Tool.vignette.defaultSubParamId, "amount")
        XCTAssertEqual(subs[0].range, AdjustmentModel.vignetteAmountRange)
        XCTAssertEqual(subs[1].range, AdjustmentModel.vignetteFeatherRange)
        XCTAssertEqual(subs[1].defaultDisplayValue, AdjustmentModel().vignetteFeather)
    }

    func testGrainDeclaresAmountSizeRoughness() {
        // #1110 — grain joined the multi-param set: Amount is the
        // drag-bar default; Size / Roughness ride the sub-param row.
        let subs = Tool.grain.subParams
        XCTAssertEqual(subs.map(\.id), ["amount", "size", "roughness"])
        XCTAssertEqual(subs.map(\.label), ["Amount", "Size", "Roughness"])
        XCTAssertTrue(Tool.grain.isMultiParam)
        XCTAssertEqual(Tool.grain.defaultSubParamId, "amount")
        XCTAssertEqual(subs[1].range, AdjustmentModel.grainSizeRange)
        XCTAssertEqual(subs[1].defaultDisplayValue, AdjustmentModel().grainSize)
        XCTAssertEqual(subs[2].defaultDisplayValue, AdjustmentModel().grainRoughness)
    }

    func testSplitToneDeclaresBalanceAndHueSatPairs() {
        // #1111 — split tone joined the multi-param set. Balance leads:
        // it is the schema-declared primary drag-bar field.
        let subs = Tool.splitTone.subParams
        XCTAssertEqual(subs.map(\.id),
                       ["balance", "shadowHue", "shadowSat", "highlightHue", "highlightSat"])
        XCTAssertTrue(Tool.splitTone.isMultiParam)
        XCTAssertEqual(Tool.splitTone.defaultSubParamId, "balance")
        XCTAssertEqual(subs[1].range, AdjustmentModel.splitToneShadowHueRange)
        XCTAssertEqual(subs[0].range, AdjustmentModel.splitToneBalanceRange)
    }

    func testHSLDeclaresTwentyFourSubParamsChannelMajor() {
        // #274 — HSL joined the multi-param set with Hue/Sat/Lum × 8
        // bands, declared channel-major so the ids match the web catalog
        // in `tool-sub-param.ts` one for one.
        let subs = Tool.hsl.subParams
        XCTAssertEqual(subs.count, 24)
        XCTAssertTrue(Tool.hsl.isMultiParam)
        XCTAssertEqual(Tool.hsl.defaultSubParamId, "hueRed")
        XCTAssertEqual(subs.prefix(8).map(\.id),
                       ["hueRed", "hueOrange", "hueYellow", "hueGreen",
                        "hueAqua", "hueBlue", "huePurple", "hueMagenta"])
        XCTAssertEqual(subs.dropFirst(8).prefix(8).map(\.id),
                       ["satRed", "satOrange", "satYellow", "satGreen",
                        "satAqua", "satBlue", "satPurple", "satMagenta"])
        XCTAssertEqual(subs.suffix(8).map(\.id),
                       ["lumRed", "lumOrange", "lumYellow", "lumGreen",
                        "lumAqua", "lumBlue", "lumPurple", "lumMagenta"])
        XCTAssertEqual(subs.prefix(8).map(\.label),
                       ["H Red", "H Orange", "H Yellow", "H Green",
                        "H Aqua", "H Blue", "H Purple", "H Magenta"])
        // All 24 are symmetric ±100 with a 0 default (the generated
        // schema's ranges), so all take the anchored mapping.
        for sub in subs {
            XCTAssertEqual(sub.range, AdjustmentModel.hueAdjustmentRedRange)
            XCTAssertEqual(sub.defaultDisplayValue, 0)
            XCTAssertEqual(sub.mapping, .anchored)
            XCTAssertEqual(sub.decimals, 0)
        }
    }

    func testHSLSubParamsWriteTheirOwnBandField() {
        // Each of the 24 descriptors must drive a DISTINCT model field —
        // a copy-paste slip in the band table would otherwise route two
        // bands at the same slider.
        var model = AdjustmentModel()
        let subs = Tool.hsl.subParams
        for (index, sub) in subs.enumerated() {
            model[keyPath: sub.keyPath] = Double(index + 1)
        }
        for (index, sub) in subs.enumerated() {
            XCTAssertEqual(model[keyPath: sub.keyPath], Double(index + 1),
                "\(sub.id) shares a field with another band")
        }
    }

    func testEveryOtherToolIsSingleParam() {
        // Crop stays a stub. Vignette joined the multi-param set at
        // #1109, grain at #1110, split tone at #1111, HSL at #274, B&W
        // Mix at #276.
        for tool in Tool.allCases
        where tool != .noise && tool != .sharpen && tool != .vignette && tool != .grain
            && tool != .splitTone && tool != .hsl && tool != .bwMix {
            XCTAssertTrue(tool.subParams.isEmpty, "\(tool) should be single-param")
            XCTAssertFalse(tool.isMultiParam)
            XCTAssertNil(tool.defaultSubParamId)
        }
    }

    func testBwMixDeclaresEightBands() {
        // #276 — B&W Mix joined the multi-param set: the drag bar drives
        // grayMixerRed (first sub-param); the other seven bands ride the
        // sub-param row, in the same order as the HSL bands (#274).
        let subs = Tool.bwMix.subParams
        XCTAssertEqual(subs.map(\.id),
                       ["red", "orange", "yellow", "green", "aqua", "blue", "purple", "magenta"])
        XCTAssertEqual(subs.map(\.label),
                       ["Red", "Orange", "Yellow", "Green", "Aqua", "Blue", "Purple", "Magenta"])
        // B&W and HSL are two modes of ONE 8-band kernel, so their band
        // ids must stay in lockstep with the shared `HSLBand.all` table
        // (raw-core's `HUE_CENTERS_DEG` order) — the pipeline indexes both
        // by position.
        XCTAssertEqual(subs.map(\.id), HSLBand.all.map(\.id))
        XCTAssertEqual(subs.map(\.label), HSLBand.all.map(\.label))
        XCTAssertTrue(Tool.bwMix.isMultiParam)
        XCTAssertEqual(Tool.bwMix.defaultSubParamId, "red")
        XCTAssertEqual(subs[0].range, AdjustmentModel.grayMixerRedRange)
        XCTAssertEqual(subs[7].range, AdjustmentModel.grayMixerMagentaRange)
        for sub in subs {
            XCTAssertEqual(sub.defaultDisplayValue, 0, accuracy: 1e-9)
        }
    }

    func testRangesAndDefaultsComeFromTheGeneratedSchema() {
        let byId = Dictionary(uniqueKeysWithValues: Tool.sharpen.subParams.map { ($0.id, $0) })
        XCTAssertEqual(byId["amount"]?.range, AdjustmentModel.sharpenAmountRange)
        XCTAssertEqual(byId["radius"]?.range, AdjustmentModel.sharpenRadiusRange)
        XCTAssertEqual(byId["detail"]?.range, AdjustmentModel.sharpenDetailRange)
        XCTAssertEqual(byId["masking"]?.range, AdjustmentModel.sharpenMaskingRange)

        let defaults = AdjustmentModel()
        XCTAssertEqual(byId["amount"]?.defaultDisplayValue, defaults.sharpenAmount)
        XCTAssertEqual(byId["radius"]?.defaultDisplayValue, defaults.sharpenRadius)
        XCTAssertEqual(byId["detail"]?.defaultDisplayValue, defaults.sharpenDetail)
        XCTAssertEqual(byId["masking"]?.defaultDisplayValue, defaults.sharpenMasking)

        let noise = Dictionary(uniqueKeysWithValues: Tool.noise.subParams.map { ($0.id, $0) })
        XCTAssertEqual(noise["luminance"]?.range, AdjustmentModel.nrLuminanceRange)
        XCTAssertEqual(noise["color"]?.range, AdjustmentModel.nrColorRange)
        XCTAssertEqual(noise["luminance"]?.defaultDisplayValue, defaults.nrLuminance)
        XCTAssertEqual(noise["color"]?.defaultDisplayValue, defaults.nrColor)
    }

    // MARK: - Mapping math

    func testAnchoredMappingPivotsOnTheCanonicalDefault() {
        let amount = Tool.sharpen.subParams[0]
        XCTAssertEqual(amount.displayValue(internalValue: 0), 40, accuracy: 1e-9)
        XCTAssertEqual(amount.displayValue(internalValue: 100), 150, accuracy: 1e-9)
        XCTAssertEqual(amount.displayValue(internalValue: -100), 0, accuracy: 1e-9)
        XCTAssertEqual(amount.internalValue(displayValue: 40), 0, accuracy: 1e-9)
        XCTAssertEqual(amount.internalValue(displayValue: 150), 100, accuracy: 1e-9)

        let radius = Tool.sharpen.subParams[1]
        XCTAssertEqual(radius.displayValue(internalValue: 0), 1.0, accuracy: 1e-9)
        XCTAssertEqual(radius.displayValue(internalValue: 100), 3.0, accuracy: 1e-9)
        XCTAssertEqual(radius.displayValue(internalValue: -100), 0.5, accuracy: 1e-9)
        XCTAssertEqual(radius.internalValue(displayValue: 1.0), 0, accuracy: 1e-9)
    }

    func testLinearMappingIsAffineOntoTheRange() {
        let detail = Tool.sharpen.subParams[2]
        XCTAssertEqual(detail.displayValue(internalValue: -100), 0, accuracy: 1e-9)
        XCTAssertEqual(detail.displayValue(internalValue: 0), 50, accuracy: 1e-9)
        XCTAssertEqual(detail.displayValue(internalValue: 100), 100, accuracy: 1e-9)
        XCTAssertEqual(detail.internalValue(displayValue: 25), -50, accuracy: 1e-9)
    }

    func testFirstSubParamMappingMatchesToolLevelMapping() {
        // Pre-#1108 parity: arming the default sub-param must behave
        // exactly like the single-param pill did (noise ≡ nrLuminance,
        // sharpen ≡ sharpenAmount).
        let lum = Tool.noise.subParams[0]
        let amount = Tool.sharpen.subParams[0]
        for v in [-100.0, -50, -7, 0, 13, 50, 100] {
            XCTAssertEqual(
                lum.displayValue(internalValue: v),
                ToolValueMapping.displayValue(for: .noise, internalValue: v),
                accuracy: 1e-9
            )
            XCTAssertEqual(
                amount.displayValue(internalValue: v),
                ToolValueMapping.displayValue(for: .sharpen, internalValue: v),
                accuracy: 1e-9
            )
        }
    }

    func testMappingRoundTripsForEveryDeclaredSubParam() {
        for tool in [Tool.noise, .sharpen] {
            for sub in tool.subParams {
                for v in [-100.0, -50, 0, 50, 100] {
                    let d = sub.displayValue(internalValue: v)
                    XCTAssertEqual(sub.internalValue(displayValue: d), v, accuracy: 1e-6)
                }
            }
        }
    }

    // MARK: - Arming + session memory

    func testArmingMultiParamToolDefaultsToFirstSubParam() {
        let state = makeState()
        state.arm(tool: .noise)
        XCTAssertEqual(state.armedSubParamId, "luminance")
        state.arm(tool: .sharpen)
        XCTAssertEqual(state.armedSubParamId, "amount")
    }

    func testSingleParamToolCarriesNoArmedSubParam() {
        let state = makeState()
        state.arm(tool: .exposure)
        XCTAssertNil(state.armedSubParamId)
        XCTAssertNil(state.armedSubParam)
        XCTAssertTrue(state.armedSubParams.isEmpty)
    }

    func testArmSubParamRoutesTheValuePipe() {
        let state = makeState()
        state.arm(tool: .noise)
        state.arm(subParamId: "color")
        XCTAssertEqual(state.armedSubParamId, "color")

        state.setArmedDisplayValue(60)
        XCTAssertEqual(state.session.model.nrColor, 60, accuracy: 1e-9)
        // The sibling sub-param is untouched.
        XCTAssertEqual(state.session.model.nrLuminance, 0, accuracy: 1e-9)
        XCTAssertEqual(state.armedDisplayValue, 60, accuracy: 1e-9)
    }

    func testInternalValuesMapThroughTheArmedSubParam() {
        let state = makeState()
        state.arm(tool: .sharpen)
        state.arm(subParamId: "radius")
        state.setArmedInternalValue(100)
        XCTAssertEqual(state.session.model.sharpenRadius, 3.0, accuracy: 1e-9)
        state.setArmedInternalValue(-100)
        XCTAssertEqual(state.session.model.sharpenRadius, 0.5, accuracy: 1e-9)
        state.setArmedInternalValue(0)
        XCTAssertEqual(state.session.model.sharpenRadius, 1.0, accuracy: 1e-9)
        XCTAssertEqual(state.armedInternalValue, 0, accuracy: 1e-9)
    }

    func testResetActsOnTheArmedSubParamOnly() {
        let state = makeState()
        state.arm(tool: .noise)
        state.setArmedDisplayValue(80) // luminance = 80
        state.arm(subParamId: "color")
        state.setArmedDisplayValue(90) // color = 90
        state.resetArmedTool()
        XCTAssertEqual(state.session.model.nrColor, 25, accuracy: 1e-9) // canonical default
        XCTAssertEqual(state.session.model.nrLuminance, 80, accuracy: 1e-9) // untouched
        // Reset snapshots first — undo restores the pre-reset color.
        state.undo()
        XCTAssertEqual(state.session.model.nrColor, 90, accuracy: 1e-9)
    }

    func testSubParamSelectionPersistsAcrossToolSwitches() {
        let state = makeState()
        state.arm(tool: .noise)
        state.arm(subParamId: "color")
        state.arm(tool: .exposure)
        state.arm(tool: .noise)
        XCTAssertEqual(state.armedSubParamId, "color")
    }

    func testSubParamSelectionPersistsAcrossEditorStateRebuilds() {
        // Both hosts rebuild EditorState per asset; the session memory is
        // the carrier (NOT XMP, not cm.*) so an image switch keeps the
        // selection.
        let memory = ToolSubParamMemory()
        let first = makeState(memory: memory)
        first.arm(tool: .sharpen)
        first.arm(subParamId: "detail")

        let second = makeState(memory: memory)
        second.arm(tool: .sharpen)
        XCTAssertEqual(second.armedSubParamId, "detail")
    }

    func testUndeclaredSubParamIdsAreIgnored() {
        let state = makeState()
        state.arm(tool: .noise)
        state.arm(subParamId: "bogus")
        XCTAssertEqual(state.armedSubParamId, "luminance")
        state.arm(tool: .exposure)
        state.arm(subParamId: "luminance")
        XCTAssertNil(state.armedSubParamId)
    }

    func testAcceptsValueEditsIsSubParamAware() {
        let state = makeState()
        for tool in [Tool.noise, .sharpen] {
            state.arm(tool: tool)
            XCTAssertTrue(state.armedToolAcceptsValueEdits, "\(tool) should accept value edits")
        }
    }

    // MARK: - Wheel nudge burst × sub-params

    func testWheelNudgeSubParamSwitchWithinWindowStartsNewBurst() {
        // Mirrors the #1125 tool-switch rule: Luminance → Color within
        // the 0.5 s window must land in SEPARATE undo snapshots.
        let state = makeState()
        let t0 = Date()
        state.arm(tool: .noise) // luminance armed
        state.wheelNudge(steps: 5, unit: 1, at: t0)
        let lumAfterNudge = state.session.model.nrLuminance
        state.arm(subParamId: "color")
        state.wheelNudge(steps: 3, unit: 1, at: t0.addingTimeInterval(0.1))
        let colorAfterNudge = state.session.model.nrColor
        XCTAssertNotEqual(lumAfterNudge, 0)
        XCTAssertNotEqual(colorAfterNudge, 25)
        // First undo unwinds ONLY the color nudge…
        state.undo()
        XCTAssertEqual(state.session.model.nrColor, 25, accuracy: 1e-9)
        XCTAssertEqual(state.session.model.nrLuminance, lumAfterNudge, accuracy: 1e-9)
        // …second undo unwinds the luminance burst.
        state.undo()
        XCTAssertEqual(state.session.model.nrLuminance, 0, accuracy: 1e-9)
        XCTAssertFalse(state.canUndo)
    }

    // MARK: - Commit on release (#1153)

    func testCommitOnReleaseSubParamWritesOncePerGesture() {
        let state = makeState()
        state.arm(tool: .noise)
        state.arm(subParamId: "deep")
        XCTAssertTrue(state.armedCommitsOnRelease)

        state.beginGesture()
        // 40 drag samples — the shape a real drag produces.
        for i in 1...40 { state.setArmedDisplayValue(Double(i)) }
        // The model (and therefore the decoded-buffer cache key) has NOT moved…
        XCTAssertEqual(state.session.model.deepDenoise, 0, accuracy: 1e-9)
        // …but the slider tracks the finger.
        XCTAssertEqual(state.armedDisplayValue, 40, accuracy: 1e-9)
        XCTAssertEqual(state.deferredDisplayValue, 40)

        state.endGesture()
        XCTAssertEqual(state.session.model.deepDenoise, 40, accuracy: 1e-9)
        XCTAssertNil(state.deferredDisplayValue)
    }

    func testPrefilterDefersWhileTheNlmTiersWriteThrough() {
        let state = makeState()
        state.arm(tool: .noise)
        state.arm(subParamId: "prefilter")
        state.beginGesture()
        for i in 1...10 { state.setArmedDisplayValue(Double(i)) }
        XCTAssertEqual(state.session.model.chromaPrefilter, 0, accuracy: 1e-9)
        state.endGesture()
        XCTAssertEqual(state.session.model.chromaPrefilter, 10, accuracy: 1e-9)

        state.arm(subParamId: "luminance")
        XCTAssertFalse(state.armedCommitsOnRelease)
        state.beginGesture()
        for i in 1...10 { state.setArmedDisplayValue(Double(i)) }
        // Per-tick tools are untouched: the value lands immediately.
        XCTAssertEqual(state.session.model.nrLuminance, 10, accuracy: 1e-9)
        state.endGesture()
        XCTAssertEqual(state.session.model.nrLuminance, 10, accuracy: 1e-9)
    }

    func testCancelledOrReArmedGestureDropsTheDeferredValue() {
        let state = makeState()
        state.arm(tool: .noise)
        state.arm(subParamId: "deep")
        state.beginGesture()
        state.setArmedDisplayValue(70)
        state.cancelGesture()
        XCTAssertEqual(state.session.model.deepDenoise, 0, accuracy: 1e-9)

        state.beginGesture()
        state.setArmedDisplayValue(55)
        state.arm(subParamId: "color") // arming elsewhere mid-gesture
        state.endGesture()
        XCTAssertEqual(state.session.model.deepDenoise, 0, accuracy: 1e-9)
        XCTAssertEqual(state.session.model.nrColor, 25, accuracy: 1e-9)
    }

    func testBeginGestureIsIdempotentAndKeepsTheParkedValue() {
        // `LivingSliderRow` has no drag-start hook and opens the gesture from
        // its value setter, so a repeated begin must not discard the value.
        let state = makeState()
        state.arm(tool: .noise)
        state.arm(subParamId: "deep")
        state.beginGesture()
        state.setArmedDisplayValue(30)
        state.beginGesture()
        XCTAssertEqual(state.deferredDisplayValue, 30)
        state.endGesture()
        XCTAssertEqual(state.session.model.deepDenoise, 30, accuracy: 1e-9)
    }

    func testWheelDetentsParkThenFlushOnceTheBurstStops() async throws {
        // A wheel has no release event, so a burst of detents would otherwise
        // kick one re-decode each. The value parks and lands once, on idle.
        let state = makeState()
        state.arm(tool: .noise)
        state.arm(subParamId: "deep")
        let t0 = Date()
        for i in 0..<20 {
            state.wheelNudge(steps: 1, unit: 1, at: t0.addingTimeInterval(Double(i) * 0.01))
        }
        XCTAssertEqual(state.session.model.deepDenoise, 0, accuracy: 1e-9)
        XCTAssertNotNil(state.deferredDisplayValue)
        let parked = try XCTUnwrap(state.deferredDisplayValue)
        XCTAssertGreaterThan(parked, 0)

        try await Task.sleep(for: .milliseconds(500))
        XCTAssertEqual(state.session.model.deepDenoise, parked, accuracy: 1e-9)
        XCTAssertNil(state.deferredDisplayValue)
    }

    func testResetWritesThroughForACommitOnReleaseSubParam() {
        let state = makeState()
        state.arm(tool: .noise)
        state.arm(subParamId: "deep")
        state.beginGesture()
        state.setArmedDisplayValue(60)
        state.endGesture()
        XCTAssertEqual(state.session.model.deepDenoise, 60, accuracy: 1e-9)
        state.resetArmedTool()
        XCTAssertEqual(state.session.model.deepDenoise, 0, accuracy: 1e-9)
    }

    // MARK: - Chip formatting

    func testFormatIsUnsignedForOneSidedRangesAndKeepsDecimals() {
        let detail = Tool.sharpen.subParams[2]
        XCTAssertEqual(detail.format(35), "35")
        let radius = Tool.sharpen.subParams[1]
        XCTAssertEqual(radius.format(1.0), "1.0")
        XCTAssertEqual(radius.format(2.34), "2.3")
        // Rounding never emits a negative zero.
        XCTAssertEqual(radius.format(-0.04), "0.0")
    }
}
