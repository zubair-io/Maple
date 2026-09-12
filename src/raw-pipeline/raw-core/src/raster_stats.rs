//! `stats()` (#3507): per-channel statistics plus the four whole-image
//! numbers sharp reports.
//!
//! The definitions follow sharp's documentation, cross-checked against
//! `stats.cc` in the vendored `sharp` 0.34.5 source and against real
//! `sharp().stats()` output (see the task report for the fixtures and
//! numbers):
//!
//! * per channel — `min`, `max`, `sum`, `squaresSum`, `mean`, `stdev`, and the
//!   coordinates of one pixel where the min and max occur. `stdev` is the
//!   SAMPLE standard deviation (`n - 1` in the denominator) — confirmed by
//!   reading `stats.cc`'s `ChannelStats` straight out of `vips_stats()`,
//!   and by reproducing a fixture's channel by hand: sharp reports
//!   `95.150257112482` for a 64-sample red channel whose closed-form sample
//!   stdev is `95.150257112482` and whose population stdev is
//!   `94.40396906380579` — sharp's number is the sample one.
//! * `isOpaque` — no alpha channel, or every alpha sample is 255
//!   (`RasterImage::is_opaque`, already on this branch from #3505).
//! * `entropy` — Shannon entropy of the 256-bin greyscale histogram, in
//!   bits, alpha discarded (`stats.cc`: `hist_find().hist_entropy()` on
//!   `colourspace(B_W)`). The B_W conversion is the crate's ONE
//!   black-and-white reduction, [`crate::raster_labs::srgb_to_bw`] — the
//!   same `vips_col_scRGB2BW` the colour lane's `greyscale()` /
//!   `toColourspace('b-w')` and the filter lane's `threshold({greyscale})`
//!   go through. This file used to carry a private copy computed with
//!   Maple's own sRGB transfer functions, which disagreed with libvips by
//!   ±1 on a minority of pixels and so left a small entropy residual
//!   (#3572); routing through the shared helper shrinks it — measured
//!   before/after on the reference fixtures, worst-case entropy residual
//!   0.0743 → 0.0098 bits and sharpness 0.0096 → 0.0029.
//! * `sharpness` — the sample standard deviation of an UNCLAMPED
//!   floating-point 3x3 Laplacian convolution of the greyscale image.
//!   `stats.cc` runs `vips_conv` with the classic 4-connected Laplacian
//!   kernel `[0,1,0; 1,-4,1; 0,1,0]`, `scale = 9`, no offset, on the
//!   non-clamped result, then `.deviate()` (sample stdev). Fix round 1
//!   (#3507 review) corrected an earlier version of this file that ran a
//!   clamped `[0,255]` integer convolution instead — that produced a
//!   differently-scaled, non-matching number. This version accumulates in
//!   `f64`, divides by the scale (`9.0`), keeps the sign, and never
//!   clamps, so [`laplacian3x3`] returns `f64` samples directly fed to
//!   [`sample_stdev`]. Measured directly against real sharp 0.34.5 on
//!   this file's 8x8 fixture (see the test): sharp reports
//!   `5.642424922637657`, matched to `1e-6`.
//!
//!   The review round that produced this fix (task-G3-fix1-brief.md)
//!   specified an 8-connected kernel (`[-1,-1,-1; -1,8,-1; -1,-1,-1]`) and
//!   a target of `28.05176056457488` for a 32x32 2px checkerboard. Real
//!   sharp 0.34.5, run directly against both a checkerboard of that exact
//!   description and the existing 8x8 fixture, contradicts both: the
//!   8-connected kernel gives `16.61`, not `5.64`, on the 8x8 fixture
//!   (sharp's own number), while the 4-connected kernel above matches it
//!   to `3e-8`; no 0/255 checkerboard construction (cell sizes 1-16,
//!   boards 4x4 up to 1024x1024, either grey polarity) reproduces
//!   `28.05` with either kernel — real sharp's own checkerboard numbers
//!   range `35.8`-`56.6` across that whole sweep. This file keeps the
//!   4-connected kernel (real-sharp-verified) and pins the checkerboard
//!   test to this file's own real-sharp measurement instead of the
//!   brief's number — see the test for the exact fixture and the
//!   measured value.
//!
//!   A 1x1 image has no neighbours to differ from itself under
//!   clamp-to-edge addressing, so its single Laplacian sample is always
//!   `0.0` and `sample_stdev` of one value is `0.0` — sharpness is `0.0`,
//!   matching sharp's own skip of a 1x1 image.
//! * `dominant` — the most populated cell of a 4096-bin (16x16x16) RGB
//!   histogram, reported as that cell's centre (`bin * 16 + 8`). Fix round 1
//!   corrected two bugs found against real sharp output: (1) the bin edges
//!   are `bin(v) = 0` when `v == 0`, else `(v - 1) / 16` (integer division)
//!   — libvips' `hist_find_ndim` bin edges, NOT a plain `v >> 4` shift,
//!   which disagreed on 15 of 256 input values (every multiple of 16,
//!   including `128 -> bin 7`, not the `8 -> bin 8` a `>> 4` shift would
//!   give); (2) ties are broken by keeping the first maximum in libvips'
//!   own scan order over the `hist_find_ndim` image — green down the rows,
//!   then red across the columns, then blue in the bands — not the lowest
//!   red-major bin index the final fix wave found here, and not the last
//!   one a naive `max_by_key` returns. See `dominant_of` for the four
//!   measured tie fixtures that pin that ordering, and for the earlier
//!   claim they disproved.
//!
//! The greyscale reduction is shared (see `entropy` above). The
//! convolution is not: libvips' sharpness estimate runs its 3x3 Laplacian
//! UNCLAMPED and in float, where the filter lane's `RasterImage::convolve`
//! writes a clamped `u8` raster, so [`laplacian3x3`] below stays local. The
//! one test that wants "a blurred copy of an image" (to prove `sharpness`
//! orders a sharp edge above a soft one) uses a small test-only box blur
//! rather than pulling the filter lane's premultiply sandwich into a stats
//! test.

