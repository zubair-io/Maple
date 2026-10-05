//! 10-bit terminal quantizer for the display path (#1626).
//!
//! Sibling of [`crate::view::encode::dither_and_quantize`] (8-bit, the
//! universal display fallback) and
//! [`crate::view::quantize16::dither_and_quantize_u16`] (16-bit, the export
//! master). Display output is 8-bit on every surface today; blue-noise
//! dithering hides banding but cannot add levels, so smooth skies and skin
//! still contour on 10-bit-capable panels. This quantizes the f32 display
//! buffer directly to 10-bit levels (`0..=1023`), which a 10-bit-capable
//! surface (Apple `bgr10a2` / `rgba16Float` `CAMetalLayer`, WebGPU
//! `rgba16float` canvas) presents natively while the dithered 8-bit path
//! stays the universal fallback, byte-identical.
//!
//! It lives in its own file rather than alongside the 8-bit quantizer because
//! `view/encode.rs` is at the file-size budget, and because the 8-bit path is
//! gated by the whole color harness — leaving it untouched keeps every
//! committed budget byte-identical.

use crate::{
    image::{ColorSpace, Image},
    view::dither::blue_noise_offset_lsb,
};
use rayon::prelude::*;

/// Largest value a 10-bit channel can hold.
pub const U10_MAX: u16 = 1023;

/// Largest value a 10-bit channel can hold, as the quantize scale.
const MAX_LEVEL: f32 = 1023.0;

/// Blue-noise-dithered quantise from sRGB-encoded f32 → packed 10-bit RGB.
///
/// Input must be display-encoded (via
/// [`crate::view::encode::srgb_gamma_encode`]) and in `[0, 1]`. Returns a flat
/// row-major `Vec<u16>` of length `3 * w * h`, every lane in `0..=1023`.
///
/// The dither is the same positional blue-noise ±0.5-LSB offset the 8-bit
/// quantizer applies, just scaled to this step size. At 10 bits its amplitude
/// is ~0.1% and it is not doing the anti-banding job it does at 8 bits;
/// it is kept so the quantizers stay one shape rather than three, and it is
/// deterministic either way (the mask is a fixed table, not an RNG), so
/// display output remains reproducible.
pub fn dither_and_quantize_u10(img: &mut Image) -> Vec<u16> {
    dither_and_quantize_u10_windowed(img, (0, 0))
}

/// Quantize a patch using the full image's noise coordinates (#1107).
pub fn dither_and_quantize_u10_windowed(img: &mut Image, origin: (u32, u32)) -> Vec<u16> {
    img.assert_space(ColorSpace::DisplayEncodedSrgb);
    let w = img.width as usize;
    let mut out = vec![0u16; img.pixels.len() * 3];
    out.par_chunks_mut(3)
        .zip(img.pixels.par_iter())
        .enumerate()
        .for_each(|(i, (dst, p))| {
            // Same (x, y) recovery as the 8-bit path: row-major, `w` stride,
            // offset by the patch origin. The same offset is applied to all
            // three channels at a pixel, so a neutral input stays neutral
            // after dithering (no chroma noise).
            let x = origin.0 + (i % w) as u32;
            let y = origin.1 + (i / w) as u32;
            let off = blue_noise_offset_lsb(x, y);
            for (j, &c) in p.iter().enumerate() {
                dst[j] = (c * MAX_LEVEL + off + 0.5).clamp(0.0, MAX_LEVEL) as u16;
            }
        });
    out
}

