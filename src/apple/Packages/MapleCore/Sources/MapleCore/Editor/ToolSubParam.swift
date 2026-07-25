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
    /// Noise pill's future tiers — Deep (BM3D, #1105) and Prefilter
    /// (§3.1) — join the `noise` list data-only when their pipeline
    /// stages land. Vignette joined at #1109, grain at #1110, split tone
    /// at #1111 (Balance leads — it is the schema-declared primary
    /// drag-bar field, and the legacy splitTone drag bar drove it). HSL
    /// joined at #274 with 24 sub-params (Hue/Sat/Lum × 8 bands); its
    /// catalog is built from the shared `HSLBand.all` table in
    /// `HSLBand.swift` rather than spelled out here.
    public var subParams: [ToolSubParam] {
        switch self {
        case .hsl:
            return Self.hslSubParams
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
