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
// Static palettes are generated from raw-core ui_slider_gradients (#4662),
// shared with Android so tool track colors cannot drift.

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
    self.g = Double((hex >> 8) & 0xFF) / 255.0
    self.b = Double(hex & 0xFF) / 255.0
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

  /// Per-band HSL track: neutral grey → the band's own swatch, so the
  /// three sliders of the armed band carry that band's colour.
  public static func hslStops(for band: HSLBand) -> [GradientStop] {
    [
      brightness[0],  // textDim (neutral)
      GradientStop(t: 1.0, hex: band.swatch),
    ]
  }

  // MARK: - Look-up by Tool / sub-param id

  /// Returns the gradient stops for `tool` (using its primary gradient),
  /// or the tool-level entry for a sub-param's parent when the sub-param
  /// does not define its own gradient. Returns `nil` for tools that carry
  /// no slider track of their own (`.crop`, `.presets`), and for
  /// `.bwMix` (#276) and `.colorGrade` (#275), which are wired but
  /// render eight per-hue weights and colour wheels respectively
  /// instead of a gradient track. `.filmLook` (#2683) is the same
  /// shape: a category-grouped catalog list, not a gradient track.
  public static func stops(for tool: Tool) -> [GradientStop]? {
    switch tool {
    case .exposure: return exposure
    case .brightness: return brightness
    case .contrast: return contrast
    case .highlights: return highlights
    case .shadows: return shadows
    case .whites: return whites
    case .blacks: return blacks
    case .temp: return temp
    case .tint: return tint
    case .vibrance: return vibrance
    case .saturation: return saturation
    case .clarity: return clarity
    case .texture: return texture
    case .dehaze: return dehaze
    case .vignette: return vignette
    case .grain: return grain
    case .sharpen: return sharpen
    case .noise: return noise
    case .colorNR: return colorNR
    case .captureSharpen: return captureSharpen
    case .captureSigma: return captureSigma
    case .hsl: return hsl
    case .toneCurve: return toneCurve
    // B&W Mix (#276) is wired but multi-band — no single 2-stop
    // gradient reads correctly for eight independent per-hue weights,
    // so it's excluded from the gradient-track requirement, the same
    // way colour grading is (#275: colour wheels, not a track).
    // Mask (#3274) is a full-surface panel swap, not a slider track
    // (same shape as `.crop`); Heal has no Tool-level surface yet.
    // Geometry (#3410) joins this list for the `.lensCorrections` reason:
    // seven independent sliders and no single track to tint.
    case .crop, .presets, .colorGrade, .bwMix, .filmLook, .lensCorrections, .geometry,
      .defringe,
      .mask, .heal:
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
  /// Colour-grading, grain, vignette, sharpen, and noise sub-params each map
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
    case .colorGrade:
      // Sub-params use colour wheels, not gradient tracks (#275).
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
