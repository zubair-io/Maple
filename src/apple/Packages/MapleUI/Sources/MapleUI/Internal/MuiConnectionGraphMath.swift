// MuiConnectionGraphMath.swift — pure layout/mapping math for
// MuiConnectionGraph (unified-component-catalog.md §2.6). The web
// reference draws whatever normalized 0...1 node positions the caller
// supplies — it never computes a layout itself. MuiConnectionGraph keeps
// that same contract (an explicit `x`/`y` per node) and additionally
// offers `circularLayout` as a deterministic fallback for callers with no
// real spatial layout of their own (e.g. the gallery's fixed sample data):
// no randomness, no force simulation, no iteration — same node count in,
// same positions out, every time.

import Foundation
import CoreGraphics

enum MuiConnectionGraphMath {
    /// `nodeCount` positions spaced evenly around a circle, normalized to
    /// `[0, 1]`. Node 0 sits at the top (12 o'clock); the rest proceed
    /// clockwise. Returns an empty array for `nodeCount <= 0`.
    static func circularLayout(
        nodeCount: Int,
        centerFraction: Double = 0.5,
        radiusFraction: Double = 0.4
    ) -> [(x: Double, y: Double)] {
        guard nodeCount > 0 else { return [] }
        return (0..<nodeCount).map { i in
            let angle = -Double.pi / 2 + (2 * Double.pi * Double(i) / Double(nodeCount))
            return (
                x: centerFraction + radiusFraction * cos(angle),
                y: centerFraction + radiusFraction * sin(angle)
            )
        }
    }

    /// Scales a normalized `[0, 1]` node position into canvas pixels.
    static func canvasPoint(x: Double, y: Double, width: CGFloat, height: CGFloat) -> CGPoint {
        CGPoint(x: CGFloat(x) * width, y: CGFloat(y) * height)
    }
}
