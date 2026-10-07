//! Debounced whole-image refinement and native-patch fallback (#4317).
use crate::{detail::DetailFrame, detail_worker::DetailSource};
use eframe::egui;
use raw_core::{pipeline, AdjustmentModel, CancelToken};
use std::sync::Arc;

pub(crate) fn required(model: &AdjustmentModel) -> bool {
    !raw_core::stages::perspective::Perspective::from_model(model).is_identity()
        || model.dehaze.abs() > 1e-3
        || raw_core::stages::local_adjustments::spatial::any_dehaze_engaged(
            &model.local_adjustments,
        )
}

/// Limit the pre-geometry develop resolution, including a narrow crop's hidden pixels.
pub(crate) fn request_rect(
    native: (u32, u32),
    displayed: (u32, u32),
    scale: f32,
) -> pipeline::TileRect {
    let long = native.0.max(native.1).max(1);
    let requested = (long as f64 * f64::from(scale.min(1.0))).ceil().max(1.0) as u32;
    let pixels = |edge: u32| {
        let w = (u64::from(native.0) * u64::from(edge)).div_ceil(u64::from(long));
        let h = (u64::from(native.1) * u64::from(edge)).div_ceil(u64::from(long));
        w * h
    };
    let (mut low, mut high) = (1, requested);
    while low < high {
        let middle = low + (high - low).div_ceil(2);
        if pixels(middle) <= 8_388_608 {
            low = middle;
        } else {
            high = middle - 1;
        }
    }
    // Floor keeps output rounding from asking the renderer to exceed the chosen cap.
    let output =
        |dimension: u32| (u64::from(dimension) * u64::from(low) / u64::from(long)).max(1) as u32;
    pipeline::TileRect {
        src_x: 0,
        src_y: 0,
        src_w: displayed.0,
        src_h: displayed.1,
        out_w: output(displayed.0),
        out_h: output(displayed.1),
    }
}

pub(crate) fn render(
    source: &DetailSource,
    model: &AdjustmentModel,
    rect: pipeline::TileRect,
    cancel: CancelToken<'_>,
    obsolete: impl Fn() -> bool,
) -> Result<Option<DetailFrame>, String> {
    if cancel.is_cancelled() || obsolete() {
        return Ok(None);
    }
    if rect.src_x != 0
        || rect.src_y != 0
        || rect.out_w == 0
        || rect.out_h == 0
        || rect.out_w > rect.src_w
        || rect.out_h > rect.src_h
        || u64::from(rect.out_w) * u64::from(rect.out_h) > 8_388_608
    {
        return Err("Whole-image refinement exceeds its resolution budget".into());
    }
    let film = crate::film::resolve(&model.film_look)?;
    let Dimensions { native, displayed } = dimensions(source, model)?;
    if displayed != (rect.src_w, rect.src_h) {
        return Err("Whole-image refinement does not match the opened image".into());
    }
    let scale = (rect.out_w as f64 / rect.src_w as f64).max(rect.out_h as f64 / rect.src_h as f64);
    let edge = (native.0.max(native.1) as f64 * scale).ceil() as u32;
    let develop_scale = edge as f64 / native.0.max(native.1) as f64;
    let working_w = (native.0 as f64 * develop_scale).ceil() as u64;
    let working_h = (native.1 as f64 * develop_scale).ceil() as u64;
    if working_w * working_h > 8_388_608 {
        return Err("Whole-image refinement exceeds its resolution budget".into());
    }
    let result = if let Some(raw) = &source.raw {
        pipeline::render_detail_base_cancellable(
            raw,
            model,
            pipeline::RawInput::Bytes {
                bytes: &source.bytes,
                ext: &source.ext,
            },
            pipeline::DetailRenderOptions {
                quality: pipeline::RenderQuality::Auto,
                max_long_edge: edge,
                film_lut: film.as_ref().map(|f| f.lut),
            },
            cancel,
        )
        .map(|(w, h, rgb, _)| (w, h, rgb))
    } else {
        pipeline::render_export_raster_cancellable(
            &source.bytes,
            model,
            Some(edge),
            raw_core::view::encode::TargetPrimaries::Srgb,
            pipeline::ExportDepth::Eight,
            film.as_ref().map(|f| f.lut),
            cancel,
        )
        .map(|(w, h, pixels)| {
            let pipeline::ExportPixels::Eight(rgb) = pixels else {
                unreachable!("eight-bit refinement")
            };
            (w, h, rgb)
        })
    };
    if cancel.is_cancelled() || obsolete() {
        return Ok(None);
    }
    let (w, h, rgb) = result.map_err(|e| e.to_string())?;
    let patch = egui::ColorImage::from_rgb([w as usize, h as usize], &rgb);
    Ok(Some(DetailFrame {
        native_size: (rect.src_w, rect.src_h),
        rect,
        request: rect,
        whole_fallback: false,
        base: Arc::new(patch.clone()),
        patch,
    }))
}

struct Dimensions {
    native: (u32, u32),
    displayed: (u32, u32),
}

fn dimensions(source: &DetailSource, model: &AdjustmentModel) -> Result<Dimensions, String> {
    let native = if let Some(raw) = &source.raw {
        pipeline::native_render_dims(raw)
    } else {
        let metadata = raw_core::probe_raster_metadata(&source.bytes).map_err(|e| e.to_string())?;
        if raw_core::image::ExifOrientation::from_u16(metadata.orientation.unwrap_or(1)).swaps_wh()
        {
            (metadata.height, metadata.width)
        } else {
            (metadata.width, metadata.height)
        }
    };
    let displayed =
        raw_core::stages::crop::CropPresentation::new(&model.crop, native.0, native.1).dims;
    Ok(Dimensions { native, displayed })
}

/// Preserve the original request identity while painting a full-frame fallback.
pub(crate) fn fallback(
    source: &DetailSource,
    model: &AdjustmentModel,
    request: pipeline::TileRect,
    cancel: CancelToken<'_>,
    obsolete: impl Fn() -> bool,
) -> Result<Option<DetailFrame>, String> {
    if cancel.is_cancelled() || obsolete() {
        return Ok(None);
    }
    let Dimensions { native, displayed } = dimensions(source, model)?;
    if request.src_w == 0
        || request.src_h == 0
        || request.src_w != request.out_w
        || request.src_h != request.out_h
        || request
            .src_x
            .checked_add(request.src_w)
            .is_none_or(|x| x > displayed.0)
        || request
            .src_y
            .checked_add(request.src_h)
            .is_none_or(|y| y > displayed.1)
    {
        return Err("Invalid native-detail fallback request".into());
    }
    let rect = request_rect(native, displayed, 1.0);
    render(source, model, rect, cancel, obsolete).map(|frame| {
        frame.map(|frame| DetailFrame {
            request,
            whole_fallback: true,
            ..frame
        })
    })
}

#[cfg(test)]
#[path = "whole_detail_tests.rs"]
mod tests;
