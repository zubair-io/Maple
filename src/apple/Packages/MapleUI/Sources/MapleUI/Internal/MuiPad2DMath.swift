// MuiPad2DMath.swift — pure x/y↔point math for MuiPad2D. Mirrors the web
// reference's `mui-pad-2d.component.ts`: `x` right-positive, `y`
// up-positive, both clamped to `[-1, 1]`. Kept side-effect-free so it's
// unit-testable without rendering a view or running a gesture.

import Foundation

enum MuiPad2DMath {
    static func clamp(_ v: Double) -> Double {
        Swift.max(-1, Swift.min(1, v))
    }

    /// Converts a pointer's fractional position within the pad — `fracX`/
    /// `fracY` in `[0, 1]`, box coordinates (top-left origin, `y` grows
    /// down) — into an `x`/`y` pair in `[-1, 1]` (right/up positive).
    static func value(fracX: Double, fracY: Double) -> (x: Double, y: Double) {
        (x: clamp(fracX * 2 - 1), y: clamp(1 - fracY * 2))
    }

    /// Puck position for a given `x`/`y`, as box coordinates — the inverse
    /// of `value(fracX:fracY:)`.
    static func puckPosition(x: Double, y: Double) -> (leftPct: Double, topPct: Double) {
        (leftPct: (x + 1) * 50, topPct: (1 - y) * 50)
    }
}
