//! Ticket #433 hue-preservation matrix + scene-referred placement tests for
//! the scene-tone-controls stage. Extracted from the sibling `tests.rs` when
//! the file crossed the 600-LOC hard cap (per CONTRIBUTING.md) — same split
//! as `tests_brightness.rs`.

#![cfg(test)]

use super::*;

// Duplicates of `tests::model_default` / `tests::fresh_img` — the sibling
// `mod tests` is a private cousin; duplicating two tiny constructors keeps
// the helpers test-local (per the `xmp/tests_modes.rs` precedent) instead
// of widening their visibility.
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
