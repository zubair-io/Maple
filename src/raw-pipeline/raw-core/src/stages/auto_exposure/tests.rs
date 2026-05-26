//! Tests for the auto-exposure stage. Split out of `mod.rs` to keep both
//! files under the 600-LOC hard cap (per CONTRIBUTING.md). Visibility:
//! all helpers used here are already `pub` on `mod.rs`, so `use super::*;`
//! is sufficient.

#![cfg(test)]

use super::*;

fn build_image(w: u32, h: u32, f: impl Fn(u32, u32) -> [f32; 3]) -> Image {
    let mut img = Image::new(w, h, ColorSpace::SceneLinearRec2020);
    for y in 0..h {
        for x in 0..w {
            img.pixels[(y * w + x) as usize] = f(x, y);
        }
    }
    img
}

#[test]
fn black_frame_anchor_is_identity() {
    let img = build_image(32, 32, |_, _| [0.0, 0.0, 0.0]);
    let gain = compute_scene_anchor_gain(&img);
    assert_eq!(gain, 1.0);
}

#[test]
fn mid_grey_anchor_is_unity() {
    // A 0.18 neutral frame is already at mid-gray — anchor must
    // produce ~1.0.
    let img = build_image(64, 64, |_, _| [0.18, 0.18, 0.18]);
    let gain = compute_scene_anchor_gain(&img);
    assert!(
        (gain - 1.0).abs() < 1e-4,
        "mid-grey scene should yield gain ≈ 1.0; got {}",
        gain
    );
}

#[test]
fn dark_scene_gets_positive_gain() {
    // Uniform 5% grey → gain ≈ 0.18 / 0.05 = 3.6.
    let img = build_image(64, 64, |_, _| [0.05, 0.05, 0.05]);
    let gain = compute_scene_anchor_gain(&img);
    assert!(
        (gain - 3.6).abs() < 1e-3,
        "5% grey should yield gain ≈ 3.6; got {}",
        gain
    );
}

#[test]
fn bright_scene_gets_negative_gain() {
    // Uniform 50% grey → gain ≈ 0.18 / 0.5 = 0.36.
    let img = build_image(64, 64, |_, _| [0.5, 0.5, 0.5]);
    let gain = compute_scene_anchor_gain(&img);
    assert!(
        (gain - 0.36).abs() < 1e-3,
        "50% grey should yield gain ≈ 0.36; got {}",
        gain
    );
}

#[test]
fn anchor_gain_is_clamped() {
    // Near-black image: midgrey ≈ 0.001 → raw gain ≈ 180 → clamped to 8.0.
    let img = build_image(64, 64, |_, _| [0.001, 0.001, 0.001]);
    let gain = compute_scene_anchor_gain(&img);
    assert_eq!(gain, MAX_ANCHOR_GAIN, "near-black gain must be clamped");
}

#[test]
fn specular_highlights_dont_dominate() {
    // Mostly mid-gray with a sprinkling of >1.0 specular pixels. The
    // P75 trim means the highlights are excluded from the geometric
    // mean — the anchor still lands on the bulk of the histogram.
    let img = build_image(32, 32, |x, y| {
        // Top-right quadrant gets specular highlights at 5.0; the
        // other 3/4 of the image is at 0.18.
        if x >= 16 && y < 16 {
            [5.0, 5.0, 5.0]
        } else {
            [0.18, 0.18, 0.18]
        }
    });
    let gain = compute_scene_anchor_gain(&img);
    assert!(
        (gain - 1.0).abs() < 1e-3,
        "specular highlights should not perturb the anchor; got {}",
        gain
    );
}

#[test]
fn crushed_shadows_dont_dominate() {
    // Mid-gray plus a crushed-shadow patch at 0.0. The P25 trim
    // removes the zeros from the geometric mean.
    let img = build_image(32, 32, |x, y| {
        if x < 16 && y < 16 {
            [0.0, 0.0, 0.0]
        } else {
            [0.18, 0.18, 0.18]
        }
    });
    let gain = compute_scene_anchor_gain(&img);
    assert!(
        (gain - 1.0).abs() < 1e-3,
        "crushed shadows should not perturb the anchor; got {}",
        gain
    );
}

#[test]
fn apply_off_is_identity() {
    let mut img = build_image(16, 16, |x, _| {
        let v = (x as f32 / 15.0) * 0.5;
        [v, v, v]
    });
    let original = img.pixels.clone();
    let mut model = AdjustmentModel::default();
    model.auto_exposure = AutoExposureMode::Off;
    let gain = apply(&mut img, &model);
    assert_eq!(gain, 1.0);
    for (pa, pb) in img.pixels.iter().zip(original.iter()) {
        assert_eq!(pa, pb, "AutoExposureMode::Off must be a bit-identical no-op");
    }
}

#[test]
fn apply_on_multiplies_pixels() {
    // 5% scene → anchor gain ≈ 3.6 → output ≈ 0.18.
    let mut img = build_image(64, 64, |_, _| [0.05, 0.05, 0.05]);
    let mut model = AdjustmentModel::default();
    model.auto_exposure = AutoExposureMode::On;
    let gain = apply(&mut img, &model);
    assert!((gain - 3.6).abs() < 1e-3);
    for p in &img.pixels {
        for c in 0..3 {
            assert!(
                (p[c] - 0.18).abs() < 1e-3,
                "anchored pixel should be ≈ 0.18; got {}",
                p[c]
            );
        }
    }
}

#[test]
fn apply_is_deterministic() {
    let make = || build_image(96, 96, |x, y| {
        let v = ((x + y) as f32 / 191.0) * 0.4;
        [v, v * 0.9, v * 1.1]
    });
    let mut a = make();
    let mut b = make();
    let model = AdjustmentModel::default();
    let ga = apply(&mut a, &model);
    let gb = apply(&mut b, &model);
    assert_eq!(ga.to_bits(), gb.to_bits());
    for (pa, pb) in a.pixels.iter().zip(b.pixels.iter()) {
        for c in 0..3 {
            assert_eq!(pa[c].to_bits(), pb[c].to_bits());
        }
    }
}
