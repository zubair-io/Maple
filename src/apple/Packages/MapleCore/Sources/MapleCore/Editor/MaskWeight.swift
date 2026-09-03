// MaskWeight.swift — per-pixel mask weight `w ∈ [0, 1]` for a local
// adjustment (#355): a Swift port of raw-core's
// `stages/local_adjustments/mask.rs::evaluate`, kept 1:1 so the weight
// overlay the editor draws over the canvas is a direct read of what the
// render pipeline applies, not a second definition of the mask.
//
// Inputs are normalized full-frame image coordinates — `x ∈ [0, 1]`
// left→right, `y ∈ [0, 1]` top→bottom. Aspect ratio is NOT corrected here
// (same convention as the Rust evaluator): a "circular" radial mask on a
// 3:2 image is an ellipse on screen unless the UI pre-corrects the radii.
//
// Pure functions, no allocation — `MaskWeightTests` pins them against the
// analytic points the Rust module's own tests check.

import Foundation

public enum MaskWeight {
    /// Smoothstep S(t) = 3t² − 2t³, clamped to [0, 1].
    static func smoothstep(_ t: Double) -> Double {
        let c = min(1, max(0, t))
        return c * c * (3 - 2 * c)
    }

    /// The mask weight at normalized point (`x`, `y`).
    public static func evaluate(_ mask: LocalMask, x: Double, y: Double) -> Double {
        switch mask {
        case .linear(let start, let end, let feather):
            return linear(start: start, end: end, feather: feather, x: x, y: y)
        case .radial(let center, let radii, let angle, let feather, let invert):
            let w = radial(center: center, radii: radii, angle: angle, feather: feather, x: x, y: y)
            return invert ? 1 - w : w
        }
    }

    /// Linear gradient weight along `start → end`: the parametric position
    /// `t` of the point projected onto the gradient line, ramped by a
    /// smoothstep over a band of width `feather` centered on `t = 0.5`.
    /// `feather == 0` is a hard step; a degenerate (zero-length) gradient
    /// weighs 0 everywhere rather than dividing by zero.
    static func linear(start: MaskPoint, end: MaskPoint, feather: Double, x: Double, y: Double) -> Double {
        let dx = end.x - start.x
        let dy = end.y - start.y
        let lenSq = dx * dx + dy * dy
        guard lenSq > Double(Float.ulpOfOne) else { return 0 }
        let t = ((x - start.x) * dx + (y - start.y) * dy) / lenSq
        let f = min(1, max(0, feather))
        guard f > Double(Float.ulpOfOne) else { return t < 0.5 ? 0 : 1 }
        let lo = 0.5 - f * 0.5
        let hi = 0.5 + f * 0.5
        return smoothstep((t - lo) / (hi - lo))
    }

    /// Radial weight against an ellipse with half-axes `radii`, rotated by
    /// `angle` radians about `center`: 1 inside the inner radius
    /// (`1 − feather` of the geometric ellipse), 0 outside it, a smoothstep
    /// falloff between. A zero radius weighs 0 everywhere.
    static func radial(
        center: MaskPoint, radii: MaskPoint, angle: Double, feather: Double, x: Double, y: Double
    ) -> Double {
        guard abs(radii.x) > Double(Float.ulpOfOne), abs(radii.y) > Double(Float.ulpOfOne) else { return 0 }
        let cosA = cos(angle)
        let sinA = sin(angle)
        let dx = x - center.x
        let dy = y - center.y
        // Inverse-rotate the sample into the ellipse's local frame.
        let lx = cosA * dx + sinA * dy
        let ly = -sinA * dx + cosA * dy
        let d = ((lx / radii.x) * (lx / radii.x) + (ly / radii.y) * (ly / radii.y)).squareRoot()
        let f = min(1, max(0, feather))
        guard f > Double(Float.ulpOfOne) else { return d <= 1 ? 1 : 0 }
        let lo = 1 - f
        return 1 - smoothstep((d - lo) / (1 - lo))
    }
}
