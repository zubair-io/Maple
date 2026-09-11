//! Rank/point/arbitrary-kernel filters (#3504 task E3): `median`,
//! `threshold`, `convolve`. Split out of `raster_filter.rs` (which keeps
//! `blur`) to stay under the file-size budget — see that file's module doc
//! for the family-wide alpha/clamp-to-edge conventions this file inherits.
//!
//! **Alpha, per operation** (each has different real libvips/sharp
//! behaviour, so there is no one shared rule here):
//! - `median` ranks every band, alpha included — a median has no special
//!   alpha handling in libvips (`vips_rank`), and the lone-transparent-pixel
//!   test below depends on alpha being ranked alongside colour to erase it.
//! - `convolve` is colour-only (alpha passes through unfiltered), matching
//!   `colour_only: true` elsewhere in this file family — a caller convolving
//!   with an edge detector does not want alpha convolved into noise.
//! - `threshold` never touches alpha at all, in either mode.
//!
//! **Integer vs float convolution.** libvips picks between `vips_convi`
//! (integer coefficients, truncating division) and `vips_convf` (float
//! coefficients, rounding) based on whether the mask is integer-valued.
//! `convolve` mirrors that: when every kernel entry, the resolved divisor,
//! and the offset are all whole numbers, the accumulation runs in `i64` and
//! divides with Rust's `/` (truncates toward zero, same as `fast_sharpen`'s
//! integer path in `raster_sharpen.rs`); otherwise it accumulates in `f64`
//! and rounds. This is a measured distinction, not a guess: on sharp 0.34.5,
//! a 3x3 box kernel (`[1;9]`, scale 9) run over the 16x4 60/200 step-edge
//! fixture (`step_edge` in `raster_filter_ops_tests.rs`) gives row value 106
//! at x=7 (window sum 960, `960/9 = 106.67`, which *rounds* to 107 but
//! *truncates* to 106 — sharp's actual output is 106).

use crate::error::{Error, Result};
use crate::raster::RasterImage;
use crate::raster_filter::clamp_index;

/// Rec.709 luma weights ([ITU-R BT.709] luminance coefficients: `Y' =
/// 0.2126 R' + 0.7152 G' + 0.0722 B'`), used by `threshold`'s greyscale mode.
/// `raster_colour` (the module the task brief names as the source of this
/// constant) is not present on this branch, mirroring `raster_sharpen.rs`'s
/// own note about `raster_lab.rs` (plan lane D1) — so it's defined locally
/// here rather than blocking on that lane. `255 * 0.2126 = 54.2` (pure red)
/// and `255 * 0.7152 = 182.4` (pure green) are the two values pinned in
/// `threshold_binarises_through_greyscale_by_default` below.
pub(crate) const REC709_LUMA: [f64; 3] = [0.2126, 0.7152, 0.0722];

/// Largest median window `size` this crate accepts — sharp validates
/// `size` as an integer >= 1 with no documented ceiling, but an unbounded
/// window is an O(size²) rank-sort per pixel; 1000 is a generous, explicit
/// cap rather than an unbounded one (values named in the error either way).
const MAX_MEDIAN_SIZE: u32 = 1000;

impl RasterImage {
    /// Square median (rank) filter: window `size` x `size`, `size` odd and
    /// in `[1, 1000]`. Every band, alpha included — see the module doc.
    /// Clamp-to-edge addressing at the image boundary, matching `blur`.
    pub fn median(&self, size: u32) -> Result<Self> {
        if size == 0 || size % 2 == 0 || size > MAX_MEDIAN_SIZE {
            return Err(Error::Pipeline(format!(
                "median window {size} must be an odd integer in [1, {MAX_MEDIAN_SIZE}]"
            )));
        }
        let radius = (size / 2) as i64;
        let c = self.channels as usize;
        let (w, h) = (self.width as usize, self.height as usize);
        let data = (0..h)
            .flat_map(|y| {
                (0..w).flat_map(move |x| {
                    (0..c).map(move |band| {
                        let mut window: Vec<u8> = (-radius..=radius)
                            .flat_map(|dy| {
                                (-radius..=radius).map(move |dx| {
                                    let sy = clamp_index(y as i64 + dy, h);
                                    let sx = clamp_index(x as i64 + dx, w);
                                    self.data[(sy * w + sx) * c + band]
                                })
                            })
                            .collect();
                        window.sort_unstable();
                        window[window.len() / 2]
                    })
                })
            })
            .collect();
        Ok(Self {
            data,
            ..self.clone()
        })
    }

