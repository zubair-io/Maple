use crate::{
    color::{
        matrices::M_REC2020_TO_SRGB,
        oklab::{oklab_to_srgb_linear, srgb_linear_to_oklab},
        oklab_gamut::compress_to_unit_cube_oklab,
    },
    image::{ColorSpace, Image},
};
use rayon::prelude::*;

/// Rec.2020 → sRGB linear via compile-time 3×3 + **hue-preserving gamut
/// compression** for any post-matrix triple that leaves `[0, 1]^3`.
///
/// Wide-gamut Rec.2020 colors near the saturated primaries land outside
/// the sRGB unit box after the matrix multiply (typically with one or
/// two channels negative). The previous behaviour relied on
/// `srgb_gamma`'s per-channel `clamp(0, 1)` to bring them in; that's a
/// channel-independent clip and rotates hue (saturated red ends up
/// magenta-tinged because the now-zero blue from the negative-blue
/// channel reads as a chromaticity shift rather than a hue-preserving
/// chroma reduction).
///
/// #438 replaces the per-channel clip with Oklab `(a, b)` bisection at
/// constant `L` — hue is invariant by construction, only chroma is
/// reduced until the triple fits in `[0, 1]^3`. The bisection uses the
/// shared helper at [`crate::color::oklab_gamut`] so the AgX caller
/// (#435 / `view/agx_hue_restoration.rs`) and this encode caller stay
/// algorithmically locked.
///
/// **Byte-identity contract:** when the post-matrix triple is already
/// in `[0, 1]^3` (the overwhelming common case — most pixels post-AgX),
/// [`compress_to_unit_cube_oklab`] returns the triple **unmodified**.
/// The downstream `srgb_gamma` clamp behaves identically to before, so
/// in-gamut input produces bit-for-bit identical output to the
/// pre-#438 pipeline.
pub fn rec2020_to_srgb(img: &mut Image) {
    img.assert_space(ColorSpace::DisplayLinearRec2020);
    img.pixels.par_iter_mut().for_each(|p| {
        let srgb = M_REC2020_TO_SRGB.mul_vec(*p);
        *p = compress_to_unit_cube_oklab(srgb, srgb_linear_to_oklab, oklab_to_srgb_linear);
    });
    img.space = ColorSpace::DisplayLinearSrgb;
}

/// Piecewise sRGB gamma encode. Per IEC 61966-2-1.
pub fn srgb_gamma(x: f32) -> f32 {
    let x = x.clamp(0.0, 1.0);
    if x <= 0.003_130_8 {
        x * 12.92
    } else {
        1.055 * x.powf(1.0 / 2.4) - 0.055
    }
}

// Display-space Levels look-layer was previously applied here (black=66,
// white=227, gamma=0.65) to compensate for Blender 4.x AgX's mid-gray lift
// when measured against the reference renderer. Maple AgX (v6) is now
// calibrated directly against the reference renderer — its polynomial places
// mid-gray near 0.18 display-linear, matching the reference renderer's tone
// placement. The Levels layer is therefore no longer
// needed; leaving it in compounds the correction and crushes midtones.