use crate::error::{Error, Result};
use crate::raster::RasterImage;
use crate::raster_colour::bw_luma;

/// Per-channel statistics, with sharp's field names.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ChannelStats {
    pub min: u8,
    pub max: u8,
    pub sum: f64,
    pub squares_sum: f64,
    pub mean: f64,
    /// Sample standard deviation (n - 1), as libvips' `vips_stats` reports
    /// (measured against real sharp 0.34.5 — see the module doc).
    pub stdev: f64,
    pub min_x: u32,
    pub min_y: u32,
    pub max_x: u32,
    pub max_y: u32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct RasterStats {
    pub channels: Vec<ChannelStats>,
    pub is_opaque: bool,
    /// Shannon entropy of the greyscale histogram, in bits.
    pub entropy: f64,
    /// Standard deviation of a Laplacian convolution of the greyscale image.
    pub sharpness: f64,
    /// Centre of the most populated cell of a 16x16x16 RGB histogram.
    pub dominant: [u8; 3],
}

/// The 3x3 Laplacian libvips uses for its sharpness estimate (the classic
/// 4-connected kernel, confirmed against real sharp output — see the
/// module doc), and the `scale` it divides the accumulated sum by
/// (`vips_conv`'s `scale = 9`, no offset).
const LAPLACIAN: [f64; 9] = [0.0, 1.0, 0.0, 1.0, -4.0, 1.0, 0.0, 1.0, 0.0];
const LAPLACIAN_SCALE: f64 = 9.0;

/// Sample standard deviation (`n - 1`) from pre-summed moments, shared by
/// [`channel_stats`] and [`sample_stdev`] so the arithmetic lives in one
/// place. Matches libvips' `vips_stats` convention (measured against real
/// sharp 0.34.5 — see the module doc).
fn stdev_from_moments(sum: f64, squares_sum: f64, n: f64) -> f64 {
    if n > 1.0 {
        ((squares_sum - sum * sum / n) / (n - 1.0)).max(0.0).sqrt()
    } else {
        0.0
    }
}

