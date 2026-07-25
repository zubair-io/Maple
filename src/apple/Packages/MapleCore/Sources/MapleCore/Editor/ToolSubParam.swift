// ToolSubParam.swift — multi-param tool pills (#1108, spec §10.0).
//
// A tool may declare an ORDERED list of sub-parameters. Arming a
// multi-param pill surfaces a compact chip selector above the drag bar
// (`SubParamRow` in the app target); the drag bar, value chip, fine mode
// and undo semantics then act on the armed (tool, subParam) pair.
// Single-param tools declare no sub-params and keep the
// `ToolValueMapping` tool-level path byte-for-byte.
//
// Mirrors the web `ToolSubParam` in
// `src/web/projects/maple-common/src/lib/editor/tool-sub-param.ts`.
//
// Ranges are sourced from the GENERATED `AdjustmentModel.*Range`
// constants and defaults from the canonical `AdjustmentModel()` field
// defaults, so sub-params cannot drift from raw-core — same rule the
// web side follows via `ADJUSTMENT_RANGES` (#953).

import Foundation

// MARK: - ToolSubParam

/// Not `Sendable`: the `WritableKeyPath` member lacks an unconditional
/// Sendable conformance pre-SE-0418 adoption, and the descriptor is
/// MainActor-consumed UI state anyway (built per call by
/// `Tool.subParams`, read by `EditorState` + the editor views).
public struct ToolSubParam: Identifiable, Equatable {
    /// Internal `[-100, +100]` ↔ display mapping family.
    ///
    /// - `linear`: affine `lo..hi` onto `-100..+100` — the noise /
    ///   colorNR layout, where the marker position mirrors the position
    ///   in the range.
    /// - `anchored`: pivot at the field's canonical default — internal 0
    ///   IS the default and ±100 are the range ends (the temp /
    ///   sharpen-amount layout). Requires `lo < default < hi`.
    public enum Mapping: Equatable, Sendable {
        case linear
        case anchored
    }

    /// Stable id, unique within the tool (used in accessibility ids +
    /// session memory).
    public let id: String
    /// Chip label; the value chip shows it uppercased.
    public let label: String
    /// `AdjustmentModel` field this sub-param reads/writes.
    public let keyPath: WritableKeyPath<AdjustmentModel, Double>
    public let mapping: Mapping
    /// Canonical generated range for the field.
    public let range: ClosedRange<Double>
    /// Canonical default display value — the generated field default.
    public let defaultDisplayValue: Double
    /// Value-chip fraction digits (radius is sub-integer: "1.0").
    public let decimals: Int
    /// DECODE-PRODUCT field: writing it invalidates the decoded buffer, so
    /// the model write is held until the gesture ENDS instead of firing per
    /// tick (spec § 3.1 / § 3.2 — "the UI commits on release, not per
    /// tick"). `RawCoreBridge.stripAppleGPUStages` KEEPS these fields, so a
    /// per-tick write would force a full re-decode — seconds of BM3D — on
    /// every drag sample. `false` for the Metal-rerun sliders, which stay
    /// on the per-tick path untouched.
    public let commitsOnRelease: Bool

    /// Designated initializer. `commitsOnRelease` defaults to `false` so the
    /// pre-#1153 declarations read unchanged.
    public init(
        id: String,
        label: String,
        keyPath: WritableKeyPath<AdjustmentModel, Double>,
        mapping: Mapping,
        range: ClosedRange<Double>,
        defaultDisplayValue: Double,
        decimals: Int,
        commitsOnRelease: Bool = false
    ) {
        self.id = id
        self.label = label
        self.keyPath = keyPath
        self.mapping = mapping
        self.range = range
        self.defaultDisplayValue = defaultDisplayValue
        self.decimals = decimals
        self.commitsOnRelease = commitsOnRelease
    }

