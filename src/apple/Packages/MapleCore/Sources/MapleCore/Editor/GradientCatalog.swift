// GradientCatalog.swift — Pro Editor Canvas-first (A1, #1536).
//
// Maps each wired editor tool (and multi-param sub-params) to an ordered
// array of platform-neutral `GradientStop` values. Lives in MapleCore so
// it's unit-testable without a SwiftUI or UIKit dependency.
//
// Color values are expressed as sRGB components in [0, 1]. The view layer
// (LivingSlider) converts these to SwiftUI `Color` / `LinearGradient` —
// MapleCore itself does not import SwiftUI.
//
// Stops are pending final match against the exact `primitives.jsx` GRAD
// imports; hex values documented inline match the current Pro palette spec
// (A1, #1536) and will be ratcheted by the design pass in A2.

import Foundation

// MARK: - Value types

/// A single color stop in a slider gradient, expressed as sRGB.
///
/// The position `t` is in [0, 1]: 0 = left edge, 1 = right edge.
/// Positions are explicit so the catalog can represent non-uniform
/// distributions (e.g. Vignette's three-stop symmetric arc).
public struct GradientStop: Sendable, Hashable {
    /// Normalised position within the gradient, 0 (left) … 1 (right).
    public let t: Double
    /// Red component in sRGB (display-referred, gamma-encoded), [0, 1].
    public let r: Double
    /// Green component in sRGB (display-referred, gamma-encoded), [0, 1].
    public let g: Double
    /// Blue component in sRGB (display-referred, gamma-encoded), [0, 1].
    public let b: Double

    public init(t: Double, r: Double, g: Double, b: Double) {
        self.t = t
        self.r = r
        self.g = g
        self.b = b
    }
}

extension GradientStop {
    /// Convenience init from 8-bit sRGB hex (e.g. `0x0B0A08`) and a
    /// position in [0, 1]. Values are stored as gamma-encoded sRGB channel
    /// values in [0, 1] — just the byte divided by 255. No gamma decode is
    /// applied; these are display-referred palette colours, not scene-linear.
    /// The GPU path handles any necessary colour management at render time.
    public init(t: Double, hex: UInt32) {
        self.t = t
        self.r = Double((hex >> 16) & 0xFF) / 255.0
        self.g = Double((hex >>  8) & 0xFF) / 255.0
        self.b = Double( hex        & 0xFF) / 255.0
    }
}

// MARK: - Catalogue

/// Per-tool gradient stop arrays for the living slider track.
///
/// Every wired tool in the four `ToolGroup`s must have an entry — the
/// completeness invariant is enforced by `GradientCatalogTests`.
///
/// Tools with sub-params each have one gradient per sub-param keyed on the
/// sub-param's `id`; the catalogue falls back to the tool-level entry for
/// sub-params that share the parent's visual.
public enum GradientCatalog {

    // MARK: Light group

    /// Exposure — scene dark canvas → bright highlight.
    public static let exposure: [GradientStop] = [
        GradientStop(t: 0.0, hex: 0x0B0A08), // canvas
        GradientStop(t: 1.0, hex: 0xF2EFE9), // text (bright)
    ]

    /// Brightness (midtone-band gain) — dim → neutral light.
    public static let brightness: [GradientStop] = [
        GradientStop(t: 0.0, hex: 0x6E675E), // textDim
        GradientStop(t: 1.0, hex: 0xF2EFE9), // text
    ]

    /// Contrast — flat muted → punchy.
    public static let contrast: [GradientStop] = [
        GradientStop(t: 0.0, hex: 0x6E675E), // textDim (flat)
        GradientStop(t: 1.0, hex: 0xF2EFE9), // text (punchy)
    ]

    /// Highlights — recovered mid-grey → blown white.
    public static let highlights: [GradientStop] = [
        GradientStop(t: 0.0, hex: 0x9B958C), // recovered grey
        GradientStop(t: 1.0, hex: 0xFFFFFF), // full white
    ]

    /// Shadows — black → lifted shadow grey.
    public static let shadows: [GradientStop] = [
        GradientStop(t: 0.0, hex: 0x000000), // pure black
        GradientStop(t: 1.0, hex: 0x9B958C), // lifted shadow
    ]

