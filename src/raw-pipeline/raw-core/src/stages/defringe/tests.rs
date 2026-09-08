//! Unit gates for the unified defringe stage (#3407 per-mask, #3411 global).
//!
//! The per-mask half of this file is #3407's original suite, carried over
//! verbatim in intent: those cases pin the behaviour the per-mask control
//! shipped with, and `per_mask_path_is_bit_identical_to_the_single_amount_kernel`
//! additionally pins it against a local re-implementation of exactly the
//! code #3407 merged, so unifying the two callers cannot have moved a
//! single per-mask pixel.

use super::*;
use crate::image::{ColorSpace, Image};

fn image(w: u32, h: u32, fill: impl Fn(usize, usize) -> [f32; 3]) -> Image {
    let mut img = Image::new(w, h, ColorSpace::SceneLinearRec2020);
    for y in 0..h as usize {
        for x in 0..w as usize {
            img.pixels[y * w as usize + x] = fill(x, y);
        }
    }
    img
}

fn chroma(p: [f32; 3]) -> f32 {
    let lab = rec2020_to_oklab(p);
    (lab[1] * lab[1] + lab[2] * lab[2]).sqrt()
}

/// A hard black/white step with a magenta fringe on the boundary column —
/// the shape the stage exists for. Both plateaus are exactly neutral, so
/// the only pixel with a hue to judge is the fringe itself.
fn fringed(colour: [f32; 3]) -> Image {
    image(8, 4, |x, _| {
        if x == 3 {
            colour
        } else if x < 3 {
            [0.02, 0.02, 0.02]
        } else {
            [0.9, 0.9, 0.9]
        }
    })
}

// -------------------------------------------------------------------------
// Per-mask control (#3407)
// -------------------------------------------------------------------------

/// The exact kernel #3407 merged, before the two callers were unified.
/// Kept here as an oracle so the unification can be proven pixel-for-pixel
/// rather than asserted.
fn single_amount_reference(img: &mut Image, amount: f32) {
    if amount.abs() < 1e-3 {
        return;
    }
    let strength = (amount / 100.0).clamp(0.0, 1.0);
    let (w, h) = (img.width as usize, img.height as usize);
    let luma: Vec<f32> = img
        .pixels
        .iter()
        .map(|p| LUMA_REC2020[0] * p[0] + LUMA_REC2020[1] * p[1] + LUMA_REC2020[2] * p[2])
        .collect();
    for y in 0..h {
        let (up, down, here) = (y.saturating_sub(1) * w, (y + 1).min(h - 1) * w, y * w);
        for x in 0..w {
            let (left, right) = (x.saturating_sub(1), (x + 1).min(w - 1));
            let centre = luma[here + x];
            if centre <= LUMA_FLOOR {
                continue;
            }
            let dx = luma[here + right] - luma[here + left];
            let dy = luma[down + x] - luma[up + x];
            let relative = (dx.abs() + dy.abs()) / centre;
            let edge = smoothstep(EDGE_LO, EDGE_HI, relative);
            if edge <= 0.0 {
                continue;
            }
            let scale = 1.0 - strength * edge;
            let lab = rec2020_to_oklab(img.pixels[here + x]);
            img.pixels[here + x] = oklab_to_rec2020([lab[0], lab[1] * scale, lab[2] * scale]);
        }
    }
}

/// THE UNIFICATION GATE: the per-mask caller's output is bit-identical to
/// the single-amount kernel it replaced, on every amount and on scenes that
/// exercise the neutral, coloured, edge and flat branches alike.
#[test]
fn per_mask_path_is_bit_identical_to_the_single_amount_kernel() {
    let scenes = [
        fringed([0.6, 0.1, 0.6]),
        fringed([0.06, 0.45, 0.10]),
        fringed([0.55, 0.22, 0.03]),
        image(16, 12, |x, y| {
            let t = (y * 16 + x) as f32 / 192.0;
            [0.05 + t, 0.9 - t * 0.5, 0.2 + t * 0.3]
        }),
        image(8, 8, |_, _| [0.4, 0.1, 0.5]),
        image(8, 8, |x, y| {
            let v = if (x + y) % 2 == 0 { 0.0 } else { 0.7 };
            [v, v, v]
        }),
    ];
    for amount in [0.0_f32, 0.5, 12.5, 40.0, 75.0, 100.0] {
        for seed in &scenes {
            let mut expected = seed.clone();
            single_amount_reference(&mut expected, amount);
            let mut actual = seed.clone();
            apply(&mut actual, amount);
            assert_eq!(
                actual.pixels, expected.pixels,
                "per-mask output moved at amount {amount}"
            );
        }
    }
}

