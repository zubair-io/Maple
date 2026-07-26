// ToneCurveEditing.swift — curve evaluation + point-list editing for the
// SwiftUI curve widget (#367).
//
// Two halves, both pure value math with no SwiftUI import, so they unit-test
// under `swift test` without a host app:
//
//   * `ToneCurveMath` — a port of
//     `raw_core::stages::tone_curves::evaluator` (Fritsch–Carlson monotonic
//     cubic Hermite). The widget MUST draw the shape the pipeline actually
//     renders; a plot that interpolates differently is a lie about what the
//     photo will look like. The port stays in the `[0, 1]` AUTHORING domain
//     only — the authoring → scene-linear mapping (`REF_MAX`, the tanh
//     soft-knee above 0.98) belongs to the stage and has no meaning on a
//     curve plot.
//
//   * `ToneCurveEditing` — the rules that keep an authored list well-formed
//     for that stage: sorted by `x`, inside the authoring domain, and never
//     two knots at the same `x` (the stage's `prepare_curve` de-duplicates
//     equal-x neighbours, so allowing that state would draw a knot the
//     render silently ignores).
//
// Identity is the EMPTY list on all three platforms, which is what keeps an
// unedited sidecar byte-clean (#365). "Reset" therefore means empty, not the
// two corner anchors: `[(0,0), (1,1)]` renders identically but would
// serialize a `papp:SceneLinearToneCurve` block into a file the user never
// drew on.
//
// The TypeScript twins are `tone-curve-math.ts` / `tone-curve-edit.ts`, and
// the three ports are pinned to one another by the sample table in
// `ToneCurveMathTests` / `tone-curve.spec.ts` / raw-core's
// `monotonic_cubic_matches_the_cross_platform_parity_anchor`.

import Foundation

// MARK: - ToneCurveMath

public enum ToneCurveMath {

    /// Knots plus their monotonicity-guarded tangents, computed once so
    /// sampling the curve for a path does no per-sample work.
    /// Mirrors `evaluator::PreparedCurve`.
    public struct Prepared {
        public let knots: [ToneCurvePoint]
        public let tangents: [Double]
    }

    /// Sort by `x`, clamp into the authoring domain and drop equal-x
    /// neighbours (last-write-wins), then compute Fritsch–Carlson tangents.
    /// Mirrors `prepare_curve`.
    public static func prepare(_ points: [ToneCurvePoint]) -> Prepared {
        let sorted = points
            .map { (x: $0.x.clamped01, y: $0.y.clamped01) }
            .sorted { $0.x < $1.x }
        // Keep the LATER of two equal-x knots, matching the Rust
        // `dedup_by` whose body is `*prev = *next`.
        let knots = sorted.enumerated().compactMap { index, point -> ToneCurvePoint? in
            index == sorted.count - 1 || sorted[index + 1].x != point.x ? point : nil
        }
        return Prepared(knots: knots, tangents: tangents(for: knots))
    }

    private static func tangents(for knots: [ToneCurvePoint]) -> [Double] {
        let n = knots.count
        guard n >= 2 else { return [] }

        let slopes = (0..<(n - 1)).map { i in
            (knots[i + 1].y - knots[i].y) / (knots[i + 1].x - knots[i].x)
        }

        // Endpoints take the one-sided slope; an interior knot whose two
        // adjacent slopes disagree in sign gets a zero tangent, forcing the
        // local extremum onto the knot instead of overshooting past it.
        var t: [Double] = [slopes[0]]
        for i in 1..<(n - 1) {
            t.append(slopes[i - 1] * slopes[i] <= 0 ? 0 : (slopes[i - 1] + slopes[i]) * 0.5)
        }
        t.append(slopes[n - 2])

        // Monotonicity guard: project each (alpha, beta) pair into the
        // circle of radius 3, and zero both tangents across a flat segment.
        for i in 0..<(n - 1) {
            let m = slopes[i]
            if abs(m) < .ulpOfOne {
                t[i] = 0
                t[i + 1] = 0
                continue
            }
            let alpha = t[i] / m
            let beta = t[i + 1] / m
            let magnitude = (alpha * alpha + beta * beta).squareRoot()
            if magnitude > 3 {
                let scale = 3 / magnitude
                t[i] = scale * alpha * m
                t[i + 1] = scale * beta * m
            }
        }
        return t
    }

