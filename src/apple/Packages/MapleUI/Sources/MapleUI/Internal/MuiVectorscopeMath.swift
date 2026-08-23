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
}
