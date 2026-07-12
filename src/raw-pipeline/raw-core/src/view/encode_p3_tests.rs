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
fn p3_gamut_compression_targets_the_p3_hull() {
    // Confirms the corrected pipeline order (#1921): the working triple is
    // rotated Rec.2020 → linear P3 FIRST, then Oklab gamut compression runs
    // against the **P3** hull. The pre-#1921 order compressed to the sRGB hull
    // first and rotated afterward, capping P3 output at sRGB gamut.
    //
    // Round-trip oracle: manually apply the corrected steps and compare
    // against `rec2020_to_display(..., P3)`:
    //   1. Rec.2020 → linear P3   (M_REC2020_TO_P3)
    //   2. Oklab compress against the P3 hull
    //      (p3_linear_to_oklab / oklab_to_p3_linear)
    //
    // A saturated Rec.2020 red is the hardest case: it lands outside even the
    // P3 gamut post-matrix, so the bisector fires.
    use crate::color::matrices::M_REC2020_TO_P3;
    use crate::color::oklab::{oklab_to_p3_linear, p3_linear_to_oklab};
    use crate::color::oklab_gamut::compress_to_unit_cube_oklab;

    let input = [1.0f32, 0.0, 0.0]; // saturated Rec.2020 red

    // Oracle: explicit corrected steps (rotate to P3, then compress to P3 hull).
    let p3 = M_REC2020_TO_P3.mul_vec(input);
    let expected_p3 = compress_to_unit_cube_oklab(p3, p3_linear_to_oklab, oklab_to_p3_linear);

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

#[test]
fn p3_export_reaches_beyond_srgb_gamut() {
    // #1921 deliverable: a P3 export must actually reach into P3's wider gamut
    // — colors that are inside P3 but outside sRGB must survive the P3 path
    // with their extra saturation intact, not get capped at the sRGB hull.
    //
    // Construction: take a saturated color that is IN the P3 gamut but OUT of
    // the sRGB gamut, expressed as a Rec.2020 input. Feed it through both the
    // sRGB and P3 export paths and prove the P3 output carries saturation that
    // sRGB literally cannot represent.
    use crate::color::matrices::{M_REC2020_TO_P3, M_REC2020_TO_SRGB, M_SRGB_TO_P3};
    use crate::color::oklab::{p3_linear_to_oklab, srgb_linear_to_oklab};

    let m_p3_to_srgb = M_SRGB_TO_P3.inverse().expect("M_SRGB_TO_P3 invertible");

    // A saturated green that sits inside the P3 hull but past the sRGB hull.
    // Choose it in linear P3 space, then express it as the Rec.2020 input the
    // encode entry expects.
    let target_p3 = [0.05f32, 0.92, 0.10];
    let m_p3_to_rec2020 = M_REC2020_TO_P3.inverse().expect("M_REC2020_TO_P3 invertible");
    let input_rec2020 = m_p3_to_rec2020.mul_vec(target_p3);

    // Preconditions: the chosen color really is P3-in-gamut and sRGB-out-of-gamut.
    let as_p3 = M_REC2020_TO_P3.mul_vec(input_rec2020);
    let as_srgb = M_REC2020_TO_SRGB.mul_vec(input_rec2020);
    assert!(
        as_p3.iter().all(|&c| (-1e-4..=1.0 + 1e-4).contains(&c)),
        "test setup: target must be inside the P3 gamut, got P3={as_p3:?}"
    );
    assert!(
        as_srgb.iter().any(|&c| c < -1e-3 || c > 1.0 + 1e-3),
        "test setup: target must be OUTSIDE the sRGB gamut, got sRGB={as_srgb:?}"
    );

    // --- P3 export path ---
    let mut img_p3 = Image::new(1, 1, ColorSpace::DisplayLinearRec2020);
    img_p3.pixels[0] = input_rec2020;
    rec2020_to_display(&mut img_p3, TargetPrimaries::P3);
    let out_p3 = img_p3.pixels[0];

    // The P3 output is a valid P3 pixel (in [0, 1]^3).
    for c in 0..3 {
        assert!(
            (-1e-4..=1.0 + 1e-4).contains(&out_p3[c]),
            "P3 output channel {c} out of [0, 1]: {}",
            out_p3[c]
        );
    }

    // Load-bearing: the exported P3 pixel, rotated back to sRGB primaries, must
    // land OUTSIDE the sRGB unit cube — i.e. it carries saturation that sRGB
    // cannot express. Under the pre-#1921 order the whole pixel was compressed
    // to the sRGB hull first, so this rotation would sit *inside* [0, 1]^3.
    let out_p3_as_srgb = m_p3_to_srgb.mul_vec(out_p3);
    let escapes_srgb = out_p3_as_srgb.iter().any(|&c| c < -1e-3 || c > 1.0 + 1e-3);
    assert!(
        escapes_srgb,
        "P3 export was capped at the sRGB gamut (#1921 regression): \
         P3 out {out_p3:?} maps to sRGB {out_p3_as_srgb:?}, which is in [0, 1]^3"
    );

    // --- sRGB export path (contrast) ---
    let mut img_srgb = Image::new(1, 1, ColorSpace::DisplayLinearRec2020);
    img_srgb.pixels[0] = input_rec2020;
    rec2020_to_display(&mut img_srgb, TargetPrimaries::Srgb);
    let out_srgb = img_srgb.pixels[0];

    // The represented color's colorfulness (Oklab chroma) must be strictly
    // greater on the P3 path than on the sRGB path — P3 kept the saturation the
    // sRGB hull clamped away. Measure each in its own primaries via the
    // matching Oklab transform (both land the color on the same Oklab axes).
    let chroma = |lab: [f32; 3]| (lab[1] * lab[1] + lab[2] * lab[2]).sqrt();
    let chroma_p3 = chroma(p3_linear_to_oklab(out_p3));
    let chroma_srgb = chroma(srgb_linear_to_oklab(out_srgb));
    assert!(
        chroma_p3 > chroma_srgb + 1e-3,
        "P3 export no more saturated than sRGB (#1921): \
         chroma P3={chroma_p3} sRGB={chroma_srgb}"
    );
}
