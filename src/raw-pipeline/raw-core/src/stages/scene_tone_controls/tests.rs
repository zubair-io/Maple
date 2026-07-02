//! Tests for the scene-tone-controls stage. Split out of `mod.rs` to
//! keep both files under the 600-LOC hard cap (per CONTRIBUTING.md).
//! Visibility: private functions and constants on `mod.rs` are visible
//! to this child module via `use super::*;` — no production code needs
//! to be touched to make the tests compile.

#![cfg(test)]

use super::*;

fn model_default() -> AdjustmentModel {
    AdjustmentModel::default()
}

fn fresh_img(value: [f32; 3]) -> Image {
    let mut img = Image::new(2, 2, ColorSpace::SceneLinearRec2020);
    for p in &mut img.pixels {
        *p = value;
    }
    img
}

#[test]
fn identity_when_all_fields_zero() {
    let mut img = fresh_img([0.3, 0.4, 0.5]);
    apply(&mut img, &model_default());
    for p in &img.pixels {
        assert_eq!(*p, [0.3, 0.4, 0.5]);
    }
}

#[test]
fn exposure_plus_one_doubles() {
    let mut img = fresh_img([0.1, 0.2, 0.3]);
    let mut m = model_default();
    m.exposure = 1.0;
    apply(&mut img, &m);
    let p = img.pixels[0];
    assert!((p[0] - 0.2).abs() < 1e-6);
    assert!((p[1] - 0.4).abs() < 1e-6);
    assert!((p[2] - 0.6).abs() < 1e-6);
}

#[test]
fn exposure_preserves_scene_headroom() {
    let mut img = fresh_img([5.0, 5.0, 5.0]);
    let mut m = model_default();
    m.exposure = 1.0;
    apply(&mut img, &m);
    assert_eq!(img.pixels[0], [10.0, 10.0, 10.0]);
}

#[test]
fn highlights_positive_compresses_above_knee() {
    // Neutral pixel above the knee: Y = 2.0 > 1.0 (#1103 response).
    // Shape: Y_new = 1 + 1/3 (the kept pre-#1103 compression), times the
    // weighted gain g = 2^(−0.7·1·w_h(2)) with w_h saturated at 1.
    // All channels land at (4/3)·2^−0.7 ≈ 0.8208.
    let mut img = fresh_img([2.0, 2.0, 2.0]);
    let mut m = model_default();
    m.highlights = 100.0;
    apply(&mut img, &m);
    let p = img.pixels[0];
    let expected = (1.0 + 1.0 / 3.0) * (-0.7_f32).exp2();
    assert!(
        (p[0] - expected).abs() < 1e-4,
        "R was {}, expected {}",
        p[0],
        expected
    );
}

#[test]
fn highlights_leaves_below_engagement_untouched() {
    // #1103: the engagement floor is Y = 0.25 (calibrated, see H_W0) —
    // below it `w_h` clamps to exactly 0, the gain is exp2(0) = 1.0, and
    // (below the knee) the shape term is 1: bit-exact passthrough even at
    // the slider rail.
    let mut img = fresh_img([0.20, 0.20, 0.20]);
    let mut m = model_default();
    m.highlights = 100.0;
    apply(&mut img, &m);
    assert_eq!(img.pixels[0], [0.20, 0.20, 0.20]);
}

#[test]
fn highlights_engages_below_the_knee() {
    // #1103: the headline behaviour change — a bright-but-unclipped tone
    // (Y = 0.7 < 1.0) now responds. w_h(0.7) = smoothstep(0.25, 1, 0.7) =
    // 0.648, so +100 darkens by 2^(−0.7·0.648) ≈ 0.7301 and −100 brightens
    // by the mirror factor.
    let g = (-0.7_f32 * 0.648).exp2();
    let mut img = fresh_img([0.7, 0.7, 0.7]);
    let mut m = model_default();
    m.highlights = 100.0;
    apply(&mut img, &m);
    let p = img.pixels[0];
    assert!(
        (p[0] - 0.7 * g).abs() < 1e-4,
        "+100 expected {}, got {}",
        0.7 * g,
        p[0]
    );

    let mut img = fresh_img([0.7, 0.7, 0.7]);
    let mut m = model_default();
    m.highlights = -100.0;
    apply(&mut img, &m);
    let p = img.pixels[0];
    assert!(
        (p[0] - 0.7 / g).abs() < 1e-4,
        "-100 expected {}, got {}",
        0.7 / g,
        p[0]
    );
}

