//! Display-P3 encode with the Auto tail applied gamut-preservingly (#4741), the
//! FFI-facing f32 RGBA twin of [`crate::view::encode::rec2020_to_p3_auto_encoded`].
//!
//! The Apple CoreImage path applies the Auto tail as an sRGB colour cube after
//! the encode, which caps a P3 canvas at the sRGB gamut. This entry runs the
//! tail inside the encode instead, from the same composed lattice that cube is
//! baked from, so the CPU fallback, native-detail patch and export match the GPU
//! live path on a P3 target.

use crate::error::{Error, Result};
use crate::image::{ColorSpace, Image};
use crate::view::auto_profile::{apply::prepared_tail, MAX_LUT_SIZE};

/// Post-AgX display-linear Rec.2020 f32 RGBA in, P3-gamma-encoded f32 RGBA out,
/// with the Auto tail `lut` (`lut_size`³ RGB, the composed curve∘residual
/// lattice in sRGB-encoded space) applied per [`rec2020_to_p3_auto_encoded`].
/// Output alpha is 1.0, like [`super::encode_display_f32`].
///
/// [`rec2020_to_p3_auto_encoded`]: crate::view::encode::rec2020_to_p3_auto_encoded
pub fn encode_display_p3_auto_f32(
    in_f32_rgba: &[f32],
    width: u32,
    height: u32,
    lut_size: usize,
    lut: &[f32],
) -> Result<Vec<f32>> {
    let invalid =
        |message: String| Error::Pipeline(format!("encode_display_p3_auto_f32: {message}"));
    let expected_lut = (2..=MAX_LUT_SIZE)
        .contains(&lut_size)
        .then(|| lut_size.pow(3) * 3)
        .ok_or_else(|| invalid(format!("unsupported lut size {lut_size}")))?;
    if lut.len() != expected_lut {
        return Err(invalid(format!(
            "lut length {} != {expected_lut}",
            lut.len()
        )));
    }
    (width as usize)
        .checked_mul(height as usize)
        .filter(|count| count.checked_mul(4) == Some(in_f32_rgba.len()))
        .ok_or_else(|| {
            invalid(format!(
                "input length {} does not match {width}x{height} RGBA",
                in_f32_rgba.len()
            ))
        })?;
    let mut img = Image {
        width,
        height,
        pixels: in_f32_rgba
            .chunks_exact(4)
            .map(|px| [px[0], px[1], px[2]])
            .collect(),
        space: ColorSpace::DisplayLinearRec2020,
        nr_sampling_scale: 1.0,
        whites_anchor_ev: None,
    };
    crate::view::encode::rec2020_to_p3_auto_encoded(
        &mut img,
        prepared_tail(None, Some((lut_size, lut)), 1.0),
    );
    Ok(img
        .pixels
        .iter()
        .flat_map(|p| [p[0], p[1], p[2], 1.0])
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::view::auto_profile::lut::ColorLut;
    use crate::view::encode::TargetPrimaries;

    fn swatches() -> Vec<f32> {
        [
            [0.0, 0.8, 0.0],
            [0.7, 0.05, 0.05],
            [0.46, 0.46, 0.46],
            [0.2, 0.3, 0.75],
            [0.95, 0.97, 0.9],
        ]
        .iter()
        .flat_map(|rgb| [rgb[0], rgb[1], rgb[2], 1.0])
        .collect()
    }

    fn warm_lut() -> ColorLut {
        let mut lut = ColorLut::identity(9);
        for (i, lane) in lut.data.iter_mut().enumerate() {
            *lane = (*lane + [0.03, -0.01, -0.02][i % 3]).clamp(0.0, 1.0);
        }
        lut
    }

    #[test]
    fn matches_the_view_encode_bit_for_bit() {
        let input = swatches();
        let lut = warm_lut();
        let out = encode_display_p3_auto_f32(&input, 5, 1, lut.size, &lut.data).unwrap();
        let mut reference = Image::new(5, 1, ColorSpace::DisplayLinearRec2020);
        for (p, px) in reference.pixels.iter_mut().zip(input.chunks_exact(4)) {
            *p = [px[0], px[1], px[2]];
        }
        crate::view::encode::rec2020_to_p3_auto_encoded(
            &mut reference,
            prepared_tail(None, Some((lut.size, &lut.data)), 1.0),
        );
        for (got, want) in out.chunks_exact(4).zip(&reference.pixels) {
            for c in 0..3 {
                assert_eq!(got[c].to_bits(), want[c].to_bits());
            }
            assert_eq!(got[3], 1.0);
        }
    }

    #[test]
    fn identity_lut_stays_on_the_neutral_p3_encode() {
        let input = swatches();
        let lut = ColorLut::identity(17);
        let auto = encode_display_p3_auto_f32(&input, 5, 1, lut.size, &lut.data).unwrap();
        let neutral = super::super::encode_display_f32(&input, 5, 1, TargetPrimaries::P3).unwrap();
        let max = auto
            .iter()
            .zip(&neutral)
            .map(|(a, b)| (a - b).abs())
            .fold(0.0, f32::max);
        assert!(max < 1e-4, "identity Auto drifted {max} from Neutral P3");
    }

    #[test]
    fn rejects_bad_lattices_and_sizes_without_panicking() {
        let input = swatches();
        let lut = warm_lut();
        assert!(encode_display_p3_auto_f32(&input, 5, 1, 1, &[0.0; 3]).is_err());
        assert!(encode_display_p3_auto_f32(&input, 5, 1, lut.size, &lut.data[1..]).is_err());
        assert!(encode_display_p3_auto_f32(&input, 4, 1, lut.size, &lut.data).is_err());
        assert!(
            encode_display_p3_auto_f32(&input, u32::MAX, u32::MAX, lut.size, &lut.data).is_err()
        );
    }
}
