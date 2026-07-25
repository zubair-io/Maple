//! Tests for `stages::color_grade` (#275). Split into a sibling file so
//! the stage stays under the 600-LOC budget.

use super::*;
use crate::color::oklab::rec2020_to_oklab;
use crate::image::{ColorSpace, Image};

fn grey_display(w: u32, h: u32, v: f32) -> Image {
    let mut img = Image::new(w, h, ColorSpace::DisplayLinearRec2020);
    for p in &mut img.pixels {
        *p = [v, v, v];
    }
    img
}

/// A display-linear neutral ramp of `n` samples spanning `[0, 1]`.
fn grey_ramp(n: u32) -> Image {
    let mut img = Image::new(n, 1, ColorSpace::DisplayLinearRec2020);
    for (i, p) in img.pixels.iter_mut().enumerate() {
        let v = i as f32 / (n - 1) as f32;
        *p = [v, v, v];
    }
    img
}

/// Strongly contrasting per-zone settings — the worst case for a visible
/// band boundary, and the settings the smoothness test sweeps.
fn contrasting_zones() -> ColorGradeSliders {
    ColorGradeSliders {
        shadow: [30.0, 100.0, 60.0],
        midtone: [150.0, 100.0, -40.0],
        highlight: [270.0, 100.0, -60.0],
        global: [0.0, 0.0, 0.0],
        balance: 0.0,
    }
}

// ── Identity ──────────────────────────────────────────────────────────────

/// A default [`AdjustmentModel`] is a bit-identical no-op through the
/// model-facing entry point: identity at all-neutral, asserted on the
/// pixels rather than on the gate flag.
#[test]
fn default_model_is_bit_identical() {
    let mut img = grey_ramp(64);
    let before = img.pixels.clone();
    apply_model(&mut img, &AdjustmentModel::default());
    assert_eq!(img.pixels, before);
}

/// Zero saturations *and* zero luminances are a bit-identical no-op
/// regardless of hues and balance — the neutral-preserving gate.
#[test]
fn zero_saturation_and_luminance_is_bit_identical() {
    let mut img = grey_ramp(64);
    let before = img.pixels.clone();
    apply(
        &mut img,
        &ColorGradeSliders {
            shadow: [220.0, 0.0, 0.0],
            midtone: [90.0, 0.0, 0.0],
            highlight: [40.0, 0.0, 0.0],
            global: [310.0, 0.0, 0.0],
            balance: 60.0,
        },
    );
    assert_eq!(img.pixels, before);
    assert!(color_grade_params(&ColorGradeSliders::default()).is_identity);
}

/// Identity holds on *coloured* pixels too, not just neutrals — the gate
/// is on the sliders, so nothing in the image can defeat it.
#[test]
fn identity_holds_on_coloured_pixels() {
    let mut img = Image::new(3, 1, ColorSpace::DisplayLinearRec2020);
    img.pixels[0] = [0.62, 0.11, 0.07];
    img.pixels[1] = [0.04, 0.55, 0.31];
    img.pixels[2] = [0.18, 0.20, 0.71];
    let before = img.pixels.clone();
    apply_model(&mut img, &AdjustmentModel::default());
    assert_eq!(img.pixels, before);
}

// ── Zone weights ──────────────────────────────────────────────────────────

/// The three zone weights are an exact partition of unity and each stays
/// inside `[0, 1]`, for every luminance and every balance.
#[test]
fn zone_weights_are_a_partition_of_unity() {
    for &bal in &[-100.0f32, -50.0, 0.0, 25.0, 100.0] {
        let exp = (-bal / 100.0).exp2();
        for i in 0..=200 {
            let yd = i as f32 / 200.0;
            let w = zone_weights(yd, exp);
            let sum = w[0] + w[1] + w[2];
            assert!(
                (sum - 1.0).abs() < 1e-5,
                "weights must sum to 1 at yd={yd}, bal={bal}: {sum} ({w:?})"
            );
            for (z, &wz) in w.iter().enumerate() {
                assert!(
                    (-1e-6..=1.0 + 1e-6).contains(&wz),
                    "zone {z} weight out of range at yd={yd}, bal={bal}: {wz}"
                );
            }
        }
    }
}

