//! `opcode_apply` tests — the lens-correction opcodes and their
//! user-facing strength scales (#376). Split out of the sibling `tests.rs`
//! to keep both files under the 600-LOC hard cap (CONTRIBUTING.md §
//! File-size budget); that file keeps the `GainMap` / `WarpRectilinear`
//! coverage and owns the two shared image helpers imported below.

use super::super::opcodes::WarpPlaneParams;
use super::tests::{flat_image, gm};
use super::*;
use crate::image::ColorSpace;

// ---------------------------------------------------------------------
// FixVignetteRadial (#376)
// ---------------------------------------------------------------------

fn vignette(k0: f64) -> FixVignetteRadialOpcode {
    FixVignetteRadialOpcode {
        k: [k0, 0.0, 0.0, 0.0, 0.0],
        center_x: 0.5,
        center_y: 0.5,
    }
}

/// The gain follows `1 + k0·t` with `t` the squared center distance
/// normalized so `t = 1` at the farthest corner — hand-computed against
/// the same `Lerp(0, dim, c)` center and max-corner radius the warp uses,
/// so the two opcodes share one coordinate system.
#[test]
fn fix_vignette_radial_matches_the_hand_computed_gain_curve() {
    let (w, h) = (21u32, 21u32);
    let aa = ActiveAreaRect::full(w, h);
    let mut img = flat_image(w, h, [1.0; 3]);
    apply_fix_vignette_radial(&mut img, &vignette(0.5), aa, 1.0);

    // Center convention: cx = 0.5 * 21 = 10.5, cy likewise. Corner radius
    // is hypot(max(10.5, 10.5), max(10.5, 10.5)) = 10.5·√2, so
    // norm_radius² = 220.5.
    let (cx, cy, r2) = (10.5f64, 10.5f64, 220.5f64);
    for (col, row) in [(10usize, 10usize), (0, 0), (20, 10), (5, 17)] {
        let (dx, dy) = (col as f64 - cx, row as f64 - cy);
        let t = ((dx * dx + dy * dy) / r2).min(1.0);
        let expected = (1.0 + 0.5 * t) as f32;
        let got = img.pixels[row * w as usize + col][1];
        assert!(
            (got - expected).abs() < 1e-6,
            "gain at ({col},{row}): expected {expected}, got {got}"
        );
    }
}

/// The multiplied result is deliberately NOT clamped to 1.0 the way
/// dng_sdk clamps its bounded stage buffers: nothing before the view
/// transform may clip (scene-linear invariant, and the same policy
/// `apply_gain_map` already documents).
#[test]
fn fix_vignette_radial_does_not_clip_the_scene_linear_result() {
    let (w, h) = (9u32, 9u32);
    let mut img = flat_image(w, h, [4.0; 3]);
    apply_fix_vignette_radial(&mut img, &vignette(0.75), ActiveAreaRect::full(w, h), 1.0);
    let corner = img.pixels[0][0];
    assert!(
        corner > 4.0,
        "a >1 corner gain must brighten past the input, got {corner}"
    );
    assert!(corner.is_finite());
}

/// Pixels outside the active area are masked sensor columns that
/// DefaultCrop discards — the gain must not touch them.
#[test]
fn fix_vignette_radial_leaves_pixels_outside_active_area_untouched() {
    let (w, h) = (20u32, 8u32);
    let aa = ActiveAreaRect {
        top: 0,
        left: 0,
        width: 14,
        height: h,
    };
    let mut img = flat_image(w, h, [1.0; 3]);
    apply_fix_vignette_radial(&mut img, &vignette(0.6), aa, 1.0);
    for row in 0..h as usize {
        for col in 14..w as usize {
            assert_eq!(
                img.pixels[row * w as usize + col],
                [1.0; 3],
                "masked col {col} must pass through"
            );
        }
    }
}

