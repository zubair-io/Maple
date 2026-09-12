//! The one place a run of filter operations is premultiplied, executed and
//! unpremultiplied (#3504 PR-E final fix wave).
//!
//! sharp does not premultiply per operation. `pipeline.cc` decides **once**
//! whether the whole job needs it —
//! `shouldPremultiplyAlpha = has_alpha && (shouldResize || shouldBlur ||
//! shouldConv || shouldSharpen)` — premultiplies there, runs median,
//! threshold, blur, convolve and sharpen in that fixed order without
//! re-quantising, and unpremultiplies once afterwards. Maple keeps the
//! caller's own order (see the package README's op-order note), but it
//! follows sharp on the sandwich: one premultiply, one unpremultiply, one
//! cast back to bytes for a whole run of consecutive filter ops.
//!
//! The model, measured against sharp 0.34.5 and matching libvips 8.17.3's
//! source exactly:
//!
//! 1. `vips_premultiply` scales colour by `alpha/255` and leaves alpha
//!    alone, in float; sharp then casts straight back to the input format
//!    (`image.premultiply().cast(premultiplyFormat)`), and libvips' cast to
//!    `uchar` **clips then truncates** (`cast.c`: "now does floor(), not
//!    rint()"). So the run starts from premultiplied *bytes*.
//! 2. Every filter then runs in `f64` with no intermediate clamp. libvips'
//!    float convolutions write float images, so an over- or undershoot is
//!    not clipped away between operations.
//! 3. `vips_unpremultiply` divides colour by `alpha/255` — deliberately
//!    using the *unclipped* alpha, so its comment goes, "we want over and
//!    undershoots on alpha and RGB to cancel" — treating an alpha whose
//!    magnitude is under 0.01 as zero, and clips only the alpha band.
//! 4. One clipping, truncating cast to `u8` at the end.
//!
//! Step 3's use of the unclipped alpha is what makes sharp's output for a
//! transparent pixel beside an opaque one reproducible at all: on an 8x4
//! half-opaque `(200,10,10,255)` / half-transparent `(0,250,0,0)` fixture,
//! `sharpen()` drives the alpha accumulator to −31.875 and the red
//! accumulator to −25.0, and `255/−31.875 · −25.0` is exactly the 200 sharp
//! writes there. Clamping either accumulator at 0 first — which is what a
//! per-operation `u8` sandwich does — gives 0 instead, and that single
//! difference was worth a max diff of 255 before this wave.
//!
//! `median` and `threshold` do not themselves need premultiplied input, but
//! they land *inside* the sandwich whenever the same run also has a blur,
//! convolve or sharpen — exactly as they do in sharp — so they are part of
//! the run rather than special-cased out of it.

use crate::error::Result;
use crate::raster::RasterImage;
use crate::raster_sharpen::SharpenOptions;

/// A filter run's working buffer: interleaved samples in `f64`, still on the
/// 0..255 scale, with no clamping applied.
#[derive(Clone, Debug)]
pub(crate) struct Plane {
    pub width: usize,
    pub height: usize,
    pub channels: usize,
    pub data: Vec<f64>,
}

impl Plane {
    /// libvips' cast to `uchar`: clip into range, then truncate (never
    /// round) — see the module doc.
    pub(crate) fn to_u8(&self) -> Vec<u8> {
        self.data
            .iter()
            .map(|&v| v.clamp(0.0, 255.0) as u8)
            .collect()
    }

    /// This plane's samples quantised to bytes and back, which is what a
    /// libvips operation that keeps its input's `uchar` band format does to
    /// whatever reaches it.
    pub(crate) fn quantised(&self) -> Self {
        self.with_data(self.to_u8().iter().map(|&v| v as f64).collect())
    }

    /// Same geometry, new samples.
    pub(crate) fn with_data(&self, data: Vec<f64>) -> Self {
        Self {
            width: self.width,
            height: self.height,
            channels: self.channels,
            data,
        }
    }
}

