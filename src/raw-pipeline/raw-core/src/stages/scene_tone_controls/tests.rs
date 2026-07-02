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

// ----------------------------------------------------------------
// Ticket #433 — verify scene-referred + hue-preserving for all four
// tone sliders. The first two (highlights, whites) already have hue
// tests above; these complete the matrix for shadows and blacks.
//
// "Hue-preserving" here means: a uniform scalar multiply on RGB, so
// R:G:B ratios survive unchanged. The blacks **positive** branch
// (additive lift) intentionally does NOT preserve hue on a saturated
// pixel with one channel at 0 — adding a uniform `delta` to (0, g, b)
// produces (delta, g+delta, b+delta), which shifts chromaticity by
// construction. That's a documented design choice (zero pixels must
// lift to a positive value, matching legacy semantics — see step 5
// comment block in `apply`). The test below pins that asymmetry so
// future refactors can't accidentally swap the lift to a
// multiplicative form without making a deliberate decision.
// ----------------------------------------------------------------

#[test]
fn shadows_preserves_hue_on_saturated_deep_shadow() {
    // Saturated deep red [0.06, 0.02, 0.01]: Y ≈ 0.0299, well inside the
    // #1103 engagement band (Y < 0.25), so mix(1, 2^1.5, w_s(Y)) > 1 and
    // each channel scales by the SAME factor — a uniform scalar multiply.
    // R:G and R:B ratios must survive within 0.1% (no per-channel drift).
    let mut img = fresh_img([0.06, 0.02, 0.01]);
    let mut m = model_default();
    m.shadows = 100.0;
    apply(&mut img, &m);
    let p = img.pixels[0];
    let ratio_rg_in = 0.06 / 0.02;
    let ratio_rb_in = 0.06 / 0.01;
    let ratio_rg_out = p[0] / p[1];
    let ratio_rb_out = p[0] / p[2];
    assert!(
        (ratio_rg_out - ratio_rg_in).abs() / ratio_rg_in < 0.001,
        "shadows+100 R:G drift {} → {}",
        ratio_rg_in,
        ratio_rg_out
    );
    assert!(
        (ratio_rb_out - ratio_rb_in).abs() / ratio_rb_in < 0.001,
        "shadows+100 R:B drift {} → {}",
        ratio_rb_in,
        ratio_rb_out
    );
    // And the lift direction is correct.
    assert!(
        p[0] > 0.06,
        "shadows+100 should brighten saturated deep red, got {}",
        p[0]
    );
}

#[test]
fn shadows_negative_preserves_hue_on_saturated_deep_shadow() {
    // Symmetric: shadows=-100 multiplies by mix(1, 2^−1.5, w_s) (#1103) —
    // still a uniform scalar so ratios survive. Verify both direction
    // (crush) and hue preservation.
    let mut img = fresh_img([0.06, 0.02, 0.01]);
    let mut m = model_default();
    m.shadows = -100.0;
    apply(&mut img, &m);
    let p = img.pixels[0];
    let ratio_rg_out = p[0] / p[1];
    let ratio_rb_out = p[0] / p[2];
    assert!(
        (ratio_rg_out - 3.0).abs() / 3.0 < 0.001,
        "shadows-100 R:G drift, got {}",
        ratio_rg_out
    );
    assert!(
        (ratio_rb_out - 6.0).abs() / 6.0 < 0.001,
        "shadows-100 R:B drift, got {}",
        ratio_rb_out
    );
    assert!(
        p[0] < 0.06,
        "shadows-100 should crush deep shadow, got {}",
        p[0]
    );
}