// ---------------------------------------------------------------------
// LensCorrectionScales (#376)
// ---------------------------------------------------------------------

/// Every family scaled to zero leaves the buffer bit-identical, and the
/// list reports nothing as applied.
#[test]
fn zero_scales_skip_every_opcode_bit_identically() {
    let (w, h) = (12u32, 10u32);
    let aa = ActiveAreaRect::full(w, h);
    let list = OpcodeList3 {
        opcodes: vec![
            PanoOpcode::GainMap(gm(2, 2, 1, vec![2.0; 4], (w, h))),
            PanoOpcode::FixVignetteRadial(vignette(0.5)),
            PanoOpcode::WarpRectilinear(WarpRectilinearOpcode {
                planes: vec![WarpPlaneParams {
                    kr: [0.85, 0.1, 0.0, 0.0],
                    kt: [0.0, 0.0],
                }],
                center_x: 0.5,
                center_y: 0.5,
            }),
        ],
        skipped_unknown: 0,
    };
    let mut img = Image::new(w, h, ColorSpace::SceneLinearRec2020);
    for (i, px) in img.pixels.iter_mut().enumerate() {
        *px = [i as f32, i as f32 * 0.5, 100.0 - i as f32];
    }
    let before = img.pixels.clone();
    let applied = apply_opcode_list3(&mut img, &list, aa, LensCorrectionScales::NONE);
    assert!(applied.is_empty(), "nothing ran, got {applied:?}");
    assert_eq!(img.pixels, before);
}

/// A half-strength vignetting scale lands exactly halfway between the
/// identity and the vendor's authored gain, for both gain opcodes.
#[test]
fn vignetting_scale_blends_gain_opcodes_toward_identity() {
    let (w, h) = (17u32, 17u32);
    let aa = ActiveAreaRect::full(w, h);

    let mut full = flat_image(w, h, [1.0; 3]);
    apply_fix_vignette_radial(&mut full, &vignette(0.8), aa, 1.0);
    let mut half = flat_image(w, h, [1.0; 3]);
    apply_fix_vignette_radial(&mut half, &vignette(0.8), aa, 0.5);
    for (f, hh) in full.pixels.iter().zip(half.pixels.iter()) {
        let expected = 1.0 + 0.5 * (f[1] - 1.0);
        assert!((hh[1] - expected).abs() < 1e-6);
    }

    let map = gm(2, 2, 1, vec![1.0, 2.0, 3.0, 4.0], (w, h));
    let mut full_map = flat_image(w, h, [1.0; 3]);
    apply_gain_map(&mut full_map, &map, aa, 1.0);
    let mut half_map = flat_image(w, h, [1.0; 3]);
    apply_gain_map(&mut half_map, &map, aa, 0.5);
    for (f, hh) in full_map.pixels.iter().zip(half_map.pixels.iter()) {
        let expected = 1.0 + 0.5 * (f[1] - 1.0);
        assert!((hh[1] - expected).abs() < 1e-6);
    }
}