    /// Internal `[-100, +100]` → display. Same math as the tool-level
    /// mapping families in `ToolValueMapping`, generalized per descriptor.
    public func displayValue(internalValue v: Double) -> Double {
        let (lo, hi) = (range.lowerBound, range.upperBound)
        switch mapping {
        case .linear:
            return lo + ((v + 100) / 200.0) * (hi - lo)
        case .anchored:
            let a = defaultDisplayValue
            return v >= 0 ? a + (v / 100.0) * (hi - a)
                          : a + (v / 100.0) * (a - lo)
        }
    }

    /// Inverse of `displayValue(internalValue:)`.
    public func internalValue(displayValue d: Double) -> Double {
        let (lo, hi) = (range.lowerBound, range.upperBound)
        switch mapping {
        case .linear:
            return ((d - lo) / (hi - lo)) * 200 - 100
        case .anchored:
            let a = defaultDisplayValue
            return d >= a ? ((d - a) / (hi - a)) * 100
                          : ((d - a) / (a - lo)) * 100
        }
    }

    /// Value-chip text ("DETAIL · SHARPEN · RADIUS · 1.0"). Signed only
    /// when the range spans negative (spec §10.0 shows one-sided
    /// sub-params unsigned: "FEATHER · 35"); `decimals` fraction digits.
    public func format(_ d: Double) -> String {
        let scale = pow(10.0, Double(decimals))
        let rounded = (d * scale).rounded() / scale
        let magnitude = String(format: "%.\(decimals)f", abs(rounded))
        if rounded < 0 { return "-" + magnitude }
        return range.lowerBound < 0 ? "+" + magnitude : magnitude
    }
}

// MARK: - Per-tool catalog

