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
    cancel::CancelToken,
    color::dcp,
    demosaic,
    error::{Error, Result},
    image::RawImage,
    linearize,
    stages::{
        auto_exposure, bm3d, capture_sharpening, chroma_prefilter, clarity, dehaze,
        highlight_recovery, highlight_recovery_oklab, hot_pixel, local_adjustments,
        noise_reduction, saturation, scene_tone_controls, sharpen, texture, tone_curves, vibrance,
        vignette, wb_camera, white_balance,
    },
    xmp::AdjustmentModel,
};

use super::{
    capture_sharpening_helper::capture_sharpening_params_from_model,
    develop::{crop_to_default, effective_quality_divisor},
    downsample::downsample_image_area,
    dump_after, stage, RenderQuality,
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
/// Non-cancellable wrapper — forwards to
/// [`develop_scene_linear_sized_from_raw_with_quality_cancellable`] with a
/// never-cancel token, so a completed sized develop is byte-for-byte
/// identical to before #951.
#[inline]
pub fn develop_scene_linear_sized_from_raw_with_quality(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
    max_long_edge: u32,
) -> Result<crate::image::Image> {
    develop_scene_linear_sized_from_raw_with_quality_cancellable(
        raw,
        model,
        quality,
        max_long_edge,
        CancelToken::never(),
    )
}

/// Cancellable variant of
/// [`develop_scene_linear_sized_from_raw_with_quality`]. Same early-downsample
/// chain, with `cancel` threaded into the expensive stage kernels and checked
/// at the top + after each heavy stage (returns `Err(Error::Cancelled)` on a
/// host cancel). The fast-phase RAW open routes through here, so this is the
/// path the editor actually interrupts on a slider tick during a cold open
/// (#951). Never-cancel ⇒ bit-identical to the wrapper above.
pub fn develop_scene_linear_sized_from_raw_with_quality_cancellable(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
    max_long_edge: u32,
    cancel: CancelToken<'_>,
) -> Result<crate::image::Image> {
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
            stage("sized_demosaic_xtrans", || match quality {
                RenderQuality::Preview => demosaic::xtrans_bilinear(&mosaic, raw.cfa),
                RenderQuality::Full | RenderQuality::Amaze => {
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
            // #1637: when the requested long edge is at most half the sensor's,
            // demosaic at HALF resolution (`half_res`, sensor/2) even for
            // Full/Amaze. The full-res RGB buffer (~1.4 GB on a 100 MP sensor)
            // is then never allocated — that buffer (held twice on a cold Auto
            // open: render + auto-profile fit) is what jetsam-killed iOS on
            // large RAWs. After the early downsample to `max_long_edge` the
            // on-screen result is unchanged (half-sensor still exceeds the
            // sub-half-sensor target). `crop_divisor` follows to 2 so the
            // DefaultCrop coords still land on the (now half-res) buffer.
            let sensor_le = mosaic.width.max(mosaic.height);
            let demosaic_half =
                quality != RenderQuality::Preview && max_long_edge.saturating_mul(2) <= sensor_le;
            if demosaic_half {
                crop_divisor = 2;
            }
            // Interactive Bayer paths use cancellable kernels; see the
            // unsized variant for the AMaZE / HA rationale.
            stage("sized_demosaic", || {
                if demosaic_half {
                    return demosaic::half_res_cancellable(&mosaic, raw.cfa, cancel);
                }
                match quality {
                    RenderQuality::Preview => {
                        demosaic::half_res_cancellable(&mosaic, raw.cfa, cancel)
                    }
                    #[cfg(feature = "high-quality-demosaic")]
                    RenderQuality::Full => demosaic::hamilton_adams(&mosaic, raw.cfa),
                    #[cfg(not(feature = "high-quality-demosaic"))]
                    RenderQuality::Full => demosaic::bilinear_cancellable(&mosaic, raw.cfa, cancel),
                    RenderQuality::Amaze => demosaic::amaze(&mosaic, raw.cfa),
                }
            })
        }
    };
    if cancel.is_cancelled() {
        return Err(Error::Cancelled);
    }

    // Stage 2a (#1695): DNG OpcodeList3 on the demosaiced linear data, in
    // ActiveArea coordinates — i.e. BEFORE DefaultCrop moves the origin.
    if let Some((list, aa)) = raw.opcode_list3.as_ref() {
        stage("sized_opcode_list3", || {
            let scale = camera_rgb.width as f32 / raw.width as f32;
            let scaled_aa = if (scale - 1.0).abs() > 1e-4 {
                crate::pipeline::pano::opcodes::ActiveAreaRect {
                    top: ((aa.top as f32) * scale).round() as u32,
                    left: ((aa.left as f32) * scale).round() as u32,
                    width: ((aa.width as f32) * scale).round() as u32,
                    height: ((aa.height as f32) * scale).round() as u32,
                }
            } else {
                *aa
            };
            crate::pipeline::pano::opcode_apply::apply_opcode_list3(
                &mut camera_rgb,
                list,
                scaled_aa,
            );
        });
        dump_after("00a_opcode_list3", &camera_rgb);
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
        highlight_recovery::apply(&mut camera_rgb, model.highlight_recovery, hr_neutral)
    });
    dump_after("02_highlight_recovery", &camera_rgb);
    let (profile, profile_source) = stage("sized_dcp_profile_for", || {
        dcp::profile_for_with_source(raw)
    })?;
    // Camera-space user white balance (#1726) — mirrors the full-res
    // develop chain exactly; see `super::develop` and `stages::wb_camera`
    // for the full design writeup and the `RawlerFallback` tier-gate
    // rationale.
    let camera_wb_target =
        if !skip_pre_gain && !matches!(profile_source, dcp::ProfileSource::RawlerFallback) {
            let frame = wb_camera::SliderFrame::resolve(raw, &profile);
            let (target_temperature, target_tint) = wb_camera::resolve_target(model, &frame);
            stage("sized_wb_camera::apply", || {
                wb_camera::apply(
                    &mut camera_rgb,
                    &frame,
                    raw.as_shot_neutral,
                    target_temperature,
                    target_tint,
                )
            });
            Some((frame, target_temperature, target_tint))
        } else {
            None
        };
    let camera_wb_applied = camera_wb_target.is_some();
    dump_after("02b_wb_camera", &camera_rgb);
    // DNG-spec `SetWhiteXY` retarget (#1727) — mirrors `super::develop`:
    // DCP's rendering matrices track the user's target when camera-space
    // WB moved off as-shot; as-shot targets return the profile unchanged
    // (bit-identical). See `wb_camera::retargeted_render_profile`.
    let dcp_profile = match &camera_wb_target {
        Some((frame, target_temperature, target_tint)) => {
            wb_camera::retargeted_render_profile(frame, profile, *target_temperature, *target_tint)
        }
        None => profile,
    };
    // Colorimetry-only DCP per #425 — see `pipeline::develop` for the
    // rationale. PLT and PTC no longer run; HSM still does (metameric
    // correction).
    let mut scene = stage("sized_dcp_apply", || {
        dcp::apply_colorimetry(&camera_rgb, &dcp_profile)
    })?;
    dump_after("03_dcp_apply", &scene);
    // Ticket #471: post-DCP Oklab chroma-reduction highlight recovery. See
    // `super::develop` for the rationale; no-op unless the user opts in via
    // `papp:HighlightRecoveryMode="OklabChromaReduction"`.
    stage("sized_highlight_recovery_oklab", || {
        highlight_recovery_oklab::apply_post_dcp(&mut scene, model.highlight_recovery)
    });
    dump_after("03b_oklab_highlight_recovery", &scene);
    if let Some(pgtm) = raw.profile_gain_table_map.as_ref() {
        stage("sized_profile_gain_table_map", || {
            crate::color::profile_gain_table_map::apply(&mut scene, pgtm)
        });
    }
    dump_after("04_profile_gain_table_map", &scene);
    // Decode-time chroma pre-filter (#1104) — runs on the downsampled
    // buffer here; same position as the unsized variant (post-PGTM, pre
    // capture-sharpening). No-op at the default 0.
    stage("sized_chroma_prefilter", || {
        chroma_prefilter::apply(&mut scene, model.chroma_prefilter)
    });
    dump_after("04a_chroma_prefilter", &scene);
    // BM3D deep denoise (#1105) — runs on the downsampled buffer here;
    // same position as the unsized variant. See that variant's comment.
    stage("sized_deep_denoise", || {
        bm3d::apply_cancellable(&mut scene, model.deep_denoise, cancel, bm3d::env_progress())
    });
    if cancel.is_cancelled() {
        return Err(Error::Cancelled);
    }
    dump_after("04ab_deep_denoise", &scene);
    if let Some(params) = capture_sharpening_params_from_model(model) {
        // Cancellable RL deconvolution (#1089) — same rationale as the
        // unsized develop chain. Observes `cancel` between iterations / per
        // row; the post-stage check is defense-in-depth around the `?`.
        stage("sized_capture_sharpening", || {
            capture_sharpening::apply_capture_sharpening_cancellable(&mut scene, &params, cancel)
        })?;
        if cancel.is_cancelled() {
            return Err(Error::Cancelled);
        }
    }
    dump_after("04b_capture_sharpening", &scene);
    stage("sized_auto_exposure", || {
        auto_exposure::apply(&mut scene, model)
    });
    dump_after("05_auto_exposure", &scene);
    // Post-DCP white balance — skipped when camera-space WB already ran
    // (#1726); see `super::develop` for the full rationale. Falls through
    // to the ACR-anchored CAT16 path (#1729 / round-trip fix, #1725 band
    // fix) via the shared `white_balance::resolve_wb` helper otherwise.
    if !camera_wb_applied {
        let (effective_temperature, effective_tint) = white_balance::resolve_wb(model);
        stage("sized_white_balance", || {
            white_balance::apply(
                &mut scene,
                effective_temperature,
                effective_tint,
                model.wb_method,
            )
        });
    }
    dump_after("06_white_balance", &scene);
    stage("sized_scene_tone_controls", || {
        scene_tone_controls::apply(&mut scene, model)
    });
    dump_after("07_scene_tone_controls", &scene);
    stage("sized_tone_curves", || {
        tone_curves::apply(&mut scene, model)
    });
    dump_after("07b_tone_curves", &scene);
    stage("sized_vibrance", || {
        vibrance::apply(&mut scene, model.vibrance)
    });
    dump_after("08_vibrance", &scene);
    stage("sized_saturation", || {
        saturation::apply(&mut scene, model.saturation)
    });
    dump_after("09_saturation", &scene);
    stage("sized_clarity", || {
        clarity::apply(&mut scene, model.clarity)
    });
    dump_after("10_clarity", &scene);
    stage("sized_texture", || {
        texture::apply(&mut scene, model.texture)
    });
    dump_after("11_texture", &scene);
    stage("sized_dehaze", || dehaze::apply(&mut scene, model.dehaze));
    dump_after("12_dehaze", &scene);
    stage("sized_local_adjustments", || {
        local_adjustments::apply(&mut scene, &model.local_adjustments)
    });
    dump_after("12b_local_adjustments", &scene);
    // Vignette (#1109) — normalized elliptical radius makes the gain field
    // resolution-invariant, so the sized render agrees with the full-res
    // one at any viewport scale. Same chain position as the unsized funnel.
    stage("sized_vignette", || {
        vignette::apply(&mut scene, model.vignette_amount, model.vignette_feather)
    });
    dump_after("12c_vignette", &scene);
    stage("sized_sharpen", || {
        sharpen::apply_cancellable(
            &mut scene,
            model.sharpen_amount,
            model.sharpen_radius,
            model.sharpen_detail,
            model.sharpen_masking,
            cancel,
        )
    });
    dump_after("13_sharpen", &scene);
    if cancel.is_cancelled() {
        return Err(Error::Cancelled);
    }
    stage("sized_nr_luminance", || {
        noise_reduction::apply_luminance_cancellable(
            &mut scene,
            model.nr_luminance,
            cancel,
            raw.noise_profile.as_deref(),
            raw.iso,
        )
    });
    dump_after("14_nr_luminance", &scene);
    if cancel.is_cancelled() {
        return Err(Error::Cancelled);
    }
    stage("sized_nr_color", || {
        noise_reduction::apply_color_cancellable(
            &mut scene,
            model.nr_color,
            cancel,
            raw.noise_profile.as_deref(),
            raw.iso,
        )
    });
    dump_after("15_nr_color", &scene);
    if cancel.is_cancelled() {
        return Err(Error::Cancelled);
    }
    Ok(scene)
}
