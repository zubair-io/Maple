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
//! - `convolve` filters every band, alpha included — libvips' `vips_conv`
//!   has no band exclusion either; a lone-transparent-pixel "hole" in an
//!   otherwise-opaque alpha channel spreads under a 3x3 box exactly like any
//!   other band (measured against sharp 0.34.5: a single 0 surrounded by
//!   255 comes out 226 at every cell the box's 3x3 support touches —
//!   `(8*255 + 1*0) / 9 = 226.67`, truncated). On a 4-channel raster the
//!   colour bands are premultiplied by alpha before convolving and
//!   unpremultiplied afterwards (reusing `raster_filter`'s `premultiply`/
//!   `unpremultiply`, the same treatment `blur` uses), so a fully
//!   transparent neighbour's stored colour can't bleed into a partly opaque
//!   pixel's result — the alpha band itself is still convolved directly, not
//!   premultiplied against itself (controller ruling on the E3 re-review,
//!   #3504 task E4). `median` is a rank filter and libvips' `vips_rank` does
//!   not premultiply, so it is untouched by this.
//! - `threshold` thresholds alpha too, but directly against `value` (a plain
//!   `alpha >= value` comparison, in both `greyscale` modes) rather than
//!   through the luma computation — matching sharp, whose underlying
//!   `>=` comparison runs over every band of the image, alpha included.
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
use crate::raster_filter::{clamp_index, premultiply, unpremultiply};
use crate::view::encode::{srgb_degamma, srgb_gamma};

/// Rec.709 luma weights ([ITU-R BT.709] luminance coefficients: `Y' =
/// 0.2126 R' + 0.7152 G' + 0.0722 B'`), used by [`bw_luma`]. `raster_colour`
/// (the module the task brief names as the source of this constant) is not
/// present on this branch, mirroring `raster_sharpen.rs`'s own note about
/// `raster_lab.rs` (plan lane D1) — so it's defined locally here rather than
/// blocking on that lane.
pub(crate) const REC709_LUMA: [f64; 3] = [0.2126, 0.7152, 0.0722];

/// Largest median window `size` this crate accepts — sharp validates
/// `size` as an integer >= 1 with no documented ceiling, but an unbounded
/// window is an O(size²) rank-sort per pixel; 1000 is a generous, explicit
/// cap rather than an unbounded one (values named in the error either way).
const MAX_MEDIAN_SIZE: u32 = 1000;

/// sharp's documented `convolve` kernel dimension contract: both `width` and
/// `height` must be integers in `[3, 1001]` — even sizes are accepted (a
/// 4x4 kernel is a valid, real sharp input), only the floor and ceiling are
/// enforced.
const MIN_KERNEL_DIM: u32 = 3;
const MAX_KERNEL_DIM: u32 = 1001;

/// sharp's `threshold({greyscale: true})` (the default) does not take a
/// weighted sum of the gamma-encoded 8-bit channels — it runs libvips'
/// standard `toColourspace('b-w')` conversion: decode each channel from the
/// sRGB transfer curve to linear light, take the Rec.709-weighted linear
/// luminance, then re-encode with the sRGB OETF and round to a byte.
/// Measured against sharp 0.34.5: pure red -> 127, pure green -> 220,
/// `(100, 200, 50)` -> 178 (a naive weighted sum of the encoded bytes would
/// give 54 / 182 / 168 instead — visibly wrong for red and green, and close
/// enough elsewhere to hide the bug, which is why it needs pinning here
/// rather than only through `threshold`'s black/white outcomes).
pub(crate) fn bw_luma(rgb: [u8; 3]) -> u8 {
    let linear = rgb.map(|v| srgb_degamma(v as f32 / 255.0));
    let luma_linear: f32 = (0..3).map(|i| linear[i] * REC709_LUMA[i] as f32).sum();
    (srgb_gamma(luma_linear) as f64 * 255.0)
        .round()
        .clamp(0.0, 255.0) as u8
}

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
    /// default in sharp's own JS API) the colour decision is made once on
    /// [`bw_luma`] and the same 0/255 result is written to all three colour
    /// channels; without it, each colour channel is thresholded
    /// independently. Alpha is thresholded too either way, via a direct
    /// `alpha >= value` comparison — see the module doc.
    pub fn threshold(&self, value: u8, greyscale: bool) -> Self {
        let c = self.channels as usize;
        let on = |v: u8| if v >= value { 255 } else { 0 };
        let data = self
            .data
            .chunks_exact(c)
            .flat_map(|px| {
                let colour: [u8; 3] = if greyscale {
                    let luma = on(bw_luma([px[0], px[1], px[2]]));
                    [luma, luma, luma]
                } else {
                    [0, 1, 2].map(|i| on(px[i]))
                };
                colour.into_iter().chain(px.get(3).map(|&a| on(a)))
            })
            .collect();
        Self {
            data,
            ..self.clone()
        }
    }

    /// Arbitrary `width` x `height` convolution: `out = round_or_truncate(sum(kernel
    /// * neighbourhood) / divisor) + offset`, clamped to `[0, 255]`. `width`
    /// and `height` must each be in `[3, 1001]` (sharp's own kernel-size
    /// contract; even sizes are accepted). `scale == 0.0` means "use the
    /// kernel's own sum" (sharp's documented default), falling back to
    /// `1.0` for a zero-sum kernel such as a Sobel operator. Every band is
    /// filtered, alpha included (see the module doc). Clamp-to-edge
    /// addressing at the boundary. On a 4-channel raster, colour is
    /// premultiplied by alpha before convolving and unpremultiplied
    /// afterwards (see the module doc); a 3-channel raster is unaffected,
    /// since [`premultiply`]/[`unpremultiply`] are no-ops without an alpha
    /// band.
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
        if !(MIN_KERNEL_DIM..=MAX_KERNEL_DIM).contains(&width)
            || !(MIN_KERNEL_DIM..=MAX_KERNEL_DIM).contains(&height)
        {
            return Err(Error::Pipeline(format!(
                "convolve kernel is {width}x{height}; both dimensions must be in [{MIN_KERNEL_DIM}, {MAX_KERNEL_DIM}]"
            )));
        }
        let expected = width as usize * height as usize;
        if kernel.len() != expected {
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
        let (w, h) = (self.width as usize, self.height as usize);
        let int_kernel: Vec<i64> = kernel.iter().map(|v| *v as i64).collect();
        let int_kernel: &[i64] = &int_kernel;
        let (int_divisor, int_offset) = (divisor as i64, offset as i64);
        let premultiplied = premultiply(self);
        let source: &RasterImage = &premultiplied;
        let data = (0..h)
            .flat_map(|y| {
                (0..w).flat_map(move |x| {
                    (0..c).map(move |band| {
                        let taps = (0..height as i64).flat_map(|ky| {
                            (0..width as i64).map(move |kx| {
                                let sy = clamp_index(y as i64 + ky - ry, h);
                                let sx = clamp_index(x as i64 + kx - rx, w);
                                let k = (ky * width as i64 + kx) as usize;
                                (source.data[(sy * w + sx) * c + band], k)
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
        let convolved = Self {
            data,
            ..self.clone()
        };
        Ok(unpremultiply(&convolved))
    }
}

#[cfg(test)]
#[path = "raster_filter_ops_tests.rs"]
mod tests;
