// MuiVectorscopeMath.swift — pure chroma math for MuiVectorscope
// (unified-component-catalog.md §2.6). Mirrors the web reference exactly:
// each RGB sample (0...1 per channel) converts to a BT.601 Cb/Cr pair, then
// plots onto the scope's circular canvas with Cb growing right and Cr
// growing up (canvas y is flipped, since screen y grows down).

import Foundation
import CoreGraphics

enum MuiVectorscopeMath {
    /// BT.601 luma-independent chroma pair for an RGB sample.
    static func chroma(r: Double, g: Double, b: Double) -> (cb: Double, cr: Double) {
        let cb = -0.168736 * r - 0.331264 * g + 0.5 * b
        let cr = 0.5 * r - 0.418688 * g - 0.081312 * b
        return (cb, cr)
    }

    /// Maps a chroma pair onto the scope's canvas: `cb` grows right, `cr`
    /// grows up. Matches the web reference's
    /// `x = cx + cb*radius*2`, `y = cy - cr*radius*2`.
    static func canvasPoint(cb: Double, cr: Double, center: CGPoint, radius: CGFloat) -> CGPoint {
        CGPoint(x: center.x + CGFloat(cb) * radius * 2, y: center.y - CGFloat(cr) * radius * 2)
    }

    /// Rec.709 luma-independent chroma — matches raw-core's
    /// `scope::vectorscope::cb_cr_rec709` exactly (spec §11: display-
    /// referred Rec.709, the GPU/CPU scope pass's own space, distinct from
    /// `chroma`'s BT.601 used by the legacy per-sample dot-scatter path).
    static func chromaRec709(r: Double, g: Double, b: Double) -> (cb: Double, cr: Double) {
        (
            -0.114572 * r - 0.385428 * g + 0.5 * b,
            0.5 * r - 0.454153 * g - 0.045847 * b
        )
    }

    /// The broadcast graticule angle (degrees, 0° = +cb axis, CCW) of each
    /// primary/secondary target — derived from `chromaRec709` of the pure
    /// colour itself, so the six dots can never drift from the plotted math.
    static func targetAngleDeg(_ target: VectorscopeTarget) -> Double {
        let rgb: (Double, Double, Double)
        switch target {
        case .red: rgb = (1, 0, 0)
        case .magenta: rgb = (1, 0, 1)
        case .blue: rgb = (0, 0, 1)
        case .cyan: rgb = (0, 1, 1)
        case .green: rgb = (0, 1, 0)
        case .yellow: rgb = (1, 1, 0)
        }
        let c = chromaRec709(r: rgb.0, g: rgb.1, b: rgb.2)
        return atan2(c.cr, c.cb) * 180 / .pi
    }

    /// Rotate a chroma pair by `degrees` counter-clockwise about the origin.
    static func rotated(cb: Double, cr: Double, by degrees: Double) -> (cb: Double, cr: Double) {
        let rad = degrees * .pi / 180
        return (cb * cos(rad) - cr * sin(rad), cb * sin(rad) + cr * cos(rad))
    }

    /// Broadcast-convention skin-tone line angle (spec §11 — a graticule
    /// constant, independent of `RangeRefinement.skinTone`'s Oklab hue).
    static let skinToneLineAngleDeg: Double = 123.0
    static let skinToneLineWedgeDeg: Double = 10.0
}

/// The six broadcast-graticule primary/secondary targets a vectorscope
/// plots, in the ACTUAL counter-clockwise order the Rec.709 matrix puts
/// them in (verified against `chromaRec709` of each pure colour — this is
/// NOT a uniform 60°-per-step wheel: real vectorscope targets alternate
/// between roughly 54° and 72° gaps, a well-known property of how the eye's
/// hue sensitivity is baked into these coefficients, not a bug).
enum VectorscopeTarget: CaseIterable {
    case red, yellow, green, cyan, blue, magenta
}
