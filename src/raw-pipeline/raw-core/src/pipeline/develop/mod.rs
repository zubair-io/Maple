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
//! 5. highlight recovery, OpcodeList3 / lens correction, DefaultCrop,
//! 6. the capture stage (#5213): retouch, chroma pre-filter, BM3D and
//!    capture sharpening in a fixed as-shot Rec.2020 basis, then camera-space
//!    user white balance and DCP `profile_for` + `apply_colorimetry` (CM/FM + HSM in
//!    linear-ProPhoto-D50, then gamut conversion to Rec.2020 — #425
//!    dropped the Adobe aesthetic layers PLT/PTC, and #2774 the DNG 1.6
//!    ProfileGainTableMap that is the spatial half of the PTC pair),
//! 7. post-DCP Oklab highlight recovery and per-image auto-exposure
//!    measured on the as-shot render,
//! 8. fallback CAT16 white balance, scene-tone-controls, vibrance, saturation, hsl,
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
        clarity, color_curves, defringe, dehaze, hot_pixel, hsl, local_adjustments,
        noise_reduction, saturation, scene_tone_controls, sharpen, texture, tone_curves, vibrance,
        vignette, white_balance,
    },
    xmp::AdjustmentModel,
};

use super::{dump_after, stage, RenderQuality};

mod colour;
mod geometry;

use super::capture_first::Chain;
pub(crate) use colour::{capture_colour, develop_colour, CameraReady};

pub(super) use geometry::{
    crop_to_default, effective_quality_divisor, highlight_active_area, lateral_ca,
    recover_sensor_highlights,
};

// The three forwarding entries live in a sibling for the file-size budget
// (#3409); the chain itself, and the `_with_gain` entry they all forward
// to, stay here.
mod entries;
pub use entries::{
    develop_scene_linear_from_raw_with_quality,
    develop_scene_linear_from_raw_with_quality_cancellable,
    develop_scene_linear_from_raw_with_quality_with_gain,
};

/// Same develop chain as [`develop_scene_linear_from_raw_with_quality_cancellable`],
/// additionally returning the scalar gain the `auto_exposure` stage applied
/// (1.0 when `model.auto_exposure` is `Off`, or when the anchor computation
/// degenerates to a no-op — see `stages::auto_exposure::apply`). Ticket #1167:
/// this is the export the tile-develop path threads back in as its `ae_gain`
/// input, so a deep-zoom tile can reproduce the exact per-scene AE gain the
/// full-image develop picked instead of omitting the stage. Kept as a
/// separate entry (rather than changing the widely-called plain function's
/// return type) to avoid touching the ~30 existing callers across raw-core,
/// maple-cli, and the test suite that only want the `Image`.
pub fn develop_scene_linear_from_raw_with_quality_cancellable_with_gain(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
    cancel: CancelToken<'_>,
) -> Result<(crate::image::Image, f32)> {
    // Bail before any work if the host already cancelled (e.g. the decode
    // task was superseded before the worker thread even started).
    if cancel.is_cancelled() {
        return Err(Error::Cancelled);
    }
    let (frame_w, frame_h) = crate::pipeline::native_render_dims(raw);
    let model = &*crate::types::with_brush_rasters(model, frame_w, frame_h);
    // Before any full-density buffer exists, so the two develops never coexist.
    let haze = super::develop_sized::frame_haze(raw, model, cancel)?;
    let (camera_rgb, input) =
        develop_camera(raw, model, quality, cancel)?.colour(raw, model, Chain::Full, cancel);
    let (scene, ae_gain) = develop_colour(camera_rgb, input)?;
    develop_after_colour(scene, raw, model, haze.as_ref(), cancel).map(|scene| (scene, ae_gain))
}

