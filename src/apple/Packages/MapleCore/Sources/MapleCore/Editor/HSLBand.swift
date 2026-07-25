// HSLBand.swift — the 8 HSL hue bands (#274).
//
// Single source on the Swift side for the band ORDER, their display
// labels, their chip swatches, and the 24 `AdjustmentModel` key paths
// they drive. The numeric band windows themselves (hue centers, the
// raised-cosine half-width, the chroma gate) live once in raw-core —
// `HUE_CENTERS_DEG` / `BAND_HALF_WIDTH_DEG` / `CHROMA_GATE_C0` in
// `src/raw-pipeline/raw-core/src/stages/hsl.rs` — and are shared from
// there by the WGSL kernel and by the Black & White mix (#276). This
// table only names the bands and points at their fields, so the UI can
// never disagree with the pipeline about which band is which.
//
// Mirrors the web catalog in
// `src/web/projects/maple-common/src/lib/editor/tool-sub-param.ts`
// (same ids, same labels, same declaration order).

import Foundation

// MARK: - HSLBand

/// One of the eight ACR-aligned hue bands, with the three
/// `AdjustmentModel` fields it drives.
///
/// Not `Sendable` for the same reason `ToolSubParam` isn't: the
/// `WritableKeyPath` members lack an unconditional `Sendable`
/// conformance, and the table is MainActor-consumed UI state.
public struct HSLBand: Identifiable, Equatable {
    /// Stable id — the suffix shared by the three sub-param ids
    /// (`hueRed` / `satRed` / `lumRed` all carry `id == "red"`).
    public let id: String
    /// Chip label ("Red").
    public let label: String
    /// Representative swatch colour for the band chip, 0xRRGGBB. Drawn
    /// from the same palette as `GradientCatalog`'s slider tracks.
    public let swatch: UInt32
    public let hue: WritableKeyPath<AdjustmentModel, Double>
    public let saturation: WritableKeyPath<AdjustmentModel, Double>
    public let luminance: WritableKeyPath<AdjustmentModel, Double>

    /// The eight bands in raw-core's `HUE_CENTERS_DEG` order:
    /// Red, Orange, Yellow, Green, Aqua, Blue, Purple, Magenta.
    public static let all: [HSLBand] = [
        HSLBand(id: "red", label: "Red", swatch: 0xC4493A,
                hue: \.hueAdjustmentRed,
                saturation: \.saturationAdjustmentRed,
                luminance: \.luminanceAdjustmentRed),
        HSLBand(id: "orange", label: "Orange", swatch: 0xE8A33D,
                hue: \.hueAdjustmentOrange,
                saturation: \.saturationAdjustmentOrange,
                luminance: \.luminanceAdjustmentOrange),
        HSLBand(id: "yellow", label: "Yellow", swatch: 0xE3D24A,
                hue: \.hueAdjustmentYellow,
                saturation: \.saturationAdjustmentYellow,
                luminance: \.luminanceAdjustmentYellow),
        HSLBand(id: "green", label: "Green", swatch: 0x3FAE6A,
                hue: \.hueAdjustmentGreen,
                saturation: \.saturationAdjustmentGreen,
                luminance: \.luminanceAdjustmentGreen),
        HSLBand(id: "aqua", label: "Aqua", swatch: 0x45B6C4,
                hue: \.hueAdjustmentAqua,
                saturation: \.saturationAdjustmentAqua,
                luminance: \.luminanceAdjustmentAqua),
        HSLBand(id: "blue", label: "Blue", swatch: 0x3B6FB0,
                hue: \.hueAdjustmentBlue,
                saturation: \.saturationAdjustmentBlue,
                luminance: \.luminanceAdjustmentBlue),
        HSLBand(id: "purple", label: "Purple", swatch: 0x8A6BC4,
                hue: \.hueAdjustmentPurple,
                saturation: \.saturationAdjustmentPurple,
                luminance: \.luminanceAdjustmentPurple),
        HSLBand(id: "magenta", label: "Magenta", swatch: 0xC64FB0,
                hue: \.hueAdjustmentMagenta,
                saturation: \.saturationAdjustmentMagenta,
                luminance: \.luminanceAdjustmentMagenta),
    ]
}

// MARK: - HSLChannel

/// The three per-band channels. Declaration order is presentation order
/// in `HSLSection` and drives the sub-param declaration order below.
public enum HSLChannel: String, CaseIterable, Sendable {
    case hue, saturation, luminance

    /// Section-header label ("Hue").
    public var displayName: String {
        switch self {
        case .hue:        return "Hue"
        case .saturation: return "Saturation"
        case .luminance:  return "Luminance"
        }
    }

    /// Sub-param id prefix — `hueRed`, `satRed`, `lumRed` (web parity).
    var idPrefix: String {
        switch self {
        case .hue:        return "hue"
        case .saturation: return "sat"
        case .luminance:  return "lum"
        }
    }

    /// Sub-param chip label prefix — "H Red", "S Red", "L Red".
    var labelPrefix: String {
        switch self {
        case .hue:        return "H"
        case .saturation: return "S"
        case .luminance:  return "L"
        }
    }

    public func keyPath(for band: HSLBand) -> WritableKeyPath<AdjustmentModel, Double> {
        switch self {
        case .hue:        return band.hue
        case .saturation: return band.saturation
        case .luminance:  return band.luminance
        }
    }

    public func range(for band: HSLBand) -> ClosedRange<Double> {
        // All 24 HSL fields share the generated ±100 range; reading it
        // from one representative generated constant per channel keeps
        // the bound sourced from raw-core rather than hard-coded here.
        switch self {
        case .hue:        return AdjustmentModel.hueAdjustmentRedRange
        case .saturation: return AdjustmentModel.saturationAdjustmentRedRange
        case .luminance:  return AdjustmentModel.luminanceAdjustmentRedRange
        }
    }
}

// MARK: - Sub-param catalog

extension Tool {
    /// The 24 HSL sub-params, channel-major (all eight Hue bands, then
    /// Saturation, then Luminance) — the exact order and ids the web
    /// `SUB_PARAMS.hsl` catalog declares, so a sub-param id means the
    /// same thing on both platforms.
    ///
    /// Every field is symmetric ±100 with a 0 default, so all 24 take the
    /// `.anchored` mapping (internal 0 IS the default).
    static var hslSubParams: [ToolSubParam] {
        HSLChannel.allCases.flatMap { channel in
            HSLBand.all.map { band in
                ToolSubParam(
                    id: Self.hslSubParamId(channel: channel, band: band),
                    label: "\(channel.labelPrefix) \(band.label)",
                    keyPath: channel.keyPath(for: band),
                    mapping: .anchored,
                    range: channel.range(for: band),
                    defaultDisplayValue: 0,
                    decimals: 0
                )
            }
        }
    }

    /// `hueRed`, `satOrange`, `lumMagenta`, … — the id shared with web.
    public static func hslSubParamId(channel: HSLChannel, band: HSLBand) -> String {
        channel.idPrefix + band.id.prefix(1).uppercased() + band.id.dropFirst()
    }
}
