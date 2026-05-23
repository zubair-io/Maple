//! Sized variant of the develop chain — runs `linearize` + `demosaic` (or
//! `linearraw_to_camera_rgb` for LinearRaw), then immediately downsamples
//! the camera-RGB buffer to fit within `max_long_edge`, then runs the rest
//! of the development chain on the smaller buffer. Saves ~8× on every
//! post-demosaic stage when the source is 100 MP and the viewport is ~3 MP.
//!
//! Per-stage profile labels are prefixed `sized_` so `MAPLE_PROFILE=1`
//! traces don't collide with the full-res `develop_*` labels — same
//! convention the tile path uses (`tile_*`).
//!
//! Stages match the full-res variant in `super::develop` (see that
//! module's docstring for the canonical list); only the labels differ.

use crate::{
    color::dcp,
    demosaic,
    error::Result,
    image::RawImage,
    linearize,
    stages::{
        auto_exposure, capture_sharpening, clarity, dehaze, highlight_recovery, local_adjustments,
        noise_reduction, saturation, scene_tone_controls, sharpen, texture, tone_curves, vibrance,
        white_balance,
    },
    xmp::AdjustmentModel,
};

use super::{
    capture_sharpening_helper::capture_sharpening_params_from_model,
    develop::{crop_to_default, quality_divisor},
    downsample::downsample_image_area,
    dump_after, stage, RenderQuality, AUTO_EXPOSURE_CLIP_PCT,
};