    /// Whites — near-white point → paper white.
    public static let whites: [GradientStop] = [
        GradientStop(t: 0.0, hex: 0xD8D4CC), // near-white
        GradientStop(t: 1.0, hex: 0xFFFFFF), // paper white
    ]

    /// Blacks — pure black → raised black point.
    public static let blacks: [GradientStop] = [
        GradientStop(t: 0.0, hex: 0x000000), // pure black
        GradientStop(t: 1.0, hex: 0x3A352F), // raised black point
    ]

    // MARK: Color group

    /// Temp (colour temperature) — cool blue → warm amber.
    public static let temp: [GradientStop] = [
        GradientStop(t: 0.0, hex: 0x3B6FB0), // cool blue
        GradientStop(t: 1.0, hex: 0xE8A33D), // warm amber
    ]

    /// Tint — green shift → magenta shift.
    public static let tint: [GradientStop] = [
        GradientStop(t: 0.0, hex: 0x3FAE6A), // tint green
        GradientStop(t: 1.0, hex: 0xC64FB0), // tint magenta
    ]

    /// Vibrance — muted neutral → vibrant accent.
    public static let vibrance: [GradientStop] = [
        GradientStop(t: 0.0, hex: 0x6E675E), // muted neutral
        GradientStop(t: 1.0, hex: 0x4A9FC4), // vibrant blue-teal
    ]

    /// Saturation — grey → saturated red accent.
    public static let saturation: [GradientStop] = [
        GradientStop(t: 0.0, hex: 0x6E675E), // near-grey
        GradientStop(t: 1.0, hex: 0xC4493A), // accent red (saturated)
    ]

    /// HSL — a hue sweep across the band palette. Matches the web
    /// `GRADIENTS.hsl` entry stop-for-stop so both platforms' HSL tracks
    /// read the same. Used as the fall-back for any HSL sub-param whose
    /// band has no swatch-derived track of its own.
    public static let hsl: [GradientStop] = [
        GradientStop(t: 0.0, hex: 0xC4493A),  // red
        GradientStop(t: 0.33, hex: 0xE8A33D), // orange
        GradientStop(t: 0.66, hex: 0x3FAE6A), // green
        GradientStop(t: 1.0, hex: 0x3B6FB0),  // blue
    ]

    /// Per-band HSL track: neutral grey → the band's own swatch, so the
    /// three sliders of the armed band carry that band's colour.
    public static func hslStops(for band: HSLBand) -> [GradientStop] {
        [
            GradientStop(t: 0.0, hex: 0x6E675E), // textDim (neutral)
            GradientStop(t: 1.0, hex: band.swatch),
        ]
    }

    // MARK: Effects group

    /// Clarity — flat haze → micro-contrast crisp.
    public static let clarity: [GradientStop] = [
        GradientStop(t: 0.0, hex: 0x4A443B), // borderHi (flat)
        GradientStop(t: 1.0, hex: 0xA8A097), // textMuted (crisp)
    ]

    /// Texture — soft detail → fine detail.
    public static let texture: [GradientStop] = [
        GradientStop(t: 0.0, hex: 0x4A443B), // borderHi
        GradientStop(t: 1.0, hex: 0xA8A097), // textMuted
    ]

    /// Dehaze — hazy grey → clear neutral.
    public static let dehaze: [GradientStop] = [
        GradientStop(t: 0.0, hex: 0x4A443B), // borderHi
        GradientStop(t: 1.0, hex: 0xA8A097), // textMuted
    ]

    /// Vignette — canvas black, mid lift, back to black (symmetric arc).
    public static let vignette: [GradientStop] = [
        GradientStop(t: 0.0, hex: 0x08070A), // canvasAlt
        GradientStop(t: 0.5, hex: 0x6E675E), // textDim (lifted midpoint)
        GradientStop(t: 1.0, hex: 0x08070A), // canvasAlt
    ]

    /// Grain amount — panel quiet → textured warm.
    public static let grain: [GradientStop] = [
        GradientStop(t: 0.0, hex: 0x1D1B17), // panel
        GradientStop(t: 1.0, hex: 0xA8A097), // textMuted
    ]

    // MARK: Detail group

    /// Sharpen — soft haze → crisp edge.
    public static let sharpen: [GradientStop] = [
        GradientStop(t: 0.0, hex: 0x4A443B), // borderHi
        GradientStop(t: 1.0, hex: 0xF2EFE9), // text (sharp)
    ]

