// ToneCurveSplits.swift — parametric split-point clamping + active-region
// window shading for the Tone Curve editor (#5039).
//
// Pure value math with no SwiftUI import so it unit-tests under `swift test`
// alongside `ToneCurveEditing`. Mirrors the region-window math in
// `raw_core::stages::tone_curves::parametric` (`ordered_splits`,
// `region_centres`, `region_windows`) plus the UI authoring clamps specified
// in #5039 so interactive diamond handles can never cross, collapse, or enter
// degenerate edge intervals.

import Foundation

public enum ParametricSplitHandle: String, CaseIterable, Sendable, Equatable {
  case shadow
  case midtone
  case highlight
}

public enum ParametricRegion: String, CaseIterable, Sendable, Equatable {
  case shadows
  case darks
  case lights
  case highlights

  public var index: Int {
    switch self {
    case .shadows: return 0
    case .darks: return 1
    case .lights: return 2
    case .highlights: return 3
    }
  }
}

public enum ToneCurveSplits {
  /// Default split positions on the `[0, 100]` parametric region axis.
  public static let defaultShadow: Double = AdjustmentModel.parametricShadowSplitDefault
  public static let defaultMidtone: Double = AdjustmentModel.parametricMidtoneSplitDefault
  public static let defaultHighlight: Double = AdjustmentModel.parametricHighlightSplitDefault

  /// Minimum separation between adjacent splits during interactive UI drag.
  public static let minGap: Double = 5.0

  /// Top of the authoring domain in parametric axis units
  /// (`50 + 12.5 * log2(4.0 / 0.18)`), matching `parametric::AXIS_TOP`.
  public static let axisTop: Double = ParametricAxisTuning.top

  /// Clamp a proposed split-handle drag value against the current triplet
  /// using the #5039 UI authoring bounds:
  /// - shadow: `[10, min(70, midtone - 5)]`
  /// - midtone: `[max(20, shadow + 5), min(80, highlight - 5)]`
  /// - highlight: `[max(30, midtone + 5), 90]`
  public static func clampSplit(
    handle: ParametricSplitHandle,
    proposed: Double,
    shadow: Double,
    midtone: Double,
    highlight: Double
  ) -> Double {
    let val = proposed.isFinite ? proposed : defaultValue(for: handle)
    switch handle {
    case .shadow:
      let hi = max(10.0, min(70.0, midtone - minGap))
      return min(max(val, 10.0), hi).rounded()
    case .midtone:
      let lo = min(80.0, max(20.0, shadow + minGap))
      let hi = max(lo, min(80.0, highlight - minGap))
      return min(max(val, lo), hi).rounded()
    case .highlight:
      let lo = min(90.0, max(30.0, midtone + minGap))
      let hi = max(lo, 90.0)
      return min(max(val, lo), hi).rounded()
    }
  }

  public static func defaultValue(for handle: ParametricSplitHandle) -> Double {
    switch handle {
    case .shadow: return defaultShadow
    case .midtone: return defaultMidtone
    case .highlight: return defaultHighlight
    }
  }

  /// Repair an arbitrary (possibly hand-edited) split triplet into strictly
  /// ordered `[0, 100]` coordinates with at least 1 axis unit gap, matching
  /// `raw_core::stages::tone_curves::parametric::ordered_splits`.
  public static func orderedSplits(
    shadow: Double, midtone: Double, highlight: Double
  ) -> (shadow: Double, midtone: Double, highlight: Double) {
    let minSplitGap = 1.0
    let m = min(max(midtone, 2.0 * minSplitGap), 100.0 - 2.0 * minSplitGap)
    let s = min(max(shadow, minSplitGap), m - minSplitGap)
    let h = min(max(highlight, m + minSplitGap), 100.0 - minSplitGap)
    return (s, m, h)
  }

  /// The four region centres in `[0, 100]` axis units for a split triplet,
  /// ordered `[shadows, darks, lights, highlights]`.
  public static func regionCentres(
    shadow: Double, midtone: Double, highlight: Double
  ) -> [Double] {
    let (s, m, h) = orderedSplits(shadow: shadow, midtone: midtone, highlight: highlight)
    return [
      s * 0.5,
      (s + m) * 0.5,
      (m + h) * 0.5,
      (h + 100.0) * 0.5,
    ]
  }

  /// Evaluate the four smoothstep region weights `[w_shadows, w_darks,
  /// w_lights, w_highlights]` at axis coordinate `p` in `[0, 100]`, matching
  /// `parametric::region_windows`.
  public static func regionWindows(
    at p: Double,
    shadow: Double,
    midtone: Double,
    highlight: Double
  ) -> [Double] {
    let c = regionCentres(shadow: shadow, midtone: midtone, highlight: highlight)
    let s01 = smoothstep(c[0], c[1], p)
    let s12 = smoothstep(c[1], c[2], p)
    let s23 = smoothstep(c[2], c[3], p)
    let s3t = smoothstep(c[3], axisTop, p)
    return [1.0 - s01, s01 - s12, s12 - s23, s23 - s3t]
  }

  /// Sample the active region's window weight over `samples + 1` points
  /// across the scene-linear authoring axis for plotting a shaded envelope.
  public static func sampleRegionWindow(
    region: ParametricRegion,
    shadow: Double,
    midtone: Double,
    highlight: Double,
    samples: Int = 64
  ) -> [(x: Double, weight: Double)] {
    let idx = region.index
    let count = max(2, samples)
    return (0...count).map { i in
      let x = Double(i) / Double(count)
      let w = regionWindows(
        at: x > 0
          ? ParametricAxisTuning.midtone + ParametricAxisTuning.unitsPerStop
            * log2(x * ParametricAxisTuning.referenceMax / ParametricAxisTuning.midgrey) : 0,
        shadow: shadow, midtone: midtone, highlight: highlight
      )[idx]
      return (x: x, weight: max(0.0, min(1.0, w)))
    }
  }

  private static func smoothstep(_ a: Double, _ b: Double, _ p: Double) -> Double {
    guard b > a else { return p >= b ? 1.0 : 0.0 }
    let t = min(max((p - a) / (b - a), 0.0), 1.0)
    return t * t * (3.0 - 2.0 * t)
  }
}
