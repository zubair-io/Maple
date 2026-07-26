//! Closed-form gate on the parametric region curve (#2318).
//!
//! Every assertion here is a property of the synthesised curve alone —
//! none of it compares against a reference render, and none of it depends
//! on the amplitude calibration #368 will fit. That is deliberate: the
//! three defects this file pins were established with no reference at all,
//! and calibrating amplitude first would have baked the worst of them
//! (`darks` and `lights` cancelling) into a passing budget.
//!
//! The properties, and the defect each one would have caught:
//!
//! 1. Slider independence — no non-zero setting is the identity curve, and
//!    no two sliders move the curve the same way. Pre-#2318 `darks` and
//!    `lights` shared one averaged knot, so `darks = +100, lights = −100`
//!    was bit-identical to identity.
//! 2. Region locality — every slider is inert at every *other* region's
//!    centre, and each has real effect at or below diffuse white.
//!    Pre-#2318 the knots sat at scene 1.0 / 2.0 / 3.0, so `highlights`
//!    did nothing at or below diffuse white and `shadows` multiplied
//!    midgrey by 2.3.
//! 3. Direction — a positive slider never darkens and a negative one never
//!    lightens, at any scene value. Pre-#2318 `darks = +100` darkened
//!    midgrey (0.963×).
//!
//! Plus the structural invariants: exact identity at all-zero, strict
//! monotonicity over the whole slider grid, and smoothness across knot
//! boundaries.

#![cfg(test)]

use super::evaluator::eval_curve_scene_linear;
use super::parametric::{
    axis_to_authoring_x, build_parametric_curve_from_sliders, KNOT_COUNT, MAX_STOPS,
    REGION_CENTRES,
};

/// Slider order used everywhere in this file and in the builder.
const REGION_NAMES: [&str; 4] = ["shadows", "darks", "lights", "highlights"];

/// Scene values at the four region centres, in the same order.
fn region_centre_scenes() -> [f32; 4] {
    let mut out = [0.0_f32; 4];
    for (slot, centre) in out.iter_mut().zip(REGION_CENTRES) {
        *slot = axis_to_authoring_x(centre) * 4.0;
    }
    out
}

/// One slider at `value`, the rest zero.
fn only(region: usize, value: f32) -> [f32; 4] {
    let mut s = [0.0_f32; 4];
    s[region] = value;
    s
}

fn curve_of(s: [f32; 4]) -> super::PreparedCurve {
    build_parametric_curve_from_sliders(s[0], s[1], s[2], s[3])
}

/// Scene sweep: log-spaced from deep shadow to the top of the authoring
/// domain, so the shadow regions (which occupy a tiny slice of the linear
/// authoring domain) are sampled as densely as the highlights.
fn scene_sweep() -> Vec<f32> {
    (0..=1200)
        .map(|i| {
            let stops = -10.0 + (i as f32) * 14.5 / 1200.0;
            0.18_f32 * stops.exp2()
        })
        .filter(|v| *v <= 4.0)
        .collect()
}

/// Gain of a setting relative to the all-zero curve at the same scene
/// value. Referenced against the identity *curve*, not against `v`, so the
/// evaluator's `REF_MAX` soft-knee (which compresses ~0.5% at scene 4.0
/// under every setting including identity) cancels out.
fn gain_sweep(s: [f32; 4]) -> Vec<(f32, f32)> {
    let ident = curve_of([0.0; 4]);
    let curve = curve_of(s);
    scene_sweep()
        .into_iter()
        .map(|v| {
            let base = eval_curve_scene_linear(&ident, v);
            (v, eval_curve_scene_linear(&curve, v) / base)
        })
        .collect()
}

fn gain_at(s: [f32; 4], v: f32) -> f32 {
    let ident = curve_of([0.0; 4]);
    eval_curve_scene_linear(&curve_of(s), v) / eval_curve_scene_linear(&ident, v)
}

// -----------------------------------------------------------------
// Structural
// -----------------------------------------------------------------

#[test]
fn all_zero_sliders_synthesise_the_exact_identity_curve() {
    // Not "within epsilon" — bit-exact. The stage's slider-epsilon
    // short-circuit skips the pixel loop entirely for a default model, so
    // the two paths have to agree exactly or a sidecar that writes
    // `ParametricDarks="0"` would render differently from one that omits
    // the attribute.
    let c = curve_of([0.0; 4]);
    assert_eq!(c.knots.len(), KNOT_COUNT);
    for &(x, y) in &c.knots {
        assert_eq!(y, x, "knot ({x}, {y}) is off the identity line");
    }
    for (i, &t) in c.tangents.iter().enumerate() {
        assert_eq!(t, 1.0, "tangent {i} is {t}, expected 1");
    }
}

#[test]
fn knot_count_fits_the_gpu_curve_slot() {
    // `raw_gpu::tone_curves::prep::CURVE_CAP` is 32 and over-running it is
    // a hard panic there, so the synthesised count is a cross-crate
    // contract. 10 knots: two pinned endpoints, the four region centres,
    // the three split points, one highlights fade-out midpoint.
    assert_eq!(KNOT_COUNT, 10);
    assert!(KNOT_COUNT <= 32);
}

