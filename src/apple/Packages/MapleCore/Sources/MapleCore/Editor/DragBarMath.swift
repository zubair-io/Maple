// DragBarMath.swift — responsive-program S5b (#625).
//
// Pure value↔pixel math for the drag-bar primitive. Lives in MapleCore so
// the same math can be unit-tested without a SwiftUI dependency and shared
// between the bar's gesture handler and the canvas overlay's drag handler.
//
// Internal value scale: [-100, +100]. Mapping to pixels:
//   marker x = (50 + value/2) % of bar width.
//
// Three sensitivity modes:
//   • barDrag    — 1:1.    Δvalue = Δpx / barWidth * 200
//   • canvasDrag — 0.5:1.  Δvalue = Δpx / barWidth * 200 * 0.5
//   • fineDrag   — 0.25:1. Δvalue = Δpx / barWidth * 200 * 0.25
//
// Spec: docs/design/responsive-program/s5-editor.md §3.

import Foundation

public enum DragSensitivity: Double, Sendable, Hashable {
    case bar    = 1.0
    case canvas = 0.5
    case fine   = 0.25
}

public enum DragBarMath {
    /// Internal value range — [-100, +100].
    public static let valueMin: Double = -100
    public static let valueMax: Double = 100

    /// 21 ticks at 5% increments. Index 10 is the center (50%).
    public static let tickCount: Int = 21
    public static let centerTickIndex: Int = 10
    /// Height of the center tick in points (spec §3 — "14pt").
    public static let centerTickHeight: CGFloat = 14
    /// Height of the non-center ticks (spec §3 — "6pt").
    public static let regularTickHeight: CGFloat = 6
    /// Marker width × height (spec §3 — "2pt × 22pt").
    public static let markerWidth: CGFloat = 2
    public static let markerHeight: CGFloat = 22

    /// Clamp `v` to the value range.
    public static func clamp(_ v: Double) -> Double {
        min(max(v, valueMin), valueMax)
    }

    /// Map an internal value to the marker's center-x within a bar of
    /// width `barWidth` points. Value `0` lands at the bar's center.
    public static func markerX(forValue v: Double, barWidth: CGFloat) -> CGFloat {
        let pct = 0.5 + clamp(v) / 200.0   // [-100,100] → [0,1]
        return barWidth * pct
    }

    /// Inverse — map a pointer x to an internal value, clamped.
    public static func value(forPointerX x: CGFloat, barWidth: CGFloat) -> Double {
        guard barWidth > 0 else { return 0 }
        let pct = Double(x / barWidth)
        let raw = (pct - 0.5) * 200
        return clamp(raw)
    }

    /// Translate a pointer delta (px) into a value delta given a
    /// sensitivity mode and bar width.
    public static func valueDelta(forDeltaX dx: CGFloat,
                                  barWidth: CGFloat,
                                  sensitivity: DragSensitivity) -> Double
    {
        guard barWidth > 0 else { return 0 }
        return (Double(dx) / Double(barWidth)) * 200 * sensitivity.rawValue
    }

    /// Layout helper — returns the center-x of tick `i` in a `barWidth`-
    /// wide bar (ticks evenly spread, edges at 0 and barWidth).
    public static func tickX(forIndex i: Int, barWidth: CGFloat) -> CGFloat {
        precondition(i >= 0 && i < tickCount, "tick index out of range")
        return barWidth * CGFloat(i) / CGFloat(tickCount - 1)
    }

    /// Height of tick `i` — 14pt for the center, 6pt otherwise.
    public static func tickHeight(forIndex i: Int) -> CGFloat {
        i == centerTickIndex ? centerTickHeight : regularTickHeight
    }

    /// `true` when the value moved across the zero line on this update
    /// (used for the .light haptic trigger).
    public static func didCrossZero(from a: Double, to b: Double) -> Bool {
        (a < 0 && b >= 0) || (a > 0 && b <= 0) || (a == 0 && b != 0)
    }

    /// `true` when the value just landed on or past one of the extremes
    /// (used for the .medium haptic trigger).
    public static func didReachExtreme(from a: Double, to b: Double) -> Bool {
        (a > valueMin && b <= valueMin) || (a < valueMax && b >= valueMax)
    }
}
