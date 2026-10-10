//! Bounded, pre-WB camera context for removal calibration qualification (#3955).
use super::{camera, region, TILE_OVERLAP_PX};
use crate::{
    cancel::CancelToken,
    error::{Error, Result},
    image::{CropRect, Image, RawImage},
    linearize,
    pipeline::{removal_context::anchor_model, RenderQuality},
    types::accepted_removal::NativeWindow,
};

pub(in crate::pipeline) fn render_removal_camera_context(
    raw: &RawImage,
    window: NativeWindow,
    cancel: CancelToken<'_>,
) -> Result<Image> {
    if cancel.is_cancelled() {
        return Err(Error::Cancelled);
    }
    let crop = raw
        .crop_rect
        .and_then(|c| CropRect::clamped(c.x, c.y, c.w, c.h, raw.width, raw.height))
        .unwrap_or(CropRect {
            x: 0,
            y: 0,
            w: raw.width,
            h: raw.height,
        });
    window.validate(crop.w, crop.h).map_err(Error::Pipeline)?;
    if window.width > 2048 || window.height > 2048 {
        return Err(Error::Pipeline(
            "removal calibration context exceeds the 2048-pixel native context limit".into(),
        ));
    }
    let model = anchor_model();
    // Direct SENSOR coordinates, unlike the display-oriented tile entry.
    // DefaultCrop coordinates are translated once; EXIF has no role here.
    // Match AMaZE's GLOBAL tile grid, not merely Bayer parity. Its Nyquist
    // reconstruction has tile-local boundaries even with adequate overlap.
    let stride = match raw.cfa {
        crate::image::CfaPattern::LinearRgb => 1,
        crate::image::CfaPattern::XTrans(_) => 6,
        _ => crate::demosaic::amaze::TILE_STRIDE,
    };
    let sx = crop.x + window.x;
    let sy = crop.y + window.y;
    let rx = sx.saturating_sub(TILE_OVERLAP_PX) / stride * stride;
    let ry = sy.saturating_sub(TILE_OVERLAP_PX) / stride * stride;
    let right = (u64::from(sx) + u64::from(window.width) + u64::from(TILE_OVERLAP_PX))
        .div_ceil(u64::from(stride))
        * u64::from(stride);
    let bottom = (u64::from(sy) + u64::from(window.height) + u64::from(TILE_OVERLAP_PX))
        .div_ceil(u64::from(stride))
        * u64::from(stride);
    let rw = right.min(u64::from(raw.width)) as u32 - rx;
    let rh = bottom.min(u64::from(raw.height)) as u32 - ry;
    let (left, top) = (sx - rx, sy - ry);
    // The fixed model disables lens correction, lateral CA and hot pixels.
    // No ordinary tile fallback is used: its guards concern creative stages
    // which do not run in this pre-WB context.
    let active_area = region::active_area_for_padded_crop(raw, rx, ry, 1);
    let camera = if raw.cfa == crate::image::CfaPattern::LinearRgb {
        let rgb = linearize::linearraw_to_camera_rgb_region(raw, rx, ry, rw, rh)?;
        if cancel.is_cancelled() {
            return Err(Error::Cancelled);
        }
        camera::finish(rgb, raw, &model, active_area)?
    } else {
        let mosaic = linearize::sensor_linearize_region(raw, rx, ry, rw, rh);
        if cancel.is_cancelled() {
            return Err(Error::Cancelled);
        }
        camera::prepare(
            &mosaic,
            raw,
            &model,
            RenderQuality::Amaze,
            active_area,
            (rx, ry),
        )?
    };
    if cancel.is_cancelled() {
        return Err(Error::Cancelled);
    }
    Ok(region::trim_image_to_inner(
        &camera,
        left,
        top,
        window.width,
        window.height,
    ))
}
