//! The parametric region curve — the four PV2012 region sliders
//! (`shadows` / `darks` / `lights` / `highlights`) synthesised into a
//! monotone Hermite curve over the tone-curve authoring domain.
//!
//! # The region axis
//!
//! ACR's four-region model is parameterised on a `[0, 100]` axis whose
//! split points default to 25 / 50 / 75. Maple anchors that axis to scene
//! exposure: **50 is midgrey (0.18) and one stop is 12.5 axis units**, so
//! the default split points land at −2 stops (0.045), midgrey (0.18) and
//! +2 stops (0.72), and the four region *centres* — the midpoints of the
//! split intervals — land at −3 / −1 / +1 / +3 stops. `highlights` is
//! therefore centred a stop and a half above diffuse white, `shadows`
//! three stops below midgrey, and `darks` / `lights` bracket midgrey.
//!
//! Before #2318 the knots sat at a fixed 0.25 / 0.5 / 0.75 of the
//! *authoring* domain, which — the authoring domain being linear in scene
//! with `REF_MAX = 4.0` — put them at scene 1.0 / 2.0 / 3.0, i.e. +2.47 to
//! +4.06 stops. Midgrey fell inside the shadows segment and `highlights`
//! had exactly zero effect at or below diffuse white.
//!
//! # The gain profile
//!
//! Each slider contributes a log-gain over the axis, weighted by a smooth
//! region window:
//!
//! ```text
//!   L(p)   = Σ_i  a_i · w_i(p),     a_i = clamp(slider_i, ±100)/100 · MAX_STOPS
//!   y(x)   = x · 2^L(p(x))
//!   p(x)   = 50 + 12.5 · log2(x · REF_MAX / 0.18)
//! ```
//!
//! The windows are smoothstep crossfades between adjacent region centres,
//! so `Σ w_i = 1` below the highlights centre and each `w_i ≥ 0`. Two
//! properties fall straight out of that form and need no reference render
//! to check:
//!
//! * **Direction is structural.** `a_i ≥ 0 ⟹ L ≥ 0 ⟹ y ≥ x`. A positive
//!   slider cannot darken and a negative one cannot lighten, anywhere.
//!   The old construction moved a knot by a fixed *offset* in authoring
//!   space, which made `darks = +100` darken midgrey by 3.7%.
//! * **Zero is exactly identity.** `L = 0` gives `y = x·1` and tangent 1
//!   at every knot, bit-for-bit.
//!
//! Because each slider owns its own window, `darks` and `lights` are
//! independent — the pre-#2318 construction averaged them onto one shared
//! knot, where `darks = +100, lights = −100` was bit-identical to identity.
//!
//! # Monotonicity
//!
//! `dy/dx = 2^L · (1 + 12.5 · L'(p))`, and `L'` is bounded by the steepest
//! crossfade: a smoothstep over width `W` has `|w'| ≤ 1.5/W`, the windows
//! are `W = 25` axis units wide (two stops), and at most two windows are
//! changing at any `p`, so `|L'| ≤ 2·MAX_STOPS/100 · 1.5/25 · 100`. With
//! `MAX_STOPS = 0.5` that gives `12.5·|L'| ≤ 0.75` — the curve is strictly
//! increasing for **every** in-range slider combination, retaining at
//! worst a quarter of the identity slope. The bound goes flat at
//! `MAX_STOPS = 2/3`; anything at or above that would need a wider
//! crossfade. #368 calibrates `MAX_STOPS` against ACR and must re-derive
//! this bound if it moves.
//!
//! # Sampling
//!
//! The GPU path consumes *prepared curves* (knots + tangents), so the
//! closed-form profile is sampled onto knots. Knot placement is not
//! arbitrary: a knot sits on every axis landmark — the four region
//! centres and the three split points, which is one knot per stop from −3
//! to +3 — plus two log-spaced knots carrying the highlights window back
//! down to identity at the top of the authoring domain. Landing knots on
//! the landmarks is what makes the direction property survive
//! discretisation: the window derivatives are zero there, so where the
//! profile rejoins the identity line it does so *at a knot*, with tangent
//! 1, and the neighbouring segment is exactly identity rather than a cubic
//! that dips under it.

