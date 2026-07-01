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

/// A monotonic-cubic-ready curve: knots plus the Fritsch–Carlson slopes
/// and tangents pre-computed once, so the per-pixel evaluator does zero
/// allocation.
///
/// Build via [`prepare_curve`] (from a `ToneCurve`) or
/// [`prepare_curve_from_slice`] (from a synthesised knot array, e.g. the
/// parametric path's 5-knot polyline).
pub(super) struct PreparedCurve {
    /// Sorted, deduped, clamped knots. Length ≥ 0.
    pub(super) knots: Vec<ToneCurvePoint>,
    /// Per-knot tangents after Fritsch–Carlson monotonicity adjustment.
    /// Length = `knots.len()` when `knots.len() ≥ 2`, else 0. Slopes are
    /// computed inside `finalize_prepared_curve` and folded into the
    /// tangents; they aren't needed after preparation, so we don't keep
    /// them around.
    tangents: Vec<f32>,
}

impl PreparedCurve {
    /// Number of knots — handy when a caller needs to short-circuit on
    /// degenerate curves.
    pub(super) fn len(&self) -> usize {
        self.knots.len()
    }
}

/// Sort the curve's control points by `x` ascending and clamp them into
/// the `[0, 1]` × `[0, 1]` authoring domain. The evaluator requires
/// strictly increasing x; if two points share an x value we keep the
/// later one (last-write-wins matches the way UI editors typically draw
/// curves when the user drags through an existing knot).
///
/// Returns a [`PreparedCurve`] with the Fritsch–Carlson slopes and
/// monotonicity-guarded tangents pre-computed — the per-pixel evaluator
/// reads these without allocating.
pub(super) fn prepare_curve(curve: &ToneCurve) -> PreparedCurve {
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
    finalize_prepared_curve(pts)
}

/// Same as [`prepare_curve`] but consumes a synthesised knot slice
/// (already in authoring domain). Used by the parametric path, which
/// builds its 5-knot array in-line.
pub(super) fn prepare_curve_from_slice(pts: &[ToneCurvePoint]) -> PreparedCurve {
    finalize_prepared_curve(pts.to_vec())
}

fn finalize_prepared_curve(knots: Vec<ToneCurvePoint>) -> PreparedCurve {
    let n = knots.len();
    if n < 2 {
        return PreparedCurve {
            knots,
            tangents: Vec::new(),
        };
    }

    // Compute segment slopes.
    let mut slopes = Vec::with_capacity(n - 1);
    for i in 0..n - 1 {
        let dx = knots[i + 1].0 - knots[i].0;
        let dy = knots[i + 1].1 - knots[i].1;
        // dx > 0 because `prepare_curve` dedups equal-x neighbours.
        slopes.push(dy / dx);
    }

    // Compute per-knot tangents.
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

    let _ = slopes; // consumed into `tangents`; no need to keep after prep
    PreparedCurve { knots, tangents }
}

/// Evaluate the curve at scene-linear value `v`. The authoring `[0, 1]`
/// domain maps to scene `[0, REF_MAX]`. Above `REF_MAX` the curve becomes
/// flat at the last knot's `y` (scaled out to scene) — this preserves the
/// "two-stops-above-white headroom" intent and prevents the user's curve
/// from clipping specular detail that AgX would have preserved (paper §
/// 4.6).
pub(super) fn eval_curve_scene_linear(curve: &PreparedCurve, v: f32) -> f32 {
    if curve.len() < 2 {
        // Degenerate curves: empty is identity (early-return'd by the
        // caller — kept here for total-function defence). Single-point
        // is constant output, scaled out to scene linear.
        if let Some(&(_, y)) = curve.knots.first() {
            return y * REF_MAX;
        }
        return v;
    }
    // Map scene v → authoring x in [0, 1].
    // Instead of a hard clamp, apply a C1-continuous tanh soft-knee above 0.98 (3.92 scene-linear).
    let x_raw = v / REF_MAX;
    let x = if x_raw < 0.98 {
        x_raw
    } else {
        0.98 + 0.02 * ((x_raw - 0.98) / 0.02).tanh()
    };
    let x = x.clamp(0.0, 1.0);
    let y_authoring = eval_monotonic_cubic(curve, x);
    // Map authoring y → scene linear.
    y_authoring * REF_MAX
}

