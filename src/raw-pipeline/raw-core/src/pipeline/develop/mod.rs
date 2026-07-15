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
//!    dropped the Adobe aesthetic layers PLT/PTC),
//! 7. ProfileGainTableMap (when present),
//! 8. damped per-image auto-exposure,
//! 9. white-balance, scene-tone-controls, vibrance, saturation, hsl,
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
    demosaic,
    error::{Error, Result},
    image::RawImage,
    linearize,
    stages::{
        auto_exposure, bm3d, capture_sharpening, chroma_prefilter, clarity, dehaze,
        highlight_recovery, highlight_recovery_oklab, hot_pixel, hsl, local_adjustments,
        noise_reduction, saturation, scene_tone_controls, sharpen, texture, tone_curves, vibrance,
        vignette, wb_camera, white_balance,
    },
    xmp::AdjustmentModel,
};

use super::{
    capture_sharpening_helper::capture_sharpening_params_from_model, dump_after, stage,
    RenderQuality,
};

mod geometry;

pub(super) use geometry::{crop_to_default, effective_quality_divisor};

/// Run the entire development chain through `nr_color` and return the
/// developed `Image` in `ColorSpace::SceneLinearRec2020`. Shared by both
/// the legacy display-encoded entry (`render_from_raw_with_quality`) and
/// the scene-linear FFI entry (`render_scene_linear_from_raw_with_quality`)
/// so the two paths can never drift.
///
/// Stages: linearize, demosaic, baseline_exposure, highlight_recovery,
/// dcp::profile_for + dcp::apply (camera RGB → SceneLinearRec2020),
/// white_balance, scene_tone_controls, tone_curves, vibrance, saturation,
/// hsl, clarity, texture, dehaze, sharpen, nr_luminance, nr_color.
/// Non-cancellable wrapper — forwards to
/// [`develop_scene_linear_from_raw_with_quality_cancellable`] with a
/// never-cancel token. Every existing caller (CLI, WASM, the legacy FFI
/// entries, tests, `auto_fit`) routes through here, so a completed develop is
/// byte-for-byte identical to before #951.
#[inline]
pub fn develop_scene_linear_from_raw_with_quality(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
) -> Result<crate::image::Image> {
    develop_scene_linear_from_raw_with_quality_cancellable(
        raw,
        model,
        quality,
        CancelToken::never(),
    )
}

