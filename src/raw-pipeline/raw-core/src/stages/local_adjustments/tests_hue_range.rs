//! Hue (#3269) and colour-range refinement (#3270) tests for the local-adjustments
//! stage. Split out of `tests.rs` for the 600-line file budget, the same reason
//! `hsl_tests.rs` / `hsl_bw_tests.rs` / `hsl_hull_tests.rs` are separate siblings
//! of `hsl.rs` rather than one file. Reaches `local_adjustments/mod.rs`'s
//! private items through `super::*`, exactly like `tests.rs` itself.

use super::*;
use crate::types::{Mask, Point2};

/// Duplicated from `tests.rs` (private to that sibling module, not reachable
/// through `super::*` here) — tiny enough that a shared `pub(super)` helper
/// isn't worth the indirection.
fn flat_image(w: u32, h: u32, v: f32) -> Image {
    Image {
        width: w,
        height: h,
        pixels: vec![[v, v, v]; (w * h) as usize],
        space: ColorSpace::SceneLinearRec2020,
    }
}

fn oklab_hue_deg(rgb: [f32; 3]) -> f32 {
    let lab = crate::color::oklab::rec2020_to_oklab(rgb);
    lab[2].atan2(lab[1]).to_degrees()
}

fn oklab_lc(rgb: [f32; 3]) -> (f32, f32) {
    let lab = crate::color::oklab::rec2020_to_oklab(rgb);
    (lab[0], (lab[1] * lab[1] + lab[2] * lab[2]).sqrt())
}

/// Signed circular hue delta in degrees, `(-180, 180]`.
fn hue_delta_deg(from: f32, to: f32) -> f32 {
    let mut d = to - from;
    while d > 180.0 {
        d -= 360.0;
    }
    while d <= -180.0 {
        d += 360.0;
    }
    d
}

#[test]
fn hue_100_rotates_oklab_hue_by_30_degrees_and_keeps_l_and_c() {
    // A mid-chroma orange, well inside the Rec.2020 hull at the rotated hue.
    let src = [0.45, 0.22, 0.08];
    let layers = vec![LocalAdjustment::linear(
        Point2::new(0.0, 0.5),
        Point2::new(1.0, 0.5),
        PartialAdjustments {
            hue: Some(100.0),
            ..Default::default()
        },
    )];
    let mut img = Image {
        width: 3,
        height: 1,
        pixels: vec![src; 3],
        space: ColorSpace::SceneLinearRec2020,
    };
    apply(&mut img, &layers);
    // x=2 is the w=1 end of the gradient (feather 0.5 spans t 0.25..0.75).
    let out = img.pixels[2];
    let d = hue_delta_deg(oklab_hue_deg(src), oklab_hue_deg(out));
    assert!((d - 30.0).abs() < 0.5, "rotated by {d}°, expected 30°");
    let (l0, c0) = oklab_lc(src);
    let (l1, c1) = oklab_lc(out);
    assert!((l1 - l0).abs() < 1e-4, "L moved {l0} -> {l1}");
    assert!((c1 - c0).abs() < 1e-4, "C moved {c0} -> {c1}");
    // x=0 is the w=0 end: untouched.
    assert_eq!(img.pixels[0], src);
}

#[test]
fn hue_at_half_weight_rotates_15_degrees() {
    let src = [0.45, 0.22, 0.08];
    let layers = vec![LocalAdjustment {
        mask: Mask::Radial {
            center: Point2::new(0.5, 0.5),
            radii: Point2::new(10.0, 10.0),
            angle: 0.0,
            feather: 0.0,
            invert: false,
        },
        range: None,
        adjustments: PartialAdjustments {
            hue: Some(50.0),
            ..Default::default()
        },
    }];
    let mut img = flat_image(2, 2, 0.0);
    img.pixels = vec![src; 4];
    apply(&mut img, &layers);
    let d = hue_delta_deg(oklab_hue_deg(src), oklab_hue_deg(img.pixels[0]));
    assert!((d - 15.0).abs() < 0.5, "rotated by {d}°, expected 15°");
}

#[test]
fn hue_leaves_a_pixel_below_the_chroma_gate_bit_identical() {
    // A pixel whose Oklab chroma is genuinely below the `1e-6` gate (a
    // uniform RGB value, not a Rec.2020 "grey": Rec.2020 (0.18,0.18,0.18)
    // itself carries ~1.08e-5 Oklab chroma from the primaries-matrix float32
    // round trip — see `hue_rotation_of_actual_grey_stays_within_a_tight_bound`
    // below, which pins that magnitude instead of pretending it's zero).
    // Constructing a pixel from L=0,a=0,b=0 directly (Rec.2020 black) sits
    // exactly at zero chroma with no such noise.
    let layers = vec![LocalAdjustment::linear(
        Point2::new(0.0, 0.5),
        Point2::new(1.0, 0.5),
        PartialAdjustments {
            hue: Some(100.0),
            ..Default::default()
        },
    )];
    let mut img = flat_image(4, 1, 0.0);
    let snapshot = img.pixels.clone();
    apply(&mut img, &layers);
    assert_eq!(img.pixels, snapshot);
}

