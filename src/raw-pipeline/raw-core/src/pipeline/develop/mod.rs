//! The canonical scene-linear develop chain.
//!
//! `develop_scene_linear_from_raw_with_quality` is the single funnel
//! every full-image entry point runs through. Stages, in order:
//!
//! 1. `linearize` (or `linearraw_to_camera_rgb` for `LinearRgb` DNGs),
//! 2. `demosaic` (half-res / bilinear / hamilton-adams / AMaZE per
//!    [`super::RenderQuality`]),
//! 3. DNG `BaselineExposure` gain,
//! 4. DNG WB pre-gain (skipped for 8-bit lossy LinearRaw),
//! 5. highlight recovery,
//! 6. DCP `profile_for` + `apply_colorimetry` (CM/FM + HSM in
//!    linear-ProPhoto-D50, then gamut conversion to Rec.2020 — #425
//!    dropped the Adobe aesthetic layers PLT/PTC, and #2774 the DNG 1.6
//!    ProfileGainTableMap that is the spatial half of the PTC pair),
//! 7. damped per-image auto-exposure,
//! 8. white-balance, scene-tone-controls, vibrance, saturation, hsl,
//!    clarity, texture, dehaze, local-adjustments, vignette, sharpen,
//!    nr_luminance, nr_color.
//!
//! `develop_scene_linear_sized_from_raw_with_quality` is the
//! early-downsample variant (ticket 06 § Milestone 3): demosaic →
//! downsample-to-fit-viewport → rest-of-chain. Same stages in the same
//! order, with a `sized_*` profile-label prefix so `MAPLE_PROFILE` traces
//! don't collide with the full-res labels.

use crate::{
    cancel::CancelToken,
    color::dcp,
    error::{Error, Result},
    image::RawImage,
    stages::{
        auto_exposure, bm3d, capture_sharpening, chroma_prefilter, clarity, defringe, dehaze,
        highlight_recovery_oklab, hsl, local_adjustments, noise_reduction, retouch, saturation,
        scene_tone_controls, sharpen, texture, tone_curves, vibrance, vignette, wb_camera,
        white_balance,
    },
    xmp::AdjustmentModel,
};

use super::{
    capture_sharpening_helper::capture_sharpening_params_from_model, dump_after, stage,
    RenderQuality,
};

pub(super) mod camera;
mod geometry;

pub(super) use geometry::{
    crop_to_default, effective_quality_divisor, highlight_active_area, lateral_ca,
};

// Public forwarding entries live in a sibling for the file-size budget.
// The canonical chain and the #3955 calibration qualification seam stay here.
mod entries;
pub use entries::{
    develop_scene_linear_from_raw_with_quality,
    develop_scene_linear_from_raw_with_quality_cancellable,
    develop_scene_linear_from_raw_with_quality_cancellable_with_gain,
    develop_scene_linear_from_raw_with_quality_with_gain,
};

