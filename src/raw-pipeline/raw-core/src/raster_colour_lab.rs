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
use crate::raster_colour::bw_luma;
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

/// libvips' normalised cumulative histogram of a float L* band, the input
/// [`percent`] reads.
///
/// `vips_hist_find` casts the float band down to an integer one — which
/// TRUNCATES — and then sizes the histogram to `max + 1` bins, so the bin
/// count is a property of the image's own brightest pixel rather than a
/// fixed 101 or 256. `vips_hist_norm` then rescales the cumulative counts so
/// the largest becomes the largest bin INDEX (`width - 1`), with the product
/// landing in a float32 band and truncating on the way back to integers.
fn normalised_cumulative_luma(ls: impl Iterator<Item = f32>) -> Vec<u32> {
    let codes: Vec<usize> = ls.map(|l| (l as i64).clamp(0, 65535) as usize).collect();
    let width = codes.iter().copied().max().unwrap_or(0) + 1;
    let counts = codes.iter().fold(vec![0u32; width], |mut acc, &code| {
        acc[code] += 1;
        acc
    });
    let scale = (width - 1) as f64 / (codes.len() as f64).max(1.0);
    counts
        .iter()
        .scan(0u32, |cum, &count| {
            *cum += count;
            Some(*cum)
        })
        .map(|cum| (cum as f64 * scale) as f32 as u32)
        .collect()
}

/// libvips `vips_percent`, which is NOT a rank search.
///
/// The threshold is `percent * width / 100` — width being the histogram's
/// own bin count, from [`normalised_cumulative_luma`] — and the comparison
/// is STRICTLY greater, so the answer is the first bin whose normalised
/// cumulative count exceeds it. That bin can sit above every pixel present:
/// on a 101-bin ramp `percent(99)` is bin 100 and `percent(100)` is bin 101,
/// because `vips_profile` reports the image width when a row holds no
/// qualifying pixel. A rank search gets this wrong in both directions, which
/// is what put the default 1/99 `normalise()` up to 46 codes away from
/// sharp.
///
/// Verified against real libvips 8.17.3 `vips_percent`, called through its
/// own C entry point, on 11 designed distributions x 20 percentiles: 220
/// data points, zero mismatches.
fn percent(norm: &[u32], p: f64) -> i32 {
    let threshold = p * norm.len() as f64 / 100.0;
    norm.iter()
        .position(|&v| v as f64 > threshold)
        .unwrap_or(norm.len()) as i32
}

impl RasterImage {
    /// sharp's `Tint`: reduce each pixel to luminance, then look it up in a
    /// 256-entry Lab table whose L* is the grey's own L* and whose a*/b*
    /// are the tint colour's a*/b* scaled by `w = 1 - 4*(l - 0.5)^2`
    /// (`l = L*/100`) — full tint chroma at mid-grey, zero at black and
    /// white. The table depends only on the tint colour, so it is built
    /// once per call and every pixel is mapped through it.
    ///
    /// The luminance reduction is [`bw_luma`] — the same linear-light
    /// Rec.709 reduction `greyscale()` uses (#3503 controller ruling B):
    /// sharp's tint preserves linear-light luminance, not a matrix applied
    /// to the encoded samples.
    pub fn tint(&self, rgb: [u8; 3]) -> Self {
        let tint_lab = srgb_to_lab(rgb);
        let lut: [[u8; 3]; 256] = std::array::from_fn(|y| {
            let l = srgb_to_lab([y as u8, y as u8, y as u8])[0];
            let w = 1.0 - 4.0 * (l / 100.0 - 0.5).powi(2);
            lab_to_srgb([l, tint_lab[1] * w, tint_lab[2] * w])
        });
        map_colour(self, |px| lut[bw_luma(px) as usize])
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
    /// keeping a*/b* and alpha — `sharp::Normalise` (`operations.cc:64-77`):
    /// convert to LAB, take the `lower`/`upper` percentile of the L* band,
    /// and linearly stretch L* so those two land on 0 and 100.
    ///
    /// Three details are load-bearing, all of them measured against sharp
    /// 0.34.5 rather than inferred:
    ///
    /// * `lower == 0` and `upper == 100` do NOT go through the percentile
    ///   machinery at all. sharp takes the band's true minimum and maximum
    ///   and casts each to `int`, which truncates toward zero.
    /// * every other percentile is libvips' [`vips_percent`](percent), which
    ///   is not a rank search — see that function's own doc.
    /// * the stretch is applied to L* WITHOUT clamping. sharp's `linear` can
    ///   push L* past 100 or below 0 and lets the LAB -> sRGB conversion clip
    ///   each channel instead, which keeps a blown pixel's hue rather than
    ///   pinning it at L* = 100. [`lab_to_srgb`] clips the same way.
    ///
    /// If the two bounds land within 1 of each other — a flat image, or a
    /// population of outliers too small to separate `lower` from `upper`
    /// (one stray pixel among a solid field, at 5/95) — sharp returns the
    /// image unchanged rather than dividing by a near-zero range.
    pub fn normalise(&self, lower: f64, upper: f64) -> Self {
        let c = self.channels as usize;
        let labs: Vec<[f32; 3]> = self
            .data
            .chunks_exact(c)
            .map(|px| srgb_to_lab([px[0], px[1], px[2]]))
            .collect();
        let norm = normalised_cumulative_luma(labs.iter().map(|lab| lab[0]));
        let extreme = |init: f32, pick: fn(f32, f32) -> f32| {
            labs.iter().fold(init, |acc, lab| pick(acc, lab[0])) as i32
        };
        let min = if lower == 0.0 {
            extreme(f32::INFINITY, f32::min)
        } else {
            percent(&norm, lower)
        };
        let max = if upper == 100.0 {
            extreme(f32::NEG_INFINITY, f32::max)
        } else {
            percent(&norm, upper)
        };
        if (max - min).abs() <= 1 {
            return self.clone();
        }
        let scale = 100.0 / (max - min) as f64;
        let offset = -(min as f64 * scale);
        let data = labs
            .iter()
            .zip(self.data.chunks_exact(c))
            .flat_map(|(lab, px)| {
                let l = (lab[0] as f64 * scale + offset) as f32;
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
