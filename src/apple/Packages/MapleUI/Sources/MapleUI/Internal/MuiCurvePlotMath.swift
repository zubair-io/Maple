// MuiCurvePlotMath.swift — pure point/curve math for MuiCurvePlot
// (unified-component-catalog.md §2.6). Mirrors the web reference's
// `mui-curve-plot`: points are 0...1 normalized (x right-positive, y
// up-positive — canvas y is flipped since screen y grows down), hit-tested
// by pixel radius, and smoothed with the same "midpoint-quadratic" curve —
// each interior control point bends the curve without ever overshooting
// past it, since the curve's abscissa is a Bernstein blend of three
// non-decreasing x's (prior midpoint <= this point's x <= next midpoint)
// whenever the input points are sorted by x. That's what keeps the curve
// monotone in x by construction, the way a tone curve must be.

import Foundation
import CoreGraphics

enum MuiCurvePlotMath {
    static let hitRadius: CGFloat = 8
    static let nudgeStep = 0.02

    static func clampUnit(_ v: Double) -> Double {
        Swift.max(0, Swift.min(1, v))
    }

    /// Normalized point -> canvas pixel, for a plot of `width`x`height`.
    static func toCanvasPoint(_ p: MuiCurvePoint, width: CGFloat, height: CGFloat) -> CGPoint {
        CGPoint(x: p.x * width, y: (1 - p.y) * height)
    }

    /// Canvas pixel -> normalized point, clamped into `[0, 1]`. The inverse
    /// of `toCanvasPoint`.
    static func fromCanvasPoint(_ point: CGPoint, width: CGFloat, height: CGFloat) -> MuiCurvePoint {
        guard width > 0, height > 0 else { return MuiCurvePoint(x: 0, y: 0) }
        return MuiCurvePoint(
            x: clampUnit(Double(point.x / width)),
            y: clampUnit(1 - Double(point.y / height))
        )
    }

    /// The index of whichever point's canvas position is within
    /// `hitRadius` of `location`, or `nil` if none qualify. First match
    /// wins (matches the web reference's linear scan).
    static func hitTest(_ points: [MuiCurvePoint], location: CGPoint, width: CGFloat, height: CGFloat) -> Int? {
        for (index, p) in points.enumerated() {
            let c = toCanvasPoint(p, width: width, height: height)
            let dx = c.x - location.x
            let dy = c.y - location.y
            if (dx * dx + dy * dy).squareRoot() <= hitRadius { return index }
        }
        return nil
    }

    /// Arrow-key nudge: moves one point by `(dx, dy)` normalized units,
    /// clamped back into `[0, 1]`.
    static func nudged(_ p: MuiCurvePoint, dx: Double, dy: Double) -> MuiCurvePoint {
        MuiCurvePoint(x: clampUnit(p.x + dx), y: clampUnit(p.y + dy))
    }

    /// `points` converted to canvas pixels and sorted by x — the order the
    /// curve is actually drawn in, regardless of the order points were
    /// supplied or dragged into.
    static func sortedCanvasPoints(_ points: [MuiCurvePoint], width: CGFloat, height: CGFloat) -> [CGPoint] {
        points.sorted { $0.x < $1.x }.map { toCanvasPoint($0, width: width, height: height) }
    }

    /// One interior "curve to" step of the midpoint-quadratic path:
    /// `control` bends the curve, `end` is the midpoint it lands on (the
    /// final point's own true position is a plain trailing line, not part
    /// of this list — see `MuiCurvePlot`'s `Path` construction).
    struct Segment: Equatable {
        let control: CGPoint
        let end: CGPoint
    }

    /// Builds the interior midpoint-quadratic segments for an already
    /// sorted-by-x canvas point list (`sortedCanvasPoints`'s output). The
    /// drawn path starts at `points[0]`, runs each of these as a quadratic
    /// curve, then finishes with a plain line to `points.last`.
    static func segments(forSortedCanvasPoints points: [CGPoint]) -> [Segment] {
        guard points.count >= 2 else { return [] }
        guard points.count > 2 else { return [] }
        var result: [Segment] = []
        for i in 1..<(points.count - 1) {
            let mid = CGPoint(x: (points[i].x + points[i + 1].x) / 2, y: (points[i].y + points[i + 1].y) / 2)
            result.append(Segment(control: points[i], end: mid))
        }
        return result
    }

    /// A point at parameter `t` (`0...1`) along the quadratic Bezier
    /// `start -> control -> end`. Exposed for monotonicity testing — the
    /// view itself never needs to sample a curve it hands straight to
    /// `Path.addQuadCurve`.
    static func quadraticBezierPoint(start: CGPoint, control: CGPoint, end: CGPoint, t: Double) -> CGPoint {
        let mt = 1 - t
        let x = mt * mt * Double(start.x) + 2 * mt * t * Double(control.x) + t * t * Double(end.x)
        let y = mt * mt * Double(start.y) + 2 * mt * t * Double(control.y) + t * t * Double(end.y)
        return CGPoint(x: x, y: y)
    }
}
