//! Shared camera-native decode prefix, before user WB and DCP (#3955).
//! Extracted without changing stage order or arithmetic from the full chain.

use super::{crop_to_default, effective_quality_divisor, geometry};
use crate::pipeline::{dump_after, stage, RenderQuality};
use crate::{
    cancel::CancelToken,
    demosaic,
    error::{Error, Result},
    image::{Image, RawImage},
    linearize,
    stages::{highlight_recovery, hot_pixel, white_balance},
    xmp::AdjustmentModel,
};

pub(in crate::pipeline) fn prepare(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
    cancel: CancelToken<'_>,
) -> Result<(Image, bool)> {
    let (camera, skip_pre_gain) = prepare_unwarped(raw, model, quality, cancel)?;
    Ok((finish_geometry(raw, model, quality, camera)?, skip_pre_gain))
}

/// Sensor-sized camera RGB before any optical correction or DefaultCrop.
/// Removal's fixed plate is transported here, so the normal optical stages
/// subsequently process originals and replacements together (#3955).
pub(in crate::pipeline) fn prepare_unwarped(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
    cancel: CancelToken<'_>,
) -> Result<(Image, bool)> {
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
                demosaic::demosaic_cancellable(algo, &mosaic, raw.cfa, cancel)
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
    let hr_neutral = if skip_pre_gain {
        [1.0; 3]
    } else {
        raw.as_shot_neutral
    };
    stage("highlight_recovery", || {
        highlight_recovery::apply_in_region(
            &mut camera_rgb,
            model.highlight_recovery,
            hr_neutral,
            raw.baseline_exposure,
            crate::pipeline::develop::highlight_active_area(
                raw,
                effective_quality_divisor(quality, raw.cfa),
            ),
        )
    });
    dump_after("00b_highlight_recovery", &camera_rgb);

    Ok((camera_rgb, skip_pre_gain))
}

pub(in crate::pipeline) fn finish_geometry(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
    mut camera_rgb: Image,
) -> Result<Image> {
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

    Ok(camera_rgb)
}
