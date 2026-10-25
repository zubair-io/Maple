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
    demosaic,
    error::{Error, Result},
    image::RawImage,
    linearize,
    stages::{
        clarity, color_curves, defringe, dehaze, hot_pixel, hsl, local_adjustments, saturation,
        scene_tone_controls, texture, tone_curves, vibrance, vignette, white_balance,
    },
    xmp::AdjustmentModel,
};

use super::{
    capture_first::Chain,
    develop::{
        crop_to_default, develop_colour, effective_quality_divisor, lateral_ca, ColourInput,
    },
    downsample::downsample_image_area,
    dump_after, stage, RenderQuality,
};

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
    let (mut scene, ae_gain) = develop_sized_prefix(raw, model, quality, max_long_edge, cancel)?;
    super::sized_detail::apply(&mut scene, raw, model, cancel)?;
    Ok((scene, ae_gain))
}

/// Exact sized develop up to the immutable pre-detail scene. Both consumers
/// preserve native clipping/crop/WB/AE/density before any preview detail work.
pub(super) fn develop_sized_prefix(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
    max_long_edge: u32,
    cancel: CancelToken<'_>,
) -> Result<(crate::image::Image, f32)> {
    if cancel.is_cancelled() {
        return Err(Error::Cancelled);
    }
    let (frame_w, frame_h) = crate::pipeline::native_render_dims(raw);
    let model = &*crate::types::with_brush_rasters(model, frame_w, frame_h);
    let (mut scene, ae_gain) = develop_sized_to_dehaze(raw, model, quality, max_long_edge, cancel)?;
    stage("sized_dehaze", || dehaze::apply(&mut scene, model.dehaze));
    dump_after("12_dehaze", &scene);
    develop_sized_after_dehaze(scene, raw, model).map(|scene| (scene, ae_gain))
}

/// [`haze_map_from_raw`] when `model` engages dehaze anywhere.
pub(crate) fn frame_haze(
    raw: &RawImage,
    model: &AdjustmentModel,
    cancel: CancelToken<'_>,
) -> Result<Option<dehaze::FrameHaze>> {
    dehaze::any_engaged(model)
        .then(|| haze_map_from_raw(raw, model, cancel))
        .transpose()
}

/// The frame's haze map (#3287), measured from a Preview-density develop
/// sized to the map's own proxy grid, so a native-resolution develop and a
/// native tile of the same frame measure the identical map without either
/// developing the frame at native density twice (the #5049 pattern). Its
/// working set is one half-resolution demosaic, released before return.
pub(crate) fn haze_map_from_raw(
    raw: &RawImage,
    model: &AdjustmentModel,
    cancel: CancelToken<'_>,
) -> Result<dehaze::FrameHaze> {
    let (mut scene, _) = develop_sized_to_dehaze(
        raw,
        model,
        RenderQuality::Preview,
        dehaze::HAZE_PROXY_LONG_EDGE,
        cancel,
    )?;
    if cancel.is_cancelled() {
        return Err(Error::Cancelled);
    }
    let global = dehaze::engaged(model.dehaze)
        .then(|| stage("sized_dehaze_map", || dehaze::HazeMap::measure(&scene)));
    if !local_adjustments::spatial::any_dehaze_engaged(&model.local_adjustments) {
        return Ok(dehaze::FrameHaze {
            global,
            layers: Vec::new(),
        });
    }
    // Per-mask dehaze measures each layer's own scratch, which sits after
    // the global dehaze and defringe: run them to reach it.
    if let Some(map) = &global {
        let frame = (scene.width, scene.height);
        dehaze::apply_with_map(&mut scene, model.dehaze, map, (0, 0), frame);
    }
    defringe::apply_model(&mut scene, model);
    let (layers, rasters) = crate::pipeline::mask::orient_adjustments_to_sensor(
        &model.local_adjustments,
        &model.mask_rasters,
        raw.orientation,
    );
    let layers = stage("sized_local_dehaze_maps", || {
        local_adjustments::apply_measuring_haze(&mut scene, &layers, &rasters)
    });
    if cancel.is_cancelled() {
        return Err(Error::Cancelled);
    }
    Ok(dehaze::FrameHaze { global, layers })
}

/// The sized develop through texture: the scene dehaze receives.
fn develop_sized_to_dehaze(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
    max_long_edge: u32,
    cancel: CancelToken<'_>,
) -> Result<(crate::image::Image, f32)> {
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
            stage("sized_demosaic", || {
                if demosaic_half {
                    return demosaic::half_res_cancellable(&mosaic, raw.cfa, cancel);
                }
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
    stage("sized_highlight_recovery", || {
        super::tile::recover_full_frame(&mut camera_rgb, raw, model, crop_divisor, cancel)
    })?;
    dump_after("00b_highlight_recovery", &camera_rgb);

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
    let (mut scene, ae_gain) = develop_colour(
        camera_rgb,
        ColourInput {
            raw,
            model,
            profile,
            profile_source,
            skip_pre_gain,
            whites_anchor_ev,
            chain: Chain::Sized,
            cancel,
        },
    )?;
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
    stage("sized_color_curves", || {
        color_curves::apply_model(&mut scene, model)
    });
    dump_after("09c_color_curves", &scene);
    stage("sized_clarity", || {
        clarity::apply(&mut scene, model.clarity)
    });
    dump_after("10_clarity", &scene);
    stage("sized_texture", || {
        texture::apply(&mut scene, model.texture)
    });
    dump_after("11_texture", &scene);
    if cancel.is_cancelled() {
        return Err(Error::Cancelled);
    }
    Ok((scene, ae_gain))
}

fn develop_sized_after_dehaze(
    mut scene: crate::image::Image,
    raw: &RawImage,
    model: &AdjustmentModel,
) -> Result<crate::image::Image> {
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
    Ok(scene)
}
