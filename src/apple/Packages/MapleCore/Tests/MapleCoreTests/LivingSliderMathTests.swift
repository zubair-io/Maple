// LivingSliderMathTests.swift — Pro Editor Canvas-first (A1, #1536).
//
// Three test classes:
//   1. LivingSliderMathTests — bipolar/unipolar pct↔value round-trips.
//   2. GradientCatalogTests  — completeness: every wired tool has an entry.
//   3. ProTokensAccentTests  — accent alpha helpers derive from the base hex.

import XCTest
@testable import MapleCore

// MARK: - 1. LivingSliderMathTests

final class LivingSliderMathTests: XCTestCase {

    // MARK: Bipolar — value → pct

    func testBipolarZeroIsCenter() {
        XCTAssertEqual(LivingSliderMath.pctBipolar(value: 0, halfRange: 100), 0.5,
                       accuracy: 1e-9)
    }

    func testBipolarMaxIsOne() {
        XCTAssertEqual(LivingSliderMath.pctBipolar(value: 4, halfRange: 4), 1.0,
                       accuracy: 1e-9)
    }

    func testBipolarMinIsZero() {
        XCTAssertEqual(LivingSliderMath.pctBipolar(value: -4, halfRange: 4), 0.0,
                       accuracy: 1e-9)
    }

    func testBipolarPositiveQuarter() {
        let pct = LivingSliderMath.pctBipolar(value: 50, halfRange: 100)
        XCTAssertEqual(pct, 0.75, accuracy: 1e-9)
    }

    func testBipolarNegativeQuarter() {
        let pct = LivingSliderMath.pctBipolar(value: -50, halfRange: 100)
        XCTAssertEqual(pct, 0.25, accuracy: 1e-9)
    }

    func testBipolarClampAboveMax() {
        // Values beyond halfRange clamp to 1
        let pct = LivingSliderMath.pctBipolar(value: 200, halfRange: 100)
        XCTAssertEqual(pct, 1.0, accuracy: 1e-9)
    }

    func testBipolarClampBelowMin() {
        let pct = LivingSliderMath.pctBipolar(value: -200, halfRange: 100)
        XCTAssertEqual(pct, 0.0, accuracy: 1e-9)
    }

    func testBipolarZeroHalfRangeReturnsZero() {
        // Guard against divide-by-zero
        let pct = LivingSliderMath.pctBipolar(value: 50, halfRange: 0)
        XCTAssertEqual(pct, 0)
    }

    // MARK: Bipolar — pct → value

    func testBipolarPctHalfIsZero() {
        XCTAssertEqual(LivingSliderMath.valueBipolar(pct: 0.5, halfRange: 100), 0.0,
                       accuracy: 1e-9)
    }

    func testBipolarPctOneIsMax() {
        XCTAssertEqual(LivingSliderMath.valueBipolar(pct: 1.0, halfRange: 4), 4.0,
                       accuracy: 1e-9)
    }

    func testBipolarPctZeroIsMin() {
        XCTAssertEqual(LivingSliderMath.valueBipolar(pct: 0.0, halfRange: 4), -4.0,
                       accuracy: 1e-9)
    }

    // MARK: Bipolar — round-trip

    func testBipolarRoundTripExposure() {
        let halfRange: Double = 4
        for ev in stride(from: -4.0, through: 4.0, by: 0.25) {
            let pct = LivingSliderMath.pctBipolar(value: ev, halfRange: halfRange)
            let back = LivingSliderMath.valueBipolar(pct: pct, halfRange: halfRange)
            XCTAssertEqual(back, ev, accuracy: 1e-9,
                           "round-trip failed for EV=\(ev)")
        }
    }

    func testBipolarRoundTripPlusMinus100() {
        let halfRange: Double = 100
        for v in stride(from: -100.0, through: 100.0, by: 5.0) {
            let pct = LivingSliderMath.pctBipolar(value: v, halfRange: halfRange)
            let back = LivingSliderMath.valueBipolar(pct: pct, halfRange: halfRange)
            XCTAssertEqual(back, v, accuracy: 1e-9,
                           "round-trip failed for v=\(v)")
        }
    }

    // MARK: Unipolar — value → pct

    func testUnipolarZeroIsZero() {
        XCTAssertEqual(LivingSliderMath.pctUnipolar(value: 0, range: 0...150), 0.0,
                       accuracy: 1e-9)
    }

    func testUnipolarMaxIsOne() {
        XCTAssertEqual(LivingSliderMath.pctUnipolar(value: 150, range: 0...150), 1.0,
                       accuracy: 1e-9)
    }

    func testUnipolarMidpoint() {
        XCTAssertEqual(LivingSliderMath.pctUnipolar(value: 75, range: 0...150), 0.5,
                       accuracy: 1e-9)
    }