/// Dropping the CA scale to zero while distortion stays at full strength
/// must collapse all three planes onto the green plane's geometry — the
/// definition of "correct distortion, leave lateral CA alone". Verified
/// against a warp built from green's coefficient set alone, which is the
/// independent expression of the same result.
#[test]
fn zero_ca_scale_collapses_every_plane_onto_the_green_warp() {
    let (w, h) = (33u32, 9u32);
    let gradient = || {
        let mut img = Image::new(w, h, ColorSpace::SceneLinearRec2020);
        for row in 0..h as usize {
            for col in 0..w as usize {
                let v = col as f32;
                img.pixels[row * w as usize + col] = [v, v * 2.0, v * 3.0];
            }
        }
        img
    };
    let set = |kr0: f64| WarpPlaneParams {
        kr: [kr0, 0.0, 0.0, 0.0],
        kt: [0.0, 0.0],
    };
    let per_plane = WarpRectilinearOpcode {
        planes: vec![set(0.9), set(1.0), set(1.1)],
        center_x: 0.5,
        center_y: 0.5,
    };
    let green_only = WarpRectilinearOpcode {
        planes: vec![set(1.0)],
        center_x: 0.5,
        center_y: 0.5,
    };
    let aa = ActiveAreaRect::full(w, h);

    let mut no_ca = gradient();
    apply_warp_rectilinear(&mut no_ca, &per_plane, aa, 1.0, 0.0);
    let mut reference = gradient();
    apply_warp_rectilinear(&mut reference, &green_only, aa, 1.0, 1.0);
    assert_eq!(no_ca.pixels, reference.pixels);

    // Sanity: at full CA the three planes really do diverge, so the test
    // above is not passing on a warp that was per-plane in name only.
    let mut with_ca = gradient();
    apply_warp_rectilinear(&mut with_ca, &per_plane, aa, 1.0, 1.0);
    assert_ne!(with_ca.pixels, reference.pixels);
}

/// Dropping the distortion scale to zero while CA stays at full strength
/// keeps only each plane's deviation from green — so the green plane
/// itself becomes an exact no-op while R and B still shift.
#[test]
fn zero_distortion_scale_keeps_only_the_per_plane_ca_deviation() {
    let (w, h) = (33u32, 9u32);
    let mut img = Image::new(w, h, ColorSpace::SceneLinearRec2020);
    for row in 0..h as usize {
        for col in 0..w as usize {
            let v = col as f32;
            img.pixels[row * w as usize + col] = [v, v, v];
        }
    }
    let before = img.pixels.clone();
    let set = |kr0: f64| WarpPlaneParams {
        kr: [kr0, 0.0, 0.0, 0.0],
        kt: [0.0, 0.0],
    };
    let warp = WarpRectilinearOpcode {
        planes: vec![set(0.9), set(1.05), set(1.1)],
        center_x: 0.5,
        center_y: 0.5,
    };
    apply_warp_rectilinear(&mut img, &warp, ActiveAreaRect::full(w, h), 0.0, 1.0);
    // Green's deviation from itself is zero, so its blended set is the
    // identity and the plane resamples in place.
    for (got, was) in img.pixels.iter().zip(before.iter()) {
        assert!(
            (got[1] - was[1]).abs() < 1e-5,
            "green must be untouched, got {} want {}",
            got[1],
            was[1]
        );
    }
    let mid = 4 * w as usize + 6;
    assert!(
        (img.pixels[mid][0] - before[mid][0]).abs() > 1e-3,
        "red still carries its CA deviation"
    );
}

/// The master switch overrides the three scales, and 100 maps to exactly
/// 1.0 so a default model reproduces the vendor's math bit-for-bit.
#[test]
fn scales_from_model_honour_the_master_switch_and_full_strength_default() {
    assert_eq!(
        LensCorrectionScales::from_model(&AdjustmentModel::default()),
        LensCorrectionScales::FULL
    );

    let off = AdjustmentModel {
        lens_profile_enable: LensProfileEnable::Off,
        lens_correction_distortion: 100.0,
        lens_correction_ca: 100.0,
        lens_correction_vignetting: 100.0,
        ..AdjustmentModel::default()
    };
    assert_eq!(
        LensCorrectionScales::from_model(&off),
        LensCorrectionScales::NONE,
        "crs:LensProfileEnable=0 must override the scales"
    );

    // Out-of-range sidecar values clamp instead of amplifying or
    // inverting the vendor's correction.
    let wild = AdjustmentModel {
        lens_correction_distortion: 250.0,
        lens_correction_ca: -40.0,
        lens_correction_vignetting: 50.0,
        ..AdjustmentModel::default()
    };
    let s = LensCorrectionScales::from_model(&wild);
    assert_eq!((s.distortion, s.ca, s.vignetting), (1.0, 0.0, 0.5));
}
