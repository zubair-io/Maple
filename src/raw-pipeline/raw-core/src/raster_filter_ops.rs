//! Rank/point/arbitrary-kernel filters (#3504): `median`, `threshold`,
//! `convolve`. Split out of `raster_filter.rs` (which keeps `blur`) to stay
//! under the file-size budget.
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
//!   `(8*255 + 1*0) / 9 = 226.67`, truncated).
//! - `threshold` thresholds alpha too, but directly against `value` (a plain
//!   `alpha >= value` comparison, in both `greyscale` modes) rather than
//!   through the luma computation — matching sharp, whose underlying
//!   `>=` comparison runs over every band of the image, alpha included.
//!
//! Premultiplication is not this file's business: it belongs to the filter
//! run as a whole (`raster_filter_chain.rs`), the way sharp does it.
//!
//! **`convolve` is a float convolution, always.** sharp's `Convolve` is a
//! bare `image.conv(kernel)` (`operations.cc`), and `vips_conv` defaults to
//! FLOAT precision, whose output image is float — so nothing is rounded or
//! clamped inside the operation and the only quantisation is the chain's
//! single truncating cast at the end. That is why an integer box kernel
//! comes out truncated and not rounded: on sharp 0.34.5, a 3x3 box (`[1;9]`,
//! scale 9) over the 16x4 60/200 step-edge fixture (`step_edge` in
//! `raster_filter_ops_tests.rs`) gives 106 at x=7 — window sum 960,
//! `960/9 = 106.67`, truncated, not rounded to 107 — and a non-integer
//! kernel behaves the same way rather than switching to a rounding path.

use crate::error::{Error, Result};
use crate::raster::RasterImage;
use crate::raster_filter_chain::{run_filter_chain, FilterOp, Plane};
use crate::raster_filter_conv::{clamp_index, conv_f64};
use crate::view::encode::{srgb_degamma, srgb_gamma};

/// Rec.709 luma weights ([ITU-R BT.709] luminance coefficients: `Y' =
/// 0.2126 R' + 0.7152 G' + 0.0722 B'`), used by [`bw_luma`]. `raster_colour`
/// (the module the task brief names as the source of this constant) is not
/// present on this branch, mirroring `raster_sharpen.rs`'s own note about
/// `raster_lab.rs` (plan lane D1) — so it's defined locally here rather than
/// blocking on that lane.
pub(crate) const REC709_LUMA: [f64; 3] = [0.2126, 0.7152, 0.0722];

/// Largest median window `size` this crate accepts — sharp validates
/// `size` as an integer in `[1, 1000]` (`lib/operation.js`'s own
/// `is.inRange(size, 1, 1000)`), so this crate's ceiling is sharp's, not an
/// invented one.
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

/// One `median` over a filter run's working buffer.
///
/// **Even-size windowing.** For an odd `size` the window is symmetric:
/// `(size - 1) / 2` taps on each side of the centre pixel. For an even
/// `size` there is no exact centre, and libvips puts the extra tap on the
/// low side — measured against sharp 0.34.5 with a single-column spike
/// probe (a lone bright pixel in an otherwise flat field): with `size: 2`,
/// the spike shows up in the output at its own column AND the column to its
/// right, never the column to its left, meaning the window at pixel `x`
/// spans `[x-1, x]`, not `[x, x+1]`. That generalises to
/// `before = size / 2` taps on the low side and `after = size - 1 - before`
/// on the high side, which collapses to the symmetric `(size - 1) / 2` on
/// both sides whenever `size` is odd.
pub(crate) fn median_plane(plane: &Plane, size: u32) -> Result<Plane> {
    if size == 0 || size > MAX_MEDIAN_SIZE {
        return Err(Error::Pipeline(format!(
            "median window {size} must be an integer in [1, {MAX_MEDIAN_SIZE}]"
        )));
    }
    // `vips_rank` refuses a window wider or taller than the image
    // ("rank: window too large", `morphology/rank.c`), so sharp does too —
    // measured on sharp 0.34.5, `median(5)` on a 4x4 and `median(9)` on an
    // 8x8 both throw while `median(8)` on the 8x8 succeeds. Clamp-to-edge
    // addressing would happily have produced a result here, which is
    // exactly why this needs its own check.
    if size as usize > plane.width || size as usize > plane.height {
        return Err(Error::Pipeline(format!(
            "median window {size} is too large for a {}x{} image (libvips' vips_rank: \"window too large\")",
            plane.width, plane.height
        )));
    }
    let before = (size / 2) as i64;
    let after = size as i64 - 1 - before;
    let (w, h, c) = (plane.width, plane.height, plane.channels);
    let data = (0..h)
        .flat_map(|y| {
            (0..w).flat_map(move |x| {
                (0..c).map(move |band| {
                    let mut window: Vec<f64> = (-before..=after)
                        .flat_map(|dy| {
                            (-before..=after).map(move |dx| {
                                let sy = clamp_index(y as i64 + dy, h);
                                let sx = clamp_index(x as i64 + dx, w);
                                plane.data[(sy * w + sx) * c + band]
                            })
                        })
                        .collect();
                    window.sort_by(|a, b| a.total_cmp(b));
                    window[window.len() / 2]
                })
            })
        })
        .collect();
    Ok(plane.with_data(data))
}