#[test]
fn region_windows_keep_the_curve_strictly_increasing() {
    // The monotonicity bound in the module docs says the curve is strictly
    // increasing for every in-range slider combination — the Fritsch-Carlson
    // radius-3 projection is a total-function guard, not a load-bearing
    // clamp the way the pre-#2318 cumulative-max pass was. Check the whole
    // 5^4 corner grid at the knot level.
    let grid = [-100.0_f32, -50.0, 0.0, 50.0, 100.0];
    let mut worst_slope = f32::INFINITY;
    for &s in &grid {
        for &d in &grid {
            for &l in &grid {
                for &h in &grid {
                    let c = build_parametric_curve_from_sliders(s, d, l, h);
                    for w in c.knots.windows(2) {
                        let slope = (w[1].1 - w[0].1) / (w[1].0 - w[0].0);
                        assert!(
                            slope > 0.0,
                            "non-increasing segment {:?} → {:?} at ({s}, {d}, {l}, {h})",
                            w[0],
                            w[1]
                        );
                        worst_slope = worst_slope.min(slope);
                    }
                }
            }
        }
    }
    // The derivation predicts a worst-case slope factor of 1 − 0.75 = 0.25
    // of the identity slope; the discrete chord slope stays above it.
    assert!(
        worst_slope > 0.25,
        "worst chord slope {worst_slope} fell to the analytic floor — \
         re-derive the bound before raising MAX_STOPS (currently {MAX_STOPS})"
    );
}

#[test]
fn synthesised_curve_is_smooth_across_knot_boundaries() {
    // Second differences against the largest first difference over a dense
    // sweep. A C1 piecewise cubic has |Δ²y| ~ |y''|·h² against |Δy| ~
    // |y'|·h, so the ratio is O(h) and tiny; a construction with a slope
    // break at a knot puts a whole slope jump into one Δ², which lands the
    // ratio at order 1. Red-checked: replacing the Hermite evaluation with
    // linear interpolation through the same knots takes the ratio from
    // 0.0164 to 0.2929 and fails this assertion.
    //
    // N is load-bearing — the ratio scales with the sample spacing.
    const N: usize = 20_000;
    let settings: [[f32; 4]; 5] = [
        [-75.0, 50.0, -50.0, 75.0], // test_0000/xmp/parametric_mixed.xmp
        [100.0, -100.0, -100.0, -100.0],
        [-100.0, 100.0, 100.0, 100.0],
        [100.0, -100.0, 100.0, -100.0],
        [0.0, 100.0, -100.0, 0.0],
    ];
    for s in settings {
        let c = curve_of(s);
        let ys: Vec<f32> = (0..=N)
            .map(|i| eval_curve_scene_linear(&c, i as f32 * 4.0 / N as f32))
            .collect();
        let d1: Vec<f32> = ys.windows(2).map(|w| w[1] - w[0]).collect();
        let d2: Vec<f32> = d1.windows(2).map(|w| w[1] - w[0]).collect();
        let max_d1 = d1.iter().fold(0.0_f32, |a, b| a.max(b.abs()));
        let max_d2 = d2.iter().fold(0.0_f32, |a, b| a.max(b.abs()));
        eprintln!("SMOOTHNESS {s:?}: max|Δ²y|/max|Δy| = {}", max_d2 / max_d1);
        assert!(
            max_d2 <= 0.05 * max_d1,
            "slope break for {s:?}: max|Δ²y| = {max_d2}, max|Δy| = {max_d1}"
        );
        assert!(
            d1.iter().all(|&d| d >= -1e-7),
            "non-monotonic output for {s:?}"
        );
    }
}

// -----------------------------------------------------------------
// 1. Independence — the defect that made `darks` + `lights` cancel
// -----------------------------------------------------------------

#[test]
fn no_single_slider_setting_collapses_to_identity() {
    for region in 0..4 {
        for value in [-100.0_f32, -50.0, 50.0, 100.0] {
            let peak = gain_sweep(only(region, value))
                .into_iter()
                .fold(0.0_f32, |a, (_, g)| a.max((g - 1.0).abs()));
            assert!(
                peak > 0.05,
                "{} at {value} moves the curve by only {peak}",
                REGION_NAMES[region]
            );
        }
    }
}

#[test]
fn opposing_darks_and_lights_do_not_cancel() {
    // The headline #2318 defect. Pre-fix, `(0, +d, -d, 0)` synthesised
    // knots bit-identical to identity for every d — the two sliders were
    // averaged onto one shared knot. Both the ±100 case and the ±50 pair
    // carried by the committed fixture must now move the curve.
    for d in [50.0_f32, 100.0] {
        let sweep = gain_sweep([0.0, d, -d, 0.0]);
        let peak = sweep
            .iter()
            .fold(0.0_f32, |a, (_, g)| a.max((g - 1.0).abs()));
        assert!(
            peak > 0.1,
            "darks=+{d}, lights=-{d} moves the curve by only {peak}"
        );
        // ...and in opposite directions, which is the point of the pair.
        let centres = region_centre_scenes();
        assert!(gain_at([0.0, d, -d, 0.0], centres[1]) > 1.0);
        assert!(gain_at([0.0, d, -d, 0.0], centres[2]) < 1.0);
    }
}

