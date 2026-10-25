//! Develop chain used by the tile path — mirrors
//! `super::super::develop::develop_scene_linear_from_raw_with_quality`
//! without the leading `linearize` call (the tile entry linearises only
//! the padded crop region) and **without** the stages that exclude
//! themselves architecturally (see the per-stage notes at each chain
//! position):
//!
//! * deep_denoise — rejected loudly at the tile entry (`super::guards`) so
//!   the host falls back to the full-image render (#1105),
//! * dehaze — recovers from the full frame's proxy haze maps (#3287),
//!   carried in [`TileAnchors::haze`],
//! * auto_exposure — a tile is a sub-region, so its own histogram isn't
//!   representative of the whole scene; this chain never recomputes the
//!   anchor gain per-tile (#1167). Instead it accepts the scalar
//!   `ae_gain` the caller already measured from a full-image (or sized)
//!   develop of the SAME model, and applies it as a flat multiply at the
//!   identical chain position `stages::auto_exposure::apply` occupies in
//!   the full/sized chains — see the call site in this file for why the
//!   position matters (non-commutative neighbor stages).
//!
//! Split out of `super::mod` so the tile entry stays under the file-size
//! budget (#114).

use crate::{
    color::dcp,
    error::Result,
    image::RawImage,
    stages::{
        clarity, color_curves, defringe, highlight_recovery, hsl, noise_reduction, saturation,
        scene_tone_controls, sharpen, texture, tone_curves, vibrance,
    },
    xmp::AdjustmentModel,
};

use super::colour::{capture_colour, develop_colour, TileColour};
use super::region::{clip_to_default_crop, trim_image_to_inner, TileWindow};
use crate::pipeline::{
    develop::effective_quality_divisor, native_render_dims, stage, RenderQuality,
};
use crate::stages::{local_adjustments, vignette};

/// What a tile develop produces.
#[derive(Clone, Copy, Debug)]
pub(crate) enum TileOutput {
    /// The developed scene, with the host-measured anchors described at
    /// [`develop_scene_linear_from_padded_mosaic`].
    Scene {
        decoded_wb_anchor: Option<(f32, f32)>,
        ae_gain: f32,
    },
    /// The capture result in the fixed as-shot basis (#5377), for a host
    /// that runs the creative stage per tick.
    Capture,
}

impl TileOutput {
    pub(crate) fn develops_scene(self) -> bool {
        matches!(self, TileOutput::Scene { .. })
    }
}

/// The per-render values the tile entry threads into the chain besides the
/// mosaic and the model: the host-measured anchors (WB delta anchor, #1725;
/// auto-exposure gain, #1167) and the tile's window in the frame (#1157).
pub(super) struct TileAnchors<'a> {
    pub output: TileOutput,
    /// Where the padded crop sits in the developed frame — the anchor for
    /// vignette's ellipse and the local-adjustment masks.
    pub window: TileWindow,
    /// Requested inner rect, relative to the padded developed buffer.
    pub inner: (u32, u32, u32, u32),
    /// Physical sensor ActiveArea translated into the padded demosaic buffer.
    pub active_area: Option<crate::image::CropRect>,
    /// Padded crop's top-left in full demosaiced coordinates (sensor / divisor).
    pub tile_origin: (u32, u32),
    pub highlight_frame: crate::stages::highlight_recovery::FrameAnchor<'a>,
    /// The full frame's haze maps (#3287); `Some` whenever dehaze is
    /// engaged, globally or in a layer.
    pub haze: Option<&'a crate::stages::dehaze::FrameHaze>,
}

pub(super) struct DevelopedTile {
    pub image: crate::image::Image,
    pub inner: (u32, u32, u32, u32),
}

/// Long edge of the FULL developed frame at the resolution the tile chain
/// develops `quality` at — the anchor for every radius that scales with the
/// image rather than with the buffer (#2476). `native_render_dims` is the
/// DefaultCrop'd extent the whole-image chains hand their stages at `Full`;
/// `Preview` divides it exactly as `demosaic::half_res` halves the crop
/// (integer floor), so a tile and the whole-image develop of the same
/// `(raw, quality)` derive identical radii.
pub(super) fn full_frame_long_edge(raw: &RawImage, quality: RenderQuality) -> usize {
    let (w, h) = native_render_dims(raw);
    let divisor = effective_quality_divisor(quality, raw.cfa);
    (w.max(h) / divisor) as usize
}

