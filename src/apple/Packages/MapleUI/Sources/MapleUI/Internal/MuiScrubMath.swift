// MuiScrubMath.swift — shared pure value↔percentage math for the drag-based
// Form & entry molecules (MuiSlider, MuiLivingSlider, MuiDragBar). Kept
// side-effect-free so it's unit-testable without rendering a view or
// running a gesture. Mirrors the decisions in the web reference's
// `projects/maple-common/src/lib/ui/internal/pointer-drag.ts` (percent-in-
// range, signed-value formatting, step snapping) — ported as math, not as
// its pointer-capture plumbing, which SwiftUI's `DragGesture` replaces.

import Foundation

enum MuiScrubMath {
    /// A value's position within `[min, max]` as a `[0, 100]` percentage.
    /// `fallbackPct` covers the degenerate `min == max` case — each caller
    /// picks its own default (a centered thumb vs. an empty track).
    static func percentInRange(value: Double, min: Double, max: Double, fallbackPct: Double) -> Double {
        guard max != min else { return fallbackPct }
        return ((value - min) / (max - min)) * 100
    }

    /// Inverse of `percentInRange` — maps a `[0, 100]` percentage back to a
    /// value within `[min, max]`, clamped.
    static func valueFromPercent(_ pct: Double, min: Double, max: Double) -> Double {
        let raw = min + (pct / 100) * (max - min)
        return Swift.min(max, Swift.max(min, raw))
    }

    /// Rounds `value` to the nearest multiple of `step`, then clamps into
    /// `[min, max]`. `step <= 0` degrades to a plain clamp (no snapping).
    static func snap(_ value: Double, step: Double, min: Double, max: Double) -> Double {
        guard step > 0 else { return Swift.min(max, Swift.max(min, value)) }
        let snapped = (value / step).rounded() * step
        return Swift.min(max, Swift.max(min, snapped))
    }

    /// Formats a scrub control's numeric value with an explicit `+` sign for
    /// positive values and an optional unit suffix — the shared readout for
    /// `MuiSlider`/`MuiLivingSlider`. Decimal precision scales with the
    /// control's step size: sub-0.1 steps show 2 decimals, sub-1 steps show
    /// 1, whole steps show none.
    static func formatSignedValue(_ value: Double, step: Double, unit: String = "") -> String {
        let decimals = step < 0.1 ? 2 : (step < 1 ? 1 : 0)
        let formatted = String(format: "%.\(decimals)f", value)
        let signed = value > 0 ? "+\(formatted)" : formatted
        return unit.isEmpty ? signed : "\(signed) \(unit)"
    }
}
