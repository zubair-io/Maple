//! Native photographic context for removal model qualification (#3941).
//! This fixed As-Shot plate excludes creative edits and view transforms.

use crate::error::{Error, Result};
use crate::image::{ColorSpace, CropRect, ExifOrientation, Image, RawImage};
use crate::types::accepted_removal::NativeWindow;
use crate::xmp::{AdjustmentModel, AutoExposureMode, LensProfileEnable};

use super::orient::apply_orientation_f32_rgba;
use super::{render_scene_linear_tile_from_raw_with_quality_f32, RenderQuality, TileRect};

fn inverse(orientation: ExifOrientation) -> ExifOrientation {
    match orientation {
        ExifOrientation::Rotate90 => ExifOrientation::Rotate270,
        ExifOrientation::Rotate270 => ExifOrientation::Rotate90,
        other => other,
    }
}

/// Fixed model for the experiment. As-Shot remains implicit: marking
/// Temperature=6500 as authored would change the camera's white balance.
pub(super) fn anchor_model() -> AdjustmentModel {
    AdjustmentModel {
        auto_exposure: AutoExposureMode::Off,
        sharpen_amount: 0.0,
        nr_color: 0.0,
        lens_profile_enable: LensProfileEnable::Off,
        ..Default::default()
    }
}

/// Develop a native window in un-oriented DefaultCrop coordinates, without
/// resizing or display encoding. It does not accept a creative model, so
/// toggling Auto, exposure, WB or crop cannot change this authoring input.
///
/// Uses the bounded tile decode. Untileable inputs return its explicit
/// error; a shipping host must use its qualified whole-frame fallback
/// within the host allocation budget (#1472), not substitute a preview.
pub fn render_removal_context(raw: &RawImage, window: NativeWindow) -> Result<Image> {
    let crop = raw
        .crop_rect
        .and_then(|crop| CropRect::clamped(crop.x, crop.y, crop.w, crop.h, raw.width, raw.height))
        .unwrap_or(CropRect {
            x: 0,
            y: 0,
            w: raw.width,
            h: raw.height,
        });
    window.validate(crop.w, crop.h).map_err(Error::Pipeline)?;
    let (display_w, display_h) = if raw.orientation.swaps_wh() {
        (raw.height, raw.width)
    } else {
        (raw.width, raw.height)
    };
    // TileRect is display-oriented SENSOR coordinates despite its older
    // pre-orientation doc comment. Translate the DefaultCrop native ROI
    // into that frame, then undo the returned tile's EXIF orientation.
    let (x, y, w, h) = inverse(raw.orientation).display_rect_to_sensor(
        crop.x + window.x,
        crop.y + window.y,
        window.width,
        window.height,
        display_w,
        display_h,
    );
    let (w, h, rgba) = render_scene_linear_tile_from_raw_with_quality_f32(
        raw,
        &anchor_model(),
        TileRect {
            src_x: x,
            src_y: y,
            src_w: w,
            src_h: h,
            out_w: w,
            out_h: h,
        },
        RenderQuality::Amaze,
    )?;
    let (w, h, native) = if raw.orientation == ExifOrientation::Normal {
        (w, h, rgba)
    } else {
        apply_orientation_f32_rgba(&rgba, w, h, inverse(raw.orientation))
    };
    if (w, h) != (window.width, window.height) {
        return Err(Error::Pipeline(
            "removal context lost native geometry".into(),
        ));
    }
    Ok(Image {
        width: w,
        height: h,
        pixels: native.chunks_exact(4).map(|p| [p[0], p[1], p[2]]).collect(),
        space: ColorSpace::SceneLinearRec2020,
        whites_anchor_ev: None,
        nr_sampling_scale: 1.0,
    })
}

#[cfg(test)]
#[path = "removal_context_tests.rs"]
mod tests;
