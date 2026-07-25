//! Hue-preserving gamut guard for display-encoded sRGB buffers (#1942).
//!
//! Split out of `encode.rs` to keep that file under the 600-LOC hard budget —
//! same sibling-module precedent as `encode_p3_tests.rs`. The guard and its
//! tests are a self-contained concern; `encode.rs` re-exports the entry point
//! so `view::encode::gamut_guard_display_encoded_srgb` keeps resolving.

use crate::color::oklab::{oklab_to_srgb_linear, srgb_linear_to_oklab};
use crate::color::oklab_gamut::compress_to_unit_cube_oklab;
use crate::image::{ColorSpace, Image};
use crate::view::agx_inverse::srgb_gamma_inv;
use crate::view::encode::srgb_gamma;
use rayon::prelude::*;

/// Hue-preserving gamut guard for a **display-ENCODED** (sRGB-gamma) f32
/// buffer (#1942).
///
/// The main view chain gamut-compresses in `rec2020_to_srgb` (which covers
/// split-tone / grain output before this point), and `srgb_gamma_encode`
/// leaves every channel in `[0, 1]`. But stages that run **after** the gamma
/// encode in display-encoded space — the Auto Profile per-channel curve + 3D
/// residual LUT (#537) — can push a channel back out of `[0, 1]` or rotate a
/// saturated color out of gamut. Without this pass the only remaining safety
/// net is `dither_and_quantize`'s naive per-channel `clamp(0.0, 1.0)` at u8
/// quantization, which hard-clips flat and posterises pushed color — exactly
/// the defect class #438 / #1621 removed from the main chain.
///
/// This decodes the sRGB gamma, runs the shared [`compress_to_unit_cube_oklab`]
/// soft-knee against the sRGB hull, and re-encodes. Pixels already in `[0, 1]`
/// per channel are left **byte-identical** (the naive clamp was a no-op there
/// and the hue is safe), so the pass is inert on the common in-gamut case and
/// only reshapes genuinely out-of-gamut post-LUT pixels.
pub fn gamut_guard_display_encoded_srgb(img: &mut Image) {
    debug_assert!(
        img.space == ColorSpace::DisplayEncodedSrgb,
        "gamut_guard_display_encoded_srgb: expected DisplayEncodedSrgb, got {:?}",
        img.space
    );
    img.pixels.par_iter_mut().for_each(|p| {
        // Fast path: already in [0, 1] per channel ⇒ in-gamut in encoded
        // space, so the naive clamp was a no-op and the hue is safe. Leave
        // byte-identical (also avoids a lossy gamma decode/re-encode round-trip).
        if (0.0..=1.0).contains(&p[0]) && (0.0..=1.0).contains(&p[1]) && (0.0..=1.0).contains(&p[2])
        {
            return;
        }
        let lin = [srgb_gamma_inv(p[0]), srgb_gamma_inv(p[1]), srgb_gamma_inv(p[2])];
        let compressed = compress_to_unit_cube_oklab(lin, srgb_linear_to_oklab, oklab_to_srgb_linear);
        p[0] = srgb_gamma(compressed[0]);
        p[1] = srgb_gamma(compressed[1]);
        p[2] = srgb_gamma(compressed[2]);
    });
}

#[cfg(test)]
mod tests {
    use super::gamut_guard_display_encoded_srgb;
    use crate::image::{ColorSpace, Image};
    use crate::view::encode::rec2020_to_srgb;

    #[test]
    fn gamut_guard_in_gamut_encoded_pixels_are_byte_identical() {
        // Every channel in [0, 1] ⇒ in-gamut in encoded space ⇒ the guard
        // must leave the pixel bit-for-bit unchanged (the naive clamp was a
        // no-op there; no lossy gamma round-trip either).
        let mut img = Image::new(1, 4, ColorSpace::DisplayEncodedSrgb);
        let inputs = [
            [0.5f32, 0.4, 0.3],
            [0.0, 0.0, 0.0],
            [1.0, 1.0, 1.0],
            [0.9, 0.1, 0.7],
        ];
        for (p, input) in img.pixels.iter_mut().zip(inputs) {
            *p = input;
        }
        gamut_guard_display_encoded_srgb(&mut img);
        for (got, input) in img.pixels.iter().zip(inputs) {
            for c in 0..3 {
                assert_eq!(
                    got[c].to_bits(),
                    input[c].to_bits(),
                    "in-gamut encoded pixel {input:?} channel {c} was modified to {}",
                    got[c]
                );
            }
        }
    }

