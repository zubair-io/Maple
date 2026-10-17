//! Sized camera preparation, before lens geometry and display-side stages.
use crate::pipeline::{
    develop::{effective_quality_divisor, lateral_ca},
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

pub(crate) fn prepare_camera(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
    max_long_edge: u32,
    cancel: CancelToken<'_>,
) -> Result<(Image, u32)> {
    // DefaultCrop coordinate divisor — tracks the demosaic output resolution so
    // `crop_to_default` (below) maps sensor-crop coords onto the actual
    // post-demosaic buffer. The Bayer arm overrides this to 2 when it drops to
    // half-res demosaic for a small target (#1637).
    let mut crop_divisor = effective_quality_divisor(quality, raw.cfa);
    let (mut camera_rgb, sensor_gains) = match raw.cfa {
        crate::image::CfaPattern::LinearRgb => (
            stage("sized_linearraw_decode", || {
                linearize::linearraw_to_camera_rgb(raw)
            })?,
            None,
        ),
        crate::image::CfaPattern::XTrans(_) => {
            // X-Trans dispatch — see `develop.rs` for the rationale.
            let mut mosaic = stage("sized_linearize", || linearize::sensor_linearize(raw));
            // Hot/dead-pixel suppression (#1106) — see the unsized variant.
            stage("sized_hot_pixel", || {
                hot_pixel::apply(&mut mosaic, raw.cfa, model.hot_pixel_suppression)
            });
            lateral_ca(&mut mosaic, raw, model, cancel)?;
            let rgb = stage("sized_demosaic_xtrans", || match quality {
                RenderQuality::Preview => demosaic::xtrans_bilinear(&mosaic, raw.cfa),
                RenderQuality::Full | RenderQuality::Amaze | RenderQuality::Auto => {
                    demosaic::markesteijn(&mosaic, raw.cfa)
                }
            });
            (rgb, None)
        }
        _ => {
            let mut mosaic = stage("sized_linearize", || linearize::sensor_linearize(raw));
            // Hot/dead-pixel suppression (#1106) — see the unsized variant.
            stage("sized_hot_pixel", || {
                hot_pixel::apply(&mut mosaic, raw.cfa, model.hot_pixel_suppression)
            });
            let ca = lateral_ca(&mut mosaic, raw, model, cancel)?;
            let gains = crate::linearize::sensor_gains::SensorGains::for_raw(raw, (0, 0), 1)
                .map(|g| g.with_ca(ca));
            // #1637: when the requested long edge is at most half the sensor's,
            // demosaic at HALF resolution (`half_res`, sensor/2) even for
            // Full/Amaze. The full-res RGB buffer (~1.4 GB on a 100 MP sensor)
            // is then never allocated — that buffer (held twice on a cold Auto
            // open: render + auto-profile fit) is what jetsam-killed iOS on
            // large RAWs. Half-sensor still exceeds the sub-half-sensor target,
            // but this is an approximation: reconstruction and nonlinear
            // colour/NR stages do not commute with resizing. #3875 tracks
            // preview/export qualification; adequate pixel dimensions alone
            // do not prove perceptual parity. `crop_divisor` follows to 2 so the
            // DefaultCrop coords still land on the (now half-res) buffer.
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
            let rgb = stage("sized_demosaic", || {
                if demosaic_half {
                    return demosaic::half_res_cancellable(&mosaic, raw.cfa, cancel);
                }
                let algo = crate::pipeline::bayer_kernel(quality, model, raw);
                demosaic::demosaic_calibrated_cancellable(
                    algo,
                    &mosaic,
                    raw.cfa,
                    raw.as_shot_neutral,
                    gains,
                    cancel,
                )
            });
            (rgb, gains)
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
        highlight_recovery::apply_calibrated_in_region(
            &mut camera_rgb,
            model.highlight_recovery,
            hr_neutral,
            raw.baseline_exposure,
            crate::pipeline::develop::highlight_active_area(raw, crop_divisor),
            None,
            sensor_gains.map(|g| g.at_resolution(crop_divisor)),
        )
    });
    dump_after("00b_highlight_recovery", &camera_rgb);

    Ok((camera_rgb, crop_divisor))
}
