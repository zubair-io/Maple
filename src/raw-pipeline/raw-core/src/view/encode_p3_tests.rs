//! P3 / `TargetPrimaries` / `rec2020_to_display` tests (#1337), split from
//! `encode.rs` (600-LOC file budget — the same split pattern as
//! `view::auto_profile::{apply, curve, lut}`).
//!
//! Every test here targets the P3 display-primary path or the `TargetPrimaries`
//! discriminant itself. sRGB-path and quantize/dither tests stay in `encode.rs`.

use super::*;

#[test]
fn target_primaries_from_u32_zero_is_srgb() {
    assert_eq!(TargetPrimaries::from_u32(0), TargetPrimaries::Srgb);
}

#[test]
fn target_primaries_from_u32_one_is_p3() {
    assert_eq!(TargetPrimaries::from_u32(1), TargetPrimaries::P3);
}

#[test]
fn target_primaries_from_u32_unknown_is_srgb() {
    // Defensive default — mirrors Look::from and WbMethod conventions.
    assert_eq!(TargetPrimaries::from_u32(99), TargetPrimaries::Srgb);
}

#[test]
fn rec2020_to_display_srgb_matches_rec2020_to_srgb_legacy() {
    // The `Srgb` path of `rec2020_to_display` MUST be bit-identical to
    // the legacy `rec2020_to_srgb` entry — both callers and the parity
    // gate depend on it.
    let inputs = [
        [0.18f32, 0.18, 0.18],
        [0.50, 0.40, 0.30],
        [0.05, 0.05, 0.05],
        [1.00, 0.00, 0.00], // out-of-gamut — exercises the bisection path
    ];
    for &input in &inputs {
        let mut img_legacy = Image::new(1, 1, ColorSpace::DisplayLinearRec2020);
        img_legacy.pixels[0] = input;
        rec2020_to_srgb(&mut img_legacy);

        let mut img_display = Image::new(1, 1, ColorSpace::DisplayLinearRec2020);
        img_display.pixels[0] = input;
        rec2020_to_display(&mut img_display, TargetPrimaries::Srgb);

        for c in 0..3 {
            assert_eq!(
                img_display.pixels[0][c].to_bits(),
                img_legacy.pixels[0][c].to_bits(),
                "Srgb path != legacy rec2020_to_srgb on channel {c} input {:?}",
                input,
            );
        }
    }
}

#[test]
fn p3_and_srgb_outputs_differ_on_saturated_patch() {
    // A saturated Rec.2020 patch MUST produce different linear-display
    // values for P3 vs sRGB (the matrices are distinct). A neutral
    // `[1,1,1]` maps to `[1,1,1]` under both (white-point identity), so
    // use a saturated color that exercises the different primaries.
    // Pure Rec.2020 red is the widest-gamut case.
    let input = [1.0f32, 0.0, 0.0];

    let mut img_srgb = Image::new(1, 1, ColorSpace::DisplayLinearRec2020);
    img_srgb.pixels[0] = input;
    rec2020_to_display(&mut img_srgb, TargetPrimaries::Srgb);

    let mut img_p3 = Image::new(1, 1, ColorSpace::DisplayLinearRec2020);
    img_p3.pixels[0] = input;
    rec2020_to_display(&mut img_p3, TargetPrimaries::P3);

    // Both must be in [0,1]^3 (gamut compression applies to both).
    for c in 0..3 {
        assert!(
            (0.0..=1.0).contains(&img_srgb.pixels[0][c]),
            "sRGB channel {c} out of [0,1]: {}",
            img_srgb.pixels[0][c]
        );
        assert!(
            (0.0..=1.0).contains(&img_p3.pixels[0][c]),
            "P3 channel {c} out of [0,1]: {}",
            img_p3.pixels[0][c]
        );
    }

    // The outputs must differ — the P3 matrix is a strict subset of
    // the sRGB matrix's column span, so any saturated wide-gamut color
    // produces different coordinates.
    let differ = (0..3).any(|c| (img_srgb.pixels[0][c] - img_p3.pixels[0][c]).abs() > 1e-3);
    assert!(
        differ,
        "P3 and sRGB outputs identical on saturated Rec.2020 red — \
         matrix selection is broken. sRGB={:?} P3={:?}",
        img_srgb.pixels[0], img_p3.pixels[0],
    );
}

#[test]
fn p3_white_maps_to_white() {
    // D65 neutral white must be preserved exactly (same white-point for
    // both Rec.2020 and Display P3 at D65).
    let mut img = Image::new(1, 1, ColorSpace::DisplayLinearRec2020);
    img.pixels[0] = [1.0, 1.0, 1.0];
    rec2020_to_display(&mut img, TargetPrimaries::P3);
    for c in 0..3 {
        assert!(
            (img.pixels[0][c] - 1.0).abs() < 1e-3,
            "P3 white channel {c} = {} (expected ≈ 1.0)",
            img.pixels[0][c]
        );
    }
}

#[test]
fn p3_gamut_compression_happens_in_srgb_primary_space() {
    // Confirms the corrected pipeline order (review item 1): gamut
    // compression runs in linear sRGB (where the Oklab helpers are
    // defined), and the sRGB→P3 primary swap is the *last* step.
    //
    // Round-trip oracle: manually apply the corrected steps and compare
    // against `rec2020_to_display(..., P3)`:
    //   1. Rec.2020 → sRGB
    //   2. Oklab compress in sRGB
    //   3. sRGB → P3
    //
    // A saturated Rec.2020 red is the hardest case: it lands outside sRGB
    // gamut post-matrix, so the bisector fires. If compression were applied
    // in P3 space (the old broken order), the Oklab LMS matrix would see
    // P3-primary values and the hue/chroma would differ.
    use crate::color::matrices::{M_REC2020_TO_SRGB, M_SRGB_TO_P3};
    use crate::color::oklab::{oklab_to_srgb_linear, srgb_linear_to_oklab};
    use crate::color::oklab_gamut::compress_to_unit_cube_oklab;

    let input = [1.0f32, 0.0, 0.0]; // saturated Rec.2020 red

    // Oracle: explicit reordered steps.
    let srgb = M_REC2020_TO_SRGB.mul_vec(input);
    let compressed = compress_to_unit_cube_oklab(srgb, srgb_linear_to_oklab, oklab_to_srgb_linear);
    let expected_p3 = M_SRGB_TO_P3.mul_vec(compressed);

    // Under test: rec2020_to_display with P3 target.
    let mut img = Image::new(1, 1, ColorSpace::DisplayLinearRec2020);
    img.pixels[0] = input;
    rec2020_to_display(&mut img, TargetPrimaries::P3);
    let got = img.pixels[0];

    // Bit-identical match confirms the implementation follows the oracle.
    for c in 0..3 {
        assert_eq!(
            got[c].to_bits(),
            expected_p3[c].to_bits(),
            "P3 pipeline order mismatch on channel {c}: \
             got={} expected={} (input={:?})",
            got[c],
            expected_p3[c],
            input,
        );
    }

    // Sanity: output must be in [0, 1]^3 (gamut compression guarantees this).
    for c in 0..3 {
        assert!(
            (0.0..=1.0).contains(&got[c]),
            "P3 channel {c} = {} out of [0, 1]",
            got[c]
        );
    }
}
