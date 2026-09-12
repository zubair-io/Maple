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
//! `gamma` and `linear` both finish with libvips' float -> uchar cast, which
//! **truncates** rather than rounding ([`to_uchar_trunc`]). That one code of
//! difference is not cosmetic: sharp's `gamma(g, gammaOut)` is a PAIR of
//! these ops, and a rounded intermediate is amplified on the way back out —
//! the default `.gamma()` drifted by up to 21/255 and `.gamma(3.0)` by
//! 40/255 against sharp 0.34.5 before this was fixed.
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

/// libvips' float -> uchar step: clip into 0..=255 and **truncate**.
///
/// `vips_cast`'s own documentation is explicit — "Floats are truncated (not
/// rounded). Out of range values are clipped." (`libvips/conversion/cast.c`)
/// — and `vips_linear`'s `uchar` output path does the same thing inline
/// (`q[i] = VIPS_FCLIP(0, t, 255)` assigned into a `VipsPel`). Both
/// `vips_gamma` and `vips_linear` finish this way, so both truncate;
/// measured against sharp 0.34.5 on all 256 codes for every exponent and
/// coefficient pair in the gate below, `floor` misses 0 samples where
/// `round` misses 113-135 of them.
///
/// Deliberately NOT the same conversion as [`to_byte`]: `bw_luma` (and the
/// CIELAB ops that share it) go through libvips' *colourspace* machinery,
/// which measurably rounds — flooring there would make #3572 worse.
#[inline]
fn to_uchar_trunc(v: f64) -> u8 {
    v.clamp(0.0, 255.0) as u8
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
        // only 256 distinct inputs. libvips builds the same LUT (an identity
        // image put through `linear1(1/255)`, `pow_const1(e)` and
        // `linear1(255, uchar=TRUE)`), and the intermediate images in that
        // chain are float32 bands while the arithmetic itself happens in
        // double — so each of the two `as f32` hops below is a real
        // quantization step libvips also takes, and the final conversion
        // truncates (see [`to_uchar_trunc`]). Reproducing the hops matters:
        // `exponent == 1.0` is only an exact identity because `v/255` is
        // rounded to f32 before being multiplied back up.
        let lut: Vec<u8> = (0..256)
            .map(|v| {
                let scaled = (v as f64 * (1.0 / 255.0)) as f32;
                let powered = (scaled as f64).powf(exponent) as f32;
                to_uchar_trunc(powered as f64 * 255.0)
            })
            .collect();
        map_colour(self, |px| [0, 1, 2].map(|i| lut[px[i] as usize]))
    }

    /// `out = a*in + b` per channel on the encoded samples, libvips `linear`
    /// with `uchar = TRUE`.
    pub fn linear(&self, a: [f64; 3], b: [f64; 3]) -> Self {
        map_colour(self, |px| {
            [0, 1, 2].map(|i| {
                // `a*v + b` in double, landing in a float32 band (libvips
                // promotes a uchar input to float for arithmetic), then
                // clipped and truncated by the cast back down to uchar. The
                // f32 hop is load-bearing, not cosmetic: in pure double
                // `1.2 * 100.0 - 10.0` is a hair under 110, which would
                // truncate to 109 where sharp gives 110.
                let scaled = (px[i] as f64 * a[i] + b[i]) as f32;
                to_uchar_trunc(scaled as f64)
            })
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
    fn gamma_one_is_an_exact_identity_on_every_code() {
        // Exact for all 256 codes only because the LUT rounds `v/255` to f32
        // before multiplying back up, exactly as libvips' float32
        // intermediate does — in pure double the product can land a hair
        // under `v` and truncate to `v - 1`.
        let ramp: Vec<u8> = (0..256u32).flat_map(|v| [v as u8; 3]).collect();
        let img = RasterImage::new_rgb(256, 1, ramp.clone());
        assert_eq!(img.gamma(1.0).data, ramp);
    }

    #[test]
    fn gamma_truncates_like_the_uchar_cast() {
        // `(15/255)^2.2 * 255 = 0.50`, which libvips truncates to 0 where
        // rounding gives 1; `(1/255)^(1/2.2) * 255 = 20.56` truncates to 20
        // where rounding gives 21. Both measured against real sharp 0.34.5
        // over the whole 0..=255 ramp (floor misses nothing, round misses
        // 113-135 codes per exponent).
        let mid = RasterImage::new_rgb(1, 1, vec![15, 15, 15]);
        assert_eq!(mid.gamma(2.2).data, vec![0, 0, 0]);
        let dark = RasterImage::new_rgb(1, 1, vec![1, 1, 1]);
        assert_eq!(dark.gamma(1.0 / 2.2).data, vec![20, 20, 20]);
    }

    #[test]
    fn gamma_leaves_alpha_untouched() {
        let img = RasterImage::new_rgba(1, 1, vec![128, 255, 0, 77]);
        assert_eq!(img.gamma(2.0).data, vec![64, 255, 0, 77]);
    }

    #[test]
    fn gamma_round_trips_through_its_inverse() {
        // Two truncating 8-bit passes, so the round trip loses up to 2
        // codes, not 1 — sharp's own `gamma()` pair loses the same way (it
        // is what makes the default `.gamma()` non-identity near black).
        let img = RasterImage::new_rgb(1, 1, vec![40, 130, 220]);
        let back = img.gamma(1.0 / 2.2).gamma(2.2);
        for (a, b) in back.data.iter().zip(&img.data) {
            assert!(
                (*a as i32 - *b as i32).abs() <= 2,
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
    fn linear_truncates_like_the_uchar_cast() {
        // `1.2*13 - 10 = 5.6` and `0.5*3 = 1.5`: libvips truncates to 5 and
        // 1 where rounding gives 6 and 2. Measured against sharp 0.34.5,
        // which disagreed with the old rounding on 996 of 3072 noise
        // samples at `linear(1.2, -10)` alone.
        let img = RasterImage::new_rgb(1, 1, vec![13, 3, 3]);
        let out = img.linear([1.2, 0.5, 0.5], [-10.0, 0.0, 0.0]);
        assert_eq!(out.data, vec![5, 1, 1]);
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