use super::evaluator::{prepare_curve_with_tangents, PreparedCurve, REF_MAX};
use crate::{types::adjustment::ToneCurvePoint, xmp::AdjustmentModel};

/// Scene-linear midgrey. Anchors axis coordinate 50.
const MIDGREY: f32 = 0.18;
/// Axis coordinate of midgrey — ACR's `ParametricMidtoneSplit` default.
const AXIS_MIDTONE: f32 = 50.0;
/// Axis units per stop. The axis spans `[0, 100]` and we place the default
/// shadow / highlight splits two stops either side of midgrey, so
/// `100 / 8 = 12.5`.
const AXIS_UNITS_PER_STOP: f32 = 12.5;
/// Top of the region axis.
const AXIS_MAX: f32 = 100.0;

/// ACR's `crs:ParametricShadowSplit` default — `model.parametric_shadow_split`
/// (#2320) now drives the curve builder for real (#3152); this literal
/// survives as the documented default and as the fallback GPU/FFI hosts
/// substitute when a stale binary leaves the field at zero (see
/// `raw-ffi::gpu_live` and `raw_gpu::tone_curves::prep`).
pub(super) const DEFAULT_SPLIT_SHADOW: f32 = 25.0;
/// ACR's `crs:ParametricMidtoneSplit` default. See [`DEFAULT_SPLIT_SHADOW`].
pub(super) const DEFAULT_SPLIT_MIDTONE: f32 = AXIS_MIDTONE;
/// ACR's `crs:ParametricHighlightSplit` default. See [`DEFAULT_SPLIT_SHADOW`].
pub(super) const DEFAULT_SPLIT_HIGHLIGHT: f32 = 75.0;

/// Clamp + order-repair for a (possibly hand-edited) sidecar's split points.
/// `region_windows`'s non-negative-partition property (see the module docs)
/// depends on `shadow <= midtone <= highlight` within `[0, AXIS_MAX]` — an
/// inverted or out-of-range split would flip a `smoothstep` and push a
/// window negative, breaking the monotonicity guarantee the whole module is
/// built on. `midtone` is clamped first (it is the axis's natural pivot —
/// default 50, the anchor `axis_to_authoring_x` already treats as midgrey)
/// and the two flanks then clamp toward it, same convention
/// `region_amplitude` uses for the sliders themselves.
fn ordered_splits(split_shadow: f32, split_midtone: f32, split_highlight: f32) -> (f32, f32, f32) {
    let midtone = split_midtone.clamp(0.0, AXIS_MAX);
    let shadow = split_shadow.clamp(0.0, midtone);
    let highlight = split_highlight.clamp(midtone, AXIS_MAX);
    (shadow, midtone, highlight)
}

/// Region centres — the midpoints of the split intervals, in axis units, for
/// the given (already-[`ordered_splits`]-repaired) split points. Order
/// matches the slider order used throughout: shadows, darks, lights,
/// highlights. With the default splits these are −3 / −1 / +1 / +3 stops.
fn region_centres(split_shadow: f32, split_midtone: f32, split_highlight: f32) -> [f32; 4] {
    [
        split_shadow * 0.5,
        (split_shadow + split_midtone) * 0.5,
        (split_midtone + split_highlight) * 0.5,
        (split_highlight + AXIS_MAX) * 0.5,
    ]
}

/// Axis coordinate of the top of the authoring domain (scene `REF_MAX`),
/// i.e. `AXIS_MIDTONE + AXIS_UNITS_PER_STOP · log2(REF_MAX / MIDGREY)`.
/// Pinned as a literal because `log2` is not a `const fn`;
/// `axis_top_matches_ref_max` asserts the literal against the computed
/// value. The highlights window fades out here so the curve rejoins the
/// pinned `(1, 1)` endpoint smoothly — the parametric curve shapes the
/// scene range, it does not extend it.
const AXIS_TOP: f32 = 105.924_14;

