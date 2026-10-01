//! Sized camera prefix and optical geometry, before user WB/DCP (#3955).
//! Extracted without changing ordinary stage arithmetic or half-resolution policy.
use crate::pipeline::{
    develop::{crop_to_default, effective_quality_divisor, lateral_ca},
    dump_after, stage, RenderQuality,
};
use crate::{
    cancel::CancelToken,
    demosaic,
    error::{Error, Result},
    image::{Image, RawImage},
    linearize,
    stages::{highlight_recovery, hot_pixel, white_balance},
    xmp::AdjustmentModel,
};

pub(super) fn prepare_unwarped(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
    max_long_edge: u32,
    cancel: CancelToken<'_>,
) -> Result<(Image, bool, u32)> {
    if cancel.is_cancelled() {
        return Err(Error::Cancelled);
    }
    // DefaultCrop coordinate divisor — tracks the demosaic output resolution so
    // `crop_to_default` (below) maps sensor-crop coords onto the actual
    // post-demosaic buffer. The Bayer arm overrides this to 2 when it drops to
    // half-res demosaic for a small target (#1637).
    let mut crop_divisor = effective_quality_divisor(quality, raw.cfa);
    let mut camera_rgb = match raw.cfa {
        crate::image::CfaPattern::LinearRgb => stage("sized_linearraw_decode", || {
            linearize::linearraw_to_camera_rgb(raw)
        })?,
        crate::image::CfaPattern::XTrans(_) => {
            // X-Trans dispatch — see `develop.rs` for the rationale.
            let mut mosaic = stage("sized_linearize", || linearize::sensor_linearize(raw));
            // Hot/dead-pixel suppression (#1106) — see the unsized variant.
            stage("sized_hot_pixel", || {
                hot_pixel::apply(&mut mosaic, raw.cfa, model.hot_pixel_suppression)
            });
            lateral_ca(&mut mosaic, raw, model, cancel)?;
            stage("sized_demosaic_xtrans", || match quality {
                RenderQuality::Preview => demosaic::xtrans_bilinear(&mosaic, raw.cfa),
                RenderQuality::Full | RenderQuality::Amaze | RenderQuality::Auto => {
                    demosaic::markesteijn(&mosaic, raw.cfa)
                }
            })
        }
        _ => {
            let mut mosaic = stage("sized_linearize", || linearize::sensor_linearize(raw));
            // Hot/dead-pixel suppression (#1106) — see the unsized variant.
            stage("sized_hot_pixel", || {
                hot_pixel::apply(&mut mosaic, raw.cfa, model.hot_pixel_suppression)
            });
            lateral_ca(&mut mosaic, raw, model, cancel)?;
            // #1637: when the requested long edge is at most half the sensor's,
            // demosaic at HALF resolution (`half_res`, sensor/2) even for
            // Full/Amaze. The full-res RGB buffer (~1.4 GB on a 100 MP sensor)
            // is then never allocated — that buffer (held twice on a cold Auto
            // open: render + auto-profile fit) is what jetsam-killed iOS on
            // large RAWs. Half-sensor still exceeds the sub-half-sensor target,
            // but reconstruction and nonlinear colour/NR do not commute with
            // resizing. #3875 tracks preview/export qualification; pixel
            // dimensions alone do not prove perceptual parity. `crop_divisor`
            // follows to 2 so DefaultCrop still lands on the half-res buffer.
            let sensor_le = mosaic.width.max(mosaic.height);
            let demosaic_half =
                quality != RenderQuality::Preview && max_long_edge.saturating_mul(2) <= sensor_le;
            if demosaic_half {
                crop_divisor = 2;
            }
            // Kernel choice via `bayer_kernel` (#3413); see the unsized
            // variant. The `demosaic_half` short-circuit above outranks it:
            // once the target is small enough to bin, there is no
            // full-resolution reconstruction left for a kernel to differ on.
            stage("sized_demosaic", || {
                if demosaic_half {
                    return demosaic::half_res_cancellable(&mosaic, raw.cfa, cancel);
                }
                let algo = crate::pipeline::bayer_kernel(quality, model, raw);
                demosaic::demosaic_cancellable(algo, &mosaic, raw.cfa, cancel)
            })
        }
    };
    if cancel.is_cancelled() {
        return Err(Error::Cancelled);
    }

    // Match full develop: reconstruct sensor clipping before lens gain,
    // warp, or downsampling mixes the clipped channels (#3633).
    if raw.baseline_exposure.abs() > 1e-4 {
        stage("sized_baseline_exposure", || {
            let be_gain = raw.baseline_exposure.exp2();
            for p in &mut camera_rgb.pixels {
                p[0] *= be_gain;
                p[1] *= be_gain;
                p[2] *= be_gain;
            }
        });
    }
    dump_after("00a_baseline_exposure", &camera_rgb);

    // WB pre-gain (mirrors the unsized variant — see comment there).
    let skip_pre_gain =
        matches!(raw.cfa, crate::image::CfaPattern::LinearRgb) && raw.white_level <= 255;
    if !skip_pre_gain {
        stage("sized_white_balance::apply_pre_gain", || {
            white_balance::apply_pre_gain(&mut camera_rgb, raw.as_shot_neutral)
        });
    }
    // See unsized variant (ticket #325, skip_pre_gain identity branch).
    let hr_neutral = if skip_pre_gain {
        [1.0; 3]
    } else {
        raw.as_shot_neutral
    };
    stage("sized_highlight_recovery", || {
        highlight_recovery::apply_in_region(
            &mut camera_rgb,
            model.highlight_recovery,
            hr_neutral,
            raw.baseline_exposure,
            crate::pipeline::develop::highlight_active_area(raw, crop_divisor),
        )
    });
    dump_after("00b_highlight_recovery", &camera_rgb);

    Ok((camera_rgb, skip_pre_gain, crop_divisor))
}