#[test]
fn blacks_negative_preserves_hue_on_saturated_deep_shadow() {
    // Crush branch (blacks < 0) is multiplicative: factor = 1 + b_amount*w.
    // For a saturated deep red [0.06, 0.02, 0.01] all three channels
    // multiply by the SAME factor (luma drives the weight, not
    // per-channel value), so ratios survive.
    let mut img = fresh_img([0.06, 0.02, 0.01]);
    let mut m = model_default();
    m.blacks = -100.0;
    apply(&mut img, &m);
    let p = img.pixels[0];
    let ratio_rg_out = p[0] / p[1];
    let ratio_rb_out = p[0] / p[2];
    assert!(
        (ratio_rg_out - 3.0).abs() / 3.0 < 0.001,
        "blacks-100 R:G drift, got {}",
        ratio_rg_out
    );
    assert!(
        (ratio_rb_out - 6.0).abs() / 6.0 < 0.001,
        "blacks-100 R:B drift, got {}",
        ratio_rb_out
    );
    assert!(p[0] < 0.06, "blacks-100 should crush, got {}", p[0]);
}

#[test]
fn blacks_positive_proportional_lift_preserves_ratios() {
    // Lift branch (blacks > 0) is proportional: it scales channels based on luma remapping
    // to preserve chromaticity ratios exactly.
    let mut img = fresh_img([0.06, 0.05, 0.04]);
    let mut m = model_default();
    m.blacks = 25.0;
    apply(&mut img, &m);
    let p = img.pixels[0];
    // Ratios must be exactly preserved: p[0]/0.06 == p[1]/0.05 == p[2]/0.04
    let r0 = p[0] / 0.06;
    let r1 = p[1] / 0.05;
    let r2 = p[2] / 0.04;
    assert!(
        (r0 - r1).abs() < 1e-5,
        "ratio R/G changed: {} vs {}",
        r0,
        r1
    );
    assert!(
        (r0 - r2).abs() < 1e-5,
        "ratio R/B changed: {} vs {}",
        r0,
        r2
    );
    // Direction.
    assert!(p[0] > 0.06, "blacks+25 should lift, got {}", p[0]);
}

#[test]
fn blacks_positive_lift_preserves_chromaticity_for_non_zero_luma() {
    // With R initially at 0.0, and Y_in > 1e-6 (since G and B are non-zero),
    // proportional luma scaling will scale R by y_out / y_in, meaning R remains exactly 0.0.
    let mut img = fresh_img([0.0, 0.05, 0.10]);
    let mut m = model_default();
    m.blacks = 100.0;
    apply(&mut img, &m);
    let p = img.pixels[0];
    assert!(
        p[0] == 0.0,
        "R was 0 and should remain 0 under proportional scaling, got {}",
        p[0]
    );
    let r1 = p[1] / 0.05;
    let r2 = p[2] / 0.10;
    assert!(
        (r1 - r2).abs() < 1e-5,
        "ratio G/B changed: {} vs {}",
        r1,
        r2
    );
}

#[test]
fn highlights_preserves_hue_on_arbitrary_saturated_above_knee() {
    // Sweep a few saturated colours through highlights=+50 and
    // verify R:G:B ratios survive. Adds breadth to the existing
    // two-case hue test above.
    let cases: &[[f32; 3]] = &[
        [2.0, 1.5, 0.5], // warm above knee
        [0.5, 1.5, 2.0], // cool above knee
        [1.8, 1.8, 0.2], // yellow above knee
    ];
    for &input in cases {
        let mut img = fresh_img(input);
        let mut m = model_default();
        m.highlights = 50.0;
        apply(&mut img, &m);
        let p = img.pixels[0];
        // Verify uniform scale: out / in should be identical on all
        // channels that started non-zero.
        let s_r = p[0] / input[0];
        let s_g = p[1] / input[1];
        let s_b = p[2] / input[2];
        assert!(
            (s_r - s_g).abs() / s_r < 0.001,
            "highlights+50 hue drift on {:?}: scale R={} G={}",
            input,
            s_r,
            s_g
        );
        assert!(
            (s_r - s_b).abs() / s_r < 0.001,
            "highlights+50 hue drift on {:?}: scale R={} B={}",
            input,
            s_r,
            s_b
        );
    }
}