#[test]
fn highlights_preserves_hue_on_partial_specular_below_knee_luma() {
    // Ticket #266 acceptance — direct case from the spec.
    // Specular red at [2.0, 0.5, 0.5]: R is above the per-channel
    // knee, but Y = 0.2627*2 + 0.6780*0.5 + 0.0593*0.5 ≈ 0.895 < 1.
    //
    // Pre-fix (per-channel): R was compressed from 2.0 to 1.333
    // while G and B stayed at 0.5 — R:G:B drifted from 4:1:1 to
    // 2.67:1:1, a hue rotation.
    //
    // Post-fix (luma-coupled): Y < knee so the shape term is 1; the
    // #1103 weighted gain does engage (w_h(0.895) > 0) but it is a
    // single uniform scalar — ratios preserved identically.
    let mut img = fresh_img([2.0, 0.5, 0.5]);
    let mut m = model_default();
    m.highlights = 100.0;
    apply(&mut img, &m);
    let p = img.pixels[0];
    let ratio_rg = p[0] / p[1];
    let ratio_rb = p[0] / p[2];
    assert!(
        (ratio_rg - 4.0).abs() / 4.0 < 0.01,
        "R:G drift {} ",
        ratio_rg
    );
    assert!(
        (ratio_rb - 4.0).abs() / 4.0 < 0.01,
        "R:B drift {} ",
        ratio_rb
    );
}

#[test]
fn highlights_preserves_hue_on_specular_above_knee_luma() {
    // Companion to the test above — when Y exceeds the knee the
    // compression *does* trigger, and we must verify it scales
    // uniformly (no hue rotation).
    //
    // Input [2.0, 1.5, 1.5]: Y ≈ 0.2627*2 + 0.6780*1.5 + 0.0593*1.5
    // ≈ 1.6364 > 1. Pre-fix would have compressed R from 2.0 to
    // 1.333 (excess 1.0 → 1/3) but G and B from 1.5 to 1.167
    // (excess 0.5 → 1/6) — drift in R:G:B.
    //
    // Post-fix scales by the shape (1 + 0.6364/3) / 1.6364 ≈ 0.741 times
    // the #1103 weighted gain 2^−0.7 — still one uniform factor for all
    // three channels → ratios preserved.
    let mut img = fresh_img([2.0, 1.5, 1.5]);
    let mut m = model_default();
    m.highlights = 100.0;
    apply(&mut img, &m);
    let p = img.pixels[0];
    let ratio_rg = p[0] / p[1];
    let ratio_rb = p[0] / p[2];
    assert!(
        (ratio_rg - 4.0 / 3.0).abs() / (4.0 / 3.0) < 0.01,
        "R:G drift {} ",
        ratio_rg
    );
    assert!(
        (ratio_rb - 4.0 / 3.0).abs() / (4.0 / 3.0) < 0.01,
        "R:B drift {} ",
        ratio_rb
    );
}

#[test]
fn shadows_lifts_deep_values() {
    let mut img = fresh_img([0.02, 0.02, 0.02]);
    let mut m = model_default();
    m.shadows = 100.0;
    apply(&mut img, &m);
    let p = img.pixels[0];
    // #1103: luma = 0.02 → w_s = (1 − smoothstep(0, 0.25, 0.02))² ≈ 0.963,
    // mult = 1 + (2^1.5 − 1)·w_s ≈ 2.76 → p ≈ 0.055.
    assert!(p[0] > 0.02, "expected lift, got {}", p[0]);
    let expected = 0.02
        * (1.0
            + ((1.5_f32).exp2() - 1.0) * {
                let t = 1.0 - {
                    let tt = (0.02_f32 / 0.25).clamp(0.0, 1.0);
                    tt * tt * (3.0 - 2.0 * tt)
                };
                t * t
            });
    assert!(
        (p[0] - expected).abs() < 1e-5,
        "expected {}, got {}",
        expected,
        p[0]
    );
}