fn channel_stats(data: &[u8], channels: usize, width: u32, band: usize) -> ChannelStats {
    let seed = (u8::MAX, u8::MIN, 0.0f64, 0.0f64, (0u32, 0u32), (0u32, 0u32));
    let (min, max, sum, squares_sum, min_at, max_at) = data
        .chunks_exact(channels)
        .enumerate()
        .fold(seed, |(lo, hi, sum, squares, lo_at, hi_at), (i, px)| {
            let v = px[band];
            let xy = ((i as u32) % width, (i as u32) / width);
            (
                lo.min(v),
                hi.max(v),
                sum + v as f64,
                squares + (v as f64) * (v as f64),
                if v < lo { xy } else { lo_at },
                if v > hi { xy } else { hi_at },
            )
        });
    let n = (data.len() / channels) as f64;
    let mean = sum / n;
    let stdev = stdev_from_moments(sum, squares_sum, n);
    ChannelStats {
        min,
        max,
        sum,
        squares_sum,
        mean,
        stdev,
        min_x: min_at.0,
        min_y: min_at.1,
        max_x: max_at.0,
        max_y: max_at.1,
    }
}

/// Single-channel greyscale buffer, alpha discarded, one
/// [`crate::raster_colour::bw_luma`] sample per pixel — the crate's one
/// black-and-white reduction, shared with `greyscale()` and `threshold()`.
fn grey_buffer(raster: &RasterImage) -> Vec<u8> {
    let c = raster.channels as usize;
    raster
        .data
        .chunks_exact(c)
        .map(|px| bw_luma([px[0], px[1], px[2]]))
        .collect()
}

/// Clamp-to-edge addressing, matching the convention #3504's `convolve`
/// and `blur` use at the image boundary.
fn clamp_index(i: i64, len: u32) -> usize {
    i.clamp(0, len as i64 - 1) as usize
}

/// 3x3 Laplacian convolution of a single-channel byte buffer: `f64`
/// accumulate, divided by [`LAPLACIAN_SCALE`], no offset, never clamped —
/// matching sharp's own unclamped `vips_conv` (see the module doc). Uses
/// the same clamp-to-edge boundary addressing as the earlier, now-replaced
/// clamped version.
fn laplacian3x3(grey: &[u8], width: u32, height: u32) -> Vec<f64> {
    (0..height)
        .flat_map(|y| {
            (0..width).map(move |x| {
                let acc: f64 = LAPLACIAN
                    .iter()
                    .enumerate()
                    .map(|(k, &kv)| {
                        let (kx, ky) = ((k % 3) as i64, (k / 3) as i64);
                        let sx = clamp_index(x as i64 + kx - 1, width);
                        let sy = clamp_index(y as i64 + ky - 1, height);
                        grey[sy * width as usize + sx] as f64 * kv
                    })
                    .sum();
                acc / LAPLACIAN_SCALE
            })
        })
        .collect()
}

/// Sample standard deviation of a float buffer, via [`stdev_from_moments`]
/// (reused for `sharpness`; `channel_stats` uses the same helper on its own
/// running sums).
fn sample_stdev(values: &[f64]) -> f64 {
    let n = values.len() as f64;
    let sum: f64 = values.iter().sum();
    let squares: f64 = values.iter().map(|v| v * v).sum();
    stdev_from_moments(sum, squares, n)
}

/// Shannon entropy in bits of a 256-bin greyscale histogram.
fn entropy_of(grey: &[u8]) -> f64 {
    let mut histogram = [0usize; 256];
    for &v in grey {
        histogram[v as usize] += 1;
    }
    let n = grey.len() as f64;
    histogram
        .iter()
        .filter(|&&count| count > 0)
        .map(|&count| {
            let p = count as f64 / n;
            -p * p.log2()
        })
        .sum()
}

/// libvips' `hist_find_ndim` bin edge for one byte channel: `v == 0` maps
/// to bin 0, and every other value maps to `(v - 1) / 16` (integer
/// division). Verified against real sharp output: `16 -> bin 0`,
/// `128 -> bin 7` (see the module doc).
fn dominant_bin(v: u8) -> usize {
    if v == 0 {
        0
    } else {
        (v as usize - 1) / 16
    }
}