/// Final encode: display-linear sRGB → u8 RGB via piecewise gamma +
/// quantize. Returns a flat row-major `Vec<u8>` of length 3 * w * h.
pub fn quantize_u8(img: &mut Image) -> Vec<u8> {
    img.assert_space(ColorSpace::DisplayLinearSrgb);
    let mut out = vec![0u8; img.pixels.len() * 3];
    out.par_chunks_mut(3)
        .zip(img.pixels.par_iter())
        .for_each(|(dst, p)| {
            for (i, &c) in p.iter().enumerate() {
                let g = srgb_gamma(c);
                dst[i] = (g * 255.0 + 0.5).clamp(0.0, 255.0) as u8;
            }
        });
    img.space = ColorSpace::DisplayEncodedSrgb;
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gamma_zero_maps_to_zero() {
        assert!((srgb_gamma(0.0) - 0.0).abs() < 1e-6);
    }

    #[test]
    fn gamma_one_maps_to_one() {
        assert!((srgb_gamma(1.0) - 1.0).abs() < 1e-3);
    }

    #[test]
    fn gamma_below_threshold_is_linear_times_12_92() {
        let x = 0.001;
        let expected = x * 12.92;
        assert!((srgb_gamma(x) - expected).abs() < 1e-6);
    }

    #[test]
    fn rec2020_white_maps_to_srgb_white() {
        let mut img = Image::new(1, 1, ColorSpace::DisplayLinearRec2020);
        img.pixels[0] = [1.0, 1.0, 1.0];
        rec2020_to_srgb(&mut img);
        for &c in &img.pixels[0] {
            assert!((c - 1.0).abs() < 1e-2);
        }
    }

    #[test]
    fn in_gamut_input_passes_through_byte_identical() {
        // #438 contract: when the post-matrix triple already fits in
        // [0, 1]^3, the gamut compression must be a no-op. The encode
        // path's only behavioural change is on out-of-gamut input.
        //
        // We construct a Rec.2020 input whose post-matrix sRGB triple is
        // strictly in-gamut, run it through `rec2020_to_srgb`, then
        // compute the pure-matrix expected value and assert bit-equality.
        let mut img = Image::new(1, 1, ColorSpace::DisplayLinearRec2020);
        let inputs = [
            [0.18f32, 0.18, 0.18],
            [0.5, 0.5, 0.5],
            [0.4, 0.3, 0.2],
            [0.05, 0.05, 0.05],
        ];
        for input in inputs {
            img.pixels[0] = input;
            img.space = ColorSpace::DisplayLinearRec2020;
            let expected = M_REC2020_TO_SRGB.mul_vec(input);
            // Pre-condition: this input must actually be in-gamut post-
            // matrix, otherwise the test is asserting on a no-op branch
            // we never enter.
            for &c in &expected {
                assert!(
                    c >= 0.0 && c <= 1.0,
                    "test setup: input {:?} maps post-matrix to {:?} which is NOT in [0,1]",
                    input,
                    expected
                );
            }
            rec2020_to_srgb(&mut img);
            let got = img.pixels[0];
            for i in 0..3 {
                assert_eq!(
                    got[i].to_bits(),
                    expected[i].to_bits(),
                    "byte-identity broken on channel {} for input {:?}: got {} expected {}",
                    i,
                    input,
                    got[i],
                    expected[i]
                );
            }
        }
    }

    #[test]
    fn saturated_rec2020_red_preserves_hue_within_2_degrees() {
        // The flagship #438 scene: pure Rec.2020 (1, 0, 0). The matrix
        // multiply drives sRGB G and B negative; the old per-channel
        // clamp inside `srgb_gamma` would clip them to 0, leaving an
        // R=1, G=0, B=0 result that *is* sRGB red — but pure sRGB red
        // is a different hue from pure Rec.2020 red (different
        // chromaticity coordinates). The hue-preserving compressor
        // bisects chroma at constant L so the perceptual hue is
        // preserved.
        //
        // Strict gate: convert the input Rec.2020 triple to Oklab (via
        // the existing `rec2020_to_oklab`) and the post-encode sRGB-
        // linear triple to Oklab (via the new `srgb_linear_to_oklab`);
        // both sit in the same Oklab axes, so the (a, b) hue angle is
        // directly comparable. The 2° budget mirrors #471's
        // OklabChromaReduction tolerance.
        use crate::color::oklab::{rec2020_to_oklab, srgb_linear_to_oklab};
        let scene = [1.0f32, 0.0, 0.0];
        let lab_in = rec2020_to_oklab(scene);
        let mut img = Image::new(1, 1, ColorSpace::DisplayLinearRec2020);
        img.pixels[0] = scene;
        rec2020_to_srgb(&mut img);
        let srgb = img.pixels[0];
        // All channels must land in [0, 1] — no negatives, no overshoot.
        for (i, &c) in srgb.iter().enumerate() {
            assert!(
                c >= 0.0 && c <= 1.0,
                "saturated Rec.2020 red channel {} out of [0,1]: {}",
                i,
                c
            );
        }
        let lab_out = srgb_linear_to_oklab(srgb);
        let h_in = lab_in[2].atan2(lab_in[1]).to_degrees();
        let h_out = lab_out[2].atan2(lab_out[1]).to_degrees();
        let mut diff = (h_out - h_in).abs();
        if diff > 180.0 {
            diff = 360.0 - diff;
        }
        assert!(
            diff < 2.0,
            "hue drift {}° (in={}° out={}°) on saturated Rec.2020 red -> sRGB {:?}",
            diff,
            h_in,
            h_out,
            srgb
        );
        // Red must still dominate.
        assert!(
            srgb[0] > srgb[1] && srgb[0] > srgb[2],
            "red dominance lost: {:?}",
            srgb
        );
    }

    #[test]
    fn quantize_produces_expected_length() {
        let mut img = Image::new(4, 4, ColorSpace::DisplayLinearSrgb);
        let bytes = quantize_u8(&mut img);
        assert_eq!(bytes.len(), 4 * 4 * 3);
    }

    #[test]
    fn quantize_black_is_zero() {
        // Display-linear 0 → sRGB-encoded 0 → u8 0.
        let mut img = Image::new(2, 2, ColorSpace::DisplayLinearSrgb);
        let bytes = quantize_u8(&mut img);
        assert!(bytes.iter().all(|b| *b == 0));
    }

    #[test]
    fn quantize_white_is_255() {
        // Display-linear 1.0 → sRGB-encoded 1.0 → u8 255.
        let mut img = Image::new(2, 2, ColorSpace::DisplayLinearSrgb);
        for p in &mut img.pixels { *p = [1.0, 1.0, 1.0]; }
        let bytes = quantize_u8(&mut img);
        assert!(bytes.iter().all(|b| *b == 255));
    }

    #[test]
    fn quantize_mid_gray_lands_near_118() {
        // Display-linear 0.18 → sRGB-encoded ≈ 0.461 → u8 ≈ 118. This is
        // the classic mid-gray placement in display-encoded sRGB; the
        // Maple AgX polynomial is calibrated to land scene 0.18 here.
        let mut img = Image::new(1, 1, ColorSpace::DisplayLinearSrgb);
        img.pixels[0] = [0.18, 0.18, 0.18];
        let bytes = quantize_u8(&mut img);
        for &b in &bytes {
            assert!((b as i32 - 118).abs() <= 2,
                "mid-gray u8 = {}, expected near 118", b);
        }
    }
}