    /// Evaluate the prepared curve at `x` in the authoring `[0, 1]` domain.
    /// Mirrors `eval_monotonic_cubic`: an empty curve is the identity and a
    /// single-knot curve is that knot's constant `y`, exactly as the stage
    /// treats them.
    public static func evaluate(_ curve: Prepared, at x: Double) -> Double {
        let knots = curve.knots
        let n = knots.count
        if n == 0 { return x.clamped01 }
        if n == 1 { return knots[0].y }
        if x <= knots[0].x { return knots[0].y }
        if x >= knots[n - 1].x { return knots[n - 1].y }

        var i = 0
        while i < n - 2 && knots[i + 1].x <= x { i += 1 }

        let (x0, y0) = knots[i]
        let (x1, y1) = knots[i + 1]
        let h = x1 - x0
        let t = (x - x0) / h
        let t2 = t * t
        let t3 = t2 * t
        let y =
            (2 * t3 - 3 * t2 + 1) * y0
            + (t3 - 2 * t2 + t) * h * curve.tangents[i]
            + (-2 * t3 + 3 * t2) * y1
            + (t3 - t2) * h * curve.tangents[i + 1]
        return y.clamped01
    }

    /// Sample the curve into `samples + 1` points in the authoring domain,
    /// for the widget's stroked path. y is NOT flipped here; the view owns
    /// the single flip into its own coordinate space.
    public static func sample(_ points: [ToneCurvePoint], samples: Int = 64) -> [ToneCurvePoint] {
        let curve = prepare(points)
        return (0...samples).map { i in
            let x = Double(i) / Double(samples)
            return (x: x, y: evaluate(curve, at: x))
        }
    }
}

// MARK: - ToneCurveEditing

public enum ToneCurveEditing {

    /// Closest approach, in authoring-domain units, that two knots may have.
    public static let minXGap = 1.0 / 256.0

    /// The list to edit against. An identity (empty) curve materialises as
    /// the two corner anchors, so a user's first tap produces a curve WITH
    /// endpoints rather than a lone knot — which the stage evaluates as a
    /// constant output, flattening the image to one tone.
    public static func materialize(_ points: [ToneCurvePoint]) -> [ToneCurvePoint] {
        points.isEmpty ? [(x: 0, y: 0), (x: 1, y: 1)] : points.sorted { $0.x < $1.x }
    }

    /// Insert a knot at `(x, y)`. Returns the list unchanged when the
    /// position would collide with an existing knot's `x`.
    public static func insert(
        _ points: [ToneCurvePoint], x: Double, y: Double
    ) -> [ToneCurvePoint] {
        let list = materialize(points)
        let px = x.clamped01
        guard !list.contains(where: { abs($0.x - px) < minXGap }) else { return list }
        return (list + [(x: px, y: y.clamped01)]).sorted { $0.x < $1.x }
    }

    /// Move knot `index` to `(x, y)`. The two endpoints are pinned to their
    /// `x` (0 and 1) and move only vertically: dragging a corner inward
    /// would leave the curve undefined over part of its own domain, where
    /// the stage clamps to the terminal knot's `y` and produces a flat
    /// shoulder the user never drew. Interior knots stay strictly between
    /// their neighbours.
    public static func move(
        _ points: [ToneCurvePoint], index: Int, x: Double, y: Double
    ) -> [ToneCurvePoint] {
        let list = materialize(points)
        guard index >= 0, index < list.count else { return list }
        let isFirst = index == 0
        let isLast = index == list.count - 1
        let lower = isFirst ? 0 : list[index - 1].x + minXGap
        let upper = isLast ? 1 : list[index + 1].x - minXGap
        let nextX = isFirst ? 0 : isLast ? 1 : min(max(x.clamped01, lower), upper)
        return list.enumerated().map { i, point in
            i == index ? (x: nextX, y: y.clamped01) : point
        }
    }

    /// Delete knot `index`. Endpoints are not deletable. Deleting back down
    /// to the bare corner anchors returns the EMPTY list — the canonical
    /// identity — so a user who removes every knot they added leaves the
    /// sidecar as clean as they found it.
    public static func remove(_ points: [ToneCurvePoint], index: Int) -> [ToneCurvePoint] {
        let list = materialize(points)
        guard index > 0, index < list.count - 1 else { return list }
        let next = list.enumerated().filter { $0.offset != index }.map(\.element)
        return isBareIdentity(next) ? [] : next
    }

    /// True for the two-corner-anchor list that renders as the identity.
    public static func isBareIdentity(_ points: [ToneCurvePoint]) -> Bool {
        points.count == 2
            && points[0].x == 0 && points[0].y == 0
            && points[1].x == 1 && points[1].y == 1
    }

    /// Index of the knot within `radius` (authoring units) of `(x, y)`, or
    /// `nil`. A drag that starts on a knot moves it; one that starts on
    /// empty plot adds a new one.
    public static func hitTest(
        _ points: [ToneCurvePoint], x: Double, y: Double, radius: Double
    ) -> Int? {
        let list = materialize(points)
        let best = list.enumerated()
            .map { (index: $0.offset, distance: hypot($0.element.x - x, $0.element.y - y)) }
            .min { $0.distance < $1.distance }
        guard let best, best.distance <= radius else { return nil }
        return best.index
    }
}

// MARK: - Clamp helper

extension Double {
    fileprivate var clamped01: Double { self < 0 ? 0 : self > 1 ? 1 : self }
}
