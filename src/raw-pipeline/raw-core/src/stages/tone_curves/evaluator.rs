//! Curve preparation + evaluation primitives for the tone-curve stage.
//!
//! Pulled out of `mod.rs` to keep both files under the 600-LOC hard cap.
//! These functions are pure-math and unit-tested in isolation; the stage
//! entry points in `mod.rs` consume them via `pub(super)` visibility.

use crate::types::adjustment::{ToneCurve, ToneCurvePoint};

/// Mapping from the curve editor's `[0, 1]` authoring domain to scene-
/// linear `[0, REF_MAX]`. The paper § 4.6 motivates the value: two stops
/// above diffuse white (`log2(4) = 2`) leaves AgX-friendly headroom for
/// specular highlights while still letting the curve editor cover the
/// useful midtone-to-bright range with one knot per region.
pub(super) const REF_MAX: f32 = 4.0;

/// Sort the curve's control points by `x` ascending and clamp them into
/// the `[0, 1]` × `[0, 1]` authoring domain. The evaluator requires
/// strictly increasing x; if two points share an x value we keep the
/// later one (last-write-wins matches the way UI editors typically draw
/// curves when the user drags through an existing knot).
pub(super) fn prepare_curve(curve: &ToneCurve) -> Vec<ToneCurvePoint> {
    let mut pts: Vec<ToneCurvePoint> = curve
        .points
        .iter()
        .map(|&(x, y)| (x.clamp(0.0, 1.0), y.clamp(0.0, 1.0)))
        .collect();
    pts.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    // De-duplicate equal-x neighbours, last-write-wins.
    pts.dedup_by(|next, prev| {
        if (next.0 - prev.0).abs() < f32::EPSILON {
            *prev = *next;
            true
        } else {
            false
        }
    });
    pts
}

/// Evaluate the curve at scene-linear value `v`. The authoring `[0, 1]`
/// domain maps to scene `[0, REF_MAX]`. Above `REF_MAX` the curve becomes
/// flat at the last knot's `y` (scaled out to scene) — this preserves the
/// "two-stops-above-white headroom" intent and prevents the user's curve
/// from clipping specular detail that AgX would have preserved (paper §
/// 4.6).
pub(super) fn eval_curve_scene_linear(knots: &[ToneCurvePoint], v: f32) -> f32 {
    if knots.len() < 2 {
        // Degenerate curves: empty is identity (early-return'd by the
        // caller — kept here for total-function defence). Single-point
        // is constant output, scaled out to scene linear.
        if let Some(&(_, y)) = knots.first() {
            return y * REF_MAX;
        }
        return v;
    }
    // Map scene v → authoring x in [0, 1].
    let x = (v / REF_MAX).clamp(0.0, 1.0);
    let y_authoring = eval_monotonic_cubic(knots, x);
    // Map authoring y → scene linear.
    y_authoring * REF_MAX
}