/// Each zone owns its end of the tonal range: shadows at black, midtones
/// at mid-grey, highlights at white.
#[test]
fn each_zone_dominates_its_own_tonal_range() {
    let w_dark = zone_weights(0.0, 1.0);
    let w_mid = zone_weights(0.5, 1.0);
    let w_light = zone_weights(1.0, 1.0);
    assert!(w_dark[0] > 0.99, "shadows must own black: {w_dark:?}");
    assert!(w_mid[1] > 0.99, "midtones must own mid-grey: {w_mid:?}");
    assert!(w_light[2] > 0.99, "highlights must own white: {w_light:?}");
}

/// Balance shifts the crossover: positive balance pushes the shadow
/// weight DOWN at a given midtone and the highlight weight UP — the ACR
/// mental model, carried over from split toning.
#[test]
fn balance_shifts_the_crossover() {
    let yd = 0.4f32;
    let pos = zone_weights(yd, (-100.0f32 / 100.0).exp2());
    let neg = zone_weights(yd, (100.0f32 / 100.0).exp2());
    assert!(
        pos[0] < neg[0],
        "positive balance must shrink the shadow weight: {pos:?} vs {neg:?}"
    );
    assert!(
        pos[2] > neg[2],
        "positive balance must grow the highlight weight: {pos:?} vs {neg:?}"
    );
}

// ── Smooth blending (the #275 acceptance criterion) ───────────────────────

/// Zones blend smoothly without banding, asserted numerically.
///
/// Sweep a 512-step neutral luminance ramp through the real stage, take
/// the per-pixel Oklab `(Δa, Δb, ΔL)` the stage produced, and compare the
/// series' second differences against its largest first difference. A C¹
/// blend keeps `max|Δ²| ≪ max|Δ|`; a hard zone boundary makes the two
/// equal, because the jump shows up undiminished one order up.
///
/// Red-checked by swapping `zone_weights`' `smoothstep` calls for hard
/// `step`s: the ratio jumps from ~0.02 to ~1.0 and the test fails on the
/// Δa series first.
#[test]
fn zone_blend_has_no_band_boundary_discontinuity() {
    const N: u32 = 512;
    const MAX_CURVATURE_RATIO: f32 = 0.25;

    let mut img = grey_ramp(N);
    let before: Vec<[f32; 3]> = img.pixels.iter().map(|p| rec2020_to_oklab(*p)).collect();
    apply(&mut img, &contrasting_zones());
    let after: Vec<[f32; 3]> = img.pixels.iter().map(|p| rec2020_to_oklab(*p)).collect();

    // Component order matches the (Δa, Δb, ΔL) triple the stage adds.
    for (comp, name) in [(1usize, "Δa"), (2, "Δb"), (0, "ΔL")] {
        let series: Vec<f32> = after
            .iter()
            .zip(&before)
            .map(|(a, b)| a[comp] - b[comp])
            .collect();
        let d1: Vec<f32> = series.windows(2).map(|w| w[1] - w[0]).collect();
        let d2: Vec<f32> = d1.windows(2).map(|w| w[1] - w[0]).collect();

        let max_d1 = d1.iter().fold(0.0f32, |m, v| m.max(v.abs()));
        let max_d2 = d2.iter().fold(0.0f32, |m, v| m.max(v.abs()));
        assert!(
            max_d1 > 1e-6,
            "{name}: the sweep must actually move, else the test is vacuous"
        );
        assert!(
            max_d2 <= MAX_CURVATURE_RATIO * max_d1,
            "{name}: band boundary detected — max|Δ²|={max_d2:.3e} exceeds \
             {MAX_CURVATURE_RATIO} × max|Δ|={max_d1:.3e} (ratio {:.3})",
            max_d2 / max_d1
        );
    }
}