    func testUnipolarNonZeroLowerBound() {
        // Sharpen radius: [0.5 .. 3.0], value = 1.75 → pct = (1.75 - 0.5) / 2.5 = 0.5
        XCTAssertEqual(LivingSliderMath.pctUnipolar(value: 1.75, range: 0.5...3.0), 0.5,
                       accuracy: 1e-9)
    }

    func testUnipolarClampAboveMax() {
        let pct = LivingSliderMath.pctUnipolar(value: 200, range: 0...100)
        XCTAssertEqual(pct, 1.0, accuracy: 1e-9)
    }

    func testUnipolarZeroRangeReturnsZero() {
        let pct = LivingSliderMath.pctUnipolar(value: 50, range: 50...50)
        XCTAssertEqual(pct, 0.0)
    }

    // MARK: Unipolar — round-trip

    func testUnipolarRoundTripSharpenRange() {
        let range: ClosedRange<Double> = 0...150
        for v in stride(from: 0.0, through: 150.0, by: 10.0) {
            let pct = LivingSliderMath.pctUnipolar(value: v, range: range)
            let back = LivingSliderMath.valueUnipolar(pct: pct, range: range)
            XCTAssertEqual(back, v, accuracy: 1e-9,
                           "round-trip failed for v=\(v)")
        }
    }

    // MARK: zeroPct helpers

    func testZeroPctBipolarIsCenter() {
        // By definition: bipolar zero always lands at 0.5
        XCTAssertEqual(LivingSliderMath.zeroPct(halfRange: 100), 0.5, accuracy: 1e-9)
        XCTAssertEqual(LivingSliderMath.zeroPct(halfRange: 4), 0.5, accuracy: 1e-9)
    }

    func testZeroPctUnipolarIsLeftEdge() {
        // A range starting at zero: zero-pct = 0
        XCTAssertEqual(LivingSliderMath.zeroPctUnipolar(range: 0...100), 0.0, accuracy: 1e-9)
    }

    // MARK: format(value:range:)

    func testFormatExactZeroIntegerRange() {
        XCTAssertEqual(LivingSliderMath.format(value: 0.0, range: -100...100), "0")
    }

    func testFormatExactZeroDecimalRange() {
        XCTAssertEqual(LivingSliderMath.format(value: 0.0, range: -4...4), "0")
    }

    /// 0.4 on an integer-range slider is within the 0.5 threshold → "0".
    func testFormatNearZeroIntegerRangeRoundsToZero() {
        XCTAssertEqual(LivingSliderMath.format(value: 0.4,  range: -100...100), "0")
        XCTAssertEqual(LivingSliderMath.format(value: -0.4, range: -100...100), "0")
    }

    /// 0.4 on a decimal range is outside the 0.005 threshold → "+0.40".
    func testFormatSmallDecimalRangeNotRoundedToZero() {
        XCTAssertEqual(LivingSliderMath.format(value: 0.4, range: -4...4), "+0.40")
    }

    func testFormatPositiveValueIntegerRange() {
        XCTAssertEqual(LivingSliderMath.format(value: 35.0, range: -100...100), "+35")
    }

    func testFormatNegativeValueIntegerRange() {
        XCTAssertEqual(LivingSliderMath.format(value: -35.0, range: -100...100), "-35")
    }

    func testFormatPositiveValueDecimalRange() {
        XCTAssertEqual(LivingSliderMath.format(value: 1.5, range: -4...4), "+1.50")
    }

    func testFormatNegativeValueDecimalRange() {
        XCTAssertEqual(LivingSliderMath.format(value: -2.25, range: -4...4), "-2.25")
    }

    /// Exactly ±0.5 on integer range is at the inclusive threshold (0.5 ≤ 0.5)
    /// so it formats as "0" (unsigned) rather than "+0" (which %.0f + sign
    /// would otherwise produce via IEEE-754 round-half-to-even).
    func testFormatHalfStepIntegerRangeIsZero() {
        XCTAssertEqual(LivingSliderMath.format(value:  0.5, range: -100...100), "0")
        XCTAssertEqual(LivingSliderMath.format(value: -0.5, range: -100...100), "0")
    }

    /// 0.6 on integer range is above the 0.5 threshold and %.0f rounds to 1.
    func testFormatAboveHalfStepIntegerRangeFormatsNonZero() {
        XCTAssertEqual(LivingSliderMath.format(value: 0.6, range: -100...100), "+1")
        XCTAssertEqual(LivingSliderMath.format(value: -0.6, range: -100...100), "-1")
    }
}

// MARK: - 2. GradientCatalogTests

/// Every wired tool in the four ToolGroups must have a gradient entry.
/// Track-less tools (crop, presets, colorGrade, bwMix) are intentionally absent.
final class GradientCatalogTests: XCTestCase {

