//! `blur` (#3504) — sharp's two blurs, which are two different libvips
//! operations and not two settings of one.
//!
//! - **`blur()` with no sigma** is a fast 3x3 box: sharp builds an all-ones
//!   3x3 mask with scale 9 and calls `image.conv(mask)`, which is
//!   `vips_conv` at its default FLOAT precision. The whole thing happens in
//!   floating point and only the final cast back to bytes truncates, so
//!   `255/9 = 28.33…` comes out 28 and `960/9 = 106.67` comes out 106 —
//!   never the rounded 29 or 107.
//! - **`blur(sigma)`** is `vips_gaussblur`, which builds a separable integer
//!   Gaussian mask (`vips_gaussmat` with `min_ampl` 0.2, sharp's default)
//!   and runs it through `vips_convsep` at INTEGER precision — two byte
//!   passes, with libvips' own fixed-point arithmetic inside each.
//!
//! Both are in [`crate::raster_filter_conv`], along with the measured
//! evidence for them; this file is just the sigma domain and the dispatch.
//!
//! The size of that Gaussian mask is the part worth knowing about as a
//! caller: libvips truncates the mask at the last tap still at or above 20%
//! of the peak, which for any sigma at or below 0.557 leaves a 1x1 mask.
//! sharp's `blur` accepts sigmas from 0.3, so the whole band 0.3 … 0.557 is
//! an **exact no-op** — measured byte-identical on 32x32 noise against
//! sharp 0.34.5, and reproduced here.
//!
//! Alpha: libvips convolves every band, alpha included, and on a 4-channel
//! image the colour bands are premultiplied for the whole filter run rather
//! than per operation — see [`crate::raster_filter_chain`].

use crate::error::{Error, Result};
use crate::raster::RasterImage;
use crate::raster_filter_chain::{run_filter_chain, FilterOp, Plane};
use crate::raster_filter_conv::{conv_f64, convsep_u8, gaussmat_int};

/// sharp's documented sigma range for `blur`. `sharpen` (`raster_sharpen.rs`)
/// has its own, different sigma domain (sharp's `lib/operation.js`), so this
/// stays private to this file rather than shared.
const MIN_SIGMA: f64 = 0.3;
const MAX_SIGMA: f64 = 1000.0;

/// `vips_gaussblur`'s amplitude cutoff, and sharp's own default for its
/// `blur` option `minAmpl`. `vips_sharpen` uses 0.1 for its mask instead,
/// which is why that constant lives in `raster_sharpen.rs` rather than being
/// shared from here.
pub(crate) const BLUR_MIN_AMPL: f64 = 0.2;

/// One `blur` over a filter run's working buffer. `None` is the float 3x3
/// box; `Some(sigma)` is the integer separable Gaussian, which quantises its
/// input to bytes first because that is the band format `vips_convsep` at
/// INTEGER precision works in.
pub(crate) fn blur_plane(plane: &Plane, sigma: Option<f64>) -> Result<Plane> {
    let Some(sigma) = sigma else {
        return Ok(plane.with_data(conv_f64(
            &plane.data,
            plane.width,
            plane.height,
            plane.channels,
            3,
            3,
            &[1.0; 9],
            9.0,
            0.0,
        )));
    };
    if !(MIN_SIGMA..=MAX_SIGMA).contains(&sigma) {
        return Err(Error::Pipeline(format!(
            "blur sigma {sigma} is outside [{MIN_SIGMA}, {MAX_SIGMA}]"
        )));
    }
    let (mask, scale) = gaussmat_int(sigma, BLUR_MIN_AMPL);
    let blurred = convsep_u8(
        &plane.to_u8(),
        plane.width,
        plane.height,
        plane.channels,
        &mask,
        scale,
    );
    Ok(plane.with_data(blurred.iter().map(|&v| v as f64).collect()))
}

impl RasterImage {
    /// `sigma = None` is sharp's fast 3x3 box blur; `Some(sigma)` is a
    /// Gaussian, and sharp's own domain `[0.3, 1000]` is enforced (a `NaN`
    /// sigma fails every range comparison and is rejected the same way).
    /// Both filter the alpha channel, as libvips does; on a 4-channel image
    /// the colour channels are premultiplied before the filter and
    /// unpremultiplied after (see [`crate::raster_filter_chain`], #3548).
    ///
    /// An out-of-range sigma is a caller-parameter error, not a decode
    /// failure, so it's reported as [`Error::Pipeline`] rather than
    /// [`Error::Decode`] (whose message reads "rawler failed to decode
    /// `<memory>`: …", which would be misleading here). The rest of the
    /// `raster_*` family (`raster_composite`'s layer-size and offset checks
    /// among them) still reports parameter errors as `Error::Decode` for the
    /// same `"<memory>"` placeholder reason — that's a pre-existing
    /// inconsistency this task doesn't fix crate-wide, only in this file.
    pub fn blur(&self, sigma: Option<f64>) -> Result<Self> {
        run_filter_chain(self, &[FilterOp::Blur(sigma)])
    }
}

#[cfg(test)]
#[path = "raster_filter_tests.rs"]
mod tests;
