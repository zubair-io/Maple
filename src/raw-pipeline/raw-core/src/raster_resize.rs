//! Resize: target-size arithmetic per fit mode, then SIMD resampling through
//! `fast_image_resize`. Split out of `raster.rs` (#3502) so that file stays
//! inside the repo's file-size budget; the public names are re-exported from
//! `raster` so no caller's import path changes.

use fast_image_resize as fr;

use crate::error::{Error, Result};
use crate::raster::RasterImage;

/// Sizing and framing strategy for resizing.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum ResizeFit {
    /// Scale image to fit inside target bounding box, preserving aspect ratio.
    #[default]
    Inside,
    /// Scale image to exactly target width and height, distorting aspect ratio if needed.
    Fill,
    /// Scale so the target box is fully covered (aspect preserved), then centre-crop to it.
    Cover,
}

/// Filter kernel for resampling.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum FilterAlg {
    #[default]
    Lanczos3,
    Bilinear,
    Nearest,
}

/// Options controlling image resizing.
#[derive(Clone, Debug)]
pub struct ResizeOptions {
    pub width: u32,
    pub height: u32,
    pub fit: ResizeFit,
    pub filter: FilterAlg,
    pub without_enlargement: bool,
}

impl Default for ResizeOptions {
    fn default() -> Self {
        Self {
            width: 512,
            height: 512,
            fit: ResizeFit::Inside,
            filter: FilterAlg::Lanczos3,
            without_enlargement: true,
        }
    }
}

/// High-performance SIMD resizing of a RasterImage using `fast_image_resize`.
pub fn resize_raster(src: &RasterImage, options: &ResizeOptions) -> Result<RasterImage> {
    if src.width == 0 || src.height == 0 {
        return Err(Error::Decode {
            path: "<memory>".into(),
            reason: "cannot resize zero-dimension image".into(),
        });
    }

    let (dst_w_calc, dst_h_calc) = match options.fit {
        ResizeFit::Cover => {
            // A 0 width/height means "keep the source dimension", the same
            // as in the `Fill` and `Inside` arms — clamping it to 1px
            // instead (the old `.max(1)`) turned `cover` with one axis
            // unspecified into a 1-pixel sliver.
            let tw = if options.width == 0 {
                src.width
            } else {
                options.width
            };
            let th = if options.height == 0 {
                src.height
            } else {
                options.height
            };
            let scale = (tw as f64 / src.width as f64).max(th as f64 / src.height as f64);
            let scale = if options.without_enlargement {
                scale.min(1.0)
            } else {
                scale
            };
            let scaled = resize_raster(
                src,
                &ResizeOptions {
                    width: (src.width as f64 * scale).round().max(1.0) as u32,
                    height: (src.height as f64 * scale).round().max(1.0) as u32,
                    fit: ResizeFit::Fill,
                    filter: options.filter,
                    without_enlargement: false,
                },
            )?;
            let cw = tw.min(scaled.width);
            let ch = th.min(scaled.height);
            return scaled.crop((scaled.width - cw) / 2, (scaled.height - ch) / 2, cw, ch);
        }
        ResizeFit::Fill => {
            let w = if options.width == 0 {
                src.width
            } else {
                options.width
            };
            let h = if options.height == 0 {
                src.height
            } else {
                options.height
            };
            (w, h)
        }
        ResizeFit::Inside => {
            let scale = match (options.width, options.height) {
                (0, 0) => 1.0,
                (w, 0) => w as f64 / src.width as f64,
                (0, h) => h as f64 / src.height as f64,
                (w, h) => {
                    let sx = w as f64 / src.width as f64;
                    let sy = h as f64 / src.height as f64;
                    sx.min(sy)
                }
            };
            let mut final_scale = scale;
            if options.without_enlargement && final_scale >= 1.0 {
                final_scale = 1.0;
            }
            let w = (src.width as f64 * final_scale).round().max(1.0) as u32;
            let h = (src.height as f64 * final_scale).round().max(1.0) as u32;
            (w, h)
        }
    };

    if dst_w_calc == src.width && dst_h_calc == src.height {
        return Ok(src.clone());
    }

    if dst_w_calc == 0 || dst_h_calc == 0 {
        return Err(Error::Decode {
            path: "<memory>".into(),
            reason: "target dimensions must be non-zero".into(),
        });
    }

    let pixel_type = match src.channels {
        3 => fr::PixelType::U8x3,
        4 => fr::PixelType::U8x4,
        other => {
            return Err(Error::Decode {
                path: "<memory>".into(),
                reason: format!("unsupported channel count: {other}"),
            })
        }
    };

    let src_image =
        fr::images::Image::from_vec_u8(src.width, src.height, src.data.clone(), pixel_type)
            .map_err(|e| Error::Decode {
                path: "<memory>".into(),
                reason: format!("fast_image_resize source creation error: {e}"),
            })?;

    let mut dst_image = fr::images::Image::new(dst_w_calc, dst_h_calc, pixel_type);

    let alg = match options.filter {
        FilterAlg::Lanczos3 => fr::ResizeAlg::Convolution(fr::FilterType::Lanczos3),
        FilterAlg::Bilinear => fr::ResizeAlg::Convolution(fr::FilterType::Bilinear),
        FilterAlg::Nearest => fr::ResizeAlg::Nearest,
    };

    let fr_opts = fr::ResizeOptions {
        algorithm: alg,
        ..Default::default()
    };

    let mut resizer = fr::Resizer::new();
    resizer
        .resize(&src_image, &mut dst_image, &fr_opts)
        .map_err(|e| Error::Decode {
            path: "<memory>".into(),
            reason: format!("resizing execution failed: {e}"),
        })?;

    Ok(RasterImage {
        width: dst_w_calc,
        height: dst_h_calc,
        channels: src.channels,
        data: dst_image.into_vec(),
        orientation: src.orientation,
    })
}