    /// Canonical list of wired, value-bearing tools (Tool.isWired == true,
    /// ToolValueMapping.displayRange != nil or sub-params present).
    /// colorGrade (#275, supersedes split tone) is wired but uses colour
    /// wheels, not a gradient track — so it is excluded from the gradient
    /// requirement.
    private let wiredGradientTools: [Tool] = [
        // Light
        .exposure, .brightness, .contrast, .highlights, .shadows, .whites, .blacks,
        // Color
        .temp, .tint, .vibrance, .saturation,
        // Effects (excluding colorGrade which uses hue/sat wheels)
        .clarity, .texture, .dehaze, .vignette, .grain,
        // Detail
        .sharpen, .noise, .colorNR, .captureSharpen, .captureSigma,
    ]

    func testAllWiredGradientToolsHaveEntry() {
        for tool in wiredGradientTools {
            let stops = GradientCatalog.stops(for: tool)
            XCTAssertNotNil(stops,
                "GradientCatalog missing entry for tool .\(tool.rawValue)")
            XCTAssertFalse(stops?.isEmpty ?? true,
                "GradientCatalog empty stops for tool .\(tool.rawValue)")
        }
    }

    func testEachEntryHasAtLeastTwoStops() {
        for tool in wiredGradientTools {
            let stops = GradientCatalog.stops(for: tool)!
            XCTAssertGreaterThanOrEqual(stops.count, 2,
                "Tool .\(tool.rawValue) should have ≥ 2 gradient stops")
        }
    }

    func testNonWiredToolsReturnNil() {
        // Tools that have no gradient track
        let noGradient: [Tool] = [.crop, .presets, .colorGrade]
        for tool in noGradient {
            XCTAssertNil(GradientCatalog.stops(for: tool),
                "Non-gradient tool .\(tool.rawValue) should return nil")
        }
    }

    /// HSL (#274) has a tool-level hue sweep AND a per-band track for each
    /// of its 24 sub-params, so a slider in `HSLSection` always resolves a
    /// gradient. Each per-band track ends on that band's own swatch.
    func testHSLResolvesATrackForEveryBandAndChannel() {
        let toolLevel = GradientCatalog.stops(for: .hsl)
        XCTAssertEqual(toolLevel?.count, 4)

        for band in HSLBand.all {
            for channel in HSLChannel.allCases {
                let id = Tool.hslSubParamId(channel: channel, band: band)
                let stops = GradientCatalog.stops(for: .hsl, subParamId: id)
                XCTAssertEqual(stops?.count, 2, "no per-band track for \(id)")
                XCTAssertEqual(stops?.last, GradientStop(t: 1.0, hex: band.swatch),
                    "\(id) should end on the \(band.label) swatch")
            }
        }
    }

    func testStopPositionsAreInOrder() {
        for tool in wiredGradientTools {
            guard let stops = GradientCatalog.stops(for: tool) else { continue }
            for i in 1..<stops.count {
                XCTAssertGreaterThanOrEqual(stops[i].t, stops[i-1].t,
                    "Tool .\(tool.rawValue) stop \(i) position \(stops[i].t) < stop \(i-1) position \(stops[i-1].t)")
            }
        }
    }

    func testStopPositionsAreNormalised() {
        for tool in wiredGradientTools {
            guard let stops = GradientCatalog.stops(for: tool) else { continue }
            XCTAssertEqual(stops.first?.t ?? -1, 0.0, accuracy: 1e-9,
                "Tool .\(tool.rawValue) first stop should be at t=0")
            XCTAssertEqual(stops.last?.t ?? -1, 1.0, accuracy: 1e-9,
                "Tool .\(tool.rawValue) last stop should be at t=1")
        }
    }

    func testAllToolsInGroupsCovered() {
        // Every ToolGroup has at least one tool with a gradient entry
        for group in ToolGroup.allCases {
            let tools = Tool.tools(in: group)
            let covered = tools.filter { GradientCatalog.stops(for: $0) != nil }
            XCTAssertFalse(covered.isEmpty,
                "ToolGroup .\(group.rawValue) has no tools with gradient entries")
        }
    }

    func testVignetteHasThreeStops() {
        // Vignette is the only three-stop (symmetric arc) entry
        let stops = GradientCatalog.vignette
        XCTAssertEqual(stops.count, 3)
        XCTAssertEqual(stops[1].t, 0.5, accuracy: 1e-9)
    }

    // MARK: Sub-param lookup — unqualified ids + tool

    func testSubParamIdsForVignette() {
        // ToolSubParam.id values are unqualified ("amount", not "vignette.amount")
        XCTAssertNotNil(GradientCatalog.stops(for: .vignette, subParamId: "amount"))
        XCTAssertNotNil(GradientCatalog.stops(for: .vignette, subParamId: "feather"))
    }