#[test]
fn the_four_sliders_are_mutually_distinguishable() {
    let sweeps: Vec<Vec<(f32, f32)>> = (0..4).map(|r| gain_sweep(only(r, 100.0))).collect();
    for a in 0..4 {
        for b in (a + 1)..4 {
            let diff = sweeps[a]
                .iter()
                .zip(&sweeps[b])
                .fold(0.0_f32, |acc, (x, y)| acc.max((x.1 - y.1).abs()));
            assert!(
                diff > 0.1,
                "{} and {} are indistinguishable (max gain difference {diff})",
                REGION_NAMES[a],
                REGION_NAMES[b]
            );
        }
    }
}

// -----------------------------------------------------------------
// 2. Locality — the defect that put every knot ~2.5 stops too high
// -----------------------------------------------------------------

#[test]
fn each_slider_peaks_at_its_own_centre_and_is_inert_at_the_others() {
    let centres = region_centre_scenes();
    for region in 0..4 {
        let s = only(region, 100.0);
        let own = gain_at(s, centres[region]);
        let peak = gain_sweep(s).into_iter().fold(0.0_f32, |a, (_, g)| a.max(g));
        assert!(
            own >= peak - 1e-4,
            "{} peaks at {peak} but only reaches {own} at its own centre",
            REGION_NAMES[region]
        );
        assert!(
            (own - MAX_STOPS.exp2()).abs() < 1e-3,
            "{} peak gain {own} does not match 2^MAX_STOPS",
            REGION_NAMES[region]
        );
        for other in 0..4 {
            if other == region {
                continue;
            }
            let g = gain_at(s, centres[other]);
            assert!(
                (g - 1.0).abs() < 1e-4,
                "{} is not inert at the {} centre (gain {g})",
                REGION_NAMES[region],
                REGION_NAMES[other]
            );
        }
    }
}

#[test]
fn the_region_centres_bracket_midgrey_and_diffuse_white() {
    // Names have to mean something against scene exposure: shadows below
    // midgrey, highlights above diffuse white, darks and lights either
    // side of midgrey. Pre-#2318 every centre sat above diffuse white.
    let [shadows, darks, lights, highlights] = region_centre_scenes();
    assert!(shadows < 0.18 / 4.0, "shadows centre at {shadows}");
    assert!(darks < 0.18 && darks > shadows, "darks centre at {darks}");
    assert!(lights > 0.18 && lights < 1.0, "lights centre at {lights}");
    assert!(highlights > 1.0, "highlights centre at {highlights}");
}

#[test]
fn every_slider_bites_at_or_below_diffuse_white() {
    // `highlights` had exactly zero effect anywhere at or below diffuse
    // white before #2318 — the slider did nothing at all on a normally
    // exposed frame.
    for region in 0..4 {
        let best = gain_sweep(only(region, 100.0))
            .into_iter()
            .filter(|(v, _)| *v <= 1.0)
            .fold(0.0_f32, |a, (_, g)| a.max(g));
        assert!(
            best > 1.05,
            "{} peaks at only {best} at or below diffuse white",
            REGION_NAMES[region]
        );
    }
}

#[test]
fn midgrey_is_driven_by_darks_and_lights_not_by_shadows() {
    // Midgrey is the darks/lights split point, so both of those move it
    // and neither of the outer regions touches it. Pre-#2318 midgrey sat
    // inside the shadows segment.
    assert!((gain_at(only(0, 100.0), 0.18) - 1.0).abs() < 1e-4);
    assert!((gain_at(only(3, 100.0), 0.18) - 1.0).abs() < 1e-4);
    assert!(gain_at(only(1, 100.0), 0.18) > 1.15);
    assert!(gain_at(only(2, 100.0), 0.18) > 1.15);
}

// -----------------------------------------------------------------
// 3. Direction — the defect that made `darks = +100` darken midgrey
// -----------------------------------------------------------------

#[test]
fn positive_sliders_never_darken_and_negative_sliders_never_lighten() {
    for region in 0..4 {
        for (value, name) in [(100.0_f32, "+100"), (-100.0, "-100")] {
            for (v, g) in gain_sweep(only(region, value)) {
                let ok = if value > 0.0 {
                    g >= 1.0 - 1e-5
                } else {
                    g <= 1.0 + 1e-5
                };
                assert!(
                    ok,
                    "{} at {name} has gain {g} at scene {v}",
                    REGION_NAMES[region]
                );
            }
        }
    }
}

#[test]
fn darks_lightens_the_lower_midtones() {
    // The literal acceptance line from #2318: `darks = +100` must lighten
    // rather than darken. It measured 0.963× at midgrey and 0.988× at 0.05
    // before the fix.
    let s = only(1, 100.0);
    for v in [0.05_f32, 0.09, 0.18] {
        let g = gain_at(s, v);
        assert!(g > 1.0, "darks=+100 gives gain {g} at scene {v}");
    }
    assert!(gain_at(s, 0.09) > 1.4, "darks=+100 barely moves its centre");
}