/// Run the development chain from a pre-cropped `CameraNativeMosaic`
/// `Image` (as produced by `linearize::sensor_linearize_region`). Used by
/// the tile path so the linearize + crop pair runs once on the padded
/// crop and the develop chain runs on a small image. Mirrors
/// `develop_scene_linear_from_raw_with_quality` but without the leading
/// `linearize` call. Deep denoise never reaches it (the entry refuses it,
/// #1105); vignette and local adjustments run windowed, capture sharpening
/// on the computed pad, and dehaze from the frame's haze maps (#3287).
///
/// `decoded_wb_anchor` is the app's live-chain / tile-refine DELTA contract
/// (#1725 band fix): `Some((decoded_temp, decoded_tint))` applies
/// `white_balance::apply_delta(scene, model.temperature, model.tint,
/// decoded_temp, decoded_tint, model.wb_method)` — the SAME delta semantics
/// `pipeline::apply_scene_linear_chain` (the per-tick GPU-live FFI entry)
/// uses, so a tile rendered at `model.temperature == decoded_temp` is
/// IDENTITY, exactly like the live frame. `None` preserves the prior
/// ABSOLUTE behavior via `white_balance::resolve_wb` + `apply` — the
/// correct semantics for the maple-cli / XMP-render callers of the tile
/// path (`maple-cli tile`, any caller that doesn't know about a "decoded"
/// buffer), where `crs:Temperature` is an absolute ACR sidecar value, not a
/// delta. See `raw-ffi/src/scene_linear/tile.rs` for which FFI entries pass
/// which.
///
/// `ae_gain` (#1167) is the scalar auto-exposure anchor gain to apply as a
/// flat scene-linear multiply, at the same chain position the full/sized
/// develop applies `stages::auto_exposure::apply`. `1.0` is a bit-identical
/// no-op — every existing tile caller passes `1.0` (matching the pre-#1167
/// omission exactly), and a caller wanting parity with a full-image develop
/// that had `papp:AutoExposure="On"` passes the gain THAT develop's
/// `auto_exposure` stage returned (see
/// `pipeline::develop::develop_scene_linear_from_raw_with_quality_with_gain`
/// / the sized sibling). The tile chain never recomputes this gain itself —
/// a tile's own histogram isn't representative of the whole scene.
pub(super) fn develop_scene_linear_from_padded_mosaic(
    mosaic: &crate::image::Image,
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
    anchors: TileAnchors<'_>,
    cancel: crate::CancelToken<'_>,
) -> Result<DevelopedTile> {
    let TileAnchors {
        output,
        window,
        inner,
        active_area,
        tile_origin,
        highlight_frame,
        haze,
    } = anchors;
    if raw.cfa == crate::image::CfaPattern::LinearRgb {
        return Err(crate::error::Error::Pipeline(
            "tile path does not support LinearRaw DNGs; use the full-image render entry instead. See ticket #07."
                .into()
        ));
    }
    if matches!(raw.cfa, crate::image::CfaPattern::XTrans(_)) {
        // The tile path rounds the padded rect's start corners to even
        // multiples (2×2 Bayer phase). X-Trans has a 6×6 phase, so the
        // current padding logic would corrupt the CFA mapping across
        // tile boundaries. Refuse here and let the caller fall back to
        // the full-image render entry — same policy as LinearRaw. See
        // tickets #420 / #417.
        return Err(crate::error::Error::Pipeline(
            "tile path does not support Fuji X-Trans RAFs; use the \
             full-image render entry instead. The X-Trans 6×6 CFA phase \
             is incompatible with the 2×2-aligned tile padding (#420)."
                .into(),
        ));
    }
    mosaic.assert_space(crate::image::ColorSpace::CameraNativeMosaic);
    let divisor = effective_quality_divisor(quality, raw.cfa);
    let sensor_origin = (tile_origin.0 * divisor, tile_origin.1 * divisor);
    let mut camera_rgb =
        super::prefix::from_mosaic(mosaic, raw, model, quality, sensor_origin, cancel);

    stage("tile_highlight_recovery", || {
        highlight_recovery::apply_in_sensor_space(
            &mut camera_rgb,
            model.highlight_recovery,
            raw.as_shot_neutral,
            raw.baseline_exposure,
            active_area,
            Some(highlight_frame),
            crate::sensor_gain_maps::ClipGainContext::new(raw, sensor_origin, divisor),
        )
    });
    if cancel.is_cancelled() {
        return Err(crate::error::Error::Cancelled);
    }
    // DNG OpcodeList3 (#376, #4288): vendor corrections applied in
    // ActiveArea coordinates after baseline exposure, AsShot pre-gain and
    // highlight recovery, before DefaultCrop and DCP, matching full develop.
    if let Some((list, aa)) = raw.opcode_list3.as_ref() {
        if list.opcodes.len() == 1 {
            if let crate::pipeline::pano::opcodes::PanoOpcode::WarpRectilinear(w) = &list.opcodes[0]
            {
                stage("tile_opcode_list3", || {
                    let qd = effective_quality_divisor(quality, raw.cfa);
                    let full_w = raw.width / qd;
                    let full_h = raw.height / qd;
                    let scaled_aa = crate::pipeline::pano::opcode_apply::scale_active_area(
                        *aa,
                        1.0 / qd as f32,
                        full_w,
                        full_h,
                    );
                    let scales =
                        crate::pipeline::pano::opcode_apply::LensCorrectionScales::from_model(
                            model,
                        );
                    crate::pipeline::pano::opcode_apply::apply_warp_rectilinear_windowed(
                        &mut camera_rgb,
                        w,
                        scaled_aa,
                        scales.distortion,
                        scales.ca,
                        tile_origin,
                    );
                });
            }
        }
    } else if crate::lens_profile::applies(raw, model) {
        let qd = effective_quality_divisor(quality, raw.cfa);
        let full_dims = (raw.width / qd, raw.height / qd);
        stage("tile_lcp_correction", || {
            crate::lens_profile::apply_for_raw_windowed(
                raw,
                model,
                &mut camera_rgb,
                1.0 / qd as f32,
                tile_origin,
                full_dims,
            )
        })?;
    }

    if cancel.is_cancelled() {
        return Err(crate::error::Error::Cancelled);
    }
    let (camera_rgb, window, mut inner) = stage("tile_crop_to_default", || {
        clip_to_default_crop(camera_rgb, window, inner)
    });
    let (profile, profile_source) =
        stage("tile_dcp_profile_for", || dcp::profile_for_with_source(raw))?;
    let (decoded_wb_anchor, ae_gain) = match output {
        TileOutput::Scene {
            decoded_wb_anchor,
            ae_gain,
        } => (decoded_wb_anchor, ae_gain),
        TileOutput::Capture => {
            return Ok(DevelopedTile {
                image: capture_colour(camera_rgb, &profile, model, window, cancel)?,
                inner,
            })
        }
    };
    let mut scene = develop_colour(
        camera_rgb,
        TileColour {
            raw,
            model,
            profile,
            profile_source,
            decoded_wb_anchor,
            ae_gain,
            window,
            cancel,
        },
    )?;
    // The S/H detail mask blurs at σ = 15 px · longEdge/2000 of the FULL
    // frame, not of this padded crop (#2476) — anchoring on the crop gave
    // every tile a radius set by its own geometry and a render that
    // disagreed with the whole-image chain across the entire interior. The
    // tile entry sizes its overlap pad to the mask's reach at this anchor
    // (`tile_overlap_px`), so the interior blur sees the same neighbourhood
    // the whole-image develop does.
    let mask_long_edge = full_frame_long_edge(raw, quality);
    stage("tile_scene_tone_controls", || {
        scene_tone_controls::apply_with_mask_anchor(&mut scene, model, mask_long_edge)
    });
    // User-authored tone curves (parametric + per-channel) — same chain
    // position as the full path (post-scene_tone_controls, pre-vibrance).
    // Pointwise per-pixel, so trivially tile-safe; identity short-circuits
    // on the default model. Was silently omitted before #1084 — deep-zoom
    // tiles diverged from the preview for any image with a curve.
    stage("tile_tone_curves", || tone_curves::apply(&mut scene, model));
    stage("tile_vibrance", || {
        vibrance::apply(&mut scene, model.vibrance)
    });
    stage("tile_saturation", || {
        saturation::apply(&mut scene, model.saturation)
    });
    // HSL 8-band (#1112) — scene-linear Oklab per-pixel op (like
    // vibrance/saturation), after saturation and before clarity, matching
    // the full and sized develop chains. Was silently omitted here (#1931):
    // a deep-zoom tile with any non-default HSL adjustment diverged from the
    // full-resolution preview. Point op with no neighbour gather, so it is
    // trivially tile-safe; identity short-circuits on the all-default model.
    stage("tile_hsl", || hsl::apply_model(&mut scene, model));
    stage("tile_color_curves", || {
        color_curves::apply_model(&mut scene, model)
    });
    stage("tile_clarity", || clarity::apply(&mut scene, model.clarity));
    stage("tile_texture", || texture::apply(&mut scene, model.texture));
    // Dehaze (#3287) is a point op given the full frame's proxy haze map,
    // sampled at the tile's place in the frame — the whole-image recovery
    // restricted to this tile, so it adds nothing to the pad.
    if let Some(map) = haze.and_then(|haze| haze.global.as_ref()) {
        stage("tile_dehaze", || {
            crate::stages::dehaze::apply_with_map(
                &mut scene,
                model.dehaze,
                map,
                window.origin,
                window.full,
            )
        });
    }
    // Local adjustments and vignette (#1157): both are point ops GIVEN the
    // tile's window in the frame — mask weights evaluate in coordinates
    // normalised to the FULL frame and the vignette ellipse is centred on
    // it — so they take `window` (origin + frame extent at this develop
    // resolution) and reproduce the whole-image field exactly. Same chain
    // positions as the full develop: after dehaze, before sharpen.
    stage("tile_defringe", || defringe::apply_model(&mut scene, model));
    stage("tile_local_adjustments", || {
        let (layers, rasters) = crate::pipeline::mask::orient_adjustments_to_sensor(
            &model.local_adjustments,
            &model.mask_rasters,
            raw.orientation,
        );
        match haze {
            Some(haze) => local_adjustments::apply_windowed_with_haze(
                &mut scene,
                &layers,
                &rasters,
                window.origin,
                window.full,
                &haze.layers,
            ),
            None => local_adjustments::apply_windowed(
                &mut scene,
                &layers,
                &rasters,
                window.origin,
                window.full,
            ),
        }
    });
    stage("tile_vignette", || {
        vignette::apply_windowed(
            &mut scene,
            model.vignette_amount,
            model.vignette_feather,
            window.origin,
            window.full,
        )
    });
    // S/H can require hundreds of source pixels of context. Its work is
    // complete now, as are the frame-anchored point ops. Keep only the sum
    // of downstream stencil reaches before running the expensive NLM tail.
    let reach = super::overlap::tail_reach_px(model) as u32;
    let x = inner.0.saturating_sub(reach);
    let y = inner.1.saturating_sub(reach);
    let right = (inner.0 + inner.2 + reach).min(scene.width);
    let bottom = (inner.1 + inner.3 + reach).min(scene.height);
    if x != 0 || y != 0 || right != scene.width || bottom != scene.height {
        scene = stage("tile_trim_consumed_overlap", || {
            trim_image_to_inner(&scene, x, y, right - x, bottom - y)
        });
        inner.0 -= x;
        inner.1 -= y;
    }
    stage("tile_sharpen", || {
        sharpen::apply(
            &mut scene,
            model.sharpen_amount,
            model.sharpen_radius,
            model.sharpen_detail,
            model.sharpen_masking,
        )
    });
    stage("tile_nr_luminance", || {
        noise_reduction::apply_luminance(
            &mut scene,
            model.nr_luminance,
            raw.noise_profile.as_deref(),
            raw.iso,
        )
    });
    stage("tile_nr_color", || {
        noise_reduction::apply_color(
            &mut scene,
            model.nr_color,
            raw.noise_profile.as_deref(),
            raw.iso,
        )
    });
    Ok(DevelopedTile {
        image: scene,
        inner,
    })
}