/// Final encode: display-linear → 10-bit RGB via piecewise gamma +
/// blue-noise-dithered quantize. Returns a flat row-major `Vec<u16>` of
/// length 3 * w * h, every lane in `0..=1023`.
///
/// Thin wrapper over [`crate::view::encode::srgb_gamma_encode`] +
/// [`dither_and_quantize_u10`], mirroring
/// [`crate::view::encode::quantize_u8`]'s shape for the 8-bit fallback.
pub fn quantize_u10(img: &mut Image) -> Vec<u16> {
    crate::view::encode::srgb_gamma_encode(img);
    dither_and_quantize_u10(img)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::view::encode::dither_and_quantize;

    fn encoded_image(pixels: Vec<[f32; 3]>, width: u32, height: u32) -> Image {
        Image {
            nr_sampling_scale: 1.0,
            whites_anchor_ev: None,
            width,
            height,
            pixels,
            space: ColorSpace::DisplayEncodedSrgb,
        }
    }

    #[test]
    fn black_and_white_hit_the_endpoints_exactly() {
        let mut img = encoded_image(vec![[0.0, 0.0, 0.0], [1.0, 1.0, 1.0]], 2, 1);
        let out = dither_and_quantize_u10(&mut img);
        assert_eq!(&out[0..3], &[0, 0, 0]);
        assert_eq!(&out[3..6], &[1023, 1023, 1023]);
    }

    #[test]
    fn quantize_u10_wrapper_endpoints_from_linear() {
        let mut black = Image::new(1, 1, ColorSpace::DisplayLinearSrgb);
        assert_eq!(quantize_u10(&mut black), vec![0, 0, 0]);
        let mut white = Image::new(1, 1, ColorSpace::DisplayLinearSrgb);
        white.pixels[0] = [1.0, 1.0, 1.0];
        assert_eq!(quantize_u10(&mut white), vec![1023, 1023, 1023]);
    }

    #[test]
    fn output_length_is_three_per_pixel() {
        let mut img = encoded_image(vec![[0.5, 0.5, 0.5]; 12], 4, 3);
        assert_eq!(dither_and_quantize_u10(&mut img).len(), 36);
    }

    #[test]
    fn mid_gray_pins_known_levels() {
        // Encoded 0.5 → 511.5 + off + 0.5, truncated: 511 where the dither
        // offset is negative (mask cell < 2048), 512 where non-negative.
        // Row 0 of the mask opens 227, 2871, 3710, 1196.
        let mut img = encoded_image(vec![[0.5, 0.5, 0.5]; 4], 4, 1);
        let out = dither_and_quantize_u10(&mut img);
        assert_eq!(
            out,
            vec![511, 511, 511, 512, 512, 512, 512, 512, 512, 511, 511, 511]
        );
    }

    /// The reason this function exists: it must resolve levels that the
    /// 8-bit quantizer collapses together.
    ///
    /// The two values are compared at the SAME pixel coordinate, in two
    /// separate single-pixel images, because the dither offset is positional —
    /// putting them side by side in one image would vary the offset as well as
    /// the value and stop isolating the depth.
    #[test]
    fn resolves_gradations_the_eight_bit_quantizer_collapses() {
        let step = 1.0f32 / 255.0;
        let base = 0.5f32;
        let quantize = |value: f32| {
            let mut eight = encoded_image(vec![[value; 3]], 1, 1);
            let mut ten = encoded_image(vec![[value; 3]], 1, 1);
            (
                dither_and_quantize(&mut eight)[0],
                dither_and_quantize_u10(&mut ten)[0],
            )
        };

        let (low_8, low_10) = quantize(base);
        let (high_8, high_10) = quantize(base + step * 0.25);

        assert_eq!(
            low_8, high_8,
            "precondition: 8-bit must collapse these two values"
        );
        assert_ne!(
            low_10, high_10,
            "10-bit must keep sub-8-bit gradations distinct"
        );
    }

    /// #1626 acceptance: on a synthetic smooth-sky ramp the 10-bit output
    /// resolves strictly more unique levels than the 8-bit fallback.
    ///
    /// The ramp is a neutral gradient across encoded [0.25, 0.45] — a
    /// luminance band of the kind a sky occupies — over a 1024×8 tile. The
    /// 8-bit fallback collapses it onto ~51 levels (0.2 × 255); the 10-bit
    /// display quantizer must land near ~204 (0.2 × 1023). Dithering
    /// re-distributes error spatially but adds no levels, while depth does —
    /// that ratio is the signal.
    #[test]
    fn smooth_sky_ramp_resolves_more_levels_than_eight_bit() {
        let w = 1024u32;
        let h = 8u32;
        let lo = 0.25f32;
        let hi = 0.45f32;
        let mut img8 = Image::new(w, h, ColorSpace::DisplayEncodedSrgb);
        for y in 0..h as usize {
            for x in 0..w as usize {
                let v = lo + (hi - lo) * (x as f32 / (w - 1) as f32);
                img8.pixels[y * w as usize + x] = [v, v, v];
            }
        }
        let mut img10 = img8.clone();

        let bytes8 = dither_and_quantize(&mut img8);
        let levels10 = dither_and_quantize_u10(&mut img10);

        let mut seen8 = [false; 256];
        for chunk in bytes8.chunks_exact(3) {
            seen8[chunk[0] as usize] = true;
        }
        let unique8 = seen8.iter().filter(|&&b| b).count();
        let mut seen10 = [false; 1024];
        for chunk in levels10.chunks_exact(3) {
            seen10[chunk[0] as usize] = true;
        }
        let unique10 = seen10.iter().filter(|&&b| b).count();

        eprintln!(
            "sky ramp [{lo}, {hi}] over {w}x{h}: 8-bit={unique8} unique, 10-bit={unique10} unique"
        );

        assert!(
            unique8 <= 60,
            "fixture sanity: the 8-bit fallback should collapse this band onto ~51 levels, got {unique8}"
        );
        assert!(
            unique10 >= 150,
            "10-bit must resolve this band onto ~204 levels, got {unique10}"
        );
        assert!(
            unique10 > unique8 * 2,
            "10-bit ({unique10}) must resolve strictly more levels than 8-bit ({unique8})"
        );
    }

    /// #1626 fallback contract: the 8-bit path is byte-identical after this
    /// ticket lands. Pins exact `dither_and_quantize` bytes on a tiny
    /// deterministic fixture: encoded 0.5 → 127.5 + off + 0.5, truncated,
    /// i.e. 127 where the mask cell is < 2048, 128 elsewhere. Mask row 0
    /// opens 227, 2871, 3710, 1196; row 1 opens 3184, 1789, 479, 3507.
    #[test]
    fn eight_bit_fallback_bytes_unchanged() {
        let mut img = encoded_image(vec![[0.5, 0.5, 0.5]; 8], 4, 2);
        let out = dither_and_quantize(&mut img);
        assert_eq!(
            out,
            vec![
                127, 127, 127, 128, 128, 128, 128, 128, 128, 127, 127, 127, 128, 128, 128, 127,
                127, 127, 127, 127, 127, 128, 128, 128,
            ]
        );
    }

    #[test]
    fn is_deterministic_across_runs() {
        let pixels: Vec<[f32; 3]> = (0..64).map(|i| [i as f32 / 64.0, 0.25, 0.75]).collect();
        let mut first = encoded_image(pixels.clone(), 8, 8);
        let mut second = encoded_image(pixels, 8, 8);
        assert_eq!(
            dither_and_quantize_u10(&mut first),
            dither_and_quantize_u10(&mut second)
        );
    }

    /// Neutral input must stay neutral: the dither offset is per-pixel, not
    /// per-channel, so it can never introduce chroma noise.
    #[test]
    fn neutral_input_stays_neutral() {
        let pixels: Vec<[f32; 3]> = (0..256).map(|i| [i as f32 / 300.0; 3]).collect();
        let mut img = encoded_image(pixels, 16, 16);
        let out = dither_and_quantize_u10(&mut img);
        for triple in out.chunks(3) {
            assert_eq!(triple[0], triple[1]);
            assert_eq!(triple[1], triple[2]);
        }
    }

    /// #1107 contract for the 10-bit path: quantizing a patch with its
    /// full-image origin must equal the same pixels quantized in place.
    #[test]
    fn windowed_origin_matches_absolute_coordinates() {
        let full = vec![[0.3; 3], [0.4; 3], [0.5; 3], [0.6; 3]];
        let mut whole = encoded_image(full, 4, 1);
        let reference = dither_and_quantize_u10(&mut whole);
        let mut patch = encoded_image(vec![[0.4; 3], [0.5; 3]], 2, 1);
        let windowed = dither_and_quantize_u10_windowed(&mut patch, (1, 0));
        assert_eq!(windowed, reference[3..9]);
    }
}
