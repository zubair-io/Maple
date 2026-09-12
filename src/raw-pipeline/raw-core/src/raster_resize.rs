//! Resize: target-size arithmetic per fit mode, then SIMD resampling through
//! `fast_image_resize`. Split out of `raster.rs` (#3502) so that file stays
//! inside the repo's file-size budget; the public names are re-exported from
//! `raster` so no caller's import path changes.

use fast_image_resize as fr;

use crate::error::{Error, Result};
use crate::raster::RasterImage;
use crate::raster_composite::Gravity;
use crate::raster_geometry::ExtendEdges;

/// Sizing and framing strategy, matching sharp's `fit`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum ResizeFit {
    /// As large as possible while both dimensions stay <= the target.
    #[default]
    Inside,
    /// Exactly the target, aspect ratio ignored.
    Fill,
    /// Cover the target (aspect preserved), then crop to it at `position`.
    Cover,
    /// Fit inside the target, then pad to it with `background` at `position`.
    Contain,
    /// As small as possible while both dimensions stay >= the target.
    Outside,
}

/// Filter kernel for resampling, matching sharp's `kernel` names.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum FilterAlg {
    #[default]
    Lanczos3,
    /// sharp's `lanczos2` — a narrower, less ringy Lanczos window.
    Lanczos2,
    Bilinear,
    /// sharp's `cubic` — the Catmull-Rom bicubic spline.
    CatmullRom,
    /// Mitchell-Netravali bicubic (B = C = 1/3).
    Mitchell,
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
    /// sharp's `withoutReduction`: never scale DOWN. Cover and contain still
    /// crop or pad afterwards to reach the exact box.
    pub without_reduction: bool,
    /// Where the source sits inside the target box for `cover` and `contain`.
    pub position: Gravity,
    /// Letterbox colour for `contain`. An alpha below 255 promotes the result
    /// to 4 channels.
    pub background: [u8; 4],
}

impl Default for ResizeOptions {
    fn default() -> Self {
        Self {
            width: 512,
            height: 512,
            fit: ResizeFit::Inside,
            filter: FilterAlg::Lanczos3,
            without_enlargement: true,
            without_reduction: false,
            position: Gravity::Centre,
            background: [0, 0, 0, 255],
        }
    }
}

/// Target dimension on one axis: `0` means "keep what the resize produced".
///
/// sharp resolves an unrequested axis AFTER the resize has run, against the
/// resized dimension (`pipeline.cc`: `if (baton->width <= 0) baton->width =
/// inputWidth;`, where `inputWidth` is re-read from the resized image). That
/// is why a single-axis `cover` or `contain` has nothing left to crop or pad.
fn target(requested: u32, resized: u32) -> u32 {
    if requested == 0 {
        resized
    } else {
        requested
    }
}

/// Per-axis shrink factors, following sharp's `ResolveShrink`
/// (`src/common.cc`). A factor ABOVE 1 shrinks the axis and one below it
/// enlarges — the inverse of a scale, which is the convention sharp and
/// libvips work in, and worth keeping because the clamps read naturally
/// there (`withoutReduction` is `min(1, shrink)`).
///
/// The part that matters most here is the single-fixed-axis branch: every
/// canvas except `fill` copies the requested axis's factor onto the other
/// axis, so `{ width: 10, fit: 'contain' }` on a 40x20 source scales BOTH
/// axes by 4 and lands on 10x5 — not a 10x20 letterbox. The two clamps are
/// then applied per axis to whatever the canvas chose, `fill` included, so
/// a `fill` that enlarges one axis and shrinks the other can have exactly
/// one of them held back.
fn resolve_shrink(src: &RasterImage, options: &ResizeOptions) -> (f64, f64) {
    let (sw, sh) = (src.width as f64, src.height as f64);
    let h_axis = (options.width > 0).then(|| sw / options.width as f64);
    let v_axis = (options.height > 0).then(|| sh / options.height as f64);
    let raw = match (h_axis, v_axis) {
        (None, None) => (1.0, 1.0),
        (Some(h), Some(v)) => match options.fit {
            // CROP / MIN: the smaller shrink, so the result covers the box.
            ResizeFit::Cover | ResizeFit::Outside => (h.min(v), h.min(v)),
            // EMBED / MAX: the larger shrink, so the result fits inside it.
            ResizeFit::Contain | ResizeFit::Inside => (h.max(v), h.max(v)),
            // IGNORE_ASPECT: each axis keeps its own factor.
            ResizeFit::Fill => (h, v),
        },
        (Some(h), None) if options.fit == ResizeFit::Fill => (h, 1.0),
        (Some(h), None) => (h, h),
        (None, Some(v)) if options.fit == ResizeFit::Fill => (1.0, v),
        (None, Some(v)) => (v, v),
    };
    // Both clamps apply to every canvas, `fill` included, and per axis —
    // `ResolveShrink` runs them after the canvas switch, on both factors.
    let no_up = if options.without_enlargement {
        (raw.0.max(1.0), raw.1.max(1.0))
    } else {
        raw
    };
    if options.without_reduction {
        (no_up.0.min(1.0), no_up.1.min(1.0))
    } else {
        no_up
    }
}

/// The size one axis resizes to, from its shrink factor. Never below 1px.
fn scaled_dim(dim: u32, shrink: f64) -> u32 {
    (dim as f64 / shrink).round().max(1.0) as u32
}

/// `cover`: crop the resized image down to the target box at `position`.
/// The box is clamped to what the resize produced, matching sharp
/// (`if (baton->width > inputWidth) baton->width = inputWidth;`).
fn crop_to(
    scaled: &RasterImage,
    (tw, th): (u32, u32),
    options: &ResizeOptions,
) -> Result<RasterImage> {
    let cw = tw.min(scaled.width);
    let ch = th.min(scaled.height);
    if (cw, ch) == (scaled.width, scaled.height) {
        return Ok(scaled.clone());
    }
    let (x, y) = options
        .position
        .place_crop((scaled.width, scaled.height), (cw, ch));
    scaled.crop(x.max(0) as u32, y.max(0) as u32, cw, ch)
}

