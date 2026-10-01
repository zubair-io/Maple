//! Sized variant of the develop chain. Sensor linearization and demosaic
//! are followed by baseline exposure, as-shot WB, highlight recovery,
//! OpcodeList3 and DefaultCrop before downsampling to `max_long_edge`.
//! This preserves sensor-clipping evidence before lens gain and interpolation
//! change it (#3633). User WB, DCP and later stages use the smaller buffer.
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
    error::{Error, Result},
    image::RawImage,
    stages::{
        auto_exposure, bm3d, capture_sharpening, chroma_prefilter, clarity, defringe, dehaze,
        highlight_recovery_oklab, hsl, local_adjustments,
        noise_reduction, retouch, saturation, scene_tone_controls, sharpen, texture, tone_curves,
        vibrance, vignette, wb_camera, white_balance,
    },
    xmp::AdjustmentModel,
};

use super::{
    capture_sharpening_helper::capture_sharpening_params_from_model,
    downsample::downsample_image_area, dump_after, stage, RenderQuality,
};

#[path = "develop_sized/camera.rs"]
mod camera;

/// Sized variant of `develop_scene_linear_from_raw_with_quality` that
/// runs `linearize` + `demosaic` (or `linearraw_to_camera_rgb` for
/// LinearRaw fixtures), then sensor highlight recovery and lens opcodes,
/// before downsampling camera RGB to `max_long_edge`. User WB, DCP and
/// subsequent stages run on the smaller buffer. Sensor recovery precedes
/// interpolation so mixed samples do not masquerade as sensor saturation. See ticket 06 § Recommended Milestones / Milestone 3 and
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
    develop_scene_linear_sized_from_raw_with_quality_cancellable_with_gain(
        raw,
        model,
        quality,
        max_long_edge,
        cancel,
    )
    .map(|(scene, _ae_gain)| scene)
}

/// Non-cancellable variant of
/// [`develop_scene_linear_sized_from_raw_with_quality_cancellable_with_gain`].
pub fn develop_scene_linear_sized_from_raw_with_quality_with_gain(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
    max_long_edge: u32,
) -> Result<(crate::image::Image, f32)> {
    develop_scene_linear_sized_from_raw_with_quality_cancellable_with_gain(
        raw,
        model,
        quality,
        max_long_edge,
        CancelToken::never(),
    )
}

/// Same sized develop chain as
/// [`develop_scene_linear_sized_from_raw_with_quality_cancellable`],
/// additionally returning the scalar gain the `auto_exposure` stage applied.
/// See the unsized sibling
/// (`super::develop::develop_scene_linear_from_raw_with_quality_cancellable_with_gain`)
/// for the full #1167 rationale — the editor's fast phase uses the sized
/// decode, so this is the entry that must export the gain for tile-develop
/// parity to hold on the interactive path, not just the cold full-res open.
pub fn develop_scene_linear_sized_from_raw_with_quality_cancellable_with_gain(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
    max_long_edge: u32,
    cancel: CancelToken<'_>,
) -> Result<(crate::image::Image, f32)> {
    develop_with_calibration_patches(raw, model, quality, max_long_edge, cancel, &[])
}