/// One `threshold` over a filter run's working buffer. The comparison runs
/// on bytes (sharp thresholds a `uchar` image), so the working buffer is
/// quantised first; the result is exact 0/255 either way.
///
/// **`value == 0` is a no-op, not "whiten everything".** sharp gates the
/// whole stage on `baton->threshold != 0` (`pipeline.cc`), and its JS layer
/// resolves `threshold(false)` to that same 0 — so `threshold(0)` returns
/// the image untouched even though `pixel >= 0` is true everywhere.
/// Measured on sharp 0.34.5: byte-identical to the source, where a literal
/// comparison gives max diff 255 on 3060 of 3072 samples of a noise
/// fixture.
pub(crate) fn threshold_plane(plane: &Plane, value: u8, greyscale: bool) -> Plane {
    if value == 0 {
        return plane.clone();
    }
    let c = plane.channels;
    let on = |v: u8| if v >= value { 255.0 } else { 0.0 };
    let data = plane
        .to_u8()
        .chunks_exact(c)
        .flat_map(|px| {
            let colour: [f64; 3] = if greyscale {
                let luma = on(bw_luma([px[0], px[1], px[2]]));
                [luma, luma, luma]
            } else {
                [0, 1, 2].map(|i| on(px[i]))
            };
            colour.into_iter().chain(px.get(3).map(|&a| on(a)))
        })
        .collect();
    plane.with_data(data)
}

/// One `convolve` over a filter run's working buffer. See the module doc for
/// why there is only a float path.
///
/// `scale == 0.0` means "the caller omitted `scale`", so the kernel's own
/// sum is used (`1.0` for a zero-sum kernel such as a Sobel operator).
/// Whichever way the divisor is resolved, sharp then clips it up to a
/// minimum of 1: `lib/operation.js` computes
/// `scale = <explicit> || <kernel sum>` and *then* applies
/// `scale < 1 ? 1 : scale`, so a kernel that sums to a negative number is
/// divided by 1, not by its own negative sum. Measured on sharp 0.34.5: a
/// 3x3 kernel of all `-1` with no `scale` turns RGB noise entirely black,
/// where dividing by −9 would have handed back roughly the source.
pub(crate) fn convolve_plane(
    plane: &Plane,
    width: u32,
    height: u32,
    kernel: &[f64],
    scale: f64,
    offset: f64,
) -> Result<Plane> {
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
    let resolved = if scale != 0.0 {
        scale
    } else if sum != 0.0 {
        sum
    } else {
        1.0
    };
    let divisor = resolved.max(1.0);
    Ok(plane.with_data(conv_f64(
        &plane.data,
        plane.width,
        plane.height,
        plane.channels,
        width as usize,
        height as usize,
        kernel,
        divisor,
        offset,
    )))
}

impl RasterImage {
    /// Square median (rank) filter: window `size` x `size`, any integer in
    /// `[1, 1000]` — sharp/`vips_rank` accepts even windows too (#3504 task
    /// E5 controller ruling (c); the odd-only rule this crate enforced
    /// through task E4 was never sharp's own rule, just an unexamined
    /// assumption). Every band, alpha included — see the module doc.
    /// Clamp-to-edge addressing at the image boundary, matching `blur`.
    pub fn median(&self, size: u32) -> Result<Self> {
        run_filter_chain(self, &[FilterOp::Median(size)])
    }

    /// Binarise at `value` (sharp's default is 128). With `greyscale` (the
    /// default in sharp's own JS API) the colour decision is made once on
    /// [`bw_luma`] and the same 0/255 result is written to all three colour
    /// channels; without it, each colour channel is thresholded
    /// independently. Alpha is thresholded too either way, via a direct
    /// `alpha >= value` comparison — see the module doc.
    pub fn threshold(&self, value: u8, greyscale: bool) -> Result<Self> {
        run_filter_chain(self, &[FilterOp::Threshold { value, greyscale }])
    }

    /// Arbitrary `width` x `height` convolution:
    /// `out = sum(kernel * neighbourhood) / divisor + offset`, in floating
    /// point with no intermediate clamp, cast to bytes (clipped and
    /// truncated) at the end of the filter run. `width` and `height` must
    /// each be in `[3, 1001]` (sharp's own kernel-size contract; even sizes
    /// are accepted). See [`convolve_plane`] for how the divisor is resolved
    /// and clipped.
    pub fn convolve(
        &self,
        width: u32,
        height: u32,
        kernel: &[f64],
        scale: f64,
        offset: f64,
    ) -> Result<Self> {
        run_filter_chain(
            self,
            &[FilterOp::Convolve {
                width,
                height,
                kernel,
                scale,
                offset,
            }],
        )
    }
}

#[cfg(test)]
#[path = "raster_filter_ops_tests.rs"]
mod tests;