#[test]
fn shadows_leaves_midtones_alone() {
    let mut img = fresh_img([0.3, 0.3, 0.3]);
    let mut m = model_default();
    m.shadows = 100.0;
    apply(&mut img, &m);
    // #1103: luma 0.3 ≥ engagement ceiling 0.25 → w_s = 0 exactly → no
    // change even at the rail.
    for p in &img.pixels {
        for &c in p {
            assert!((c - 0.3).abs() < 1e-5);
        }
    }
}

#[test]
fn whites_midtone_untouched_at_y_half() {
    // Ticket #267 acceptance — a pixel at Y=0.5 must change by <1%.
    // smoothstep(0.5, 1.0, 0.5) == 0 → gain = 1.0 → no change.
    let mut img = fresh_img([0.5, 0.5, 0.5]);
    let mut m = model_default();
    m.whites = 100.0;
    apply(&mut img, &m);
    let p = img.pixels[0];
    for &c in &p {
        assert!(
            (c - 0.5).abs() / 0.5 < 0.01,
            "Y=0.5 should not lift, got {}",
            c
        );
    }
}

#[test]
fn whites_lifts_upper_end_substantially() {
    // Ticket #267 acceptance — a pixel near diffuse white must lift
    // by ≥20% at whites=+100. For input [0.95, 0.95, 0.95]:
    // Y=0.95, w = smoothstep(0.5, 1.0, 0.95) → t=0.9, w = 0.81*1.2 = 0.972.
    // gain = 1 + 0.5*0.972 = 1.486. p_new = 0.95 * 1.486 ≈ 1.412.
    // Lift ratio ≈ 0.486 — well above the 20% bar.
    let mut img = fresh_img([0.95, 0.95, 0.95]);
    let mut m = model_default();
    m.whites = 100.0;
    apply(&mut img, &m);
    let p = img.pixels[0];
    let lift = (p[0] - 0.95) / 0.95;
    assert!(lift >= 0.20, "expected ≥20% lift at Y=0.95, got {}", lift);
}

#[test]
fn whites_preserves_neutral_hue() {
    // Uniform scalar gain → ratios preserved across all channels.
    let mut img = fresh_img([1.2, 0.9, 0.6]);
    let mut m = model_default();
    m.whites = 50.0;
    apply(&mut img, &m);
    let p = img.pixels[0];
    // R:G = 1.2/0.9 = 1.333; R:B = 1.2/0.6 = 2.0. Both must be preserved.
    let ratio_rg = p[0] / p[1];
    let ratio_rb = p[0] / p[2];
    assert!(
        (ratio_rg - 4.0 / 3.0).abs() < 1e-4,
        "R:G {} ≠ 1.333",
        ratio_rg
    );
    assert!((ratio_rb - 2.0).abs() < 1e-4, "R:B {} ≠ 2.0", ratio_rb);
}

#[test]
fn whites_symmetric_negative_pulls_bright_values_down() {
    // Ticket #267 — symmetric for negative whites. Y=0.95, whites=-100
    // pulls brightness down without touching midtones. Check that
    // the same Y=0.5 pixel remains within 1% under the same setting.
    let mut img_bright = fresh_img([0.95, 0.95, 0.95]);
    let mut img_mid = fresh_img([0.5, 0.5, 0.5]);
    let mut m = model_default();
    m.whites = -100.0;
    apply(&mut img_bright, &m);
    apply(&mut img_mid, &m);
    let p_bright = img_bright.pixels[0];
    let p_mid = img_mid.pixels[0];
    assert!(
        p_bright[0] < 0.95,
        "expected pull-down at Y=0.95, got {}",
        p_bright[0]
    );
    assert!(
        (p_mid[0] - 0.5).abs() / 0.5 < 0.01,
        "Y=0.5 should not move, got {}",
        p_mid[0]
    );
}