    #[test]
    fn gamut_guard_out_of_gamut_encoded_pixel_lands_in_box_hue_preserved() {
        // A saturated red overshoot in display-encoded space (R channel > 1).
        // Post-guard every channel must be in [0, 1], red must still dominate,
        // and the perceptual hue (Oklab angle of the gamma-decoded triple) must
        // be preserved — the whole point over the naive per-channel clamp,
        // which would flat-clip R to 1 and shift the hue.
        use crate::color::oklab::srgb_linear_to_oklab;
        use crate::view::agx_inverse::srgb_gamma_inv;
        let encoded_in = [1.4f32, 0.2, 0.1];
        let lin_in = [
            srgb_gamma_inv(encoded_in[0]),
            srgb_gamma_inv(encoded_in[1]),
            srgb_gamma_inv(encoded_in[2]),
        ];
        let lab_in = srgb_linear_to_oklab(lin_in);
        let h_in = lab_in[2].atan2(lab_in[1]).to_degrees();

        let mut img = Image::new(1, 1, ColorSpace::DisplayEncodedSrgb);
        img.pixels[0] = encoded_in;
        gamut_guard_display_encoded_srgb(&mut img);
        let out = img.pixels[0];
        for (c, &v) in out.iter().enumerate() {
            assert!(
                (0.0..=1.0).contains(&v),
                "post-guard channel {c} out of [0,1]: {v}"
            );
        }
        assert!(
            out[0] > out[1] && out[0] > out[2],
            "red dominance lost after guard: {out:?}"
        );
        let lin_out = [
            srgb_gamma_inv(out[0]),
            srgb_gamma_inv(out[1]),
            srgb_gamma_inv(out[2]),
        ];
        let lab_out = srgb_linear_to_oklab(lin_out);
        let h_out = lab_out[2].atan2(lab_out[1]).to_degrees();
        let mut diff = (h_out - h_in).abs();
        if diff > 180.0 {
            diff = 360.0 - diff;
        }
        assert!(
            diff < 2.0,
            "hue drift {diff}° (in={h_in}° out={h_out}°) through the gamut guard"
        );
    }

    /// #1942 companion: colour-grading output run through the real view
    /// tail (AgX → color_grade → rec2020_to_srgb) must not clip-collapse.
    /// Pushing grading saturation on a neutral base must produce
    /// monotonically non-decreasing output chroma — confirming
    /// `rec2020_to_srgb`'s hue-preserving compression covers the grading
    /// tint, so no separate compress pass is needed between
    /// color_grade/grain and the encode.
    #[test]
    fn color_grade_view_tail_no_chroma_collapse() {
        use crate::color::oklab::srgb_linear_to_oklab;
        const N: usize = 60;
        let mut chromas = Vec::with_capacity(N);
        for i in 0..N {
            let sat = 100.0 * (i as f32) / ((N - 1) as f32); // grading sat 0 → 100
            let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
            img.pixels[0] = [0.18, 0.18, 0.18]; // neutral midtone
            crate::view::agx::apply(&mut img, 0.0);
            // Tint every zone the same hue so the midtone is graded
            // regardless of the balance crossover; ramp all saturations.
            crate::stages::color_grade::apply(
                &mut img,
                &crate::stages::color_grade::ColorGradeSliders {
                    shadow: [40.0, sat, 0.0],
                    midtone: [40.0, sat, 0.0],
                    highlight: [40.0, sat, 0.0],
                    global: [0.0, 0.0, 0.0],
                    balance: 0.0,
                },
            );
            rec2020_to_srgb(&mut img);
            let lab = srgb_linear_to_oklab(img.pixels[0]);
            chromas.push((lab[1] * lab[1] + lab[2] * lab[2]).sqrt());
        }
        for w in chromas.windows(2) {
            assert!(
                w[1] >= w[0] - 1.5e-3,
                "colour-grade view-tail chroma inverted (clip collapse): {} -> {}",
                w[0],
                w[1]
            );
        }
        let span = chromas[N - 1] - chromas[0];
        assert!(
            span > 0.005,
            "colour-grade saturation ramp was a near no-op (span {span})"
        );
    }
}