#[test]
fn zero_amount_is_a_bit_identical_no_op() {
    let before = image(8, 8, |x, y| [0.1 * x as f32, 0.05 * y as f32, 0.2]);
    let mut after = before.clone();
    apply(&mut after, 0.0);
    assert_eq!(after.pixels, before.pixels);
}

#[test]
fn a_flat_coloured_field_is_untouched() {
    let before = image(8, 8, |_, _| [0.4, 0.1, 0.5]);
    let mut after = before.clone();
    apply(&mut after, 100.0);
    assert_eq!(
        after.pixels, before.pixels,
        "no gradient means no edge means no suppression"
    );
}

#[test]
fn a_magenta_fringe_on_a_hard_edge_loses_chroma() {
    let mut img = fringed([0.6, 0.1, 0.6]);
    let before = chroma(img.pixels[3]);
    apply(&mut img, 100.0);
    let after = chroma(img.pixels[3]);
    assert!(
        after < before * 0.5,
        "fringe chroma should be more than halved: {before} -> {after}"
    );
}

#[test]
fn lightness_survives_the_suppression() {
    let mut img = fringed([0.6, 0.1, 0.6]);
    let before = rec2020_to_oklab(img.pixels[3])[0];
    apply(&mut img, 100.0);
    let after = rec2020_to_oklab(img.pixels[3])[0];
    assert!(
        (after - before).abs() < 1e-3,
        "Oklab L must be preserved: {before} -> {after}"
    );
}

#[test]
fn strength_scales_monotonically() {
    let seed = fringed([0.6, 0.1, 0.6]);
    let sample = |amount: f32| {
        let mut img = seed.clone();
        apply(&mut img, amount);
        chroma(img.pixels[3])
    };
    let (full, half, none) = (sample(100.0), sample(50.0), sample(0.0));
    assert!(full < half, "100 must suppress more than 50");
    assert!(half < none, "50 must suppress more than 0");
}

#[test]
fn a_one_pixel_image_is_handled_without_panicking() {
    let mut img = image(1, 1, |_, _| [0.5, 0.2, 0.4]);
    apply(&mut img, 100.0);
    assert_eq!(img.pixels.len(), 1);
}

#[test]
fn the_per_mask_control_suppresses_every_hue() {
    // The whole point of the per-mask amount: it has no band, so an orange
    // fringe the global purple control ignores is still suppressed here.
    let mut img = fringed([0.55, 0.22, 0.03]);
    let before = chroma(img.pixels[3]);
    apply(&mut img, 100.0);
    assert!(chroma(img.pixels[3]) < before * 0.5);
}

// -------------------------------------------------------------------------
// Global controls (#3411)
// -------------------------------------------------------------------------

fn purple_engaged() -> DefringeParams {
    DefringeParams {
        all_hues_strength: 0.0,
        purple_strength: 1.0,
        purple_lo: 30.0,
        purple_hi: 70.0,
        green_strength: 0.0,
        green_lo: 40.0,
        green_hi: 60.0,
    }
}

#[test]
fn both_amounts_zero_is_bit_identical() {
    let mut img = fringed([0.30, 0.05, 0.55]);
    let before = img.pixels.clone();
    let model = AdjustmentModel::default();
    assert!(params_from_model(&model).is_none());
    apply_model(&mut img, &model);
    assert_eq!(img.pixels, before);
}

#[test]
fn params_engage_only_past_the_slider_epsilon() {
    let mut model = AdjustmentModel::default();
    model.defringe_purple_amount = 1e-4;
    assert!(params_from_model(&model).is_none());
    model.defringe_purple_amount = 0.0;
    model.defringe_green_amount = 5.0;
    let p = params_from_model(&model).expect("green amount engages the stage");
    assert_eq!(p.purple_strength, 0.0);
    assert!((p.green_strength - 0.25).abs() < 1e-6);
    assert_eq!(
        p.all_hues_strength, 0.0,
        "the global path claims no hue-agnostic strength"
    );
}

#[test]
fn violet_fringe_loses_chroma_and_keeps_lightness() {
    let mut img = fringed([0.30, 0.05, 0.55]);
    let before = img.pixels[3];
    apply_params(&mut img, &purple_engaged());
    let after = img.pixels[3];
    let (lab_before, lab_after) = (rec2020_to_oklab(before), rec2020_to_oklab(after));
    let c_before = (lab_before[1].powi(2) + lab_before[2].powi(2)).sqrt();
    let c_after = (lab_after[1].powi(2) + lab_after[2].powi(2)).sqrt();
    assert!(
        c_after < 0.35 * c_before,
        "fringe chroma {c_after} not suppressed from {c_before}"
    );
    assert!(
        (lab_after[0] - lab_before[0]).abs() < 1e-4,
        "lightness moved: {} -> {}",
        lab_before[0],
        lab_after[0]
    );
}

