//! Shared bounded camera prefix before user WB / DCP (#3955).
use crate::{
    cancel::CancelToken,
    demosaic,
    error::{Error, Result},
    image::{CropRect, Image, RawImage},
    pipeline::{stage, RenderQuality},
    stages::{highlight_recovery, white_balance},
    xmp::AdjustmentModel,
};

pub(super) fn prepare(
    mosaic: &Image,
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
    active_area: Option<CropRect>,
    tile_origin: (u32, u32),
    cancel: CancelToken<'_>,
) -> Result<Image> {
    mosaic.assert_space(crate::image::ColorSpace::CameraNativeMosaic);
    let camera_rgb = match raw.cfa {
        // The removal context aligns to six sensor pixels. Ordinary tiles
        // continue to reject X-Trans in guards before reaching this function.
        crate::image::CfaPattern::XTrans(_) => {
            let camera_rgb = stage("tile_demosaic", || match quality {
                RenderQuality::Preview => demosaic::xtrans_bilinear(mosaic, raw.cfa),
                _ => demosaic::markesteijn(mosaic, raw.cfa),
            });
            finish(camera_rgb, raw, model, active_area)?
        }
        _ => bayer(
            mosaic,
            raw,
            model,
            quality,
            active_area,
            tile_origin,
            cancel,
        ),
    };
    if cancel.is_cancelled() {
        return Err(Error::Cancelled);
    }
    Ok(warp(camera_rgb, raw, model, quality, tile_origin))
}

/// The ordinary tile prefix and its frame-anchored highlight recovery, so a
/// bounded context matches the same region of the full-frame plate.
fn bayer(
    mosaic: &Image,
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
    active_area: Option<CropRect>,
    tile_origin: (u32, u32),
    cancel: CancelToken<'_>,
) -> Image {
    let divisor = crate::pipeline::develop::effective_quality_divisor(quality, raw.cfa);
    let sensor_origin = (tile_origin.0 * divisor, tile_origin.1 * divisor);
    let mut camera_rgb =
        super::prefix::from_mosaic(mosaic, raw, model, quality, sensor_origin, cancel);
    let lazy_scene = super::highlight_frame::LazyScene::new(raw, model, cancel);
    let frame = super::highlight_frame::anchor(raw, quality, tile_origin, &lazy_scene);
    stage("tile_highlight_recovery", || {
        highlight_recovery::apply_in_sensor_space(
            &mut camera_rgb,
            model.highlight_recovery,
            raw.as_shot_neutral,
            raw.baseline_exposure,
            active_area,
            Some(frame),
            crate::sensor_gain_maps::ClipGainContext::new(raw, sensor_origin, divisor),
        )
    });
    camera_rgb
}

/// The bounded supported OpcodeList3 warp, after highlight recovery and in
/// the same sensor-space coordinate system as the full-image path.
/// Unsupported forms are rejected by the ordinary tile guard; removal uses a
/// zero-correction anchor model.
fn warp(
    mut camera_rgb: Image,
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
    tile_origin: (u32, u32),
) -> Image {
    let Some((list, opcode_active_area)) = raw.opcode_list3.as_ref() else {
        return camera_rgb;
    };
    if list.opcodes.len() != 1 {
        return camera_rgb;
    }
    let crate::pipeline::pano::opcodes::PanoOpcode::WarpRectilinear(w) = &list.opcodes[0] else {
        return camera_rgb;
    };
    stage("tile_opcode_list3", || {
        let divisor = crate::pipeline::develop::effective_quality_divisor(quality, raw.cfa);
        let full_w = raw.width / divisor;
        let full_h = raw.height / divisor;
        let scaled_active_area = crate::pipeline::pano::opcode_apply::scale_active_area(
            *opcode_active_area,
            1.0 / divisor as f32,
            full_w,
            full_h,
        );
        let scales = crate::pipeline::pano::opcode_apply::LensCorrectionScales::from_model(model);
        crate::pipeline::pano::opcode_apply::apply_warp_rectilinear_windowed(
            &mut camera_rgb,
            w,
            scaled_active_area,
            scales.distortion,
            scales.ca,
            tile_origin,
        );
    });
    camera_rgb
}

/// Sensor-relative gain/reconstruction shared by bounded Bayer, X-Trans and
/// already-demosaiced LinearRaw calibration inputs (#3955).
pub(super) fn finish(
    mut camera_rgb: Image,
    raw: &RawImage,
    model: &AdjustmentModel,
    active_area: Option<CropRect>,
) -> Result<Image> {
    if raw.baseline_exposure.abs() > 1e-4 {
        stage("tile_baseline_exposure", || {
            let be_gain = raw.baseline_exposure.exp2();
            for p in &mut camera_rgb.pixels {
                p[0] *= be_gain;
                p[1] *= be_gain;
                p[2] *= be_gain;
            }
        });
    }

    // Match the full camera prefix: 8-bit lossy LinearRaw already has WB
    // baked into its gamma-decoded samples; every other format gets pre-gain.
    let skip_pre_gain =
        matches!(raw.cfa, crate::image::CfaPattern::LinearRgb) && raw.white_level <= 255;
    if !skip_pre_gain {
        stage("tile_white_balance::apply_pre_gain", || {
            white_balance::apply_pre_gain(&mut camera_rgb, raw.as_shot_neutral)
        });
    }
    stage("tile_highlight_recovery", || {
        highlight_recovery::apply_in_region(
            &mut camera_rgb,
            model.highlight_recovery,
            if skip_pre_gain {
                [1.0; 3]
            } else {
                raw.as_shot_neutral
            },
            raw.baseline_exposure,
            active_area,
        )
    });
    Ok(camera_rgb)
}
