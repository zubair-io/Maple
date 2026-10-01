//! Shared bounded camera prefix before user WB / DCP (#3955).
use crate::{
    demosaic,
    error::Result,
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
) -> Result<Image> {
    mosaic.assert_space(crate::image::ColorSpace::CameraNativeMosaic);
    // Full uses RCD like every other on-screen path (#3412). Its 5-px
    // stencil sits far inside `TILE_OVERLAP_PX` (48), so the padded crop's
    // interior — the part `trim_image_to_inner` keeps — is reconstructed
    // from real neighbours and a tile matches the same region of the
    // full-image render.
    let mut camera_rgb = stage("tile_demosaic", || match raw.cfa {
        // The removal context aligns to six sensor pixels. Ordinary tiles
        // continue to reject X-Trans in guards before reaching this function.
        crate::image::CfaPattern::XTrans(_) => match quality {
            RenderQuality::Preview => demosaic::xtrans_bilinear(mosaic, raw.cfa),
            _ => demosaic::markesteijn(mosaic, raw.cfa),
        },
        _ => {
            let algo = crate::pipeline::bayer_kernel(quality, model, raw);
            demosaic::demosaic(algo, mosaic, raw.cfa)
        }
    });
// Apply the bounded supported OpcodeList3 warp in the same sensor-space
    // coordinate system as the full-image path. Unsupported forms are rejected
    // by the ordinary tile guard; removal uses a zero-correction anchor model.
    if let Some((list, opcode_active_area)) = raw.opcode_list3.as_ref() {
        if list.opcodes.len() == 1 {
            if let crate::pipeline::pano::opcodes::PanoOpcode::WarpRectilinear(w) = &list.opcodes[0] {
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
            }
        }
    }
    finish(camera_rgb, raw, model, active_area)
}

/// Sensor-relative gain/reconstruction shared by bounded Bayer, X-Trans and
/// already-demosaiced LinearRaw calibration inputs (#3955).
pub(super) fn finish(
    mut camera_rgb: Image,
    raw: &RawImage,
    model: &AdjustmentModel,
    active_area: Option<CropRect>,
) -> Result<Image>
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
