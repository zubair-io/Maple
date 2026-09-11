//! The colour ops sharp performs in a perceptual space (#3503).
//!
//! `tint(colour)` mirrors sharp's `Tint` (`lib/operations.cc`): every pixel
//! is first reduced to luminance, then each grey level is looked up in a Lab
//! table whose L* is the grey's own L* and whose a*/b* are the tint
//! colour's a*/b* scaled by a luminance-dependent weight that peaks at
//! mid-grey and falls to zero at black and white. `modulate` scales L* by
//! `brightness`, adds `lightness` to it, scales C* by `saturation` and
//! rotates h by `hue` — `sharp::Modulate`, which is a `vips_linear` in LCh
//! space. Both leave the alpha channel unchanged.

use crate::color::matrices::M_SRGB_TO_P3;
use crate::raster::RasterImage;
use crate::raster_colour::REC709_LUMA;
use crate::raster_lab::{lab_to_lch, lab_to_srgb, lch_to_lab, srgb_to_lab};
use crate::view::encode::{srgb_degamma, srgb_gamma, TargetPrimaries};

/// Rewrite the colour samples of every pixel, leaving alpha untouched.
fn map_colour(src: &RasterImage, f: impl Fn([u8; 3]) -> [u8; 3]) -> RasterImage {
    let c = src.channels as usize;
    let data = src
        .data
        .chunks_exact(c)
        .flat_map(|px| {
            let mapped = f([px[0], px[1], px[2]]);
            mapped.into_iter().chain(px.get(3).copied())
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

/// Rec.709 luma of the encoded samples, rounded and clamped — the same
/// reduction `RasterImage::greyscale` performs. sharp's `Tint` mixes to
/// luminance before placing each grey on the Lab table.
fn luma(px: [u8; 3]) -> u8 {
    let y = (0..3).map(|i| px[i] as f64 * REC709_LUMA[i]).sum::<f64>();
    y.round().clamp(0.0, 255.0) as u8
}

impl RasterImage {
    /// sharp's `Tint`: reduce each pixel to luminance, then look it up in a
    /// 256-entry Lab table whose L* is the grey's own L* and whose a*/b*
    /// are the tint colour's a*/b* scaled by `w = 1 - 4*(l - 0.5)^2`
    /// (`l = L*/100`) — full tint chroma at mid-grey, zero at black and
    /// white. The table depends only on the tint colour, so it is built
    /// once per call and every pixel is mapped through it.
    pub fn tint(&self, rgb: [u8; 3]) -> Self {
        let tint_lab = srgb_to_lab(rgb);
        let lut: [[u8; 3]; 256] = std::array::from_fn(|y| {
            let l = srgb_to_lab([y as u8, y as u8, y as u8])[0];
            let w = 1.0 - 4.0 * (l / 100.0 - 0.5).powi(2);
            lab_to_srgb([l, tint_lab[1] * w, tint_lab[2] * w])
        });
        map_colour(self, |px| lut[luma(px) as usize])
    }

    /// `L' = L*brightness + lightness`, `C' = C*saturation`, `h' = h + hue`.
    pub fn modulate(&self, brightness: f64, saturation: f64, hue: f64, lightness: f64) -> Self {
        map_colour(self, |px| {
            let lch = lab_to_lch(srgb_to_lab(px));
            lab_to_srgb(lch_to_lab([
                (lch[0] as f64 * brightness + lightness) as f32,
                (lch[1] as f64 * saturation) as f32,
                (lch[2] as f64 + hue) as f32,
            ]))
        })
    }

    /// Stretch L* so the `lower`/`upper` percentiles land on 0 and 100,
    /// keeping a*/b* and alpha — `sharp::Normalise`: convert to LAB, find
    /// the `lower`/`upper` percentile of the L channel histogram, and
    /// linearly stretch L* so those two values map to 0 and 100. If the two
    /// percentiles land within 1 of each other — including a flat image, or
    /// a population of outliers too small to separate `lower` from `upper`
    /// (e.g. one stray pixel among a solid field, at 5/95) — sharp returns
    /// the image unchanged rather than dividing by a near-zero range.
    ///
    /// The histogram has 101 bins because libvips casts the L band to uchar
    /// before taking percentiles and L* only spans 0..100; matching the bin
    /// count, and skipping empty bins in the percentile search below, is
    /// what makes the percentile land in the same place sharp's does.
    pub fn normalise(&self, lower: f64, upper: f64) -> Self {
        let c = self.channels as usize;
        let labs: Vec<[f32; 3]> = self
            .data
            .chunks_exact(c)
            .map(|px| srgb_to_lab([px[0], px[1], px[2]]))
            .collect();
        let mut histogram = [0usize; 101];
        for lab in &labs {
            histogram[lab[0].round().clamp(0.0, 100.0) as usize] += 1;
        }
        let total = labs.len();
        // Smallest POPULATED bin whose cumulative count reaches `p`% of the
        // pixels. Skipping empty bins (rather than returning the very first
        // bin the moment `seen >= want`) is what makes `percentile(0)` land
        // on the image's actual darkest pixel instead of literal L* = 0.
        //
        // `want` scales by `total - 1`, not `total` (a 0-indexed rank, the
        // same convention `numpy.percentile`'s default 'linear' method
        // uses) — matched against real sharp 0.34.5 output on the 129-px
        // compressed-ramp fixture at 0/100: scaling by `total` puts the top
        // bin one bin past the brightest pixel actually present, which
        // undershoots white (251, not 255); `total - 1` lands the top bin
        // on the brightest pixel's own bin.
        let percentile = |p: f64| -> f64 {
            let want = (p / 100.0 * total.saturating_sub(1) as f64).max(0.0);
            let mut seen = 0usize;
            for (bin, &count) in histogram.iter().enumerate() {
                if count == 0 {
                    continue;
                }
                seen += count;
                if seen as f64 >= want {
                    return bin as f64;
                }
            }
            100.0
        };
        let min = percentile(lower);
        let max = percentile(upper);
        if (max - min).abs() <= 1.0 {
            return self.clone();
        }
        let scale = 100.0 / (max - min);
        let offset = -min * scale;
        let data = labs
            .iter()
            .zip(self.data.chunks_exact(c))
            .flat_map(|(lab, px)| {
                let l = ((lab[0] as f64 * scale + offset) as f32).clamp(0.0, 100.0);
                let rgb = lab_to_srgb([l, lab[1], lab[2]]);
                rgb.into_iter().chain(px.get(3).copied())
            })
            .collect();
        Self {
            data,
            ..self.clone()
        }
    }

    /// Rotate the primaries from `from` to `to`, keeping the sRGB transfer
    /// function (which is what Display P3 uses too). The rotation is a
    /// linear-light matrix, so the samples are de-gamma'd, rotated and
    /// re-gamma'd.
    ///
    /// The ENCODE step is what tags the file — an untagged P3 file is read as
    /// sRGB by every colour-managed viewer and gets stretched a second time,
    /// which is exactly the defect `icc.rs` exists to prevent. Pair this with
    /// `RasterEncodeOptions::primaries`.
    pub fn to_colourspace(&self, from: TargetPrimaries, to: TargetPrimaries) -> Self {
        let matrix = match (from, to) {
            (TargetPrimaries::Srgb, TargetPrimaries::Srgb)
            | (TargetPrimaries::P3, TargetPrimaries::P3) => return self.clone(),
            (TargetPrimaries::Srgb, TargetPrimaries::P3) => M_SRGB_TO_P3,
            (TargetPrimaries::P3, TargetPrimaries::Srgb) => M_SRGB_TO_P3
                .inverse()
                .expect("M_SRGB_TO_P3 is non-singular"),
        };
        map_colour(self, |px| {
            let linear = [0, 1, 2].map(|i| srgb_degamma(px[i] as f32 / 255.0));
            let rotated = matrix.mul_vec(linear);
            [0, 1, 2].map(|i| (srgb_gamma(rotated[i]) * 255.0).round().clamp(0.0, 255.0) as u8)
        })
    }
}

#[cfg(test)]
#[path = "raster_colour_lab_tests.rs"]
mod tests;
