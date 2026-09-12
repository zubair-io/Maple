//! Per-pixel colour ops (#3503).
//!
//! * `greyscale` is Rec.709 luma taken in LINEAR light: de-gamma each
//!   channel, weight, re-gamma. This is a deliberate reversal of the plan's
//!   D3 note that these ops stay on encoded values — D3 was written before
//!   measuring `greyscale()`/`toColourspace('b-w')` against real sharp
//!   0.34.5 output, which round-trips through `srgb_degamma`/`srgb_gamma`
//!   (confirmed: pure red -> 127, pure green -> 220, pure blue -> 76; an
//!   encoded-values matrix would give 54/182/18 instead). `gamma` and
//!   `linear` genuinely DO stay on the encoded samples — that IS what
//!   `vips_gamma`/`vips_linear` measure — so D3 stands for those two.
//! * `gamma(e)` is `out = 255 * (in/255)^e` — a PLAIN power law, UNLIKE
//!   libvips' own `vips_gamma`, which computes `x ** (1/e)` (a reciprocal
//!   power law). The recipe's `gamma` op deliberately does not reproduce
//!   that reciprocal; the builder (`builder-colour.ts`) is what reproduces
//!   sharp's net `vips_gamma`-based effect by choosing which reciprocal to
//!   take before handing this op its `exponent` (#3503 fix-round-2).
//! * `linear(a, b)` is `out = a*in + b` with a uchar cast, `vips_linear`.
//! * `negate` is `255 - in`, and touches alpha unless told not to.
//!
//! All four leave the alpha channel alone except `negate` with
//! `negate_alpha = true`, which is sharp's documented default.

use crate::raster::RasterImage;
use crate::view::encode::{srgb_degamma, srgb_gamma};

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
        width: src.width,
        height: src.height,
        channels: src.channels,
        data,
        orientation: src.orientation,
    }
}

#[inline]
fn to_byte(v: f64) -> u8 {
    v.round().clamp(0.0, 255.0) as u8
}

/// Rec.709 luma in LINEAR light: de-gamma each channel, weight by
/// [`REC709_LUMA`], re-gamma, round — what `vips_colourspace(sRGB -> B_W)`
/// (and so sharp's `greyscale()`/`toColourspace('b-w')`) actually measures.
/// `pub(crate)` so a future filters lane can share the same reduction rather
/// than re-deriving it.
pub(crate) fn bw_luma(rgb: [u8; 3]) -> u8 {
    let linear_y = (0..3)
        .map(|i| REC709_LUMA[i] * srgb_degamma(rgb[i] as f32 / 255.0) as f64)
        .sum::<f64>();
    to_byte(srgb_gamma(linear_y as f32) as f64 * 255.0)
}

impl RasterImage {
    /// Rec.709 luma taken in linear light (see [`bw_luma`]), written back to
    /// all three channels so the result stays a web-friendly sRGB image
    /// (sharp's documented behaviour).
    pub fn greyscale(&self) -> Self {
        map_colour(self, |px| {
            let y = bw_luma(px);
            [y, y, y]
        })
    }

    /// `out = 255 * (in/255)^exponent` — a PLAIN power law applied
    /// directly to `exponent`, UNLIKE libvips' `vips_gamma(image,
    /// exponent)`, which computes `x ** (1/exponent)`. See
    /// `builder-colour.ts`'s `pushGamma` for how the builder reproduces
    /// sharp's `vips_gamma`-based net effect through this simpler op.
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
            width: self.width,
            height: self.height,
            channels: self.channels,
            data,
            orientation: self.orientation,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn greyscale_is_rec709_luma_in_linear_light() {
        // Measured against real sharp 0.34.5 `greyscale()` output: de-gamma
        // each channel, Rec.709-weight in linear light, re-gamma, round.
        // (An encoded-values matrix — the old behaviour here — would give
        // 54/182/18 instead; sharp measurably does not do that.)
        let img = RasterImage::new_rgb(3, 1, vec![255, 0, 0, 0, 255, 0, 0, 0, 255]);
        let grey = img.greyscale();
        assert_eq!(grey.channels, 3, "sharp keeps three identical channels");
        assert_eq!(grey.data, vec![127, 127, 127, 220, 220, 220, 76, 76, 76]);
    }

    #[test]
    fn greyscale_leaves_equal_channel_greys_unchanged() {
        // De-gamma then re-gamma is an exact round trip when every channel
        // already carries the same value (the Rec.709 weights sum to 1.0).
        let img = RasterImage::new_rgb(2, 1, vec![128, 128, 128, 7, 7, 7]);
        assert_eq!(img.greyscale().data, vec![128, 128, 128, 7, 7, 7]);
    }

    #[test]
    fn greyscale_leaves_alpha_untouched() {
        let img = RasterImage::new_rgba(1, 1, vec![255, 0, 0, 77]);
        assert_eq!(img.greyscale().data, vec![127, 127, 127, 77]);
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
    fn gamma_leaves_alpha_untouched() {
        let img = RasterImage::new_rgba(1, 1, vec![128, 255, 0, 77]);
        assert_eq!(img.gamma(2.0).data, vec![64, 255, 0, 77]);
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