/// Everything before the colour segment: the RAW decoded to the
/// profile-ready camera buffer.
pub(crate) fn develop_camera(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
    cancel: CancelToken<'_>,
) -> Result<CameraReady> {
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
            dump_after("00_sensor_linearized", &mosaic);
            // Hot/dead-pixel suppression (#1106) — pre-demosaic, raw-domain.
            // No-op (bit-identical) at the default Off.
            stage("hot_pixel", || {
                hot_pixel::apply(&mut mosaic, raw.cfa, model.hot_pixel_suppression)
            });
            geometry::lateral_ca(&mut mosaic, raw, model, cancel)?; // #3411
            stage("demosaic_xtrans", || match quality {
                RenderQuality::Preview => demosaic::xtrans_bilinear(&mosaic, raw.cfa),
                RenderQuality::Full | RenderQuality::Amaze | RenderQuality::Auto => {
                    demosaic::markesteijn(&mosaic, raw.cfa)
                }
            })
        }
        _ => {
            let mut mosaic = stage("linearize", || linearize::sensor_linearize(raw));
            dump_after("00_sensor_linearized", &mosaic);
            // Hot/dead-pixel suppression (#1106) — pre-demosaic, raw-domain.
            // No-op (bit-identical) at the default Off.
            stage("hot_pixel", || {
                hot_pixel::apply(&mut mosaic, raw.cfa, model.hot_pixel_suppression)
            });
            // #3411 — raw-domain, so BEFORE whichever kernel is picked below.
            geometry::lateral_ca(&mut mosaic, raw, model, cancel)?;
            // Which kernel is `bayer_kernel`'s call (#3413): the quality
            // level's own default, overridden by the model's `demosaic`
            // field, and noise-adaptive at `Auto`. Kernels with a
            // cancellable entry unwind per band/row; the rest are not on
            // the cold-open interactive path, and the post-demosaic check
            // below bails before any downstream stage runs either way.
            stage("demosaic", || {
                let algo = crate::pipeline::bayer_kernel(quality, model, raw);
                demosaic::camera_demosaic_cancellable(
                    algo,
                    &mosaic,
                    raw.cfa,
                    raw.as_shot_neutral,
                    crate::sensor_gain_maps::ClipGainContext::new(raw, (0, 0), 1),
                    cancel,
                )
            })
        }
    };
    // Post-demosaic bail: catches every demosaic path (incl. X-Trans / AMaZE)
    // and a cancel that landed during the Bayer kernel's partial fill.
    if cancel.is_cancelled() {
        return Err(Error::Cancelled);
    }

    // Reconstruct from sensor-relative values before lens gain or geometric
    // resampling changes the evidence of saturation (#3633). Exposure and
    // WB gains commute with these opcodes; highlight reconstruction does not.
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
    dump_after("00a_baseline_exposure", &camera_rgb);

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
    // After WB pre-gain, highlight ceilings are 2^BE / AsShotNeutral.
    // Use identity neutral (1,1,1) when pre-gain was skipped (8-bit lossy
    // LinearRaw); otherwise the detector misses R/B clips and trips on G.
    stage("highlight_recovery", || {
        super::tile::recover_full_frame(
            &mut camera_rgb,
            raw,
            model,
            effective_quality_divisor(quality, raw.cfa),
            cancel,
        )
    })?;
    dump_after("00b_highlight_recovery", &camera_rgb);

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
            crate::pipeline::pano::opcode_apply::apply_opcode_list3(
                &mut camera_rgb,
                list,
                scaled_aa,
                crate::pipeline::pano::opcode_apply::LensCorrectionScales::from_model(model),
            );
        });
        dump_after("01a_opcode_list3", &camera_rgb);
    } else if crate::lens_profile::applies(raw, model) {
        let scale = 1.0 / effective_quality_divisor(quality, raw.cfa) as f32;
        stage("lcp_correction", || {
            crate::lens_profile::apply_for_raw(raw, model, &mut camera_rgb, scale)
        })?;
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
    dump_after("01b_crop_to_default", &camera_rgb);

    let (profile, profile_source) =
        stage("dcp::profile_for", || dcp::profile_for_with_source(raw))?;
    let whites_anchor_ev = dcp::scene_white_anchor(&camera_rgb, &profile)?;
    Ok(CameraReady {
        camera_rgb,
        profile,
        profile_source,
        skip_pre_gain,
        whites_anchor_ev,
    })
}

fn develop_after_colour(
    mut scene: crate::image::Image,
    raw: &RawImage,
    model: &AdjustmentModel,
    haze: Option<&dehaze::FrameHaze>,
    cancel: CancelToken<'_>,
) -> Result<crate::image::Image> {
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
    stage("color_curves", || {
        color_curves::apply_model(&mut scene, model)
    });
    dump_after("09c_color_curves", &scene);
    stage("clarity", || clarity::apply(&mut scene, model.clarity));
    dump_after("10_clarity", &scene);
    stage("texture", || texture::apply(&mut scene, model.texture));
    dump_after("11_texture", &scene);
    stage("dehaze", || {
        dehaze::apply_whole_frame(&mut scene, model.dehaze, haze)
    });
    dump_after("12_dehaze", &scene);
    // Defringe (#3411) — Oklab, between dehaze and local adjustments so a
    // mask can still paint over a defringed edge. No-op at both defaults.
    stage("defringe", || defringe::apply_model(&mut scene, model));
    dump_after("12a_defringe", &scene);
    // Local adjustments (ticket #280). Empty Vec (the default) makes this a
    // bit-identical short-circuit — the parity-harness baseline is unchanged.
    stage("local_adjustments", || {
        let (layers, rasters) = crate::pipeline::mask::orient_adjustments_to_sensor(
            &model.local_adjustments,
            &model.mask_rasters,
            raw.orientation,
        );
        local_adjustments::apply_with_frame_haze(&mut scene, &layers, &rasters, haze)
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
    Ok(scene)
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