/// One filter operation, resolved from either a recipe op or a direct
/// `RasterImage` method call. `Convolve` borrows its kernel so a recipe op's
/// `Vec<f64>` needs no copy.
#[derive(Clone, Copy, Debug)]
pub enum FilterOp<'a> {
    Blur(Option<f64>),
    Sharpen(SharpenOptions),
    Median(u32),
    Threshold {
        value: u8,
        greyscale: bool,
    },
    Convolve {
        width: u32,
        height: u32,
        kernel: &'a [f64],
        /// `0.0` means "use the kernel's own sum"; see
        /// `RasterImage::convolve`.
        scale: f64,
        offset: f64,
    },
}

impl FilterOp<'_> {
    /// Whether this operation is one of the three sharp premultiplies for
    /// (`shouldBlur || shouldConv || shouldSharpen`). `median` and
    /// `threshold` do not trigger the sandwich on their own.
    fn triggers_premultiply(&self) -> bool {
        matches!(
            self,
            FilterOp::Blur(_) | FilterOp::Sharpen(_) | FilterOp::Convolve { .. }
        )
    }
}

/// `vips_premultiply`: colour scaled by the clipped alpha, alpha itself
/// passed through unchanged.
fn premultiply(plane: &Plane) -> Plane {
    let data = plane
        .data
        .chunks_exact(4)
        .flat_map(|px| {
            let nalpha = px[3].clamp(0.0, 255.0) / 255.0;
            [px[0] * nalpha, px[1] * nalpha, px[2] * nalpha, px[3]]
        })
        .collect();
    plane.with_data(data)
}

/// `vips_unpremultiply`: colour divided by the *unclipped* alpha (so
/// over- and undershoots cancel), alpha clipped into range. An alpha whose
/// magnitude is below 0.01 zeroes the colour rather than dividing, which is
/// libvips' own float-image guard against producing infinities.
fn unpremultiply(plane: &Plane) -> Plane {
    let data = plane
        .data
        .chunks_exact(4)
        .flat_map(|px| {
            let factor = if px[3].abs() < 0.01 {
                0.0
            } else {
                255.0 / px[3]
            };
            [
                px[0] * factor,
                px[1] * factor,
                px[2] * factor,
                px[3].clamp(0.0, 255.0),
            ]
        })
        .collect();
    plane.with_data(data)
}

fn apply_to_plane(plane: &Plane, op: &FilterOp<'_>) -> Result<Plane> {
    match *op {
        FilterOp::Blur(sigma) => crate::raster_filter::blur_plane(plane, sigma),
        FilterOp::Sharpen(options) => crate::raster_sharpen::sharpen_plane(plane, &options),
        FilterOp::Median(size) => crate::raster_filter_ops::median_plane(plane, size),
        FilterOp::Threshold { value, greyscale } => Ok(crate::raster_filter_ops::threshold_plane(
            plane, value, greyscale,
        )),
        FilterOp::Convolve {
            width,
            height,
            kernel,
            scale,
            offset,
        } => crate::raster_filter_ops::convolve_plane(plane, width, height, kernel, scale, offset),
    }
}

/// Run `ops` in order over `src` inside a single premultiply sandwich (when
/// the image has alpha and the run contains a blur, convolve or sharpen),
/// with one truncating cast back to bytes at the end.
pub(crate) fn run_filter_chain(src: &RasterImage, ops: &[FilterOp<'_>]) -> Result<RasterImage> {
    let sandwich = src.channels == 4 && ops.iter().any(FilterOp::triggers_premultiply);
    let start = Plane {
        width: src.width as usize,
        height: src.height as usize,
        channels: src.channels as usize,
        data: src.data.iter().map(|&v| v as f64).collect(),
    };
    // sharp's `premultiply().cast(uchar)` — the cast is why the run starts
    // from bytes rather than from the raw float product.
    let start = if sandwich {
        premultiply(&start).quantised()
    } else {
        start
    };
    let filtered = ops
        .iter()
        .try_fold(start, |plane, op| apply_to_plane(&plane, op))?;
    let finished = if sandwich {
        unpremultiply(&filtered)
    } else {
        filtered
    };
    Ok(RasterImage {
        data: finished.to_u8(),
        ..src.clone()
    })
}

#[cfg(test)]
#[path = "raster_filter_chain_tests.rs"]
mod tests;