/// Fritsch–Carlson monotonic cubic Hermite interpolation. Returns `y` at
/// the given `x` (both in authoring `[0, 1]` domain). Out-of-bounds `x`
/// clamps to the first / last knot's `y` — the caller has already
/// clamped `x` to `[0, 1]`, but the guard belongs here for total-function
/// safety.
///
/// Reads from the [`PreparedCurve`] — slopes and tangents are
/// pre-computed once at curve preparation time, so this function does
/// zero allocation on the per-pixel hot path.
///
/// Algorithm (Fritsch & Carlson, "Monotone Piecewise Cubic Interpolation",
/// SIAM J. Numer. Anal. 17, 1980):
/// 1. Segment slopes m_i = (y_{i+1} - y_i) / (x_{i+1} - x_i) — computed
///    in [`finalize_prepared_curve`].
/// 2. Per-knot tangents t_i — endpoints use one-sided slope; interior
///    knots use the average of adjacent slopes. Computed in
///    [`finalize_prepared_curve`].
/// 3. Monotonicity adjustment: where m_i = 0 the bordering tangents are
///    zeroed; otherwise (t_i, t_{i+1}) is projected into the
///    monotonicity circle of radius 3. Done in
///    [`finalize_prepared_curve`].
/// 4. Evaluate the cubic Hermite spline between the bracketing knots —
///    this function.
pub(super) fn eval_monotonic_cubic(curve: &PreparedCurve, x: f32) -> f32 {
    let knots = &curve.knots[..];
    let n = knots.len();
    debug_assert!(n >= 2);

    if x <= knots[0].0 {
        return knots[0].1;
    }
    if x >= knots[n - 1].0 {
        return knots[n - 1].1;
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
        + h10 * dx * curve.tangents[i]
        + h01 * knots[i + 1].1
        + h11 * dx * curve.tangents[i + 1]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prepared_from(knots: &[ToneCurvePoint]) -> PreparedCurve {
        prepare_curve_from_slice(knots)
    }

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
        let prepared = prepared_from(&knots);
        for &x in &[0.0, 0.1, 0.25, 0.42, 0.5, 0.63, 0.75, 0.9, 1.0] {
            let y = eval_monotonic_cubic(&prepared, x);
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
        let prepared = prepared_from(&knots);
        let xs: Vec<f32> = (0..=100).map(|i| i as f32 / 100.0).collect();
        let mut prev_y = f32::NEG_INFINITY;
        for x in xs {
            let y = eval_monotonic_cubic(&prepared, x);
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
        let prepared = prepared_from(&knots);
        assert_eq!(eval_monotonic_cubic(&prepared, -10.0), 0.0);
        assert_eq!(eval_monotonic_cubic(&prepared, 10.0), 1.0);
    }

    #[test]
    fn ref_max_soft_knee_above_98_percent() {
        // A scene value above 3.92 (98% of REF_MAX) undergoes smooth soft-knee compression
        // instead of hard flat clipping. Under the identity curve, 8.0 maps to
        // ~4.0 (approaching 4.0 asymptotically).
        let knots = [(0.0_f32, 0.0_f32), (1.0, 1.0)];
        let prepared = prepared_from(&knots);
        let v = eval_curve_scene_linear(&prepared, 8.0);
        assert!((v - 4.0).abs() < 1e-3, "got {}", v);
        assert!(v <= REF_MAX);
    }

    #[test]
    fn prepare_curve_sorts_by_x() {
        let curve = ToneCurve::new(vec![(0.5, 0.6), (0.0, 0.0), (1.0, 1.0)]);
        let prepared = prepare_curve(&curve);
        assert_eq!(prepared.knots, vec![(0.0, 0.0), (0.5, 0.6), (1.0, 1.0)]);
    }

    #[test]
    fn prepare_curve_clamps_to_unit_square() {
        let curve = ToneCurve::new(vec![(-0.1, -0.2), (1.5, 2.0)]);
        let prepared = prepare_curve(&curve);
        assert_eq!(prepared.knots, vec![(0.0, 0.0), (1.0, 1.0)]);
    }

    #[test]
    fn prepare_curve_dedups_equal_x_last_wins() {
        let curve = ToneCurve::new(vec![(0.5, 0.1), (0.5, 0.9)]);
        let prepared = prepare_curve(&curve);
        assert_eq!(prepared.knots.len(), 1);
        assert_eq!(prepared.knots[0], (0.5, 0.9));
    }

    #[test]
    fn prepared_tangents_are_precomputed_once() {
        // The whole point of `PreparedCurve` is that the Fritsch–Carlson
        // tangents are populated at prep time, not per-eval. Smoke test:
        // a non-trivial curve produces non-empty tangents immediately
        // after preparation, and `eval_monotonic_cubic` doesn't need to
        // recompute them.
        let curve = ToneCurve::new(vec![(0.0, 0.0), (0.4, 0.1), (1.0, 1.0)]);
        let prepared = prepare_curve(&curve);
        assert_eq!(prepared.tangents.len(), 3);
        // Same eval twice produces the same value — proves the state is
        // stable across calls (catches any "lazy-init mutates state" bugs).
        let a = eval_monotonic_cubic(&prepared, 0.6);
        let b = eval_monotonic_cubic(&prepared, 0.6);
        assert_eq!(a, b);
    }
}