#[test]
fn a_flat_violet_field_is_untouched_by_the_global_control() {
    let mut img = image(16, 8, |_, _| [0.30, 0.05, 0.55]);
    let before = img.pixels.clone();
    apply_params(&mut img, &purple_engaged());
    assert_eq!(img.pixels, before);
}

#[test]
fn an_out_of_band_hue_on_the_same_edge_is_untouched() {
    let mut img = fringed([0.55, 0.22, 0.03]);
    let before = img.pixels.clone();
    apply_params(&mut img, &purple_engaged());
    assert_eq!(img.pixels, before, "orange is in neither band");
}

#[test]
fn neutral_pixels_pass_through_bit_exact_on_the_global_path() {
    let mut img = image(16, 8, |x, _| {
        let v = if x < 8 { 0.02 } else { 0.9 };
        [v, v, v]
    });
    let before = img.pixels.clone();
    apply_params(&mut img, &purple_engaged());
    assert_eq!(img.pixels, before);
}

#[test]
fn global_strength_scales_the_suppression_monotonically() {
    let chroma_after = |strength: f32| {
        let mut img = fringed([0.30, 0.05, 0.55]);
        apply_params(
            &mut img,
            &DefringeParams {
                purple_strength: strength,
                ..purple_engaged()
            },
        );
        chroma(img.pixels[3])
    };
    let (c0, c_half, c_full) = (chroma_after(0.0), chroma_after(0.5), chroma_after(1.0));
    assert!(c_full < c_half, "{c_full} !< {c_half}");
    assert!(c_half < c0, "{c_half} !< {c0}");
}

#[test]
fn an_inverted_hue_band_selects_nothing() {
    let mut img = fringed([0.30, 0.05, 0.55]);
    let before = img.pixels.clone();
    apply_params(
        &mut img,
        &DefringeParams {
            purple_lo: 70.0,
            purple_hi: 30.0,
            ..purple_engaged()
        },
    );
    assert_eq!(img.pixels, before);
}

#[test]
fn green_band_covers_green_and_purple_band_does_not() {
    let sample = |p: DefringeParams| {
        let mut img = fringed([0.06, 0.45, 0.10]);
        apply_params(&mut img, &p);
        chroma(img.pixels[3])
    };
    let purple_only = sample(purple_engaged());
    let green_on = sample(DefringeParams {
        purple_strength: 0.0,
        green_strength: 1.0,
        ..purple_engaged()
    });
    assert!(
        green_on < 0.35 * purple_only,
        "green band did not suppress: {green_on} vs {purple_only}"
    );
}

#[test]
fn band_weight_is_one_inside_and_zero_beyond_the_feather() {
    assert_eq!(band_weight(50.0, 30.0, 70.0), 1.0);
    assert_eq!(band_weight(30.0 - HUE_FEATHER - 1.0, 30.0, 70.0), 0.0);
    assert_eq!(band_weight(70.0 + HUE_FEATHER + 1.0, 30.0, 70.0), 0.0);
    let mid = band_weight(30.0 - HUE_FEATHER * 0.5, 30.0, 70.0);
    assert!(mid > 0.0 && mid < 1.0, "feather flank not graded: {mid}");
}

/// The superset contract: a model that engages both a band AND the per-mask
/// strength takes the stronger claim per pixel, so neither caller can be
/// weakened by the other sharing the kernel.
#[test]
fn the_strongest_claim_on_a_pixel_wins() {
    let both = DefringeParams {
        all_hues_strength: 0.25,
        ..purple_engaged()
    };
    // In-band violet: the band's 1.0 beats the hue-agnostic 0.25, so the
    // fringe pixel lands exactly where the band alone would have put it.
    // Only that pixel is compared — the neutral plateaus around it DO see
    // the 0.25, which is the point of the hue-agnostic strength.
    let mut in_band = fringed([0.30, 0.05, 0.55]);
    apply_params(&mut in_band, &both);
    let mut band_only = fringed([0.30, 0.05, 0.55]);
    apply_params(&mut band_only, &purple_engaged());
    assert_eq!(in_band.pixels[3], band_only.pixels[3]);

    // Out-of-band orange: only the hue-agnostic 0.25 applies, and it must.
    let mut out_of_band = fringed([0.55, 0.22, 0.03]);
    let before = chroma(out_of_band.pixels[3]);
    apply_params(&mut out_of_band, &both);
    let after = chroma(out_of_band.pixels[3]);
    assert!(
        after < before,
        "hue-agnostic strength must still apply: {before} -> {after}"
    );
    assert!(after > 0.6 * before, "…but only at its own 0.25 strength");
}