/// Sized variant of `develop_scene_linear_from_raw_with_quality` that
/// runs `linearize` + `demosaic` (or `linearraw_to_camera_rgb` for
/// LinearRaw fixtures), then immediately downsamples the camera-RGB
/// buffer to fit within `max_long_edge`, then runs the rest of the
/// development chain on the smaller buffer. Saves ~8× on every
/// post-demosaic stage when the source is 100 MP and the viewport is
/// ~3 MP. See ticket 06 § Recommended Milestones / Milestone 3 and
/// .archived-plans/specs/2026-04-25-ticket-06-m3-earlier-downsample-brief.md.
///
/// Per-stage profile labels are prefixed `sized_` so MAPLE_PROFILE=1
/// traces don't collide with the full-res `develop_…` labels — same
/// convention the tile path uses (`tile_*`).
///
/// Never upscales: `downsample_image_area` early-returns when the
/// source long edge is already <= `max_long_edge`. In that case this
/// helper is functionally identical to
/// `develop_scene_linear_from_raw_with_quality`, only with `sized_*`
/// stage labels.
pub fn develop_scene_linear_sized_from_raw_with_quality(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
    max_long_edge: u32,
) -> Result<crate::image::Image> {
    let mut camera_rgb = match raw.cfa {
        crate::image::CfaPattern::LinearRgb => {
            stage("sized_linearraw_decode", || linearize::linearraw_to_camera_rgb(raw))?
        }
        _ => {
            let mosaic = stage("sized_linearize", || linearize::sensor_linearize(raw));
            stage("sized_demosaic", || match quality {
                RenderQuality::Preview => demosaic::half_res(&mosaic, raw.cfa),
                #[cfg(feature = "high-quality-demosaic")]
                RenderQuality::Full => demosaic::hamilton_adams(&mosaic, raw.cfa),
                #[cfg(not(feature = "high-quality-demosaic"))]
                RenderQuality::Full => demosaic::bilinear(&mosaic, raw.cfa),
                RenderQuality::Amaze => demosaic::amaze(&mosaic, raw.cfa),
            })
        }
    };

    // DefaultCrop BEFORE downsample — `crop_rect` is in raw-sensor coords
    // (or half of them for Preview). Applying after the downsample would
    // mean translating the crop into post-downsample coords, which the
    // sized variant doesn't have a clean handle for. Crop first, then
    // let `downsample_image_area` decide whether the cropped buffer is
    // still over the long-edge cap. See ticket #375.
    if let Some(crop) = raw.crop_rect {
        if let Some(cropped) = stage("sized_crop_to_default", || {
            crop_to_default(&camera_rgb, crop, quality_divisor(quality))
        }) {
            camera_rgb = cropped;
        }
        // No-op: keep camera_rgb as-is; crop_to_default returns None
        // instead of cloning the buffer.
    }
    dump_after("00b_crop_to_default", &camera_rgb);

    // Early downsample — the heart of this milestone. After this call
    // every later stage runs on the viewport-sized buffer instead of
    // the half-res sensor buffer. `downsample_image_area` is a no-op
    // when the source long edge is already <= `max_long_edge`.
    stage("sized_downsample_area_f32", || {
        downsample_image_area(&mut camera_rgb, max_long_edge)
    });

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
    dump_after("01_baseline_exposure", &camera_rgb);

    // WB pre-gain (mirrors the unsized variant — see comment there).
    let skip_pre_gain = matches!(raw.cfa, crate::image::CfaPattern::LinearRgb)
        && raw.white_level <= 255;
    if !skip_pre_gain {
        stage("sized_white_balance::apply_pre_gain", || {
            white_balance::apply_pre_gain(&mut camera_rgb, raw.as_shot_neutral)
        });
    }
    // See unsized variant (ticket #325, skip_pre_gain identity branch).
    let hr_neutral = if skip_pre_gain { [1.0; 3] } else { raw.as_shot_neutral };
    stage("sized_highlight_recovery", || highlight_recovery::apply(&mut camera_rgb, model.highlight_recovery, hr_neutral));
    dump_after("02_highlight_recovery", &camera_rgb);
    let (profile, source) = stage("sized_dcp_profile_for", || dcp::profile_for_with_source(raw))?;
    // PTC suppression when bundled — see the comment in the full-res
    // variant. PLT stays for DNG-Converter inputs. `source` is the
    // same lookup result `profile_for_with_source` already produced — no
    // redundant HashMap probe in the sized path either.
    let use_bundled = matches!(source, dcp::ProfileSource::Bundled);
    let ptc_for_apply = if use_bundled { None } else { raw.profile_tone_curve.as_ref() };
    let mut scene = stage("sized_dcp_apply", || dcp::apply_with_plt_and_ptc(
        &camera_rgb, &profile, raw.plt.as_ref(), ptc_for_apply,
    ))?;
    dump_after("03_dcp_apply", &scene);
    if let Some(pgtm) = raw.profile_gain_table_map.as_ref() {
        stage("sized_profile_gain_table_map", || {
            crate::color::profile_gain_table_map::apply(&mut scene, pgtm)
        });
    }
    dump_after("04_profile_gain_table_map", &scene);
    if let Some(params) = capture_sharpening_params_from_model(model) {
        stage("sized_capture_sharpening", || {
            capture_sharpening::apply_capture_sharpening(&mut scene, &params)
        });
    }
    dump_after("04b_capture_sharpening", &scene);
    stage("sized_auto_exposure", || auto_exposure::apply(&mut scene, AUTO_EXPOSURE_CLIP_PCT));
    dump_after("05_auto_exposure", &scene);
    stage("sized_white_balance", || white_balance::apply(&mut scene, model.temperature, model.tint));
    dump_after("06_white_balance", &scene);
    stage("sized_scene_tone_controls", || scene_tone_controls::apply(&mut scene, model));
    dump_after("07_scene_tone_controls", &scene);
    stage("sized_tone_curves", || tone_curves::apply(&mut scene, model));
    dump_after("07b_tone_curves", &scene);
    stage("sized_vibrance", || vibrance::apply(&mut scene, model.vibrance));
    dump_after("08_vibrance", &scene);
    stage("sized_saturation", || saturation::apply(&mut scene, model.saturation));
    dump_after("09_saturation", &scene);
    stage("sized_clarity", || clarity::apply(&mut scene, model.clarity));
    dump_after("10_clarity", &scene);
    stage("sized_texture", || texture::apply(&mut scene, model.texture));
    dump_after("11_texture", &scene);
    stage("sized_dehaze", || dehaze::apply(&mut scene, model.dehaze));
    dump_after("12_dehaze", &scene);
    stage("sized_local_adjustments", || {
        local_adjustments::apply(&mut scene, &model.local_adjustments)
    });
    dump_after("12b_local_adjustments", &scene);
    stage("sized_sharpen", || sharpen::apply(&mut scene, model.sharpen_amount, model.sharpen_radius, model.sharpen_detail, model.sharpen_masking));
    dump_after("13_sharpen", &scene);
    stage("sized_nr_luminance", || noise_reduction::apply_luminance(&mut scene, model.nr_luminance));
    dump_after("14_nr_luminance", &scene);
    stage("sized_nr_color", || noise_reduction::apply_color(&mut scene, model.nr_color));
    dump_after("15_nr_color", &scene);
    Ok(scene)
}