#[test]
fn hue_rotation_of_actual_grey_stays_within_a_tight_numerical_bound() {
    // Rec.2020 grey carries a tiny (~1e-5) Oklab chroma from the primaries
    // matrix's float32 round trip (the same noise floor `saturation::apply`'s
    // identical `c_in < 1e-6` gate already tolerates) — so it is NOT bit-
    // identical after a rotation, but the drift must stay far below anything
    // visible: a rotation can only ever move a pixel by an amount
    // proportional to its own chroma, never amplify it.
    let layers = vec![LocalAdjustment::linear(
        Point2::new(0.0, 0.5),
        Point2::new(1.0, 0.5),
        PartialAdjustments {
            hue: Some(100.0),
            ..Default::default()
        },
    )];
    let mut img = flat_image(4, 1, 0.18);
    let snapshot = img.pixels.clone();
    apply(&mut img, &layers);
    for (out, before) in img.pixels.iter().zip(&snapshot) {
        for c in 0..3 {
            assert!(
                (out[c] - before[c]).abs() < 1e-4,
                "grey drifted too far: {before:?} -> {out:?}"
            );
        }
    }
}

#[test]
fn hue_rotation_keeps_every_channel_non_negative_near_the_hull() {
    // A saturated Rec.2020 red sits on the hull; rotating it toward yellow
    // lands on a narrower part of the hull, which is exactly the case the
    // soft knee exists for.
    let src = [0.9, 0.02, 0.01];
    let layers = vec![LocalAdjustment::linear(
        Point2::new(0.0, 0.5),
        Point2::new(1.0, 0.5),
        PartialAdjustments {
            hue: Some(100.0),
            ..Default::default()
        },
    )];
    let mut img = flat_image(3, 1, 0.0);
    img.pixels = vec![src; 3];
    apply(&mut img, &layers);
    let out = img.pixels[2];
    assert!(out.iter().all(|c| *c >= -1e-5), "negative channel: {out:?}");
}

use crate::types::{RangeRefinement, SKIN_TONE_RANGE};

fn skin_like() -> [f32; 3] {
    // Oklab hue ≈ 55°, mid-chroma, mid-lightness — a mid skin tone in linear
    // Rec.2020, roughly matching SKIN_TONE_RANGE's own centre.
    [0.42, 0.24, 0.15]
}

/// Radians that rotate `rgb`'s Oklab hue onto `target_deg`.
fn delta_to(rgb: [f32; 3], target_deg: f32) -> f32 {
    (target_deg - oklab_hue_deg(rgb)).to_radians()
}

#[test]
fn skin_range_weight_is_one_inside_and_zero_far_outside_the_band() {
    let skin = skin_like();
    let d = oklab_hue_deg(skin);
    assert!((d - 55.0).abs() < 15.0, "fixture hue {d}° not near 55°");
    assert!((range::weight(&SKIN_TONE_RANGE, skin) - 1.0).abs() < 1e-6);
    // Saturated blue (hue far from 55° ± 25°) reads zero.
    assert_eq!(range::weight(&SKIN_TONE_RANGE, [0.05, 0.08, 0.6]), 0.0);
}

#[test]
fn skin_range_rolls_off_smoothly_across_the_band_edge() {
    let r = RangeRefinement::Color {
        hue_deg: 55.0,
        hue_half_width_deg: 25.0,
        chroma_min: 0.02,
        l_min: 0.0,
        l_max: 1.0,
        feather: 1.0, // pure raised cosine from the centre to the edge
    };
    let centre = hue::rotate_pixel(skin_like(), delta_to(skin_like(), 55.0));
    let half = hue::rotate_pixel(centre, 12.5_f32.to_radians());
    assert!((range::weight(&r, centre) - 1.0).abs() < 1e-3);
    let w_half = range::weight(&r, half);
    assert!((w_half - 0.5).abs() < 0.05, "midpoint weight {w_half}");
}

#[test]
fn range_gates_on_chroma_and_lightness() {
    // Grey has no hue: weight 0 regardless of the band.
    assert_eq!(range::weight(&SKIN_TONE_RANGE, [0.18, 0.18, 0.18]), 0.0);
    // A very dark skin-hued pixel falls under l_min.
    assert_eq!(range::weight(&SKIN_TONE_RANGE, [0.004, 0.0024, 0.0015]), 0.0);
}

#[test]
fn range_refinement_scopes_the_layer_to_matching_pixels_only() {
    let mut layer = LocalAdjustment::linear(
        Point2::new(0.0, 0.5),
        Point2::new(1.0, 0.5),
        PartialAdjustments {
            exposure: Some(1.0),
            ..Default::default()
        },
    );
    layer.range = Some(SKIN_TONE_RANGE);
    // A radial mask covering every pixel at full weight, so the range
    // refinement alone is what separates the two test pixels.
    layer.mask = Mask::Radial {
        center: Point2::new(0.5, 0.5),
        radii: Point2::new(10.0, 10.0),
        angle: 0.0,
        feather: 0.0,
        invert: false,
    };
    let blue = [0.05, 0.08, 0.6];
    let mut img = Image {
        width: 2,
        height: 1,
        pixels: vec![skin_like(), blue],
        space: ColorSpace::SceneLinearRec2020,
    };
    apply(&mut img, &[layer]);
    assert!(
        (img.pixels[0][0] - skin_like()[0] * 2.0).abs() < 1e-5,
        "skin pixel doubled: {}",
        img.pixels[0][0]
    );
    assert_eq!(img.pixels[1], blue, "blue pixel untouched");
}
