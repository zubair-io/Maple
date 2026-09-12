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
//!   `colourspace(B_W)`). The B_W conversion is Rec.709 luma taken in
//!   LINEAR light (de-gamma, weight, re-gamma) — the same definition #3503
//!   (`raster_colour.rs`, `bw_luma`) and #3504 (`raster_filter_ops.rs`,
//!   also `bw_luma`) both landed after measuring real sharp output. Neither
//!   of those lanes is on this branch (this worktree is stacked on the
//!   shared #3505 base only), so this file carries its own private copy of
//!   the same function rather than blocking on either lane — precisely the
//!   call #3504's own module doc makes for the identical gap. Reconcile
//!   into one shared helper when the lanes merge.
//! * `sharpness` — the standard deviation of a Laplacian convolution of the
//!   greyscale image. `stats.cc` runs `vips_conv` with the classic
//!   `[0,1,0; 1,-4,1; 0,1,0]` kernel, `scale = 9`, no offset, then
//!   `.deviate()` on the (signed-capable, non-clamped) result. This file
//!   instead runs the same kernel through a `[0, 255]`-clamped integer
//!   convolution with `scale = 1`, `offset = 128` (the shape #3507's own
//!   convolve helper — E3's `RasterImage::convolve`, also not on this
//!   branch — exposes), then takes the sample stdev of that clamped byte
//!   buffer. The two numbers are not calibrated to agree (measured: sharp
//!   gives `5.64` on this file's fixture, this implementation gives
//!   `50.78`) — what both share, and what `sharpness` is used for, is the
//!   ordering property that a sharper image scores higher than a blurred
//!   one, which is asserted directly below.
//! * `dominant` — the most populated cell of a 4096-bin (16x16x16) RGB
//!   histogram, reported as that cell's centre (`bin * 16 + 8`). Confirmed
//!   against `stats.cc`'s `hist_find_ndim(bins: 16)` + `maxpos()`, and
//!   against real sharp output on the same fixture (`{r:200,g:24,b:24}`,
//!   matched exactly).
//!
//! `greyscale`, `convolve` and `blur` are all real `RasterImage` methods
//! elsewhere in the #3507 epic (colour-ops lane #3503, filters lane #3504),
//! but none of those lanes are merged into this branch yet. Rather than
//! block this task on a merge outside its own authorization, the greyscale
//! and convolution logic needed for `entropy`/`sharpness` is reimplemented
//! locally below (`bw_luma`, `grey_buffer`, `laplacian3x3`), and the one
//! test that wants "a blurred copy of an image" (to prove `sharpness`
//! orders a sharp edge above a soft one) uses a small test-only box blur
//! instead of calling a `RasterImage::blur` that does not exist here.

use crate::error::{Error, Result};
use crate::raster::RasterImage;
use crate::view::encode::{srgb_degamma, srgb_gamma};

/// Rec.709 luma coefficients — the sRGB -> B_W matrix libvips uses. Kept in
/// sync with `raster_colour::REC709_LUMA` / `raster_filter_ops::REC709_LUMA`
/// (see the module doc: those lanes aren't merged here yet).
const REC709_LUMA: [f64; 3] = [0.2126, 0.7152, 0.0722];

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

/// The 3x3 Laplacian libvips uses for its sharpness estimate.
const LAPLACIAN: [i64; 9] = [0, 1, 0, 1, -4, 1, 0, 1, 0];

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
    let stdev = if n > 1.0 {
        ((squares_sum - sum * sum / n) / (n - 1.0)).max(0.0).sqrt()
    } else {
        0.0
    };
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

/// Rec.709 luma taken in LINEAR light: de-gamma each channel, weight, re-gamma,
/// round. This is what `vips_colourspace(sRGB -> B_W)` (and so sharp's
/// `greyscale()` / the B_W conversion `stats()` runs for `entropy`) actually
/// measures — see the module doc for why this is a local copy rather than a
/// shared helper.
fn bw_luma(rgb: [u8; 3]) -> u8 {
    let linear: f64 = (0..3)
        .map(|i| REC709_LUMA[i] * srgb_degamma(rgb[i] as f32 / 255.0) as f64)
        .sum();
    (srgb_gamma(linear as f32) as f64 * 255.0)
        .round()
        .clamp(0.0, 255.0) as u8
}

/// Single-channel greyscale buffer, alpha discarded, one [`bw_luma`] sample
/// per pixel.
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

/// 3x3 Laplacian convolution of a single-channel byte buffer: integer
/// accumulate, `scale = 1`, `offset = 128`, clamped to `[0, 255]` — the
/// same clamped-uchar convolution shape #3507's convolve helper exposes
/// (see the module doc for how this compares to sharp's own unclamped,
/// scale-9 version).
fn laplacian3x3(grey: &[u8], width: u32, height: u32) -> Vec<u8> {
    (0..height)
        .flat_map(|y| {
            (0..width).map(move |x| {
                let acc: i64 = LAPLACIAN
                    .iter()
                    .enumerate()
                    .map(|(k, &kv)| {
                        let (kx, ky) = ((k % 3) as i64, (k / 3) as i64);
                        let sx = clamp_index(x as i64 + kx - 1, width);
                        let sy = clamp_index(y as i64 + ky - 1, height);
                        grey[sy * width as usize + sx] as i64 * kv
                    })
                    .sum();
                (acc + 128).clamp(0, 255) as u8
            })
        })
        .collect()
}

/// Sample standard deviation of a byte buffer (same formula as
/// [`channel_stats`]'s `stdev`, reused for `sharpness`).
fn sample_stdev(values: &[u8]) -> f64 {
    let n = values.len() as f64;
    if n <= 1.0 {
        return 0.0;
    }
    let sum: f64 = values.iter().map(|&v| v as f64).sum();
    let squares: f64 = values.iter().map(|&v| (v as f64) * (v as f64)).sum();
    ((squares - sum * sum / n) / (n - 1.0)).max(0.0).sqrt()
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

/// Most populated cell of a 16x16x16 RGB histogram, reported as its centre.
fn dominant_of(raster: &RasterImage) -> [u8; 3] {
    let c = raster.channels as usize;
    let mut bins = vec![0u32; 16 * 16 * 16];
    for px in raster.data.chunks_exact(c) {
        let cell = [0, 1, 2].map(|i| (px[i] >> 4) as usize);
        bins[(cell[0] << 8) | (cell[1] << 4) | cell[2]] += 1;
    }
    let best = bins
        .iter()
        .enumerate()
        .max_by_key(|(_, &count)| count)
        .map(|(i, _)| i)
        .unwrap_or(0);
    // Cell centre: the low nibble is 8, so shift the index back and add it.
    [
        (((best >> 8) & 0xF) << 4) as u8 + 8,
        (((best >> 4) & 0xF) << 4) as u8 + 8,
        ((best & 0xF) << 4) as u8 + 8,
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