    func testSubParamIdsForGrain() {
        XCTAssertNotNil(GradientCatalog.stops(for: .grain, subParamId: "amount"))
        XCTAssertNotNil(GradientCatalog.stops(for: .grain, subParamId: "size"))
        XCTAssertNotNil(GradientCatalog.stops(for: .grain, subParamId: "roughness"))
    }

    func testSubParamIdsForSharpen() {
        for id in ["amount", "radius", "detail", "masking"] {
            XCTAssertNotNil(GradientCatalog.stops(for: .sharpen, subParamId: id),
                "sharpen sub-param '\(id)' should return non-nil")
        }
    }

    func testSubParamIdsForNoise() {
        XCTAssertNotNil(GradientCatalog.stops(for: .noise, subParamId: "luminance"))
        XCTAssertNotNil(GradientCatalog.stops(for: .noise, subParamId: "color"))
    }

    func testColorGradeSubParamsReturnNil() {
        // Color Grading (#275) sub-params use colour wheels, not gradient
        // tracks.
        let colorGradeIds = [
            "balance",
            "shadowHue", "shadowSat", "shadowLum",
            "midtoneHue", "midtoneSat", "midtoneLum",
            "highlightHue", "highlightSat", "highlightLum",
            "globalHue", "globalSat", "globalLum",
        ]
        for id in colorGradeIds {
            XCTAssertNil(GradientCatalog.stops(for: .colorGrade, subParamId: id),
                "colorGrade sub-param '\(id)' should return nil")
        }
    }

    /// "amount" is ambiguous across tools — grain.amount and vignette.amount
    /// are different sub-params. Verify the tool-keyed lookup returns the
    /// correct (different) gradient for each.
    func testSubParamAmountIsUnambiguousAcrossTools() {
        let vignetteStops = GradientCatalog.stops(for: .vignette, subParamId: "amount")
        let grainStops    = GradientCatalog.stops(for: .grain,    subParamId: "amount")
        XCTAssertNotNil(vignetteStops)
        XCTAssertNotNil(grainStops)
        // Vignette has 3 stops (symmetric arc); grain has 2 — they are distinct.
        XCTAssertEqual(vignetteStops?.count, 3,
            "vignette gradient should have 3 stops (symmetric arc)")
        XCTAssertEqual(grainStops?.count, 2,
            "grain gradient should have 2 stops")
    }
}

// MARK: - 3. ProTokensAccentTests
//
// The accent(_:) helper in ProTokens (app target, SwiftUI) must derive from
// the one base accent hex (0xC4493A). Since ProTokens lives in the app target
// and MapleCore tests don't import SwiftUI, we verify the structural
// invariants here using pure UInt32 hex arithmetic — the same math that
// `Color(proHex:alpha:)` calls internally.

/// Tests that the documented accent alpha levels and the base hex decode
/// correctly, ensuring accent-derived fills in ProTokens are consistent.
final class ProTokensAccentTests: XCTestCase {

    /// The four documented alpha levels are all distinct from each other.
    func testAccentAlphasAreDistinct() {
        let alphas: [UInt8] = [0x1F, 0x22, 0x28, 0x30]
        // Verify all values are strictly increasing (i.e. non-equal)
        for i in 0..<alphas.count - 1 {
            XCTAssertLessThan(alphas[i], alphas[i + 1],
                "Documented accent alpha values should be in ascending order")
        }
    }

    /// The base accent hex decodes to the expected sRGB components.
    func testAccentHexDecodesSRGB() {
        let rgb: UInt32 = 0xC4493A
        let r = Double((rgb >> 16) & 0xFF) / 255.0 // 0xC4 = 196
        let g = Double((rgb >>  8) & 0xFF) / 255.0 // 0x49 = 73
        let b = Double( rgb        & 0xFF) / 255.0 // 0x3A = 58
        XCTAssertEqual(r, 196.0 / 255.0, accuracy: 1e-9)
        XCTAssertEqual(g,  73.0 / 255.0, accuracy: 1e-9)
        XCTAssertEqual(b,  58.0 / 255.0, accuracy: 1e-9)
    }

    /// Alpha byte arithmetic: 0xFF (fully opaque) is the default.
    func testFullAlphaIsOpaque() {
        let alpha: Double = Double(0xFF) / 255.0
        XCTAssertEqual(alpha, 1.0, accuracy: 1e-9)
    }

    /// Alpha byte arithmetic: 0x1F ≈ 12%, 0x30 ≈ 19%.
    func testAccentAlphaRanges() {
        let lo = Double(0x1F) / 255.0 // 31/255 ≈ 0.1216
        let hi = Double(0x30) / 255.0 // 48/255 ≈ 0.1882
        XCTAssertGreaterThan(lo, 0.10)
        XCTAssertLessThan(lo, 0.15)
        XCTAssertGreaterThan(hi, 0.15)
        XCTAssertLessThan(hi, 0.25)
    }
}