/// `contain`: pad the resized image out to the target box at `position`.
fn pad_to(
    scaled: &RasterImage,
    (tw, th): (u32, u32),
    options: &ResizeOptions,
) -> Result<RasterImage> {
    let (x, y) = options
        .position
        .place_pad((tw, th), (scaled.width, scaled.height));
    let left = x.max(0) as u32;
    let top = y.max(0) as u32;
    scaled.extend(
        ExtendEdges {
            left,
            top,
            // `saturating_sub` guards a float-rounding edge only:
            // `scaled` is sized from the same scale factor used to
            // place it, so `scaled.width + left` cannot exceed `tw`
            // by construction — this never actually saturates.
            right: tw.saturating_sub(scaled.width + left),
            bottom: th.saturating_sub(scaled.height + top),
        },
        options.background,
    )
}

/// High-performance SIMD resizing of a RasterImage using `fast_image_resize`.
pub fn resize_raster(src: &RasterImage, options: &ResizeOptions) -> Result<RasterImage> {
    if src.width == 0 || src.height == 0 {
        return Err(Error::Decode {
            path: "<memory>".into(),
            reason: "cannot resize zero-dimension image".into(),
        });
    }

    let (hshrink, vshrink) = resolve_shrink(src, options);
    let dst_w = scaled_dim(src.width, hshrink);
    let dst_h = scaled_dim(src.height, vshrink);
    let scaled = if (dst_w, dst_h) == (src.width, src.height) {
        src.clone()
    } else {
        resample(src, dst_w, dst_h, options.filter)?
    };

    let box_ = (
        target(options.width, scaled.width),
        target(options.height, scaled.height),
    );
    match options.fit {
        ResizeFit::Cover => crop_to(&scaled, box_, options),
        ResizeFit::Contain => pad_to(&scaled, box_, options),
        ResizeFit::Inside | ResizeFit::Outside | ResizeFit::Fill => Ok(scaled),
    }
}

/// Lanczos with a = 2 — sharp's `lanczos2`. `fast_image_resize` ships
/// Lanczos3 only, so the a = 2 window is supplied as a custom filter.
fn lanczos2(x: f64) -> f64 {
    let sinc = |mut t: f64| {
        if t == 0.0 {
            return 1.0;
        }
        t *= std::f64::consts::PI;
        t.sin() / t
    };
    if (-2.0..2.0).contains(&x) {
        sinc(x) * sinc(x / 2.0)
    } else {
        0.0
    }
}

/// Map a [`FilterAlg`] onto the `fast_image_resize` algorithm it drives.
fn resize_alg(filter: FilterAlg) -> Result<fr::ResizeAlg> {
    let convolution = |t| fr::ResizeAlg::Convolution(t);
    Ok(match filter {
        FilterAlg::Nearest => fr::ResizeAlg::Nearest,
        FilterAlg::Bilinear => convolution(fr::FilterType::Bilinear),
        FilterAlg::CatmullRom => convolution(fr::FilterType::CatmullRom),
        FilterAlg::Mitchell => convolution(fr::FilterType::Mitchell),
        FilterAlg::Lanczos3 => convolution(fr::FilterType::Lanczos3),
        FilterAlg::Lanczos2 => convolution(fr::FilterType::Custom(
            fr::Filter::new("lanczos2", lanczos2, 2.0).map_err(|e| Error::Decode {
                path: "<memory>".into(),
                reason: format!("lanczos2 filter construction failed: {e:?}"),
            })?,
        )),
    })
}

/// The `fast_image_resize` call itself.
///
/// `mul_div_alpha: true` (#3548) is the crate's own premultiplied-alpha
/// resampling path: for a pixel type that carries alpha (`U8x4` here), it
/// multiplies colour by alpha before the resize kernel runs and divides it
/// back out after, internally, via the same `MulDiv` machinery the crate
/// exposes standalone — see `resample_convolution` in
/// `fast_image_resize::resizer`. Without it a fully transparent neighbour
/// still contributes its raw colour to the kernel's weighted sum, so a
/// resize can bleed colour from pixels that carry none of their own
/// opacity — e.g. an opaque red pixel next to a transparent green one,
/// downscaled together, would otherwise turn pink instead of staying red.
/// It is the crate's default already (confirmed empirically: forcing it to
/// `false` is what makes `downscaling_rgba_premultiplies_so_transparent_
/// colour_does_not_bleed` fail below); it is spelled out here so the
/// intent survives a future change to that default, and so a second,
/// hand-rolled premultiply is never added on top — doing that would
/// double-premultiply through this path and be wrong for anything but the
/// 0/255 alpha extremes. 3-channel sources have no alpha channel, so
/// `MulDiv::is_supported` reports `U8x3` unsupported and the crate falls
/// through to the unchanged straight convolution — no separate branch is
/// needed here to keep that path untouched.
fn resample(src: &RasterImage, dst_w: u32, dst_h: u32, filter: FilterAlg) -> Result<RasterImage> {
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

    let mut dst_image = fr::images::Image::new(dst_w, dst_h, pixel_type);

    let fr_opts = fr::ResizeOptions {
        algorithm: resize_alg(filter)?,
        mul_div_alpha: true,
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
        width: dst_w,
        height: dst_h,
        channels: src.channels,
        data: dst_image.into_vec(),
        orientation: src.orientation,
    })
}

#[cfg(test)]
#[path = "raster_resize_tests.rs"]
mod tests;