pub(super) fn develop_with_calibration_patches(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
    cancel: CancelToken<'_>,
    calibration_patches: &[crate::types::InpaintPatch],
) -> Result<(crate::image::Image, f32)> {
    let (mut camera_rgb, skip_pre_gain) = camera::prepare(raw, model, quality, cancel)?;

    let (profile, profile_source) =
        stage("dcp::profile_for", || dcp::profile_for_with_source(raw))?;
    let whites_anchor_ev = dcp::scene_white_anchor(&camera_rgb, &profile)?;
    // #3955 qualification entry only: fixed linear calibration pixels
    // return to camera RGB BEFORE user WB / FM retarget / nonlinear HSM.
    // Existing entries pass an empty stack; no extra pixel work or allocation.
    if !calibration_patches.is_empty() {
        super::removal_calibration::composite_camera(
            &mut camera_rgb,
            calibration_patches,
            &profile,
        )?;
    }
    // Camera-space user white balance (#1726): moves the temperature/tint
    // sliders upstream of DCP, in camera-native linear RGB, matching ACR —
    // bounded to what the sensor can physically report per channel (the
    // 12000K/+17 yellow-filter/banding repro this ticket fixes). Gated to
    // the three calibrated `ProfileSource` tiers (`RawlerFallback`'s matrix
    // is a synthetic stand-in, not a real calibration); the LinearRaw
    // (`skip_pre_gain`) and `RawlerFallback` cases fall through to the
    // pre-existing post-DCP CAT16 path below unchanged. Full design
    // writeup in `stages::wb_camera`'s module doc.
    let camera_wb_target =
        if !skip_pre_gain && !matches!(profile_source, dcp::ProfileSource::RawlerFallback) {
            let frame = wb_camera::SliderFrame::resolve(raw, &profile);
            // `resolve_target_versioned` (#1780): V1 (pre-#1756) sidecar
            // temperature/tint convert into the slider frame here so the
            // authored look is preserved; V2 models resolve unchanged.
            let (target_temperature, target_tint) =
                wb_camera::resolve_target_versioned(model, &frame, &profile, raw.as_shot_neutral);
            stage("wb_camera::apply", || {
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
    // DNG-spec `SetWhiteXY` ForwardMatrix retarget (#1727): when
    // camera-space WB moved off as-shot, the FM the DCP stage applies
    // below re-interpolates at the render profile's own CCT reading of the
    // target camera-neutral — the SDK's camera→PCS weight tracks the user
    // white point. The non-FM Bradford fallback stays at as-shot (the gain
    // is the sole carrier of the cast — see `stages::wb_camera`'s module
    // doc, and `retargeted_render_profile`'s doc for the measured evidence
    // against retargeting CM/white on that path). As-shot targets (the
    // `resolve_target` seed) return the profile unchanged, so unedited
    // renders stay bit-identical.
    let dcp_profile = match &camera_wb_target {
        Some((frame, target_temperature, target_tint)) => {
            wb_camera::retargeted_render_profile(frame, profile, *target_temperature, *target_tint)
        }
        None => profile,
    };
    // dcp::apply_colorimetry runs CM/FM (chromatic adaptation) and HSM
    // (metameric correction) only. Under ticket #425 (part of #416),
    // the Adobe aesthetic layers — ProfileToneCurve (PTC) and
    // ProfileLookTable (PLT) — no longer run inside DCP regardless of
    // profile source. They were calibrated to sit under Adobe's tone
    // mapping; AgX has a different rendering intent, and stacking the
    // Adobe layers on AgX produced compound hue errors and per-format
    // inconsistency (PTC was suppressed for bundled profiles but PLT
    // still ran for bundle-miss bodies). HSM stays because the bundled
    // profile set uses it for metameric correction the linear CM cannot
    // express. `raw.plt` and `raw.profile_tone_curve` remain on RawImage
    // for now but are dead data in the develop chain; cleanup is a
    // separate follow-up.
    let mut scene = stage("dcp::apply", || {
        dcp::apply_colorimetry(&camera_rgb, &dcp_profile)
    })?;
    dump_after("03_dcp_apply", &scene);
    // Ticket #471: opt-in `OklabChromaReduction` highlight recovery runs in
    // scene-linear Rec.2020 D65 where Oklab is well-defined. No-op for the
    // default `ChromaticAdaptation` and every other variant — see
    // `stages::highlight_recovery_oklab::apply_post_dcp`.
    stage("highlight_recovery_oklab", || {
        highlight_recovery_oklab::apply_post_dcp(&mut scene, model.highlight_recovery)
    });
    dump_after("03b_oklab_highlight_recovery", &scene);
    // Clone / heal repair spots (#3409) — a decode-product edit, applied on
    // the calibrated sensor signal right after DCP colorimetry so the
    // repaired pixels are denoised, sharpened, exposed and graded exactly
    // like their neighbours, and so no slider tick re-runs the patch work.
    // Empty list (the default) is a bit-identical skip.
    stage("retouch", || {
        retouch::apply_cancellable(&mut scene, &model.retouch_spots, cancel)
    })?;
    dump_after("03c_retouch", &scene);
    // `raw.profile_gain_table_map` (DNG 1.6 ProfileGainTableMap) is
    // deliberately NOT applied here (#2774). The spec pairs it with the
    // profile's ProfileToneCurve — "if used together, the gain table map
    // should be applied first" — and on a real Apple ProRAW the pair is a
    // ×2.7 mean shadow lift that the PTC then re-compresses. #425 dropped
    // the PTC (colorimetry-only DCP under AgX), so applying the gain map
    // alone lifts the whole scene about a stop against ACR: test_0013
    // baseline mean ΔE 11.7 / bias +0.075 with it, 5.9 / −0.03 without.
    // It is a vendor look layer like PLT/PTC, not colorimetry, and gets
    // the same treatment. See `color::profile_gain_table_map`'s module
    // doc for the measurements.
    // Decode-time chroma pre-filter (#1104, tone/zoom design § 3.1) — the
    // last denoising step of the decode product: after DCP colorimetry +
    // post-DCP highlight recovery, before capture sharpening (denoise
    // before deconvolution) and before auto-exposure / WB-delta / all user
    // adjustments. No-op (bit-identical skip) at the default 0.
    stage("chroma_prefilter", || {
        chroma_prefilter::apply(&mut scene, model.chroma_prefilter)
    });
    dump_after("04a_chroma_prefilter", &scene);
    // BM3D deep denoise (#1105, tone/zoom design § 3.2) — input-referred,
    // immediately after the chroma pre-filter, composing into the cached
    // decode product. No-op (bit-identical skip) at the default 0; the
    // heaviest stage in the chain when engaged, so it takes the cancel
    // token and reports per-reference-row progress through the shared
    // dispatch — the MAPLE_PROFILE log plus whichever host sink is
    // registered (the editor's determinate indicator, #1153).
    stage("deep_denoise", || {
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
    // Capture sharpening — Richardson-Lucy deconvolution against a Gaussian
    // PSF, run first thing in scene-linear Rec.2020 so it sees the
    // calibrated sensor signal before any user-facing tone/WB transforms.
    // No-op when `capture_sharpening_amount` is 0 (the default), which keeps
    // the parity-harness baseline bit-identical to pre-#271 behaviour.
    // Commutative with the downstream scalar gains (auto_exposure,
    // white_balance) so placement here vs. post-AE has no algebraic effect.
    if let Some(params) = capture_sharpening_params_from_model(model) {
        // Cancellable: the Richardson–Lucy iterations are seconds of compute
        // at 100 MP and sit inside this otherwise-cancellable cold-open chain
        // (#1089). The stage observes `cancel` between iterations and per row;
        // this post-stage check turns a partial-then-cancelled pass into a
        // clean Err so the half-sharpened buffer is never packed into a result.
        stage("capture_sharpening", || {
            capture_sharpening::apply_capture_sharpening_cancellable(&mut scene, &params, cancel)
        })?;
        if cancel.is_cancelled() {
            return Err(Error::Cancelled);
        }
    }
    dump_after("04b_capture_sharpening", &scene);
    // Per-image scene-anchor (ticket #429). Operates on the post-DCP /
    // PGTM scene-linear Rec.2020 image; deterministic; pure math.
    // Default is `AutoExposureMode::On` — measures the scene's mid-tone
    // (geometric mean of luma in the middle 50% percentile range, robust
    // to specular highlights and crushed shadows) and multiplies pixels
    // by `clamp(0.18 / midgrey, max=8.0)` so every camera lands at the
    // same point on the AgX sigmoid by default. User exposure
    // (`model.exposure`) stacks additively in EV in
    // `scene_tone_controls` downstream — the two scene-linear multiplies
    // commute, total per pixel is `anchor_gain * 2^user_ev`. Users can
    // opt out per-image via `papp:AutoExposure="Off"` for strict
    // scene-referred output, in which case the stage is a bit-identical
    // no-op.
    scene.whites_anchor_ev = Some(whites_anchor_ev);
    let ae_gain = stage("auto_exposure", || auto_exposure::apply(&mut scene, model));
    dump_after("05_auto_exposure", &scene);
    // Post-DCP white balance: skipped when the camera-space stage above
    // already normalised `camera_rgb` (#1726) — applying the CAT16 matrix
    // on top would double-count the shift. Falls through to the unchanged
    // ACR-anchored CAT16 path (`white_balance::resolve_wb`'s doc-comment
    // has the full anchoring table; #1729/#1725) for `RawlerFallback` and
    // LinearRaw (`skip_pre_gain`), where `camera_wb_applied` is false.
    if !camera_wb_applied {
        let (effective_temperature, effective_tint) = white_balance::resolve_wb(model);
        stage("white_balance", || {
            white_balance::apply(
                &mut scene,
                effective_temperature,
                effective_tint,
                model.wb_method,
            )
        });
    }
    dump_after("06_white_balance", &scene);
    stage("scene_tone_controls", || {
        scene_tone_controls::apply(&mut scene, model)
    });
    dump_after("07_scene_tone_controls", &scene);
    // User-authored tone curves (parametric + per-channel) — see stages/tone_curves.rs.
    // Identity short-circuits on default model so this is a no-op for non-curve fixtures.
    stage("tone_curves", || tone_curves::apply(&mut scene, model));
    dump_after("07b_tone_curves", &scene);
    stage("vibrance", || vibrance::apply(&mut scene, model.vibrance));
    dump_after("08_vibrance", &scene);
    stage("saturation", || {
        saturation::apply(&mut scene, model.saturation)
    });
    dump_after("09_saturation", &scene);
    // HSL 8-band (#1112, tone/zoom design § 10.4) — scene-linear Oklab,
    // after saturation, before clarity. Identity short-circuit on all-default.
    stage("hsl", || hsl::apply_model(&mut scene, model));
    dump_after("09b_hsl", &scene);
    stage("clarity", || clarity::apply(&mut scene, model.clarity));
    dump_after("10_clarity", &scene);
    stage("texture", || texture::apply(&mut scene, model.texture));
    dump_after("11_texture", &scene);
    stage("dehaze", || dehaze::apply(&mut scene, model.dehaze));
    dump_after("12_dehaze", &scene);
    // Defringe (#3411) — Oklab, between dehaze and local adjustments so a
    // mask can still paint over a defringed edge. No-op at both defaults.
    stage("defringe", || defringe::apply_model(&mut scene, model));
    dump_after("12a_defringe", &scene);
    // Local adjustments (ticket #280). Empty Vec (the default) makes this a
    // bit-identical short-circuit — the parity-harness baseline is unchanged.
    stage("local_adjustments", || {
        local_adjustments::apply(&mut scene, &model.local_adjustments, &model.mask_rasters)
    });
    dump_after("12b_local_adjustments", &scene);
    // Vignette (#1109, tone/zoom design § 10.1) — scene-linear radial gain,
    // late in the scene chain (after local adjustments, before the output
    // sharpen) so AgX rolls the shaped corners off filmically. Anchored to
    // this buffer's extent = the DefaultCrop render rect (user crop is
    // #1113; see the stage docs). Identity short-circuit at amount 0 keeps
    // the baseline bit-identical.
    stage("vignette", || {
        vignette::apply(&mut scene, model.vignette_amount, model.vignette_feather)
    });
    dump_after("12c_vignette", &scene);
    stage("sharpen", || {
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
    stage("nr_luminance", || {
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
    // `nr_color` is the dominant cold-open cost (~8.5 s on 100 MP); the
    // in-kernel between-shifts check is what actually interrupts the freeze,
    // and this post-stage check turns a partial-then-cancelled pass into a
    // clean Err so the half-denoised buffer is never packed into a result.
    stage("nr_color", || {
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
    Ok((scene, ae_gain))
}

#[cfg(test)]
mod tests;

#[cfg(test)]
#[path = "tests_vignette_opcode.rs"]
mod tests_vignette_opcode;

#[cfg(test)]
mod tests_defringe;
#[cfg(test)]
mod tests_highlight_bounds;
#[cfg(test)]
mod tests_sized_lateral_ca;
