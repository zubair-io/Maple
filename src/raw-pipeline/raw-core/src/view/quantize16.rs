//! 16-bit terminal quantizer for the export path (#943).
//!
//! Sibling of [`crate::view::encode::dither_and_quantize`], which is the 8-bit
//! terminal step every display render ends on. Export adds a 16-bit deliverable
//! (TIFF), and promoting the 8-bit buffer by ×257 the way
//! [`crate::tiff::encode_from_u8`] does would produce a file that is 16-bit in
//! its header and 8-bit in its data — a wider container around the same 256
//! levels per channel. A 16-bit master exists precisely so downstream grading
//! has headroom, so this quantizes the f32 display buffer directly.
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

/// Largest value a 16-bit channel can hold.
const MAX_LEVEL: f32 = 65535.0;

/// Blue-noise-dithered quantise from sRGB-encoded f32 → packed `u16` RGB.
///
/// Input must be display-encoded (via
/// [`crate::view::encode::srgb_gamma_encode`]) and in `[0, 1]`. Returns a flat
/// row-major `Vec<u16>` of length `3 * w * h`.
///
/// The dither is the same positional blue-noise ±0.5-LSB offset the 8-bit
/// quantizer applies, just scaled to this step size. At 16 bits its amplitude
/// is ~0.0015% and it is not doing the anti-banding job it does at 8 bits;
/// it is kept so the two quantizers stay one shape rather than two, and it is
/// deterministic either way (the mask is a fixed table, not an RNG), so
/// exports remain reproducible byte-for-byte.
pub fn dither_and_quantize_u16(img: &mut Image) -> Vec<u16> {
    img.assert_space(ColorSpace::DisplayEncodedSrgb);
    let w = img.width as usize;
    let mut out = vec![0u16; img.pixels.len() * 3];
    out.par_chunks_mut(3)
        .zip(img.pixels.par_iter())
        .enumerate()
        .for_each(|(i, (dst, p))| {
            // Same (x, y) recovery as the 8-bit path: row-major, `w` stride.
            let x = (i % w) as u32;
            let y = (i / w) as u32;
            let off = blue_noise_offset_lsb(x, y);
            for (j, &c) in p.iter().enumerate() {
                dst[j] = (c * MAX_LEVEL + off + 0.5).clamp(0.0, MAX_LEVEL) as u16;
            }
        });
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::view::encode::dither_and_quantize;

    fn encoded_image(pixels: Vec<[f32; 3]>, width: u32, height: u32) -> Image {
        Image {
            width,
            height,
            pixels,
            space: ColorSpace::DisplayEncodedSrgb,
        }
    }

    #[test]
    fn black_and_white_hit_the_endpoints_exactly() {
        let mut img = encoded_image(vec![[0.0, 0.0, 0.0], [1.0, 1.0, 1.0]], 2, 1);
        let out = dither_and_quantize_u16(&mut img);
        assert_eq!(&out[0..3], &[0, 0, 0]);
        assert_eq!(&out[3..6], &[65535, 65535, 65535]);
    }

    #[test]
    fn output_length_is_three_per_pixel() {
        let mut img = encoded_image(vec![[0.5, 0.5, 0.5]; 12], 4, 3);
        assert_eq!(dither_and_quantize_u16(&mut img).len(), 36);
    }

    /// The real reason this function exists: it must resolve levels that the
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
            let mut sixteen = encoded_image(vec![[value; 3]], 1, 1);
            (
                dither_and_quantize(&mut eight)[0],
                dither_and_quantize_u16(&mut sixteen)[0],
            )
        };

        let (low_8, low_16) = quantize(base);
        let (high_8, high_16) = quantize(base + step * 0.25);

        assert_eq!(
            low_8, high_8,
            "precondition: 8-bit must collapse these two values"
        );
        assert_ne!(
            low_16, high_16,
            "16-bit must keep sub-8-bit gradations distinct"
        );
    }

    /// A genuine 16-bit quantize must produce values that are NOT all multiples
    /// of 257 — that residue is the signature of an 8-bit buffer promoted into
    /// a 16-bit container.
    #[test]
    fn output_is_not_a_promoted_eight_bit_buffer() {
        let pixels: Vec<[f32; 3]> = (0..256)
            .map(|i| {
                let v = i as f32 / 255.0 + 0.0007;
                [v.min(1.0), v.min(1.0), v.min(1.0)]
            })
            .collect();
        let mut img = encoded_image(pixels, 256, 1);
        let out = dither_and_quantize_u16(&mut img);
        assert!(
            out.iter().any(|v| v % 257 != 0),
            "every sample was a multiple of 257 — this is 8-bit data in a 16-bit box"
        );
    }

    #[test]
    fn is_deterministic_across_runs() {
        let pixels: Vec<[f32; 3]> = (0..64).map(|i| [i as f32 / 64.0, 0.25, 0.75]).collect();
        let mut first = encoded_image(pixels.clone(), 8, 8);
        let mut second = encoded_image(pixels, 8, 8);
        assert_eq!(
            dither_and_quantize_u16(&mut first),
            dither_and_quantize_u16(&mut second)
        );
    }

    /// Neutral input must stay neutral: the dither offset is per-pixel, not
    /// per-channel, so it can never introduce chroma noise.
    #[test]
    fn neutral_input_stays_neutral() {
        let pixels: Vec<[f32; 3]> = (0..256).map(|i| [i as f32 / 300.0; 3]).collect();
        let mut img = encoded_image(pixels, 16, 16);
        let out = dither_and_quantize_u16(&mut img);
        for triple in out.chunks(3) {
            assert_eq!(triple[0], triple[1]);
            assert_eq!(triple[1], triple[2]);
        }
    }
}