#[test]
fn whites_preserves_hue_on_arbitrary_saturated() {
    // Sweep saturated near-white colours through whites=±50; assert
    // uniform scaling (already tested for one neutral case above —
    // this adds saturated coverage).
    let cases: &[[f32; 3]] = &[[0.95, 0.70, 0.50], [0.50, 0.70, 0.95], [0.95, 0.95, 0.40]];
    for &slider in &[50.0_f32, -50.0] {
        for &input in cases {
            let mut img = fresh_img(input);
            let mut m = model_default();
            m.whites = slider;
            apply(&mut img, &m);
            let p = img.pixels[0];
            let s_r = p[0] / input[0];
            let s_g = p[1] / input[1];
            let s_b = p[2] / input[2];
            assert!(
                (s_r - s_g).abs() / s_r.abs().max(1e-6) < 0.001,
                "whites={} hue drift on {:?}",
                slider,
                input
            );
            assert!(
                (s_r - s_b).abs() / s_r.abs().max(1e-6) < 0.001,
                "whites={} hue drift on {:?}",
                slider,
                input
            );
        }
    }
}

// ----------------------------------------------------------------
// Scene-referred placement: these tests pin that the stage operates
// in scene-linear Rec.2020 (so it can see values > 1.0 unclipped)
// and never clamps to display range. The pipeline-level invariant
// (runs BEFORE the AgX view transform) lives in
// `pipeline::scene_linear_chain` and is asserted there.
// ----------------------------------------------------------------

#[test]
fn scene_referred_handles_values_above_unity() {
    // Ticket #433: stage must operate on unbounded scene-linear
    // f32. A value at 5.0 (specular highlight) must survive all
    // four sliders at zero (identity short-circuit) and survive
    // a positive exposure (linear gain) without clipping.
    let mut img = fresh_img([5.0, 5.0, 5.0]);
    let mut m = model_default();
    m.exposure = 1.0; // ×2 → 10.0
    apply(&mut img, &m);
    let p = img.pixels[0];
    assert!(
        (p[0] - 10.0).abs() < 1e-4,
        "expected unclipped 10.0, got {}",
        p[0]
    );
    assert_eq!(p[0], p[1]);
    assert_eq!(p[1], p[2]);
}

#[test]
fn scene_referred_does_not_clip_negatives_introduced_upstream() {
    // DCP on saturated colours can yield slightly negative
    // scene-linear values. The stage must not clamp; downstream
    // AgX handles negatives. Validate by feeding a slight negative
    // and ensuring exposure (the only operation that touches every
    // pixel unconditionally) passes the sign through.
    let mut img = fresh_img([-0.01, 0.5, 0.5]);
    let mut m = model_default();
    m.exposure = 1.0; // ×2 → [-0.02, 1.0, 1.0]
    apply(&mut img, &m);
    let p = img.pixels[0];
    assert!(
        (p[0] - (-0.02)).abs() < 1e-5,
        "scene-linear stage must pass negatives through, got R={}",
        p[0]
    );
}

#[test]
fn exposure_and_highlights_compose() {
    // Exposure +1 doubles 0.6 → 1.2 (above knee). Then highlights +100
    // applies the #1103 response at the post-exposure luma: shape
    // (1 + 0.2/3)/1.2 times weighted gain 2^(−0.7·w_h(1.2)) with w_h
    // saturated at 1 → out = 1.0667 · 2^−0.7 ≈ 0.6566.
    let mut img = fresh_img([0.6, 0.6, 0.6]);
    let mut m = model_default();
    m.exposure = 1.0;
    m.highlights = 100.0;
    apply(&mut img, &m);
    let p = img.pixels[0];
    let expected = (1.0 + 0.2 / 3.0) * (-0.7_f32).exp2();
    assert!(
        (p[0] - expected).abs() < 1e-4,
        "R was {}, expected {}",
        p[0],
        expected
    );
}