/// The same smoothness holds with the balance pushed to either rail —
/// warping the tonal axis must not reintroduce a boundary.
#[test]
fn zone_blend_stays_smooth_at_balance_rails() {
    const N: u32 = 512;
    for &bal in &[-100.0f32, 100.0] {
        let sliders = ColorGradeSliders {
            balance: bal,
            ..contrasting_zones()
        };
        let mut img = grey_ramp(N);
        let before: Vec<f32> = img.pixels.iter().map(|p| rec2020_to_oklab(*p)[1]).collect();
        apply(&mut img, &sliders);
        let series: Vec<f32> = img
            .pixels
            .iter()
            .zip(&before)
            .map(|(p, b)| rec2020_to_oklab(*p)[1] - b)
            .collect();
        let d1: Vec<f32> = series.windows(2).map(|w| w[1] - w[0]).collect();
        let d2: Vec<f32> = d1.windows(2).map(|w| w[1] - w[0]).collect();
        let max_d1 = d1.iter().fold(0.0f32, |m, v| m.max(v.abs()));
        let max_d2 = d2.iter().fold(0.0f32, |m, v| m.max(v.abs()));
        assert!(
            max_d2 <= 0.25 * max_d1,
            "balance {bal}: max|Δ²|={max_d2:.3e} vs max|Δ|={max_d1:.3e}"
        );
    }
}

// ── Stage contract ────────────────────────────────────────────────────────

/// The Oklab shift on a grey pixel matches the closed form exactly — the
/// whole-stage contract, and the predictor's warrant.
#[test]
fn grey_shift_matches_closed_form() {
    for &v in &[0.02f32, 0.18, 0.5, 0.82, 0.97] {
        let sliders = contrasting_zones();
        let mut img = grey_display(2, 2, v);
        let lab_before = rec2020_to_oklab(img.pixels[0]);
        apply(&mut img, &sliders);
        let lab_after = rec2020_to_oklab(img.pixels[0]);

        let p = color_grade_params(&sliders);
        let yd = 0.2627 * v + 0.6780 * v + 0.0593 * v;
        let expected = color_grade_shift(yd, &p);

        assert!(
            (lab_after[1] - lab_before[1] - expected[0]).abs() < 1e-5,
            "Δa mismatch at v={v}"
        );
        assert!(
            (lab_after[2] - lab_before[2] - expected[1]).abs() < 1e-5,
            "Δb mismatch at v={v}"
        );
        assert!(
            (lab_after[0] - lab_before[0] - expected[2]).abs() < 1e-5,
            "ΔL mismatch at v={v}"
        );
    }
}

/// Warm shadows / cool highlights split by luminance, and the midtone
/// wheel colours the middle without touching either end.
#[test]
fn wheels_separate_by_luminance() {
    let tint = |v: f32, s: ColorGradeSliders| {
        let mut img = grey_display(1, 1, v);
        apply(&mut img, &s);
        let lab = rec2020_to_oklab(img.pixels[0]);
        (lab[1], lab[2])
    };
    let shadows_only = ColorGradeSliders {
        shadow: [30.0, 80.0, 0.0],
        ..Default::default()
    };
    let mids_only = ColorGradeSliders {
        midtone: [30.0, 80.0, 0.0],
        ..Default::default()
    };
    let highs_only = ColorGradeSliders {
        highlight: [30.0, 80.0, 0.0],
        ..Default::default()
    };

    let (a_dark, _) = tint(0.01, shadows_only);
    let (a_dark_from_mid, _) = tint(0.01, mids_only);
    let (a_mid, _) = tint(0.5, mids_only);
    let (a_bright, _) = tint(0.99, highs_only);
    let (a_bright_from_shadow, _) = tint(0.99, shadows_only);

    assert!(a_dark > 0.03, "shadow wheel must tint black (a={a_dark})");
    assert!(a_mid > 0.03, "midtone wheel must tint mid-grey (a={a_mid})");
    assert!(
        a_bright > 0.03,
        "highlight wheel must tint white (a={a_bright})"
    );
    assert!(
        a_dark_from_mid.abs() < 1e-3,
        "midtone wheel must not reach black (a={a_dark_from_mid})"
    );
    assert!(
        a_bright_from_shadow.abs() < 1e-3,
        "shadow wheel must not reach white (a={a_bright_from_shadow})"
    );
}

