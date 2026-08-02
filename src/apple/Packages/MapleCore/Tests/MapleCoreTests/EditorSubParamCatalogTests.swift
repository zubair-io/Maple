// EditorSubParamCatalogTests.swift — the sub-param CATALOG half of #1108,
// split out of EditorSubParamTests.swift to keep that file under the 570-line
// headroom gate (#2311).
//
// Covers which tools declare sub-params, in what order, which fields each one
// writes, and that ranges/defaults come from the generated schema. The
// mapping-math and arming/session-memory halves stay in EditorSubParamTests.
//
// The allowlist in `testEveryOtherToolIsSingleParam` is hand-maintained, which
// is how `.toneCurve` went missing after #367 and left `main` red (#2488) —
// `testEveryExcludedToolActuallyDeclaresSubParams` pins the inverse so a stale
// entry fails loudly instead of quietly weakening the check.

import XCTest
@testable import MapleCore

@MainActor
final class EditorSubParamCatalogTests: XCTestCase {

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

    func testColorGradeDeclaresBalanceLeadFollowedByFourWheelZones() {
        // #1111 — split tone joined the multi-param set; #275 supersedes it
        // with Color Grading: Balance leads (schema-declared primary
        // drag-bar field), followed by shadow/midtone/highlight/global
        // hue+saturation+luminance triples — 13 sub-params total.
        let subs = Tool.colorGrade.subParams
        XCTAssertEqual(subs.map(\.id), [
            "balance",
            "shadowHue", "shadowSat", "shadowLum",
            "midtoneHue", "midtoneSat", "midtoneLum",
            "highlightHue", "highlightSat", "highlightLum",
            "globalHue", "globalSat", "globalLum",
        ])
        XCTAssertTrue(Tool.colorGrade.isMultiParam)
        XCTAssertEqual(Tool.colorGrade.defaultSubParamId, "balance")
        XCTAssertEqual(subs[1].range, AdjustmentModel.splitToneShadowHueRange)
        XCTAssertEqual(subs[0].range, AdjustmentModel.splitToneBalanceRange)
        XCTAssertEqual(subs[3].range, AdjustmentModel.colorGradeShadowLuminanceRange)
        XCTAssertEqual(subs[4].range, AdjustmentModel.colorGradeMidtoneHueRange)
        XCTAssertEqual(subs[12].range, AdjustmentModel.colorGradeGlobalLuminanceRange)
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
        // Crop stays a stub. Vignette joined the multi-param set at #1109,
        // grain at #1110, color grading (superseding split tone) at
        // #1111/#275, HSL at #274, B&W Mix at #276, tone curve at #367.
        //
        // `.toneCurve` declares the four PV2012 parametric REGION sliders
        // (`ToolSubParam.swift`). Its four per-channel POINT curves are
        // deliberately NOT sub-params — a sub-param is a scalar key path by
        // construction and a curve is a point list — so this exclusion is
        // about the region sliders only, not a blanket opt-out for the tool.
        for tool in Tool.allCases
        where tool != .noise && tool != .sharpen && tool != .vignette && tool != .grain
            && tool != .colorGrade && tool != .hsl && tool != .bwMix && tool != .toneCurve {
            XCTAssertTrue(tool.subParams.isEmpty, "\(tool) should be single-param")
            XCTAssertFalse(tool.isMultiParam)
            XCTAssertNil(tool.defaultSubParamId)
        }
    }

    /// The allowlist above is hand-maintained, which is exactly how `.toneCurve`
    /// went missing when #367 gave it sub-params: the tool became multi-param and
    /// nothing forced the list to keep up, so `main` sat red (#2488).
    ///
    /// This pins the relationship the allowlist is *supposed* to express — every
    /// excluded tool must genuinely declare sub-params — so a tool that is
    /// excluded but has none (a stale entry, e.g. after a tool is simplified)
    /// now fails too, rather than silently weakening the check above.
    func testEveryExcludedToolActuallyDeclaresSubParams() {
        let excluded: [Tool] = [.noise, .sharpen, .vignette, .grain,
                                .colorGrade, .hsl, .bwMix, .toneCurve]
        for tool in excluded {
            XCTAssertFalse(tool.subParams.isEmpty,
                "\(tool) is excluded from the single-param check but declares no sub-params — "
                + "either it regained a single param, or the exclusion is stale")
            XCTAssertTrue(tool.isMultiParam, "\(tool) is excluded but isn't multi-param")
            XCTAssertNotNil(tool.defaultSubParamId, "\(tool) is excluded but has no default sub-param")
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
}
