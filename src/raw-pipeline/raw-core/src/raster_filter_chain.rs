//! Byte resampling and float filters share one alpha premultiply/unpremultiply pair.
//! sharp 0.34.5 quantises premultiplied input to bytes before resize, retains
//! float overshoots through filters, and unpremultiplies before the final byte cast.
//! Median and threshold inherit the pair when the same run resizes, blurs,
//! convolves or sharpens. Maple retains caller order within each consecutive run.

use crate::error::Result;
use crate::raster::{needs_resampling, resize_premultiplied, RasterImage, ResizeOptions};
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
#[derive(Clone, Debug)]
pub enum FilterOp<'a> {
    Resize(ResizeOptions),
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
// libvips alpha transforms use f32; byte truncation depends on that precision.
fn premultiply_pixel(px: &[f64]) -> [f64; 4] {
    let alpha = px[3].clamp(0.0, 255.0) as f32 / 255.0;
    [
        f64::from(px[0] as f32 * alpha),
        f64::from(px[1] as f32 * alpha),
        f64::from(px[2] as f32 * alpha),
        px[3],
    ]
}

fn premultiply(plane: &Plane) -> Plane {
    plane.with_data(
        plane
            .data
            .chunks_exact(4)
            .flat_map(premultiply_pixel)
            .collect(),
    )
}

fn unpremultiply_pixel(px: &[f64]) -> [f64; 4] {
    let factor: f32 = if px[3].abs() < 0.01 {
        0.0
    } else {
        255.0 / px[3] as f32
    };
    [
        f64::from(px[0] as f32 * factor),
        f64::from(px[1] as f32 * factor),
        f64::from(px[2] as f32 * factor),
        px[3].clamp(0.0, 255.0),
    ]
}

fn unpremultiply(plane: &Plane) -> Plane {
    plane.with_data(
        plane
            .data
            .chunks_exact(4)
            .flat_map(unpremultiply_pixel)
            .collect(),
    )
}

fn transform_alpha_bytes(src: &RasterImage, transform: fn(&[f64]) -> [f64; 4]) -> RasterImage {
    RasterImage {
        width: src.width,
        height: src.height,
        channels: src.channels,
        orientation: src.orientation,
        data: src
            .data
            .chunks_exact(4)
            .flat_map(|px| {
                transform(&[
                    f64::from(px[0]),
                    f64::from(px[1]),
                    f64::from(px[2]),
                    f64::from(px[3]),
                ])
            })
            .map(|sample| sample.clamp(0.0, 255.0) as u8)
            .collect(),
    }
}

fn resize_in_sandwich(
    image: &RasterImage,
    options: &ResizeOptions,
    sandwich: bool,
) -> Result<RasterImage> {
    let background = if sandwich {
        premultiply_pixel(&options.background.map(f64::from)).map(|sample| sample as u8)
    } else {
        options.background
    };
    resize_premultiplied(
        image,
        &ResizeOptions {
            background,
            ..options.clone()
        },
    )
}

fn apply_to_plane(plane: &Plane, op: &FilterOp<'_>, sandwich: bool) -> Result<Plane> {
    match op {
        FilterOp::Resize(options) => {
            let image = RasterImage::from_raw(
                plane.width as u32,
                plane.height as u32,
                plane.channels as u8,
                plane.to_u8(),
            )?;
            let resized = resize_in_sandwich(&image, options, sandwich)?;
            Ok(Plane {
                width: resized.width as usize,
                height: resized.height as usize,
                channels: resized.channels as usize,
                data: resized.data.into_iter().map(f64::from).collect(),
            })
        }
        FilterOp::Blur(sigma) => crate::raster_filter::blur_plane(plane, *sigma),
        FilterOp::Sharpen(options) => crate::raster_sharpen::sharpen_plane(plane, options),
        FilterOp::Median(size) => crate::raster_filter_ops::median_plane(plane, *size),
        FilterOp::Threshold { value, greyscale } => Ok(crate::raster_filter_ops::threshold_plane(
            plane, *value, *greyscale,
        )),
        FilterOp::Convolve {
            width,
            height,
            kernel,
            scale,
            offset,
        } => crate::raster_filter_ops::convolve_plane(
            plane, *width, *height, kernel, *scale, *offset,
        ),
    }
}

/// Run `ops` in order over `src` inside a single premultiply sandwich (when
/// the image has alpha and the run resizes, blurs, convolves or sharpens),
/// with one truncating cast back to bytes at the end.
pub(crate) fn run_filter_chain(src: &RasterImage, ops: &[FilterOp<'_>]) -> Result<RasterImage> {
    let sandwich = src.channels == 4
        && ops.iter().any(|op| {
            op.triggers_premultiply()
                || matches!(op, FilterOp::Resize(options) if needs_resampling(src, options))
        });
    let (start, ops) = if let Some((FilterOp::Resize(options), rest)) = ops.split_first() {
        // Resize full-resolution bytes before allocating the smaller float filter plane.
        let premultiplied = sandwich.then(|| transform_alpha_bytes(src, premultiply_pixel));
        let resized = resize_in_sandwich(premultiplied.as_ref().unwrap_or(src), options, sandwich)?;
        if rest.is_empty() {
            return Ok(if sandwich {
                transform_alpha_bytes(&resized, unpremultiply_pixel)
            } else {
                resized
            });
        }
        (
            Plane {
                width: resized.width as usize,
                height: resized.height as usize,
                channels: resized.channels as usize,
                data: resized.data.into_iter().map(f64::from).collect(),
            },
            rest,
        )
    } else {
        let plane = Plane {
            width: src.width as usize,
            height: src.height as usize,
            channels: src.channels as usize,
            data: src.data.iter().copied().map(f64::from).collect(),
        };
        (
            if sandwich {
                premultiply(&plane).quantised()
            } else {
                plane
            },
            ops,
        )
    };
    let filtered = ops
        .iter()
        .try_fold(start, |plane, op| apply_to_plane(&plane, op, sandwich))?;
    let finished = if sandwich {
        unpremultiply(&filtered)
    } else {
        filtered
    };
    Ok(RasterImage {
        width: finished.width as u32,
        height: finished.height as u32,
        channels: finished.channels as u8,
        data: finished.to_u8(),
        orientation: src.orientation,
    })
}

#[cfg(test)]
#[path = "raster_filter_chain_tests.rs"]
mod tests;