pub(super) fn finish_geometry(
    raw: &RawImage,
    model: &AdjustmentModel,
    mut camera_rgb: Image,
    crop_divisor: u32,
) -> Result<Image> {
    // Stage 2a (#1695): OpcodeList3 still precedes DefaultCrop, so its
    // coordinates remain relative to the original ActiveArea.
    if let Some((list, aa)) = raw.opcode_list3.as_ref() {
        stage("sized_opcode_list3", || {
            let scale = camera_rgb.width as f32 / raw.width as f32;
            let scaled_aa = crate::pipeline::pano::opcode_apply::scale_active_area(
                *aa,
                scale,
                camera_rgb.width,
                camera_rgb.height,
            );
            crate::pipeline::pano::opcode_apply::apply_opcode_list3(
                &mut camera_rgb,
                list,
                scaled_aa,
                crate::pipeline::pano::opcode_apply::LensCorrectionScales::from_model(model),
            );
        });
        dump_after("01a_opcode_list3", &camera_rgb);
    } else if crate::lens_profile::applies(raw, model) {
        let scale = camera_rgb.width as f32 / raw.width as f32;
        stage("sized_lcp_correction", || {
            crate::lens_profile::apply_for_raw(raw, model, &mut camera_rgb, scale)
        })?;
    }

    // DefaultCrop BEFORE downsample — `crop_rect` is in raw-sensor coords
    // (or half of them for Preview). Applying after the downsample would
    // mean translating the crop into post-downsample coords, which the
    // sized variant doesn't have a clean handle for. Crop first, then
    // let `downsample_image_area` decide whether the cropped buffer is
    // still over the long-edge cap. See ticket #375.
    if let Some(crop) = raw.crop_rect {
        if let Some(cropped) = stage("sized_crop_to_default", || {
            crop_to_default(&camera_rgb, crop, crop_divisor)
        }) {
            camera_rgb = cropped;
        }
        // No-op: keep camera_rgb as-is; crop_to_default returns None
        // instead of cloning the buffer.
    }
    dump_after("01b_crop_to_default", &camera_rgb);

    Ok(camera_rgb)
}