/// Cancellable variant of [`develop_scene_linear_from_raw_with_quality`].
///
/// Threads `cancel` into the expensive stage kernels (`demosaic`, `sharpen`,
/// `nr_luminance`, `nr_color`) so a long cold-open develop can unwind mid-
/// stage (#951 — the ~8.5 s `nr_color` is the freeze a between-stages-only
/// check could not interrupt). Also checks the token at the top (a pre-set
/// flag bails before demosaic) and after each heavy stage, returning
/// `Err(Error::Cancelled)` the moment the host requests cancellation.
///
/// With a never-cancel token every check is a no-op branch and the cancellable
/// stage variants run identical math, so the output is bit-identical to the
/// wrapper above.
pub fn develop_scene_linear_from_raw_with_quality_cancellable(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
    cancel: CancelToken<'_>,
) -> Result<crate::image::Image> {
    // Bail before any work if the host already cancelled (e.g. the decode
    // task was superseded before the worker thread even started).
    if cancel.is_cancelled() {
        return Err(Error::Cancelled);
    }
    let mut camera_rgb = match raw.cfa {
        crate::image::CfaPattern::LinearRgb => {
            // LinearRaw DNG: data is already 3-channel RGB. Skip the
            // mosaic path entirely. See ticket #07.
            stage("linearraw_decode", || {
                linearize::linearraw_to_camera_rgb(raw)
            })?
        }
        crate::image::CfaPattern::XTrans(_) => {
            // Fuji X-Trans (6×6 CFA): the Bayer kernels above are all
            // hard-coded for 2×2 phase and produce garbage on the
            // X-Trans tile. Route all three RenderQuality variants to
            // the X-Trans demosaicers: bilinear for Preview (the buffer
            // is half-res-equivalent after downsample), Markesteijn for
            // Full/AMaZE. See tickets #420 / #417.
            //
            // Note: there is no half-res *preview* path for X-Trans on
            // day one — the `xtrans_bilinear` kernel runs at full
            // resolution and the surrounding pipeline downsamples
            // later via `develop_sized`. A true half-res X-Trans
            // preview is a follow-up.
            let mut mosaic = stage("linearize", || linearize::sensor_linearize(raw));
            // Hot/dead-pixel suppression (#1106) — pre-demosaic, raw-domain.
            // No-op (bit-identical) at the default Off.
            stage("hot_pixel", || {
                hot_pixel::apply(&mut mosaic, raw.cfa, model.hot_pixel_suppression)
            });
            stage("demosaic_xtrans", || match quality {
                RenderQuality::Preview => demosaic::xtrans_bilinear(&mosaic, raw.cfa),
                RenderQuality::Full | RenderQuality::Amaze => {
                    demosaic::markesteijn(&mosaic, raw.cfa)
                }
            })
        }
        _ => {
            let mut mosaic = stage("linearize", || linearize::sensor_linearize(raw));
            // Hot/dead-pixel suppression (#1106) — pre-demosaic, raw-domain.
            // No-op (bit-identical) at the default Off.
            stage("hot_pixel", || {
                hot_pixel::apply(&mut mosaic, raw.cfa, model.hot_pixel_suppression)
            });
            // The interactive Bayer paths (Preview `half_res`, Full
            // `bilinear`) take cancellable kernels so a cancel mid-demosaic
            // unwinds per-row. The export-only AMaZE / Hamilton-Adams kernels
            // are not instrumented inline — they're not on the cold-open
            // interactive path — but the post-demosaic check below still bails
            // before any downstream stage runs.
            stage("demosaic", || match quality {
                RenderQuality::Preview => demosaic::half_res_cancellable(&mosaic, raw.cfa, cancel),
                #[cfg(feature = "high-quality-demosaic")]
                RenderQuality::Full => demosaic::hamilton_adams(&mosaic, raw.cfa),
                #[cfg(not(feature = "high-quality-demosaic"))]
                RenderQuality::Full => demosaic::bilinear_cancellable(&mosaic, raw.cfa, cancel),
                RenderQuality::Amaze => demosaic::amaze(&mosaic, raw.cfa),
            })
        }
    };
    // Post-demosaic bail: catches every demosaic path (incl. X-Trans / AMaZE)
    // and a cancel that landed during the Bayer kernel's partial fill.
    if cancel.is_cancelled() {
        return Err(Error::Cancelled);
    }

    // Stage 2a (#1695): DNG OpcodeList3 on the demosaiced linear data, in
    // ActiveArea coordinates — i.e. BEFORE DefaultCrop moves the origin.
    // `aa` is in raw-sensor coordinates; Preview quality's half-res Bayer
    // demosaic (`half_res_cancellable`, same divisor `crop_to_default`
    // uses above) leaves `camera_rgb` at half those dims, so the rect
    // must scale down to match — an unscaled full-raw-width rect walked
    // straight off the end of a half-res row (out-of-bounds panic on
    // sources whose ActiveArea spans the full sensor width, e.g. a
    // WarpRectilinear-carrying DNG opened at Preview quality).
    if let Some((list, aa)) = raw.opcode_list3.as_ref() {
        stage("opcode_list3", || {
            let qd = effective_quality_divisor(quality, raw.cfa);
            let scaled_aa = crate::pipeline::pano::opcode_apply::scale_active_area(
                *aa,
                1.0 / qd as f32,
                camera_rgb.width,
                camera_rgb.height,
            );
            crate::pipeline::pano::opcode_apply::apply_opcode_list3(&mut camera_rgb, list, scaled_aa);
        });
        dump_after("00a_opcode_list3", &camera_rgb);
    }

    // DNG § 6.3 DefaultCrop — restrict the buffer to the camera-recommended
    // render rectangle BEFORE any color stage runs. The crop drops the
    // optical-black border (covered by ActiveArea) plus the few-px demosaic-
    // safe margin past it, eliminating the dark borders the harness was
    // tracking as a per-channel bias on test_0007 / test_0009 / test_0001
    // and shrinking Fuji X-Trans fixtures from the over-sized sensor area
    // (9216×6210) to the declared image (8256×6192). No-op for fixtures
    // without crop metadata (test_0002, test_0013) — those render the
    // full sensor, which is also what ACR does for them. See ticket #375.
    if let Some(crop) = raw.crop_rect {
        if let Some(cropped) = stage("crop_to_default", || {
            crop_to_default(
                &camera_rgb,
                crop,
                effective_quality_divisor(quality, raw.cfa),
            )
        }) {
            camera_rgb = cropped;
        }
        // No-op (degenerate rect or full-coverage): keep camera_rgb as-is;
        // crop_to_default returns None instead of cloning the buffer.
    }
    dump_after("00b_crop_to_default", &camera_rgb);

    // DNG § C.1.2: BaselineExposure is applied as a gain in a scene-linear
    // color space prior to the color-space transform. Mathematically
    // commutative with the linear CM that follows, so we apply in the
    // camera-native space for clarity — one multiply per channel.
    if raw.baseline_exposure.abs() > 1e-4 {
        stage("baseline_exposure", || {
            let be_gain = raw.baseline_exposure.exp2();
            for p in &mut camera_rgb.pixels {
                p[0] *= be_gain;
                p[1] *= be_gain;
                p[2] *= be_gain;
            }
        });
    }
    dump_after("01_baseline_exposure", &camera_rgb);

    // DNG WB pre-gain per spec § 1.4.4.5 step 4: divide camera RGB by
    // AsShotNeutral so a neutral scene patch reads as (1, 1, 1) going into
    // DCP. Enabled unconditionally now that the BaselineExposure compose
    // chain is sourced from DNG tags + bundled-DCP `BaselineExposureOffset`
    // only — the historical Phase-1.1 per-body BE lookup that previously
    // gated this step was removed in #370. (The follow-up global Look LUT
    // #371 was retired in #443.) See
    // .archived-plans/specs/2026-04-30-color-convergence-design.md.
    //
    // Skipped for 8-bit lossy LinearRaw DNGs (DNG Converter's
    // perceptually-encoded output) where WB stays baked through the linearize
    // step and DCP must derive scene_white_xyz from `inv(CM) · AsShotNeutral`
    // as the empirical (legacy) path. See linearize::linearraw_to_camera_rgb
    // and dcp::profile_for for the matching wb_already_baked decision.
    let skip_pre_gain =
        matches!(raw.cfa, crate::image::CfaPattern::LinearRgb) && raw.white_level <= 255;
    if !skip_pre_gain {
        stage("white_balance::apply_pre_gain", || {
            white_balance::apply_pre_gain(&mut camera_rgb, raw.as_shot_neutral)
        });
    }
    // highlight_recovery (ticket #325) sees per-channel ceilings = 1/AsShotNeutral
    // post-pre-gain, identity (1,1,1) when pre-gain was skipped (8-bit lossy
    // LinearRaw) — without the identity branch the detector misses R/B clips
    // and trips incorrectly on G.
    let hr_neutral = if skip_pre_gain {
        [1.0; 3]
    } else {
        raw.as_shot_neutral
    };
    stage("highlight_recovery", || {
        highlight_recovery::apply(&mut camera_rgb, model.highlight_recovery, hr_neutral)
    });
    dump_after("02_highlight_recovery", &camera_rgb);
    let (profile, profile_source) =
        stage("dcp::profile_for", || dcp::profile_for_with_source(raw))?;
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
    // ProfileGainTableMap (DNG 1.6 § 6.8) — spatially-varying RGB gain.
    // Applied AFTER the gamut conversion, in scene-linear Rec.2020. No-op
    // when raw.profile_gain_table_map is None (most fixtures).
    if let Some(pgtm) = raw.profile_gain_table_map.as_ref() {
        stage("profile_gain_table_map", || {
            crate::color::profile_gain_table_map::apply(&mut scene, pgtm)
        });
    }
    dump_after("04_profile_gain_table_map", &scene);
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
    // token and reports coarse progress through the MAPLE_PROFILE log
    // (UI progress wiring is the editor-UI phase, #1108).
    stage("deep_denoise", || {
        bm3d::apply_cancellable(&mut scene, model.deep_denoise, cancel, bm3d::env_progress())
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
    stage("auto_exposure", || auto_exposure::apply(&mut scene, model));
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
    stage("hsl", || {
        hsl::apply(
            &mut scene,
            &[
                model.hue_adjustment_red,
                model.hue_adjustment_orange,
                model.hue_adjustment_yellow,
                model.hue_adjustment_green,
                model.hue_adjustment_aqua,
                model.hue_adjustment_blue,
                model.hue_adjustment_purple,
                model.hue_adjustment_magenta,
            ],
            &[
                model.saturation_adjustment_red,
                model.saturation_adjustment_orange,
                model.saturation_adjustment_yellow,
                model.saturation_adjustment_green,
                model.saturation_adjustment_aqua,
                model.saturation_adjustment_blue,
                model.saturation_adjustment_purple,
                model.saturation_adjustment_magenta,
            ],
            &[
                model.luminance_adjustment_red,
                model.luminance_adjustment_orange,
                model.luminance_adjustment_yellow,
                model.luminance_adjustment_green,
                model.luminance_adjustment_aqua,
                model.luminance_adjustment_blue,
                model.luminance_adjustment_purple,
                model.luminance_adjustment_magenta,
            ],
        )
    });
    dump_after("09b_hsl", &scene);
    stage("clarity", || clarity::apply(&mut scene, model.clarity));
    dump_after("10_clarity", &scene);
    stage("texture", || texture::apply(&mut scene, model.texture));
    dump_after("11_texture", &scene);
    stage("dehaze", || dehaze::apply(&mut scene, model.dehaze));
    dump_after("12_dehaze", &scene);
    // Local adjustments (ticket #280). Empty Vec (the default) makes this a
    // bit-identical short-circuit — the parity-harness baseline is unchanged.
    stage("local_adjustments", || {
        local_adjustments::apply(&mut scene, &model.local_adjustments)
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
    Ok(scene)
}

#[cfg(test)]
mod tests;
