//! Per-pixel colour ops that libvips performs on the ENCODED samples
//! (#3503) — see the plan's decision D3 for why none of these linearise.
//!
//! * `greyscale` is the Rec.709 luma matrix on the 8-bit values, which is what
//!   `vips_colourspace(sRGB -> B_W)` does. sharp's documentation calls this
//!   "a linear operation" in the matrix sense and recommends pairing it with
//!   `gamma()` if you want it in linear light — exactly the behaviour here.
//! * `gamma(e)` is `out = 255 * (in/255)^e`, `vips_gamma`.
//! * `linear(a, b)` is `out = a*in + b` with a uchar cast, `vips_linear`.
//! * `negate` is `255 - in`, and touches alpha unless told not to.
//!
//! All four leave the alpha channel alone except `negate` with
//! `negate_alpha = true`, which is sharp's documented default.

use crate::raster::RasterImage;

/// Rec.709 luma coefficients — the sRGB -> B_W matrix libvips uses.
pub const REC709_LUMA: [f64; 3] = [0.2126, 0.7152, 0.0722];

/// Rewrite the colour samples of every pixel, leaving alpha untouched.
fn map_colour(src: &RasterImage, f: impl Fn([u8; 3]) -> [u8; 3]) -> RasterImage {
    let c = src.channels as usize;
    let data = src
        .data
        .chunks_exact(c)
        .flat_map(|px| {
            let mapped = f([px[0], px[1], px[2]]);
            let alpha = px.get(3).copied();
            mapped.into_iter().chain(alpha)
        })
        .collect();
    RasterImage {
        data,
        ..src.clone()
    }
}

#[inline]
fn to_byte(v: f64) -> u8 {
    v.round().clamp(0.0, 255.0) as u8
}

impl RasterImage {
    /// Rec.709 luma on the encoded samples, written back to all three
    /// channels so the result stays a web-friendly sRGB image (sharp's
    /// documented behaviour).
    pub fn greyscale(&self) -> Self {
        map_colour(self, |px| {
            let y = to_byte((0..3).map(|i| px[i] as f64 * REC709_LUMA[i]).sum::<f64>());
            [y, y, y]
        })
    }

    /// `out = 255 * (in/255)^exponent`, libvips `gamma`.
    pub fn gamma(&self, exponent: f64) -> Self {
        // A 256-entry LUT: the power call is the expensive part and there are
        // only 256 distinct inputs.
        let lut: Vec<u8> = (0..256)
            .map(|v| to_byte((v as f64 / 255.0).powf(exponent) * 255.0))
            .collect();
        map_colour(self, |px| [0, 1, 2].map(|i| lut[px[i] as usize]))
    }

    /// `out = a*in + b` per channel on the encoded samples, libvips `linear`
    /// with `uchar = TRUE`.
    pub fn linear(&self, a: [f64; 3], b: [f64; 3]) -> Self {
        map_colour(self, |px| {
            [0, 1, 2].map(|i| to_byte(px[i] as f64 * a[i] + b[i]))
        })
    }

    /// `out = 255 - in`. `negate_alpha` is sharp's `negate({ alpha })`,
    /// which defaults to `true`.
    pub fn negate(&self, negate_alpha: bool) -> Self {
        let c = self.channels as usize;
        let data = self
            .data
            .iter()
            .enumerate()
            .map(|(i, &v)| {
                let is_alpha = c == 4 && i % 4 == 3;
                if is_alpha && !negate_alpha {
                    v
                } else {
                    255 - v
                }
            })
            .collect();
        Self {
            data,
            ..self.clone()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn greyscale_uses_rec709_luma_on_the_encoded_values() {
        // 0.2126*255 = 54.2 -> 54; 0.7152*255 = 182.4 -> 182; 0.0722*255 = 18.4 -> 18.
        let img = RasterImage::new_rgb(3, 1, vec![255, 0, 0, 0, 255, 0, 0, 0, 255]);
        let grey = img.greyscale();
        assert_eq!(grey.channels, 3, "sharp keeps three identical channels");
        assert_eq!(grey.data, vec![54, 54, 54, 182, 182, 182, 18, 18, 18]);
    }

    #[test]
    fn greyscale_leaves_alpha_untouched() {
        let img = RasterImage::new_rgba(1, 1, vec![255, 0, 0, 77]);
        assert_eq!(img.greyscale().data, vec![54, 54, 54, 77]);
    }

    #[test]
    fn gamma_is_the_libvips_power_law() {
        // exponent 2: (128/255)^2 * 255 = 64.25 -> 64.
        let img = RasterImage::new_rgb(1, 1, vec![128, 255, 0]);
        assert_eq!(img.gamma(2.0).data, vec![64, 255, 0]);
    }

    #[test]
    fn gamma_one_is_identity() {
        let img = RasterImage::new_rgb(1, 1, vec![7, 99, 200]);
        assert_eq!(img.gamma(1.0).data, img.data);
    }

    #[test]
    fn gamma_round_trips_through_its_inverse() {
        let img = RasterImage::new_rgb(1, 1, vec![40, 130, 220]);
        let back = img.gamma(1.0 / 2.2).gamma(2.2);
        for (a, b) in back.data.iter().zip(&img.data) {
            assert!(
                (*a as i32 - *b as i32).abs() <= 1,
                "{:?} vs {:?}",
                back.data,
                img.data
            );
        }
    }

    #[test]
    fn linear_applies_a_times_x_plus_b_per_channel() {
        let img = RasterImage::new_rgb(1, 1, vec![100, 100, 100]);
        let out = img.linear([0.5, 1.0, 2.0], [10.0, 0.0, -50.0]);
        assert_eq!(out.data, vec![60, 100, 150]);
    }

    #[test]
    fn linear_clamps_rather_than_wrapping() {
        let img = RasterImage::new_rgb(1, 1, vec![200, 10, 10]);
        let out = img.linear([2.0, 1.0, 1.0], [0.0, -50.0, 0.0]);
        assert_eq!(out.data, vec![255, 0, 10]);
    }

    #[test]
    fn linear_leaves_alpha_alone() {
        let img = RasterImage::new_rgba(1, 1, vec![100, 100, 100, 60]);
        assert_eq!(img.linear([0.0, 0.0, 0.0], [0.0, 0.0, 0.0]).data[3], 60);
    }

    #[test]
    fn negate_inverts_every_channel_including_alpha_by_default() {
        let img = RasterImage::new_rgba(1, 1, vec![0, 100, 255, 200]);
        assert_eq!(img.negate(true).data, vec![255, 155, 0, 55]);
    }

    #[test]
    fn negate_alpha_false_preserves_transparency() {
        let img = RasterImage::new_rgba(1, 1, vec![0, 100, 255, 200]);
        assert_eq!(img.negate(false).data, vec![255, 155, 0, 200]);
    }
}
