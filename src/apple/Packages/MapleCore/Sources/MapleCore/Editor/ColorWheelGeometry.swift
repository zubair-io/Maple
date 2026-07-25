// ColorWheelGeometry.swift — pure geometry for the Color Grading hue/
// saturation wheels (#275). Swift sibling to `CropGeometry.swift`: no
// SwiftUI, plain maps over explicit inputs so the puck-position ↔
// (hue, saturation) conversion is unit-testable in isolation, exactly the
// split `CropOverlay` uses for its own gesture math.
//
// Coordinate space: the puck lives in a NORMALIZED unit square [0, 1] × [0, 1]
// wrapping the wheel's disc — (0.5, 0.5) is the centre (saturation 0), and
// the inscribed circle of radius 0.5 is the rim (saturation 100). `y` grows
// downward (SwiftUI's convention), so the geometry negates `dy` before
// taking the angle: hue 0° sits at the RIGHT (3 o'clock) and increases
// counter-clockwise, matching a conventional on-screen colour wheel.
//
// This is a UI convention only — `raw_core::stages::color_grade` treats hue
// as an abstract angle around the Oklab (a, b) plane
// (`c * hue.cos(), c * hue.sin()`) with no wheel-visual requirement, so any
// self-consistent, reversible mapping here is correct.

import Foundation

public enum ColorWheelGeometry {
    /// A puck position in the wheel's normalized unit square.
    public struct Position: Equatable, Sendable {
        public var x: Double
        public var y: Double

        public init(x: Double, y: Double) {
            self.x = x
            self.y = y
        }
    }

    /// Radius (in normalized units) of the wheel's rim from its centre.
    static let rimRadius: Double = 0.5

    /// Puck position → (hue degrees `[0, 360)`, saturation `[0, 100]`).
    /// Positions outside the unit disc clamp to the rim (saturation 100)
    /// along the same ray, so an overshooting drag still tracks the
    /// nearest edge colour instead of losing the gesture.
    public static func hueSaturation(at position: Position) -> (hue: Double, saturation: Double) {
        let dx = position.x - 0.5
        let dy = position.y - 0.5
        let radius = (dx * dx + dy * dy).squareRoot()
        let saturation = min(radius / rimRadius, 1.0) * 100.0
        // Negate dy: SwiftUI's y grows downward, so this makes "up" read
        // as 90° instead of -90°.
        let radians = atan2(-dy, dx)
        let degrees = radians * 180.0 / .pi
        let normalized = degrees < 0 ? degrees + 360.0 : degrees
        return (hue: normalized, saturation: saturation)
    }

    /// Inverse of `hueSaturation(at:)`. `saturation` is clamped to
    /// `[0, 100]` before mapping onto the rim radius, and `hue` is taken
    /// modulo 360° in either direction, so any value the model can hold
    /// (per the generated `AdjustmentModel` ranges) always lands inside
    /// the unit square.
    public static func position(hue: Double, saturation: Double) -> Position {
        let clampedSaturation = min(max(saturation, 0), 100)
        let radius = (clampedSaturation / 100.0) * rimRadius
        let radians = hue * .pi / 180.0
        let dx = radius * cos(radians)
        let dy = -radius * sin(radians)
        return Position(x: 0.5 + dx, y: 0.5 + dy)
    }

    /// Arrow-key nudge for keyboard / VoiceOver access: `dx` steps hue by
    /// `step` degrees, `dy` steps saturation by `step` points. `dx`/`dy`
    /// are typically -1, 0, or +1 per key event. Hue wraps at the 360° seam
    /// (never goes negative or ≥ 360); saturation clamps to `[0, 100]`.
    public static func nudge(
        hue: Double, saturation: Double, dx: Int, dy: Int, step: Double = 2
    ) -> (hue: Double, saturation: Double) {
        let rawHue = (hue + Double(dx) * step).truncatingRemainder(dividingBy: 360.0)
        let wrappedHue = rawHue < 0 ? rawHue + 360.0 : rawHue
        let nextSaturation = min(max(saturation + Double(dy) * step, 0), 100)
        return (hue: wrappedHue, saturation: nextSaturation)
    }
}