/// Peak excursion, in stops, at `|slider| = 100`. See the monotonicity
/// bound in the module docs before changing it; #368 calibrates it against
/// ACR.
pub(super) const MAX_STOPS: f32 = 0.5;

/// Axis coordinates of the sampled knots, low to high, for the given
/// (already-ordered) split points and their [`region_centres`]: the four
/// region centres interleaved with the three split points (one knot per
/// stop from −3 to +3 at the default splits), then the midpoint of the
/// highlights fade-out. The `(0, 0)` and `(1, 1)` endpoints are added by
/// [`build_parametric_curve_from_sliders`].
fn sample_axis(
    centres: &[f32; 4],
    split_shadow: f32,
    split_midtone: f32,
    split_highlight: f32,
) -> [f32; 8] {
    [
        centres[0],
        split_shadow,
        centres[1],
        split_midtone,
        centres[2],
        split_highlight,
        centres[3],
        (centres[3] + AXIS_TOP) * 0.5,
    ]
}

/// Total knots in the synthesised curve: the two pinned endpoints plus the
/// 8 entries [`sample_axis`] produces. The array length is fixed regardless
/// of where the split points sit, so this stays a compile-time constant.
/// Well inside the GPU slot's 32-knot cap.
pub(super) const KNOT_COUNT: usize = 8 + 2;

/// Region axis coordinate → authoring `x` in `[0, 1]`.
pub(super) fn axis_to_authoring_x(p: f32) -> f32 {
    MIDGREY * ((p - AXIS_MIDTONE) / AXIS_UNITS_PER_STOP).exp2() / REF_MAX
}

/// One slider's log-gain amplitude in stops. Out-of-range values (a
/// hand-edited sidecar) clamp to the documented `[-100, 100]` range, which
/// is what keeps the monotonicity bound total.
fn region_amplitude(slider: f32) -> f32 {
    slider.clamp(-100.0, 100.0) / 100.0 * MAX_STOPS
}

/// `smoothstep(a, b, p)` and its derivative w.r.t. `p`.
fn smoothstep(a: f32, b: f32, p: f32) -> (f32, f32) {
    let t_raw = (p - a) / (b - a);
    let t = t_raw.clamp(0.0, 1.0);
    let value = t * t * (3.0 - 2.0 * t);
    let slope = if t_raw <= 0.0 || t_raw >= 1.0 {
        0.0
    } else {
        6.0 * t * (1.0 - t) / (b - a)
    };
    (value, slope)
}

/// The four region windows and their derivatives at axis coordinate `p`,
/// for the given (already-ordered) region centres. Adjacent windows
/// crossfade between region centres, so the windows sum to 1 up to the
/// highlights centre and the highlights window then fades to 0 at
/// [`AXIS_TOP`]. Every window is non-negative — that is what makes the
/// direction property structural (see [`ordered_splits`] for why the
/// centres must be monotonically increasing for this to hold).
fn region_windows(p: f32, centres: &[f32; 4]) -> ([f32; 4], [f32; 4]) {
    let (s01, d01) = smoothstep(centres[0], centres[1], p);
    let (s12, d12) = smoothstep(centres[1], centres[2], p);
    let (s23, d23) = smoothstep(centres[2], centres[3], p);
    let (s3t, d3t) = smoothstep(centres[3], AXIS_TOP, p);
    (
        [1.0 - s01, s01 - s12, s12 - s23, s23 - s3t],
        [-d01, d01 - d12, d12 - d23, d23 - d3t],
    )
}

fn dot4(a: &[f32; 4], b: &[f32; 4]) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]
}

/// Synthesise the parametric curve for a model, ready to evaluate.
///
/// Sliders are read in region order (shadows, darks, lights, highlights).
/// All-zero produces the exact identity curve — every knot `(x, x)` with
/// tangent 1 — so the caller's slider-epsilon short-circuit and this
/// function agree to the bit.
pub(super) fn build_parametric_curve(model: &AdjustmentModel) -> PreparedCurve {
    build_parametric_curve_from_sliders(
        model.parametric_shadows,
        model.parametric_darks,
        model.parametric_lights,
        model.parametric_highlights,
        model.parametric_shadow_split,
        model.parametric_midtone_split,
        model.parametric_highlight_split,
    )
}

