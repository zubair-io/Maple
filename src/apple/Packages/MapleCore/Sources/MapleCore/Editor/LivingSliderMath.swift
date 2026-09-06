// LivingSliderMath.swift — Pro Editor Canvas-first (A1, #1536).
//
// Pure value↔percentage math for the LivingSlider track. Lives in MapleCore
// so it can be unit-tested without a SwiftUI dependency and shared between
// the slider view and any future canvas-overlay or keyboard-nudge handler.
//
// Two slider modes:
//   • Bipolar  — value range is symmetric around zero, e.g. [-4, +4] EV or
//                [-100, +100]. The zero point lands exactly at the midpoint.
//   • Unipolar — value range starts at zero (or an arbitrary lower bound),
//                e.g. [0, 150] for Sharpen or [0, 100] for NR.
//
// In both cases `pct` is in [0, 1] where 0 = left edge, 1 = right edge.
//
// The math is tolerant of edge cases (zero-width range → pct = 0, clamp).

import Foundation

public enum LivingSliderMath {

  /// Matches web tool-metadata.ts: keyboard precision follows the generated
  /// range, rather than a second per-tool step catalog.
  public static func keyboardStep(range: ClosedRange<Double>) -> Double {
    let width = range.upperBound - range.lowerBound
    if width <= 10 { return 0.01 }
    if width >= 5000 { return 50 }
    return 1
  }

  // MARK: - Value → Percentage

  /// Convert `value` to a track percentage [0, 1] for a bipolar slider
  /// whose range is `[-halfRange, +halfRange]`.
  ///
  /// `halfRange` is the absolute maximum (e.g. `4.0` for Exposure ±4 EV,
  /// `100.0` for a ±100 bipolar tool).
  ///
  ///     pct = (value + halfRange) / (2 × halfRange)
  ///
  /// Clamped to [0, 1].
  public static func pctBipolar(value: Double, halfRange: Double) -> Double {
    guard halfRange > 0 else { return 0 }
    return ((value + halfRange) / (2 * halfRange)).clamped01()
  }

  /// Convert `value` to a track percentage [0, 1] for a unipolar slider
  /// over `range`.
  ///
  ///     pct = (value − range.lowerBound) / range.length
  ///
  /// Clamped to [0, 1].
  public static func pctUnipolar(value: Double, range: ClosedRange<Double>) -> Double {
    let span = range.upperBound - range.lowerBound
    guard span > 0 else { return 0 }
    return ((value - range.lowerBound) / span).clamped01()
  }

  // MARK: - Percentage → Value

  /// Convert a track percentage [0, 1] to a value for a bipolar slider
  /// whose range is `[-halfRange, +halfRange]`.
  ///
  ///     value = pct × 2 × halfRange − halfRange
  ///
  /// Clamped to the range.
  public static func valueBipolar(pct: Double, halfRange: Double) -> Double {
    guard halfRange > 0 else { return 0 }
    let raw = pct.clamped01() * 2 * halfRange - halfRange
    return min(max(raw, -halfRange), halfRange)
  }

  /// Convert a track percentage [0, 1] to a value for a unipolar slider
  /// over `range`.
  ///
  ///     value = pct × range.length + range.lowerBound
  ///
  /// Clamped to the range.
  public static func valueUnipolar(pct: Double, range: ClosedRange<Double>) -> Double {
    let span = range.upperBound - range.lowerBound
    let raw = pct.clamped01() * span + range.lowerBound
    return min(max(raw, range.lowerBound), range.upperBound)
  }

  // MARK: - Value formatting

  /// Returns the display string for `value` over `range`.
  ///
  /// Rules:
  /// - Ranges wider than 10 units (e.g. –100…100) format with 0 decimal
  ///   places ("%.0f"); narrower ranges (e.g. –4…4 EV) use 2 ("%.2f").
  /// - Near-zero threshold is scaled by precision: `<= 0.5` for integer
  ///   formats, `< 0.005` for two-decimal formats, so that values that
  ///   would round to ±0 on an integer-range slider display as unsigned
  ///   `"0"` rather than `"+0"` or `"-0"`.
  /// - Values at or within the threshold format as `"0"` (unsigned).
  /// - Otherwise the string is signed: `"+N.NN"` or `"-N.NN"`.
  public static func format(value: Double, range: ClosedRange<Double>) -> String {
    let decimals = (range.upperBound - range.lowerBound) > 10 ? 0 : 2
    let absValue = abs(value)
    if decimals == 0 {
      // For integer format, suppress the sign whenever the value rounds to zero.
      // Use 0.5 (inclusive) as the threshold: values in (−0.5, +0.5] all
      // display as "0".  0.5 itself would format as "+0" via %.0f + sign logic,
      // so we catch it here instead.
      if absValue <= 0.5 { return "0" }
    } else {
      if absValue < 0.005 { return "0" }
    }
    let sign = value > 0 ? "+" : ""
    return sign + String(format: decimals == 0 ? "%.0f" : "%.2f", value)
  }

  // MARK: - Thumb position helpers

  /// Percentage position of the zero notch for a bipolar slider.
  ///
  /// For a symmetric range `[-halfRange, +halfRange]` this is always 0.5.
  /// Exposed as a named function for documentation clarity.
  public static func zeroPct(halfRange: Double) -> Double {
    pctBipolar(value: 0, halfRange: halfRange)
  }

  /// Percentage position of the lower bound for a unipolar slider —
  /// always 0.0 (left edge) when the range starts at zero.
  public static func zeroPctUnipolar(range: ClosedRange<Double>) -> Double {
    pctUnipolar(value: range.lowerBound, range: range)
  }
}

// MARK: - Private helper

extension Double {
  fileprivate func clamped01() -> Double {
    min(max(self, 0), 1)
  }
}