    /// Binarise at `value` (sharp's default is 128). With `greyscale` (the
    /// default in sharp's own JS API) the decision is made once on the
    /// Rec.709 luma and the same 0/255 result is written to all three
    /// colour channels; without it, each colour channel is thresholded
    /// independently. Alpha is always left untouched.
    pub fn threshold(&self, value: u8, greyscale: bool) -> Self {
        let c = self.channels as usize;
        let data = self
            .data
            .chunks_exact(c)
            .flat_map(|px| {
                let colour: [u8; 3] = if greyscale {
                    let luma: f64 = (0..3).map(|i| px[i] as f64 * REC709_LUMA[i]).sum();
                    let on = if luma.round() >= value as f64 { 255 } else { 0 };
                    [on, on, on]
                } else {
                    [0, 1, 2].map(|i| if px[i] >= value { 255 } else { 0 })
                };
                colour.into_iter().chain(px.get(3).copied())
            })
            .collect();
        Self {
            data,
            ..self.clone()
        }
    }

    /// Arbitrary `width` x `height` convolution: `out = round_or_truncate(sum(kernel
    /// * neighbourhood) / divisor) + offset`, clamped to `[0, 255]`.
    /// `scale == 0.0` means "use the kernel's own sum" (sharp's documented
    /// default), falling back to `1.0` for a zero-sum kernel such as a
    /// Sobel operator. Colour bands only — alpha passes through unchanged
    /// (see the module doc). Clamp-to-edge addressing at the boundary.
    ///
    /// See the module doc for the integer-vs-float path this picks between.
    pub fn convolve(
        &self,
        width: u32,
        height: u32,
        kernel: &[f64],
        scale: f64,
        offset: f64,
    ) -> Result<Self> {
        let expected = width as usize * height as usize;
        if width == 0 || height == 0 || kernel.len() != expected {
            return Err(Error::Pipeline(format!(
                "convolve kernel has {} values, expected {expected} for {width}x{height}",
                kernel.len()
            )));
        }
        if let Some((i, v)) = kernel.iter().enumerate().find(|(_, v)| v.is_nan()) {
            return Err(Error::Pipeline(format!(
                "convolve kernel value at index {i} is {v} (NaN)"
            )));
        }
        let sum: f64 = kernel.iter().sum();
        let divisor = if scale != 0.0 {
            scale
        } else if sum != 0.0 {
            sum
        } else {
            1.0
        };
        let is_whole = |v: f64| v.fract() == 0.0;
        let integer_path =
            kernel.iter().all(|v| is_whole(*v)) && is_whole(divisor) && is_whole(offset);

        let (rx, ry) = ((width / 2) as i64, (height / 2) as i64);
        let c = self.channels as usize;
        let bands = c.min(3);
        let (w, h) = (self.width as usize, self.height as usize);
        let int_kernel: Vec<i64> = kernel.iter().map(|v| *v as i64).collect();
        let int_kernel: &[i64] = &int_kernel;
        let (int_divisor, int_offset) = (divisor as i64, offset as i64);
        let data = (0..h)
            .flat_map(|y| {
                (0..w).flat_map(move |x| {
                    (0..c).map(move |band| {
                        let here = self.data[(y * w + x) * c + band];
                        if band >= bands {
                            return here;
                        }
                        let taps = (0..height as i64).flat_map(|ky| {
                            (0..width as i64).map(move |kx| {
                                let sy = clamp_index(y as i64 + ky - ry, h);
                                let sx = clamp_index(x as i64 + kx - rx, w);
                                let k = (ky * width as i64 + kx) as usize;
                                (self.data[(sy * w + sx) * c + band], k)
                            })
                        });
                        if integer_path {
                            let acc: i64 = taps.map(|(p, k)| p as i64 * int_kernel[k]).sum::<i64>()
                                / int_divisor
                                + int_offset;
                            acc.clamp(0, 255) as u8
                        } else {
                            let acc: f64 = taps.map(|(p, k)| p as f64 * kernel[k]).sum();
                            (acc / divisor + offset).round().clamp(0.0, 255.0) as u8
                        }
                    })
                })
            })
            .collect();
        Ok(Self {
            data,
            ..self.clone()
        })
    }
}

#[cfg(test)]
#[path = "raster_filter_ops_tests.rs"]
mod tests;