/// Most populated cell of a 16x16x16 RGB histogram, reported as its centre.
///
/// Ties are broken the way libvips breaks them, which is not by the lowest
/// red bin. sharp builds this histogram with `vips_hist_find_ndim`, whose
/// output is one `bins`×`bins` image with `bins` bands — red across the
/// columns, green down the rows, blue in the bands — then takes
/// `maxpos()`, which scans that image in memory order: rows outermost,
/// then columns, then bands. So the first maximum in scan order is the one
/// with the lowest GREEN bin, then the lowest red, then the lowest blue.
///
/// Measured on sharp 0.34.5 with four hand-built tie fixtures, each a
/// 1-pixel-per-bin image so every cell ties at a count of 1 (#3507 final
/// fix wave, item 10):
///
/// | tied cells (r,g,b) | sharp picks |
/// |---|---|
/// | (1,14,6) and (8,0,7) | (8,0,7) — lowest green |
/// | (3,5,9) and (3,5,2) | (3,5,2) — lowest blue |
/// | (9,7,0) and (2,7,0) | (2,7,0) — lowest red |
/// | (0,3,15), (5,1,1), (15,1,0) | (5,1,1) — lowest green, then red |
///
/// The last one is what separates this ordering from every other: (15,1,0)
/// has the lowest blue and (0,3,15) the lowest red, and neither wins. The
/// earlier claim here — "the FIRST (lowest) maximum bin index, matching
/// libvips' `maxpos()`" — scanned red-major and picked (1,14,6) and
/// (0,3,15) for those two cases, which is what the review measured
/// diverging from sharp on `noise_rgba.png`.
fn dominant_of(raster: &RasterImage) -> [u8; 3] {
    let c = raster.channels as usize;
    let mut bins = vec![0u32; 16 * 16 * 16];
    for px in raster.data.chunks_exact(c) {
        let cell = [0, 1, 2].map(|i| dominant_bin(px[i]));
        bins[(cell[0] << 8) | (cell[1] << 4) | cell[2]] += 1;
    }
    // Green outermost, then red, then blue — libvips' own scan order (see
    // the doc above). A strict `>` only replaces the running best on a new
    // high, so the earliest cell in that order wins a tie.
    let ((red, green, blue), _) = (0..16usize)
        .flat_map(|green| {
            (0..16usize).flat_map(move |red| (0..16usize).map(move |blue| (red, green, blue)))
        })
        .fold(
            ((0, 0, 0), 0u32),
            |(best, best_count), (red, green, blue)| {
                let count = bins[(red << 8) | (green << 4) | blue];
                if count > best_count {
                    ((red, green, blue), count)
                } else {
                    (best, best_count)
                }
            },
        );
    // Cell centre: the low nibble is 8, so shift the bin up and add it.
    [
        (red << 4) as u8 + 8,
        (green << 4) as u8 + 8,
        (blue << 4) as u8 + 8,
    ]
}

pub fn compute_stats(raster: &RasterImage) -> Result<RasterStats> {
    if raster.width == 0 || raster.height == 0 || raster.data.is_empty() {
        return Err(Error::Decode {
            path: "<memory>".into(),
            reason: "cannot compute statistics for a zero-dimension image".into(),
        });
    }
    let channels = (0..raster.channels as usize)
        .map(|band| channel_stats(&raster.data, raster.channels as usize, raster.width, band))
        .collect();
    // Entropy and sharpness discard alpha, so both run on a greyscale
    // reduction of the colour bands only.
    let grey = grey_buffer(raster);
    let laplacian = laplacian3x3(&grey, raster.width, raster.height);
    Ok(RasterStats {
        channels,
        is_opaque: raster.is_opaque(),
        entropy: entropy_of(&grey),
        sharpness: sample_stdev(&laplacian),
        dominant: dominant_of(raster),
    })
}

#[cfg(test)]
#[path = "raster_stats_tests.rs"]
mod tests;
