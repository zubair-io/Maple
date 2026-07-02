//! Brightness-slider tests for the scene-tone-controls stage (#1102,
//! tone/zoom design spec § 4.1). Extracted from the sibling `tests.rs`
//! when the brightness coverage pushed that file over the 600-LOC hard
//! cap (per CONTRIBUTING.md) — same split as `tests_highlights.rs` in
//! PR #1117.

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
// Brightness — midtone-band gain (#1102, tone/zoom design spec § 4.1).
// Same proof obligations as the other scene tone sliders: uniform
// scalar per pixel (hue-preserving by construction), band ends pinned,
// zero slider is an exact no-op.
// ----------------------------------------------------------------

#[test]
fn brightness_zero_is_exact_noop() {
    // The b=0 case must be bit-identical (whole-stage short-circuit) so
    // no harness numbers move when the field ships.
    let mut img = fresh_img([0.3, 0.4, 0.5]);
    let mut m = model_default();
    m.brightness = 0.0;
    apply(&mut img, &m);
    for p in &img.pixels {
        assert_eq!(*p, [0.3, 0.4, 0.5]);
    }
}

#[test]
fn brightness_positive_lifts_midtones() {
    // Y = 0.18 sits inside the band: w = smoothstep(0.05, 0.25, 0.18)·1
    //   t = (0.18-0.05)/0.2 = 0.65 → w = 0.65²·(3-1.3) = 0.71825.
    // gain = exp2(0.7·1.0·0.71825) ≈ 2^0.5028 ≈ 1.4169.
    let mut img = fresh_img([0.18, 0.18, 0.18]);
    let mut m = model_default();
    m.brightness = 100.0;
    apply(&mut img, &m);
    let p = img.pixels[0];
    let expected = 0.18 * (0.7_f32 * 0.71825).exp2();
    assert!(
        (p[0] - expected).abs() < 1e-4,
        "expected {}, got {}",
        expected,
        p[0]
    );
    assert!(p[0] > 0.18, "brightness+100 must lift a midtone");
}

#[test]
fn brightness_negative_darkens_midtones() {
    let mut img = fresh_img([0.18, 0.18, 0.18]);
    let mut m = model_default();
    m.brightness = -100.0;
    apply(&mut img, &m);
    assert!(
        img.pixels[0][0] < 0.18,
        "brightness-100 must darken a midtone"
    );
}

#[test]
fn brightness_pins_deep_shadows_exactly() {
    // Y ≤ 0.05 → w = 0 → gain = exp2(0) = 1.0 → bit-exact passthrough,
    // even with the slider railed. Deep shadows stay the blacks/shadows
    // sliders' domain.
    for &v in &[0.0_f32, 0.02, 0.05] {
        let mut img = fresh_img([v, v, v]);
        let mut m = model_default();
        m.brightness = 100.0;
        apply(&mut img, &m);
        assert_eq!(img.pixels[0], [v, v, v], "Y={} must be pinned", v);
    }
}

#[test]
fn brightness_pins_scene_ref_max_exactly() {
    // Y ≥ 4.0 → (1 − smoothstep(1, 4, Y)) = 0 → gain = 1.0 exactly.
    // Specular/HDR headroom stays exposure/highlights territory.
    for &v in &[4.0_f32, 6.0, 10.0] {
        let mut img = fresh_img([v, v, v]);
        let mut m = model_default();
        m.brightness = -100.0;
        apply(&mut img, &m);
        assert_eq!(img.pixels[0], [v, v, v], "Y={} must be pinned", v);
    }
}

#[test]
fn brightness_preserves_hue_on_saturated_midtone() {
    // Uniform scalar multiply → R:G:B ratios survive. Same matrix as the
    // #433 hue tests for shadows/whites/highlights.
    let cases: &[[f32; 3]] = &[
        [0.40, 0.20, 0.10], // warm midtone
        [0.10, 0.20, 0.40], // cool midtone
        [0.30, 0.30, 0.06], // yellow midtone
    ];
    for &slider in &[100.0_f32, -100.0] {
        for &input in cases {
            let mut img = fresh_img(input);
            let mut m = model_default();
            m.brightness = slider;
            apply(&mut img, &m);
            let p = img.pixels[0];
            let s_r = p[0] / input[0];
            let s_g = p[1] / input[1];
            let s_b = p[2] / input[2];
            assert!(
                (s_r - s_g).abs() / s_r < 0.001,
                "brightness={} hue drift on {:?}: scale R={} G={}",
                slider,
                input,
                s_r,
                s_g
            );
            assert!(
                (s_r - s_b).abs() / s_r < 0.001,
                "brightness={} hue drift on {:?}: scale R={} B={}",
                slider,
                input,
                s_r,
                s_b
            );
        }
    }
}

#[test]
fn brightness_monotone_across_band() {
    // The gain curve must be monotone in Y-band weight terms: no
    // mid-band overshoot reversal. Sample the band densely at b=+100 and
    // assert output is monotone in input (gain ≥ 1 everywhere keeps
    // ordering: out(Y) = Y·exp2(0.7·w(Y)) with w piecewise-smooth).
    let mut m = model_default();
    m.brightness = 100.0;
    let mut prev_out = -1.0_f32;
    for i in 0..200 {
        let y = 0.01 + (i as f32) * 0.025; // 0.01 → ~5.0
        let mut img = fresh_img([y, y, y]);
        apply(&mut img, &m);
        let out = img.pixels[0][0];
        assert!(
            out >= prev_out - 1e-6,
            "brightness output non-monotone at Y={}: {} < {}",
            y,
            out,
            prev_out
        );
        prev_out = out;
    }
}

#[test]
fn brightness_composes_after_exposure() {
    // Position contract (#1102): brightness runs AFTER exposure, so its
    // band weight sees the exposure-scaled luma. Exposure +1 moves
    // Y=0.09 → 0.18 (inside the band); brightness then lifts from 0.18.
    let mut img = fresh_img([0.09, 0.09, 0.09]);
    let mut m = model_default();
    m.exposure = 1.0;
    m.brightness = 100.0;
    apply(&mut img, &m);
    let p = img.pixels[0];
    // Expected: brightness applied at post-exposure Y = 0.18 (w = 0.71825).
    let expected = 0.18 * (0.7_f32 * 0.71825).exp2();
    assert!(
        (p[0] - expected).abs() < 1e-4,
        "brightness must see post-exposure luma: expected {}, got {}",
        expected,
        p[0]
    );
}