    /// Noise reduction — flat grain → smooth.
    public static let noise: [GradientStop] = [
        GradientStop(t: 0.0, hex: 0x4A443B), // borderHi (grain)
        GradientStop(t: 1.0, hex: 0xF2EFE9), // text (smooth)
    ]

    /// Colour noise reduction (same visual as luminance NR).
    public static let colorNR: [GradientStop] = [
        GradientStop(t: 0.0, hex: 0x4A443B),
        GradientStop(t: 1.0, hex: 0xF2EFE9),
    ]

    /// Capture sharpening amount.
    public static let captureSharpen: [GradientStop] = [
        GradientStop(t: 0.0, hex: 0x4A443B),
        GradientStop(t: 1.0, hex: 0xF2EFE9),
    ]

    /// Capture sharpening sigma (radius).
    public static let captureSigma: [GradientStop] = [
        GradientStop(t: 0.0, hex: 0x4A443B),
        GradientStop(t: 1.0, hex: 0xF2EFE9),
    ]

    // MARK: - Look-up by Tool / sub-param id

    /// Returns the gradient stops for `tool` (using its primary gradient),
    /// or the tool-level entry for a sub-param's parent when the sub-param
    /// does not define its own gradient. Returns `nil` for tools that carry
    /// no slider track of their own (`.crop`, `.presets`, `.splitTone`,
    /// `.bwMix`).
    public static func stops(for tool: Tool) -> [GradientStop]? {
        switch tool {
        case .exposure:       return exposure
        case .brightness:     return brightness
        case .contrast:       return contrast
        case .highlights:     return highlights
        case .shadows:        return shadows
        case .whites:         return whites
        case .blacks:         return blacks
        case .temp:           return temp
        case .tint:           return tint
        case .vibrance:       return vibrance
        case .saturation:     return saturation
        case .clarity:        return clarity
        case .texture:        return texture
        case .dehaze:         return dehaze
        case .vignette:       return vignette
        case .grain:          return grain
        case .sharpen:        return sharpen
        case .noise:          return noise
        case .colorNR:        return colorNR
        case .captureSharpen: return captureSharpen
        case .captureSigma:   return captureSigma
        case .hsl:            return hsl
        // B&W Mix (#276) is wired but multi-band like splitTone — no
        // single 2-stop gradient reads correctly for eight independent
        // per-hue weights, so it's excluded from the gradient-track
        // requirement, same as splitTone.
        case .crop, .presets, .splitTone, .bwMix:
            return nil
        }
    }

    /// Returns gradient stops for a sub-param identified by its **unqualified**
    /// `id` (as declared in `ToolSubParam.id`, e.g. `"amount"`, `"feather"`)
    /// together with its parent `tool`.
    ///
    /// Callers pass `subParam.id` directly — no manual string concatenation
    /// required, and the lookup is unambiguous across tools that share ids
    /// (e.g. both `.grain` and `.vignette` have a sub-param called `"amount"`).
    ///
    /// Split-tone, grain, vignette, sharpen, and noise sub-params each map
    /// to the parent tool's entry (they share the visual; finer per-sub-param
    /// gradients are a follow-up for A2).
    public static func stops(for tool: Tool, subParamId id: String) -> [GradientStop]? {
        switch tool {
        case .vignette:
            // "amount", "feather"
            return vignette
        case .grain:
            // "amount", "size", "roughness"
            return grain
        case .sharpen:
            // "amount", "radius", "detail", "masking"
            return sharpen
        case .noise:
            // "luminance", "color"
            return noise
        case .splitTone:
            // Sub-params use colour wheels, not gradient tracks
            return nil
        case .hsl:
            // "hueRed", "satOrange", "lumMagenta", … — each sub-param
            // carries its own band's swatch track. Unknown ids fall back
            // to the tool-level hue sweep.
            return HSLBand.all
                .first { band in
                    HSLChannel.allCases.contains {
                        Tool.hslSubParamId(channel: $0, band: band) == id
                    }
                }
                .map(hslStops(for:)) ?? hsl
        default:
            // Single-param tools have no sub-params; fall back to the
            // tool-level entry.
            return stops(for: tool)
        }
    }
}