/// The global wheel is unweighted: it shifts every tone by the same
/// `(Δa, Δb)`, black to white.
#[test]
fn global_wheel_shifts_every_tone_equally() {
    let sliders = ColorGradeSliders {
        global: [200.0, 70.0, 0.0],
        ..Default::default()
    };
    let ab = |v: f32| {
        let mut img = grey_display(1, 1, v);
        apply(&mut img, &sliders);
        let lab = rec2020_to_oklab(img.pixels[0]);
        (lab[1], lab[2])
    };
    let (a0, b0) = ab(0.05);
    let (a1, b1) = ab(0.5);
    let (a2, b2) = ab(0.95);
    assert!((a0 - a1).abs() < 1e-5 && (a1 - a2).abs() < 1e-5, "Δa drifted");
    assert!((b0 - b1).abs() < 1e-5 && (b1 - b2).abs() < 1e-5, "Δb drifted");
    assert!(a0.abs() + b0.abs() > 0.01, "the global wheel must do something");
}

/// A per-zone luminance offset moves Oklab `L` in its own zone and only
/// there — the split-toning stage's L-invariance is deliberately relaxed
/// here, which is the point of the third slider.
#[test]
fn zone_luminance_lifts_only_its_own_zone() {
    let sliders = ColorGradeSliders {
        shadow: [0.0, 0.0, 80.0],
        ..Default::default()
    };
    let delta_l = |v: f32| {
        let mut img = grey_display(1, 1, v);
        let before = rec2020_to_oklab(img.pixels[0])[0];
        apply(&mut img, &sliders);
        rec2020_to_oklab(img.pixels[0])[0] - before
    };
    let dark = delta_l(0.01);
    let bright = delta_l(0.99);
    assert!(
        (dark - COLOR_GRADE_LUMA_K * 0.8).abs() < 1e-3,
        "shadow lum must lift black by Kl·0.8: {dark}"
    );
    assert!(
        bright.abs() < 1e-3,
        "shadow lum must leave white alone: {bright}"
    );
}

/// `from_model` picks up the split-toning fields for shadow/highlight
/// hue+sat and balance (ACR's own layout) and the `color_grade_*` fields
/// for everything else.
#[test]
fn from_model_maps_every_slider() {
    let m = AdjustmentModel {
        split_tone_shadow_hue: 12.0,
        split_tone_shadow_saturation: 34.0,
        split_tone_highlight_hue: 56.0,
        split_tone_highlight_saturation: 78.0,
        split_tone_balance: -25.0,
        color_grade_shadow_luminance: 11.0,
        color_grade_midtone_hue: 22.0,
        color_grade_midtone_saturation: 33.0,
        color_grade_midtone_luminance: -44.0,
        color_grade_highlight_luminance: 55.0,
        color_grade_global_hue: 66.0,
        color_grade_global_saturation: 77.0,
        color_grade_global_luminance: -88.0,
        ..AdjustmentModel::default()
    };
    let s = ColorGradeSliders::from_model(&m);
    assert_eq!(s.shadow, [12.0, 34.0, 11.0]);
    assert_eq!(s.midtone, [22.0, 33.0, -44.0]);
    assert_eq!(s.highlight, [56.0, 78.0, 55.0]);
    assert_eq!(s.global, [66.0, 77.0, -88.0]);
    assert_eq!(s.balance, -25.0);
}