pub(super) fn develop_with_calibration_patches(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
    max_long_edge: u32,
    cancel: CancelToken<'_>,
    patches: &[crate::types::InpaintPatch],
) -> Result<(crate::image::Image, f32)> {
    let (camera, skip_pre_gain, crop_divisor) =
        camera::prepare_unwarped(raw, model, quality, max_long_edge, cancel)?;
    let mut camera_rgb = camera::finish_geometry(raw, model, camera, crop_divisor)?;

    // Early downsample — the heart of this milestone. After this call
    // every later stage runs on the viewport-sized buffer instead of
    // the half-res sensor buffer. `downsample_image_area` is a no-op
    // when the source long edge is already <= `max_long_edge`.
    stage("sized_downsample_area_f32", || {
        downsample_image_area(&mut camera_rgb, max_long_edge)
    });

    let (profile, profile_source) = stage("sized_dcp_profile_for", || {
        dcp::profile_for_with_source(raw)
    })?;
    let whites_anchor_ev = dcp::scene_white_anchor(&camera_rgb, &profile)?;
    if !patches.is_empty() {
        // Keep the original sized Whites statistic. Rebuild the same bounded
        // prefix after dropping it, then compose before optics and downsample.
        drop(camera_rgb);
        let (mut unwarped, _, divisor) =
            camera::prepare_unwarped(raw, model, quality, max_long_edge, cancel)?;
        let window = super::removal_calibration::sensor_buffer_window(
            raw,
            [unwarped.width, unwarped.height],
            divisor,
        );
        super::removal_calibration::composite_camera_sampled(
            &mut unwarped,
            patches,
            &profile,
            window,
            divisor,
        )?;
        camera_rgb = camera::finish_geometry(raw, model, unwarped, divisor)?;
        downsample_image_area(&mut camera_rgb, max_long_edge);
        if cancel.is_cancelled() {
            return Err(Error::Cancelled);
        }
    }
    // Camera-space user white balance (#1726) — mirrors the full-res
    // develop chain exactly; see `super::develop` and `stages::wb_camera`
    // for the full design writeup and the `RawlerFallback` tier-gate
    // rationale.
    let camera_wb_target =
        if !skip_pre_gain && !matches!(profile_source, dcp::ProfileSource::RawlerFallback) {
            let frame = wb_camera::SliderFrame::resolve(raw, &profile);
            // `resolve_target_versioned` (#1780): V1 (pre-#1756) sidecar
            // temperature/tint convert into the slider frame here so the
            // authored look is preserved; V2 models resolve unchanged.
            let (target_temperature, target_tint) =
                wb_camera::resolve_target_versioned(model, &frame, &profile, raw.as_shot_neutral);
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
    // ProfileGainTableMap is not applied on any path (#2774) — see
    // `super::develop` for the rationale.
    // Clone / heal repair spots (#3409) — same position as the unsized
    // variant. Spot coordinates are normalised, so they land on the same
    // scene features at this reduced resolution; the disc is simply smaller
    // in pixels, which is what a sized render wants.
    stage("sized_retouch", || {
        retouch::apply_cancellable(&mut scene, &model.retouch_spots, cancel)
    })?;
    dump_after("03c_retouch", &scene);
    // Decode-time chroma pre-filter (#1104) — runs on the downsampled
    // buffer here; same position as the unsized variant (post-DCP, pre
    // capture-sharpening). No-op at the default 0.
    stage("sized_chroma_prefilter", || {
        chroma_prefilter::apply(&mut scene, model.chroma_prefilter)
    });
    dump_after("04a_chroma_prefilter", &scene);
    // BM3D deep denoise (#1105) — runs on the downsampled buffer here;
    // same position as the unsized variant. See that variant's comment.
    stage("sized_deep_denoise", || {
        bm3d::apply_cancellable(
            &mut scene,
            model.deep_denoise,
            cancel,
            bm3d::active_progress(),
        )
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
    scene.whites_anchor_ev = Some(whites_anchor_ev);
    let ae_gain = stage("sized_auto_exposure", || {
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
    // HSL 8-band (#1112) — scene-linear Oklab, after saturation, before
    // clarity, matching `super::develop`. Was silently omitted here (#1931):
    // any non-default HSL adjustment made the sized/preview render diverge
    // from the full-resolution render. Identity short-circuits on all-default.
    stage("sized_hsl", || hsl::apply_model(&mut scene, model));
    dump_after("09b_hsl", &scene);
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
    // Global defringe must affect viewport renders as well as exports (#3889).
    // Keep the full develop ordering: after dehaze, before local adjustments.
    stage("sized_defringe", || {
        defringe::apply_model(&mut scene, model)
    });
    dump_after("12a_defringe", &scene);
    stage("sized_local_adjustments", || {
        let (layers, rasters) = crate::pipeline::mask::orient_adjustments_to_sensor(
            &model.local_adjustments,
            &model.mask_rasters,
            raw.orientation,
        );
        local_adjustments::apply(&mut scene, &layers, &rasters)
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
        let radius = sharpen::radius_at_scale(model.sharpen_radius, scene.nr_sampling_scale);
        sharpen::apply_cancellable(
            &mut scene,
            model.sharpen_amount,
            radius,
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
    let nr_sampling_scale = scene.nr_sampling_scale;
    stage("sized_nr_color", || {
        noise_reduction::apply_color_sampled_cancellable(
            &mut scene,
            model.nr_color,
            cancel,
            raw.noise_profile.as_deref(),
            raw.iso,
            nr_sampling_scale,
        )
    });
    dump_after("15_nr_color", &scene);
    if cancel.is_cancelled() {
        return Err(Error::Cancelled);
    }
    Ok((scene, ae_gain))
}
