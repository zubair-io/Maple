// MuiColorWheelMath.swift — pure hue/saturation↔point math for MuiColorWheel.
// Mirrors the web reference's `mui-color-wheel.component.ts` polar
// convention: hue 0° = right (+x axis), increasing counter-clockwise; puck
// radius = saturation. Kept side-effect-free so it's unit-testable without
// rendering a view or running a gesture.

import Foundation

enum MuiColorWheelMath {
    /// Wraps `deg` into `[0, 360)`. Normalizes `-0` to `0` so a value
    /// comparison never sees a sign-only mismatch (e.g. from `atan2(-0, 1)`
    /// at a pointer exactly on the +x axis).
    static func wrapHue(_ deg: Double) -> Double {
        let wrapped = deg.truncatingRemainder(dividingBy: 360)
        let normalized = wrapped < 0 ? wrapped + 360 : wrapped
        return normalized == 0 ? 0 : normalized
    }

    static func clamp01(_ v: Double) -> Double {
        Swift.min(1, Swift.max(0, v))
    }

    /// Converts a pointer offset from the wheel's center — `dx`/`dy`
    /// normalized to `[-1, 1]` where right/up are positive — into a
    /// hue/saturation pair. A pointer exactly on the center (`dx == dy ==
    /// 0`) keeps `currentHue` rather than producing an undefined angle.
    static func value(dx: Double, dy: Double, currentHue: Double) -> (hue: Double, saturation: Double) {
        let radius = Swift.min(1, (dx * dx + dy * dy).squareRoot())
        let hue = radius == 0 ? currentHue : wrapHue(atan2(dy, dx) * 180 / .pi)
        let roundedHue = hue.rounded().truncatingRemainder(dividingBy: 360)
        return (hue: roundedHue, saturation: (radius * 100).rounded())
    }

    /// Puck position for a given hue/saturation, as box coordinates — `left`
    /// grows right, `top` grows down — the inverse of `value(dx:dy:currentHue:)`.
    static func puckPosition(hue: Double, saturation: Double) -> (leftPct: Double, topPct: Double) {
        let radius = clamp01(saturation / 100)
        let rad = wrapHue(hue) * .pi / 180
        let x = radius * cos(rad)
        let y = radius * sin(rad)
        return (leftPct: (x + 1) * 50, topPct: (1 - y) * 50)
    }
}