/// Slider-level entry point — the form the GPU port mirrors. `split_shadow`
/// / `split_midtone` / `split_highlight` are ACR's `crs:Parametric*Split`
/// axis positions (documented default 25 / 50 / 75, `[0, 100]`); out-of-
/// range or misordered values from a hand-edited sidecar are repaired by
/// [`ordered_splits`] before they reach the window math.
#[allow(clippy::too_many_arguments)]
pub(super) fn build_parametric_curve_from_sliders(
    shadows: f32,
    darks: f32,
    lights: f32,
    highlights: f32,
    split_shadow: f32,
    split_midtone: f32,
    split_highlight: f32,
) -> PreparedCurve {
    let amps = [
        region_amplitude(shadows),
        region_amplitude(darks),
        region_amplitude(lights),
        region_amplitude(highlights),
    ];

    let (split_shadow, split_midtone, split_highlight) =
        ordered_splits(split_shadow, split_midtone, split_highlight);
    let centres = region_centres(split_shadow, split_midtone, split_highlight);
    let sample_axis = sample_axis(&centres, split_shadow, split_midtone, split_highlight);

    let mut knots: Vec<ToneCurvePoint> = Vec::with_capacity(KNOT_COUNT);
    let mut tangents: Vec<f32> = Vec::with_capacity(KNOT_COUNT);

    // Below the shadows centre the shadows window is saturated at 1, so
    // the profile there is exactly the ray `y = x · 2^a_shadows`. The
    // origin knot carries that ray's slope.
    knots.push((0.0, 0.0));
    tangents.push(amps[0].exp2());

    for &p in &sample_axis {
        let x = axis_to_authoring_x(p);
        let (w, dw) = region_windows(p, &centres);
        let gain = dot4(&amps, &w).exp2();
        // dy/dx = 2^L · (1 + AXIS_UNITS_PER_STOP · dL/dp); the log-domain
        // axis contributes the `x` in `d(2^L)/dx = 2^L · ln2 · L' · dp/dx`.
        knots.push((x, x * gain));
        tangents.push(gain * (1.0 + AXIS_UNITS_PER_STOP * dot4(&amps, &dw)));
    }

    // Top endpoint: every window is zero at AXIS_TOP, so the profile is
    // already identity here. Pinning it exactly keeps the curve a map of
    // [0, REF_MAX] onto itself.
    knots.push((1.0, 1.0));
    tangents.push(1.0);

    prepare_curve_with_tangents(knots, tangents)
}

#[cfg(test)]
mod tests {
    use super::super::evaluator::eval_curve_scene_linear;
    use super::*;

    #[test]
    fn axis_top_matches_ref_max() {
        let computed = AXIS_MIDTONE + AXIS_UNITS_PER_STOP * (REF_MAX / MIDGREY).log2();
        assert!(
            (AXIS_TOP - computed).abs() < 1e-3,
            "AXIS_TOP literal {AXIS_TOP} drifted from computed {computed}"
        );
        // ...and the authoring x it maps to is the top of the domain.
        assert!((axis_to_authoring_x(AXIS_TOP) - 1.0).abs() < 1e-6);
    }

    /// The default splits' region centres, used by every test in this
    /// module that isn't itself exercising non-default splits.
    fn default_centres() -> [f32; 4] {
        region_centres(
            DEFAULT_SPLIT_SHADOW,
            DEFAULT_SPLIT_MIDTONE,
            DEFAULT_SPLIT_HIGHLIGHT,
        )
    }

