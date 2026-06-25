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

private extension Double {
    func clamped01() -> Double {
        min(max(self, 0), 1)
    }
}
