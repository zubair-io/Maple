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
fn black_frame_returns_zero_exposure() {
    let img = build_image(32, 32, |_, _| [0.0, 0.0, 0.0]);
    let ae = auto_exposure_from_image(&img, 0.02);
    assert_eq!(ae.expcomp, 0.0);
    assert_eq!(ae.black, 0);
}

#[test]
fn mid_grey_needs_no_exposure() {
    // 18% grey frame — should already land near midgrey.
    let img = build_image(64, 64, |_, _| [0.18, 0.18, 0.18]);
    let ae = auto_exposure_from_image(&img, 0.02);
    assert!(
        ae.expcomp.abs() < 1.0,
        "mid-grey got expcomp = {}",
        ae.expcomp
    );
}

#[test]
fn dark_image_gets_positive_exposure() {
    // Underexposed scene with realistic variance: ramp from 0 to 5%.
    // Uniform images hit the ospread≤0 blackframe bail-out.
    let img = build_image(128, 128, |x, _| {
        let v = (x as f32 / 127.0) * 0.05;
        [v, v, v]
    });
    let ae = auto_exposure_from_image(&img, 0.02);
    assert!(
        ae.expcomp > 0.5,
        "dark image got expcomp = {}",
        ae.expcomp
    );
}

#[test]
fn bright_image_gets_negative_exposure() {
    // Overexposed scene: 50%..95% ramp.
    let img = build_image(128, 128, |x, _| {
        let v = 0.5 + (x as f32 / 127.0) * 0.45;
        [v, v, v]
    });
    let ae = auto_exposure_from_image(&img, 0.02);
    assert!(
        ae.expcomp < 0.0,
        "bright image got expcomp = {}",
        ae.expcomp
    );
}

#[test]
fn expcomp_clamped() {
    // Near-black frame: expcomp must be in [-5, 12].
    let img = build_image(64, 64, |_, _| [0.001, 0.001, 0.001]);
    let ae = auto_exposure_from_image(&img, 0.02);
    assert!((-5.0..=12.0).contains(&ae.expcomp));
}

#[test]
fn apply_is_deterministic() {
    // Same input → same output, byte for byte.
    let make = || build_image(96, 96, |x, y| {
        let v = ((x + y) as f32 / 191.0) * 0.4;
        [v, v * 0.9, v * 1.1]
    });
    let mut a = make();
    let mut b = make();
    let ae_a = apply(&mut a, 0.02);
    let ae_b = apply(&mut b, 0.02);
    assert_eq!(ae_a.expcomp.to_bits(), ae_b.expcomp.to_bits());
    for (pa, pb) in a.pixels.iter().zip(b.pixels.iter()) {
        for c in 0..3 {
            assert_eq!(pa[c].to_bits(), pb[c].to_bits(),
                "non-deterministic at channel {c}: {} vs {}", pa[c], pb[c]);
        }
    }
}

#[test]
fn apply_zero_expcomp_is_identity() {
    // A near-mid-grey frame should yield expcomp ≈ 0, leaving pixels
    // bit-identical (or off by at most 1 ULP). Verifies the early-exit
    // path skips the multiply when |expcomp| < 1e-6.
    let mut img = build_image(64, 64, |x, _| {
        // Distribution centred on midgrey with mild variance to avoid
        // the blackframe / ospread guards.
        let v = 0.18 + (x as f32 / 63.0 - 0.5) * 0.04;
        [v, v, v]
    });
    let original = img.pixels.clone();
    let ae = apply(&mut img, 0.02);
    if ae.expcomp.abs() < 1e-6 {
        for (pa, pb) in img.pixels.iter().zip(original.iter()) {
            assert_eq!(pa, pb, "expected exact identity when expcomp ~= 0");
        }
    }
}