    #[test]
    fn region_centres_sit_at_whole_stops_around_midgrey() {
        // shadows −3, darks −1, lights +1, highlights +3 stops re midgrey.
        for (centre, expected_stops) in default_centres().iter().zip([-3.0, -1.0, 1.0, 3.0]) {
            let scene = axis_to_authoring_x(*centre) * REF_MAX;
            let stops = (scene / MIDGREY).log2();
            assert!(
                (stops - expected_stops).abs() < 1e-4,
                "centre {centre} sits at {stops} stops, expected {expected_stops}"
            );
        }
    }

    #[test]
    fn region_windows_are_a_non_negative_partition() {
        // Non-negativity is what makes the direction property structural;
        // summing to 1 below the highlights centre is what keeps a
        // full-deflection setting from stacking two regions' gains.
        let centres = default_centres();
        for i in 0..=2000 {
            let p = i as f32 * AXIS_TOP / 2000.0;
            let (w, _) = region_windows(p, &centres);
            for (k, &wk) in w.iter().enumerate() {
                assert!(wk >= -1e-7, "window {k} negative at p={p}: {wk}");
            }
            if p <= centres[3] {
                let sum: f32 = w.iter().sum();
                assert!((sum - 1.0).abs() < 1e-5, "windows sum to {sum} at p={p}");
            }
        }
    }

    #[test]
    fn window_derivatives_match_finite_differences() {
        // The analytic tangents are only as good as these derivatives.
        let centres = default_centres();
        let h = 1e-3_f32;
        for i in 1..2000 {
            let p = i as f32 * AXIS_TOP / 2000.0;
            let (_, dw) = region_windows(p, &centres);
            let (w_lo, _) = region_windows(p - h, &centres);
            let (w_hi, _) = region_windows(p + h, &centres);
            for k in 0..4 {
                let fd = (w_hi[k] - w_lo[k]) / (2.0 * h);
                assert!(
                    (dw[k] - fd).abs() < 2e-3,
                    "window {k} derivative {} vs finite difference {fd} at p={p}",
                    dw[k]
                );
            }
        }
    }

    #[test]
    fn moving_a_split_point_changes_the_curve() {
        // #3152: the whole point of wiring the split fields through is that
        // moving one actually perturbs the rendered curve. Push the
        // shadow/midtone split from its default 25 out to 40 (shadows=+100
        // so the shadows window has something to move) and confirm the
        // curve at the old vs a nearby-new split boundary differs.
        let default_curve = build_parametric_curve_from_sliders(
            100.0,
            0.0,
            0.0,
            0.0,
            DEFAULT_SPLIT_SHADOW,
            DEFAULT_SPLIT_MIDTONE,
            DEFAULT_SPLIT_HIGHLIGHT,
        );
        let moved_curve =
            build_parametric_curve_from_sliders(100.0, 0.0, 0.0, 0.0, 40.0, 50.0, 75.0);

        // Sample at the midpoint between the two shadow-split positions —
        // inside the moved window but outside the default one, so a wired
        // split point must change the sampled value.
        let probe_axis = (DEFAULT_SPLIT_SHADOW + 40.0) * 0.5;
        let probe_scene = axis_to_authoring_x(probe_axis) * REF_MAX;
        let default_y = eval_curve_scene_linear(&default_curve, probe_scene);
        let moved_y = eval_curve_scene_linear(&moved_curve, probe_scene);
        assert!(
            (default_y - moved_y).abs() > 1e-4,
            "moving parametric_shadow_split from {DEFAULT_SPLIT_SHADOW} to 40 did not move the \
             curve at axis {probe_axis}: default={default_y}, moved={moved_y}"
        );
    }

    #[test]
    fn misordered_splits_are_repaired_not_left_to_break_monotonicity() {
        // A hand-edited sidecar could set shadow > highlight. `ordered_splits`
        // must still hand `region_windows` a monotonically increasing centre
        // sequence, or the non-negative-partition property breaks.
        let (s, m, h) = ordered_splits(90.0, 50.0, 10.0);
        assert!(s <= m && m <= h, "splits not ordered: {s} <= {m} <= {h}");
        let centres = region_centres(s, m, h);
        for w in centres.windows(2) {
            assert!(w[1] >= w[0], "region centres not increasing: {centres:?}");
        }
    }
}