#[test]
fn blacks_shift_floors_at_zero_for_deep_shadows() {
    // Bug A regression test (Ticket 11 / .archived-plans/specs/
    // 2026-04-26-blacks-clarity-bug-investigation.md). The old
    // additive shift `p += blacks/400` drove a scene-linear 0.0
    // pixel to -0.25 under blacks=-100, which fed AgX's log-encode
    // per channel — any upstream per-channel asymmetry surfaced as
    // R-only / pink speckle on what should be uniform black.
    //
    // Post-fix (#268, multiplicative crush below Y=0.2): zero stays
    // zero, no negative scene values possible. The test contract is
    // unchanged: a 0,0,0 input under blacks=-100 must remain 0,0,0.
    let mut img = fresh_img([0.0, 0.0, 0.0]);
    let mut m = model_default();
    m.blacks = -100.0;
    apply(&mut img, &m);
    for &c in &img.pixels[0] {
        assert_eq!(c, 0.0, "blacks-floored pixel must be exactly 0, got {}", c);
    }
}

#[test]
fn blacks_negative_compresses_deep_shadows_smoothly() {
    // Ticket #268 — deep shadows must retain a smooth toe (not a
    // hard floor). At Y=0.05 with blacks=-100 the multiplicative
    // factor is 1 + (-1)*w where w = 1 - smoothstep(0, 0.2, 0.05).
    // smoothstep(0, 0.2, 0.05): t=0.25, val = 0.0625*(3 - 0.5) = 0.15625.
    // w = 0.844. factor = 1 - 0.844 = 0.156. p_new ≈ 0.0078.
    // Crucially: > 0 (no hard floor), < input (still crushing).
    let mut img = fresh_img([0.05, 0.05, 0.05]);
    let mut m = model_default();
    m.blacks = -100.0;
    apply(&mut img, &m);
    for &c in &img.pixels[0] {
        assert!(c > 0.0, "expected positive scene-linear, got {}", c);
        assert!(c < 0.05, "expected crush below input, got {}", c);
    }
}

#[test]
fn blacks_negative_leaves_midtones_alone() {
    // Y ≥ 0.2 → smoothstep weight is 0 → identity.
    let mut img = fresh_img([0.3, 0.3, 0.3]);
    let mut m = model_default();
    m.blacks = -50.0;
    apply(&mut img, &m);
    for &c in &img.pixels[0] {
        assert!((c - 0.3).abs() < 1e-6, "Y=0.3 should not move, got {}", c);
    }
}

#[test]
fn blacks_no_negative_pixels_at_any_setting() {
    // Ticket #268 acceptance — no pixel goes negative scene-linear
    // for ANY blacks setting. Sweep a few representative settings
    // across a low-luma input that would have driven the legacy
    // additive shift below zero.
    for blacks in &[
        -100.0_f32, -75.0, -50.0, -25.0, -1.0, 1.0, 25.0, 50.0, 100.0,
    ] {
        for &start in &[0.0_f32, 0.005, 0.05, 0.10] {
            let mut img = fresh_img([start, start, start]);
            let mut m = model_default();
            m.blacks = *blacks;
            apply(&mut img, &m);
            for &c in &img.pixels[0] {
                assert!(
                    c >= 0.0,
                    "negative scene-linear value {} from input {} at blacks={}",
                    c,
                    start,
                    blacks,
                );
            }
        }
    }
}

#[test]
fn blacks_positive_lifts_uniformly_at_zero() {
    // blacks=+100, Y=0 → w=1, delta = 100/400 = 0.25 — matches the
    // legacy positive-blacks semantics so the additive lift
    // intuition is preserved for the user.
    let mut img = fresh_img([0.0, 0.0, 0.0]);
    let mut m = model_default();
    m.blacks = 100.0;
    apply(&mut img, &m);
    for &c in &img.pixels[0] {
        assert!((c - 0.25).abs() < 1e-6, "{} != 0.25", c);
    }
}

#[test]
fn blacks_positive_leaves_midtones_alone() {
    // Y ≥ 0.2 → smoothstep weight is 0 → identity.
    let mut img = fresh_img([0.4, 0.4, 0.4]);
    let mut m = model_default();
    m.blacks = 100.0;
    apply(&mut img, &m);
    for &c in &img.pixels[0] {
        assert!((c - 0.4).abs() < 1e-6, "Y=0.4 should not move, got {}", c);
    }
}