/// Fritsch–Carlson monotonic cubic Hermite interpolation. Returns `y` at
/// the given `x` (both in authoring `[0, 1]` domain). Out-of-bounds `x`
/// clamps to the first / last knot's `y` — the caller has already
/// clamped `x` to `[0, 1]`, but the guard belongs here for total-function
/// safety.
///
/// Algorithm (Fritsch & Carlson, "Monotone Piecewise Cubic Interpolation",
/// SIAM J. Numer. Anal. 17, 1980):
/// 1. Compute slopes m_i = (y_{i+1} - y_i) / (x_{i+1} - x_i) between
///    consecutive knots.
/// 2. Compute tangents t_i at each knot. Endpoints use one-sided slope;
///    interior knots use the average of adjacent slopes.
/// 3. Apply the monotonicity adjustment: where m_i = 0 the tangents
///    bordering it are zeroed; otherwise project (t_i, t_{i+1}) into the
///    "monotonicity circle" of radius 3 around (0, 0) in normalised
///    units.
/// 4. Evaluate the cubic Hermite spline between the bracketing knots.
pub(super) fn eval_monotonic_cubic(knots: &[ToneCurvePoint], x: f32) -> f32 {
    let n = knots.len();
    debug_assert!(n >= 2);

    if x <= knots[0].0 {
        return knots[0].1;
    }
    if x >= knots[n - 1].0 {
        return knots[n - 1].1;
    }

    // Compute segment slopes and per-knot tangents.
    let mut slopes = Vec::with_capacity(n - 1);
    for i in 0..n - 1 {
        let dx = knots[i + 1].0 - knots[i].0;
        let dy = knots[i + 1].1 - knots[i].1;
        // dx > 0 because `prepare_curve` dedups equal-x neighbours.
        slopes.push(dy / dx);
    }

    let mut tangents = Vec::with_capacity(n);
    tangents.push(slopes[0]);
    for i in 1..n - 1 {
        // Per Fritsch–Carlson: if two adjacent slopes have different
        // signs (or one is zero) the tangent at this knot is zero —
        // forces a local extremum exactly at the knot, no overshoot.
        if slopes[i - 1] * slopes[i] <= 0.0 {
            tangents.push(0.0);
        } else {
            tangents.push((slopes[i - 1] + slopes[i]) * 0.5);
        }
    }
    tangents.push(slopes[n - 2]);

    // Monotonicity guard: clamp each tangent so |t_i / m_k| ≤ 3 on the
    // adjacent segments. Without this, the cubic Hermite can overshoot
    // between knots even when each knot's tangent looks reasonable.
    for i in 0..n - 1 {
        let m = slopes[i];
        if m.abs() < f32::EPSILON {
            tangents[i] = 0.0;
            tangents[i + 1] = 0.0;
            continue;
        }
        let alpha = tangents[i] / m;
        let beta = tangents[i + 1] / m;
        let mag = alpha.hypot(beta);
        if mag > 3.0 {
            let scale = 3.0 / mag;
            tangents[i] = scale * alpha * m;
            tangents[i + 1] = scale * beta * m;
        }
    }

    // Locate the segment that brackets `x`.
    let mut i = 0;
    for j in 0..n - 1 {
        if x >= knots[j].0 && x <= knots[j + 1].0 {
            i = j;
            break;
        }
    }

    // Cubic Hermite basis on [0, 1] over the segment.
    let dx = knots[i + 1].0 - knots[i].0;
    let t = (x - knots[i].0) / dx;
    let t2 = t * t;
    let t3 = t2 * t;
    let h00 = 2.0 * t3 - 3.0 * t2 + 1.0;
    let h10 = t3 - 2.0 * t2 + t;
    let h01 = -2.0 * t3 + 3.0 * t2;
    let h11 = t3 - t2;
    h00 * knots[i].1
        + h10 * dx * tangents[i]
        + h01 * knots[i + 1].1
        + h11 * dx * tangents[i + 1]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_curve_through_knots_is_pass_through() {
        // The identity line `y = x` sampled at 5 knots evaluates back to
        // y == x at the knots; the monotonic-cubic spline preserves
        // linear input exactly (slopes are equal, tangents collapse to
        // the same slope, the Hermite basis sums to a linear function).
        let knots = [
            (0.0_f32, 0.0_f32),
            (0.25, 0.25),
            (0.5, 0.5),
            (0.75, 0.75),
            (1.0, 1.0),
        ];
        for &x in &[0.0, 0.1, 0.25, 0.42, 0.5, 0.63, 0.75, 0.9, 1.0] {
            let y = eval_monotonic_cubic(&knots, x);
            assert!((y - x).abs() < 1e-5, "identity drift at x={}: y={}", x, y);
        }
    }

    #[test]
    fn monotonic_input_produces_monotonic_output() {
        // The output sequence must be monotonically non-decreasing for
        // any monotonically non-decreasing input — Fritsch–Carlson's
        // central guarantee.
        let knots = [
            (0.0_f32, 0.0_f32),
            (0.2, 0.05),
            (0.5, 0.35),
            (0.8, 0.85),
            (1.0, 1.0),
        ];
        let xs: Vec<f32> = (0..=100).map(|i| i as f32 / 100.0).collect();
        let mut prev_y = f32::NEG_INFINITY;
        for x in xs {
            let y = eval_monotonic_cubic(&knots, x);
            assert!(
                y >= prev_y - 1e-6,
                "non-monotonic: y({})={}, prev={}",
                x,
                y,
                prev_y
            );
            prev_y = y;
        }
    }

    #[test]
    fn single_point_curve_is_constant_output() {
        let curve = ToneCurve::new(vec![(0.5, 0.7)]);
        let prepared = prepare_curve(&curve);
        // Scene-linear eval with REF_MAX=4 scales by 4 on output.
        let v = eval_curve_scene_linear(&prepared, 1.0);
        assert!((v - 0.7 * REF_MAX).abs() < 1e-5);
    }

    #[test]
    fn out_of_bounds_x_clamps_to_endpoint_y() {
        let knots = [(0.0_f32, 0.0_f32), (1.0, 1.0)];
        assert_eq!(eval_monotonic_cubic(&knots, -10.0), 0.0);
        assert_eq!(eval_monotonic_cubic(&knots, 10.0), 1.0);
    }

    #[test]
    fn ref_max_caps_scene_values_above_two_stops() {
        // A scene value above REF_MAX maps to the last knot's y in scene
        // space — no clip, just a flat tail. Tested with the identity
        // curve so the math is exact: 8.0 in, last_knot.y * REF_MAX out
        // = 1.0 * 4.0 = 4.0.
        let knots = [(0.0_f32, 0.0_f32), (1.0, 1.0)];
        let v = eval_curve_scene_linear(&knots, 8.0);
        assert!((v - REF_MAX).abs() < 1e-5, "got {}", v);
    }

    #[test]
    fn prepare_curve_sorts_by_x() {
        let curve = ToneCurve::new(vec![(0.5, 0.6), (0.0, 0.0), (1.0, 1.0)]);
        let prepared = prepare_curve(&curve);
        assert_eq!(prepared, vec![(0.0, 0.0), (0.5, 0.6), (1.0, 1.0)]);
    }

    #[test]
    fn prepare_curve_clamps_to_unit_square() {
        let curve = ToneCurve::new(vec![(-0.1, -0.2), (1.5, 2.0)]);
        let prepared = prepare_curve(&curve);
        assert_eq!(prepared, vec![(0.0, 0.0), (1.0, 1.0)]);
    }

    #[test]
    fn prepare_curve_dedups_equal_x_last_wins() {
        let curve = ToneCurve::new(vec![(0.5, 0.1), (0.5, 0.9)]);
        let prepared = prepare_curve(&curve);
        assert_eq!(prepared.len(), 1);
        assert_eq!(prepared[0], (0.5, 0.9));
    }
}