extension Tool {
    /// Ordered sub-params; empty for single-param tools. §10.0: the
    /// Noise pill's Deep (BM3D, §3.2) and Prefilter (§3.1) tiers joined at
    /// #1153 — data-only, plus the `commitsOnRelease` flag their
    /// decode-product placement forces.
    /// Vignette joined at #1109, grain at #1110, split tone
    /// at #1111 (Balance leads — it is the schema-declared primary
    /// drag-bar field, and the legacy splitTone drag bar drove it). HSL
    /// joined at #274 with 24 sub-params (Hue/Sat/Lum × 8 bands); its
    /// catalog is built from the shared `HSLBand.all` table in
    /// `HSLBand.swift` rather than spelled out here.
    public var subParams: [ToolSubParam] {
        switch self {
        case .hsl:
            return Self.hslSubParams
        case .bwMix:
            // B&W mix (#276) — eight per-hue-band luminance weights, in the
            // same order (and under the same ids/labels) as `HSLBand.all`,
            // which is raw-core's `HUE_CENTERS_DEG` order. Symmetric ±100
            // range, default 0 — `.linear` and `.anchored` coincide for a
            // range centred on the default, so either mapping family is
            // exact; `.linear` matches the plain affine layout of the
            // other symmetric-range sub-params (noise / split-tone hue).
            return [
                ToolSubParam(id: "red", label: "Red",
                             keyPath: \.grayMixerRed, mapping: .linear,
                             range: AdjustmentModel.grayMixerRedRange,
                             defaultDisplayValue: Self.defaults.grayMixerRed,
                             decimals: 0),
                ToolSubParam(id: "orange", label: "Orange",
                             keyPath: \.grayMixerOrange, mapping: .linear,
                             range: AdjustmentModel.grayMixerOrangeRange,
                             defaultDisplayValue: Self.defaults.grayMixerOrange,
                             decimals: 0),
                ToolSubParam(id: "yellow", label: "Yellow",
                             keyPath: \.grayMixerYellow, mapping: .linear,
                             range: AdjustmentModel.grayMixerYellowRange,
                             defaultDisplayValue: Self.defaults.grayMixerYellow,
                             decimals: 0),
                ToolSubParam(id: "green", label: "Green",
                             keyPath: \.grayMixerGreen, mapping: .linear,
                             range: AdjustmentModel.grayMixerGreenRange,
                             defaultDisplayValue: Self.defaults.grayMixerGreen,
                             decimals: 0),
                ToolSubParam(id: "aqua", label: "Aqua",
                             keyPath: \.grayMixerAqua, mapping: .linear,
                             range: AdjustmentModel.grayMixerAquaRange,
                             defaultDisplayValue: Self.defaults.grayMixerAqua,
                             decimals: 0),
                ToolSubParam(id: "blue", label: "Blue",
                             keyPath: \.grayMixerBlue, mapping: .linear,
                             range: AdjustmentModel.grayMixerBlueRange,
                             defaultDisplayValue: Self.defaults.grayMixerBlue,
                             decimals: 0),
                ToolSubParam(id: "purple", label: "Purple",
                             keyPath: \.grayMixerPurple, mapping: .linear,
                             range: AdjustmentModel.grayMixerPurpleRange,
                             defaultDisplayValue: Self.defaults.grayMixerPurple,
                             decimals: 0),
                ToolSubParam(id: "magenta", label: "Magenta",
                             keyPath: \.grayMixerMagenta, mapping: .linear,
                             range: AdjustmentModel.grayMixerMagentaRange,
                             defaultDisplayValue: Self.defaults.grayMixerMagenta,
                             decimals: 0),
            ]
        case .splitTone:
            return [
                ToolSubParam(id: "balance", label: "Balance",
                             keyPath: \.splitToneBalance, mapping: .anchored,
                             range: AdjustmentModel.splitToneBalanceRange,
                             defaultDisplayValue: Self.defaults.splitToneBalance,
                             decimals: 0),
                ToolSubParam(id: "shadowHue", label: "Sh Hue",
                             keyPath: \.splitToneShadowHue, mapping: .linear,
                             range: AdjustmentModel.splitToneShadowHueRange,
                             defaultDisplayValue: Self.defaults.splitToneShadowHue,
                             decimals: 0),
                ToolSubParam(id: "shadowSat", label: "Sh Sat",
                             keyPath: \.splitToneShadowSaturation, mapping: .linear,
                             range: AdjustmentModel.splitToneShadowSaturationRange,
                             defaultDisplayValue: Self.defaults.splitToneShadowSaturation,
                             decimals: 0),
                ToolSubParam(id: "highlightHue", label: "Hi Hue",
                             keyPath: \.splitToneHighlightHue, mapping: .linear,
                             range: AdjustmentModel.splitToneHighlightHueRange,
                             defaultDisplayValue: Self.defaults.splitToneHighlightHue,
                             decimals: 0),
                ToolSubParam(id: "highlightSat", label: "Hi Sat",
                             keyPath: \.splitToneHighlightSaturation, mapping: .linear,
                             range: AdjustmentModel.splitToneHighlightSaturationRange,
                             defaultDisplayValue: Self.defaults.splitToneHighlightSaturation,
                             decimals: 0),
            ]
        case .grain:
            return [
                ToolSubParam(id: "amount", label: "Amount",
                             keyPath: \.grainAmount, mapping: .linear,
                             range: AdjustmentModel.grainAmountRange,
                             defaultDisplayValue: Self.defaults.grainAmount,
                             decimals: 0),
                ToolSubParam(id: "size", label: "Size",
                             keyPath: \.grainSize, mapping: .linear,
                             range: AdjustmentModel.grainSizeRange,
                             defaultDisplayValue: Self.defaults.grainSize,
                             decimals: 0),
                ToolSubParam(id: "roughness", label: "Roughness",
                             keyPath: \.grainRoughness, mapping: .linear,
                             range: AdjustmentModel.grainRoughnessRange,
                             defaultDisplayValue: Self.defaults.grainRoughness,
                             decimals: 0),
            ]
        case .vignette:
            return [
                ToolSubParam(id: "amount", label: "Amount",
                             keyPath: \.vignetteAmount, mapping: .anchored,
                             range: AdjustmentModel.vignetteAmountRange,
                             defaultDisplayValue: Self.defaults.vignetteAmount,
                             decimals: 0),
                ToolSubParam(id: "feather", label: "Feather",
                             keyPath: \.vignetteFeather, mapping: .linear,
                             range: AdjustmentModel.vignetteFeatherRange,
                             defaultDisplayValue: Self.defaults.vignetteFeather,
                             decimals: 0),
            ]
        case .noise:
            return [
                ToolSubParam(id: "luminance", label: "Luminance",
                             keyPath: \.nrLuminance, mapping: .linear,
                             range: AdjustmentModel.nrLuminanceRange,
                             defaultDisplayValue: Self.defaults.nrLuminance,
                             decimals: 0),
                ToolSubParam(id: "color", label: "Color",
                             keyPath: \.nrColor, mapping: .linear,
                             range: AdjustmentModel.nrColorRange,
                             defaultDisplayValue: Self.defaults.nrColor,
                             decimals: 0),
                // Tiers 3 and 1 of the § 3 noise architecture (#1153). Both
                // live inside the DECODE PRODUCT, so both commit on release:
                // Deep (BM3D, #1105) costs seconds per re-decode, Prefilter
                // (#1104) rides the same decode. Order follows spec § 10.0:
                // "Luminance, Color (existing NLM), Deep, Prefilter".
                ToolSubParam(id: "deep", label: "Deep",
                             keyPath: \.deepDenoise, mapping: .linear,
                             range: AdjustmentModel.deepDenoiseRange,
                             defaultDisplayValue: Self.defaults.deepDenoise,
                             decimals: 0,
                             commitsOnRelease: true),
                ToolSubParam(id: "prefilter", label: "Prefilter",
                             keyPath: \.chromaPrefilter, mapping: .linear,
                             range: AdjustmentModel.chromaPrefilterRange,
                             defaultDisplayValue: Self.defaults.chromaPrefilter,
                             decimals: 0,
                             commitsOnRelease: true),
            ]
        case .sharpen:
            return [
                ToolSubParam(id: "amount", label: "Amount",
                             keyPath: \.sharpenAmount, mapping: .anchored,
                             range: AdjustmentModel.sharpenAmountRange,
                             defaultDisplayValue: Self.defaults.sharpenAmount,
                             decimals: 0),
                ToolSubParam(id: "radius", label: "Radius",
                             keyPath: \.sharpenRadius, mapping: .anchored,
                             range: AdjustmentModel.sharpenRadiusRange,
                             defaultDisplayValue: Self.defaults.sharpenRadius,
                             decimals: 1),
                ToolSubParam(id: "detail", label: "Detail",
                             keyPath: \.sharpenDetail, mapping: .linear,
                             range: AdjustmentModel.sharpenDetailRange,
                             defaultDisplayValue: Self.defaults.sharpenDetail,
                             decimals: 0),
                ToolSubParam(id: "masking", label: "Masking",
                             keyPath: \.sharpenMasking, mapping: .linear,
                             range: AdjustmentModel.sharpenMaskingRange,
                             defaultDisplayValue: Self.defaults.sharpenMasking,
                             decimals: 0),
            ]
        default:
            return []
        }
    }

    /// True when the tool shows the sub-param chip row (≥ 2 sub-params).
    public var isMultiParam: Bool { subParams.count > 1 }

    /// Default armed sub-param id (first declared); nil for single-param.
    public var defaultSubParamId: String? { subParams.first?.id }

    /// Canonical defaults instance, read once — the same source
    /// `ToolValueMapping.defaultDisplayValue` documents (hand-written
    /// `AdjustmentModel.init` defaults matching raw-core's schema).
    private static let defaults = AdjustmentModel()
}

// MARK: - Session memory

/// Last-armed sub-param per tool, remembered for the app session only —
/// never persisted (NOT in XMP, not in `cm.*`). Lives outside
/// `EditorState` because both editor hosts rebuild `EditorState` per
/// asset; the selection must survive an image switch (#1108).
/// Injectable so tests get isolated instances.
@MainActor
public final class ToolSubParamMemory {
    public static let shared = ToolSubParamMemory()

    private var selections: [Tool: String] = [:]

    public init() {}

    public func remember(_ subParamId: String, for tool: Tool) {
        selections[tool] = subParamId
    }

    public func recall(for tool: Tool) -> String? {
        selections[tool]
    }
}
