//! Develop chain used by the tile path — mirrors
//! `super::super::develop::develop_scene_linear_from_raw_with_quality`
//! without the leading `linearize` call (the tile entry linearises only
//! the padded crop region) and **without** the stages that exclude
//! themselves architecturally (see the per-stage notes at each chain
//! position):
//!
//! * dehaze and deep_denoise — rejected loudly at the tile entry
//!   (`super::guards`) so the host falls back to the full-image render
//!   (#1105; dehaze awaits a full-frame proxy plane),
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
    demosaic,
    error::Result,
    image::RawImage,
    stages::{
        chroma_prefilter, clarity, highlight_recovery, highlight_recovery_oklab, hsl,
        noise_reduction, saturation, scene_tone_controls, sharpen, texture, tone_curves, vibrance,
        wb_camera, white_balance,
    },
    xmp::AdjustmentModel,
};

use super::region::{trim_image_to_inner, TileWindow};
use crate::pipeline::{
    capture_sharpening_helper::capture_sharpening_params_from_model,
    develop::effective_quality_divisor, native_render_dims, stage, RenderQuality,
};
use crate::stages::{capture_sharpening, local_adjustments, vignette};

/// The per-render values the tile entry threads into the chain besides the
/// mosaic and the model: the host-measured anchors (WB delta anchor, #1725;
/// auto-exposure gain, #1167) and the tile's window in the frame (#1157).
pub(super) struct TileAnchors {
    /// See [`develop_scene_linear_from_padded_mosaic`].
    pub decoded_wb_anchor: Option<(f32, f32)>,
    /// See [`develop_scene_linear_from_padded_mosaic`].
    pub ae_gain: f32,
    /// Where the padded crop sits in the developed frame — the anchor for
    /// vignette's ellipse and the local-adjustment masks.
    pub window: TileWindow,
    /// Requested inner rect, relative to the padded developed buffer.
    pub inner: (u32, u32, u32, u32),
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
/// `linearize` call and **without** dehaze / vignette / deep_denoise /
/// local_adjustments / capture_sharpening (the tile entry errors before
/// this fn runs when any of them is active — see the rejection block in
/// `render_scene_linear_tile_from_raw_with_quality`, #1084 / #1105 /
/// #1109).
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
    anchors: TileAnchors,
) -> Result<DevelopedTile> {
    let TileAnchors {
        decoded_wb_anchor,
        ae_gain,
        window,
        mut inner,
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
    let mut camera_rgb = stage("tile_demosaic", || match quality {
        RenderQuality::Preview => demosaic::half_res(mosaic, raw.cfa),
        #[cfg(feature = "high-quality-demosaic")]
        RenderQuality::Full => demosaic::hamilton_adams(mosaic, raw.cfa),
        #[cfg(not(feature = "high-quality-demosaic"))]
        RenderQuality::Full => demosaic::bilinear(mosaic, raw.cfa),
        RenderQuality::Amaze => demosaic::amaze(mosaic, raw.cfa),
    });
    if raw.baseline_exposure.abs() > 1e-4 {
        stage("tile_baseline_exposure", || {
            let be_gain = raw.baseline_exposure.exp2();
            for p in &mut camera_rgb.pixels {
                p[0] *= be_gain;
                p[1] *= be_gain;
                p[2] *= be_gain;
            }
        });
    }

    // WB pre-gain: matches the unsized + sized variants (Phase 1.2 contract).
    // The DCP profile downstream runs with `wb_already_baked = true` for
    // Bayer paths, expecting input camera RGB to have been divided by
    // AsShotNeutral. Skip would have been required for 8-bit lossy LinearRaw
    // but this entire function rejects LinearRaw at the top, so the only
    // path here is Bayer — always pre-gain.
    stage("tile_white_balance::apply_pre_gain", || {
        white_balance::apply_pre_gain(&mut camera_rgb, raw.as_shot_neutral)
    });
    stage("tile_highlight_recovery", || {
        highlight_recovery::apply(
            &mut camera_rgb,
            model.highlight_recovery,
            raw.as_shot_neutral,
        )
    });
    let (profile, profile_source) =
        stage("tile_dcp_profile_for", || dcp::profile_for_with_source(raw))?;
    // Camera-space user white balance (#1726) — mirrors the full-res
    // develop chain; see `pipeline::develop` and `stages::wb_camera` for
    // the design writeup. This function rejects LinearRaw at the top (see
    // the guard above), so the only tier gate needed here is
    // `RawlerFallback`.
    //
    // `decoded_wb_anchor` (#1725 delta contract) takes precedence over
    // `resolve_target`'s absolute As-Shot seeding when both apply: a
    // `Some` anchor means the caller has its own decoded/live reference
    // point in hand (see `stages::wb_camera::apply_delta`'s doc for why
    // that reference point can differ from `resolve_target`'s
    // `profile.scene_cct` idealized-locus seed — a real camera's as-shot
    // chromaticity can sit far enough off the locus that no
    // `(temperature, tint)` pair within the slider's ±100 tint range
    // reaches it, so `apply`'s single fixed identity point isn't always
    // reachable). `apply_delta`'s own identity short-circuit (`target ==
    // anchor`) is what actually decides no-op-ness in that case.
    let camera_wb_target = if !matches!(profile_source, dcp::ProfileSource::RawlerFallback) {
        let frame = wb_camera::SliderFrame::resolve(raw, &profile);
        let target = stage("tile_wb_camera::apply", || match decoded_wb_anchor {
            Some((decoded_temperature, decoded_tint)) => {
                wb_camera::apply_delta(
                    &mut camera_rgb,
                    &frame,
                    raw.as_shot_neutral,
                    (model.temperature, model.tint),
                    (decoded_temperature, decoded_tint),
                );
                // The anchor contract promises the caller hydrated the
                // model to explicit values (see `apply_delta`'s doc), so
                // the model pair IS the render target the full develop of
                // this same model would retarget DCP at.
                (model.temperature, model.tint)
            }
            None => {
                // `resolve_target_versioned` (#1780): V1 (pre-#1756)
                // sidecar temperature/tint convert into the slider frame
                // here, mirroring the full develop chain. The Some(anchor)
                // branch above is the live-delta contract (#1725) and is
                // deliberately untouched — its values come from the host's
                // live model, not from a parsed sidecar.
                let (target_temperature, target_tint) = wb_camera::resolve_target_versioned(
                    model,
                    &frame,
                    &profile,
                    raw.as_shot_neutral,
                );
                wb_camera::apply(
                    &mut camera_rgb,
                    &frame,
                    raw.as_shot_neutral,
                    target_temperature,
                    target_tint,
                );
                (target_temperature, target_tint)
            }
        });
        Some((frame, target))
    } else {
        None
    };
    let camera_wb_applied = camera_wb_target.is_some();
    // DNG-spec `SetWhiteXY` retarget (#1727) — mirrors `pipeline::develop`:
    // DCP's rendering matrices track the user's target when camera-space
    // WB moved off as-shot, keeping a tile bit-consistent with a full
    // develop of the same model. As-shot targets return the profile
    // unchanged. See `wb_camera::retargeted_render_profile`.
    let dcp_profile = match &camera_wb_target {
        Some((frame, (target_temperature, target_tint))) => {
            wb_camera::retargeted_render_profile(frame, profile, *target_temperature, *target_tint)
        }
        None => profile,
    };
    // Colorimetry-only DCP per #425 — PLT and PTC no longer run on any
    // path (see `pipeline::develop` for the strategic rationale).
    let mut scene = stage("tile_dcp_apply", || {
        dcp::apply_colorimetry(&camera_rgb, &dcp_profile)
    })?;
    // Ticket #471: opt-in post-DCP Oklab chroma-reduction highlight
    // recovery. No-op for every other mode — see `pipeline::develop` for
    // the strategic rationale.
    stage("tile_highlight_recovery_oklab", || {
        highlight_recovery_oklab::apply_post_dcp(&mut scene, model.highlight_recovery)
    });
    // ProfileGainTableMap is not applied on any path (#2774) — see
    // `pipeline::develop` for the rationale.
    // Decode-time chroma pre-filter (#1104). Translation-invariant with a
    // ±4 px stencil — well inside TILE_OVERLAP_PX (48), so the padded tile
    // renders the same pixels the full-image path does. No-op at default 0.
    stage("tile_chroma_prefilter", || {
        chroma_prefilter::apply(&mut scene, model.chroma_prefilter)
    });
    // deep_denoise (BM3D, #1105) intentionally omitted — its reference-patch
    // grid is frame-anchored, so a tile-relative grid would seam at tile
    // borders. The tile entry rejects `deep_denoise != 0` before this fn
    // runs (and the FFI file/bytes tile entries pre-check it as well — see
    // `raw-ffi/src/model.rs::deep_denoise_active`).
    //
    // Capture sharpening (#1157) — same chain position as the full develop
    // (after the chroma prefilter, before the scene anchor). The iterated
    // Richardson–Lucy stencil reaches `iterations × 2 × ⌈3σ⌉` px (96 at the
    // σ = 8 clamp), which the tile entry's overlap calculator pads for
    // (`capture_sharpening::stencil_reach_px`), so the padded crop's interior
    // sees the same neighbourhood the whole-image pass does.
    if let Some(params) = capture_sharpening_params_from_model(model) {
        stage("tile_capture_sharpening", || {
            capture_sharpening::apply_capture_sharpening(&mut scene, &params)
        });
    }
    // Per-image scene-anchor gain (#1167). A tile's own histogram is not
    // representative of the whole scene, so this chain never RECOMPUTES the
    // anchor — `ae_gain` is a scalar the caller already measured from a
    // full-image (or sized) develop of the same model (see this function's
    // doc comment). Applied at EXACTLY the chain position
    // `stages::auto_exposure::apply` occupies in the full/sized develop
    // chains: after chroma_prefilter/deep_denoise/capture_sharpening (the
    // latter two are rejected loudly at the tile entry, same as dehaze), and
    // before the post-DCP white-balance block below. Position matters here
    // for two reasons: (a) genuinely non-commutative downstream stages —
    // `scene_tone_controls`' shaping (shadows/highlights/whites/blacks/
    // contrast) and `tone_curves` are nonlinear in pixel value, so a scalar
    // applied after them yields different pixels than one applied before;
    // (b) bit-exact parity — the linear WB matrix/diagonal multiplies in
    // between DO commute with a scalar algebraically, but not bit-for-bit
    // under f32 rounding, and bit-equality with the full chain is this
    // path's test contract (`tile_matches_full_chain_*`). So the multiply
    // must land at the same relative position the full chain uses, not just
    // "somewhere before the pixels are returned." `1.0` (every pre-#1167
    // caller) is a bit-identical no-op.
    if (ae_gain - 1.0).abs() > 1e-6 {
        stage("tile_auto_exposure", || {
            for p in &mut scene.pixels {
                p[0] *= ae_gain;
                p[1] *= ae_gain;
                p[2] *= ae_gain;
            }
        });
    }
    // Post-DCP white balance — skipped entirely when camera-space WB
    // already ran (#1726; see `pipeline::develop` for the full rationale):
    // that stage normalised `camera_rgb` to the user's target illuminant
    // pre-DCP, so neither the delta nor the absolute post-DCP contract
    // below should also fire, or the shift would double-count. Falls
    // through to the pre-#1726 WB contract split (#1725 band fix)
    // unchanged for the `RawlerFallback` tier, where `camera_wb_applied`
    // is false:
    //
    // - `decoded_wb_anchor = Some((decoded_temp, decoded_tint))`: the caller
    //   is the app's live-chain / tile-refine flow, which treats slider
    //   values as a DELTA vs. the buffer's decode-time WB — exactly like
    //   `pipeline::apply_scene_linear_chain` (the GPU-live per-tick FFI
    //   entry) does. Applying `model.temperature`/`model.tint` here via
    //   `resolve_wb` + ABSOLUTE `apply` (the pre-fix behavior) shifted the
    //   tile away from the GPU-live frame's IDENTITY render whenever the
    //   as-shot CCT was off D65 — the horizontal band. `apply_delta` with
    //   the SAME anchor the live chain used makes slider==as-shot render
    //   IDENTITY through both paths.
    // - `None`: the caller is the maple-cli / XMP-render family (or any
    //   caller that predates the anchor), where ABSOLUTE semantics are
    //   correct — `crs:Temperature` in an XMP sidecar is an absolute ACR
    //   value, not a delta. Falls through to the pre-fix `resolve_wb` +
    //   `apply` path unchanged.
    if !camera_wb_applied {
        match decoded_wb_anchor {
            Some((decoded_temp, decoded_tint)) => {
                stage("tile_white_balance_delta", || {
                    white_balance::apply_delta(
                        &mut scene,
                        model.temperature,
                        model.tint,
                        decoded_temp,
                        decoded_tint,
                        model.wb_method,
                    )
                });
            }
            None => {
                // ACR anchoring (#1729 / round-trip fix): delegate to
                // `white_balance::resolve_wb` — the single source of truth
                // for WB resolution semantics, shared by the
                // develop/mod.rs and develop_sized.rs XMP/CLI render
                // sites.
                let (effective_temperature, effective_tint) = white_balance::resolve_wb(model);
                stage("tile_white_balance", || {
                    white_balance::apply(
                        &mut scene,
                        effective_temperature,
                        effective_tint,
                        model.wb_method,
                    )
                });
            }
        }
    }
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
    stage("tile_clarity", || clarity::apply(&mut scene, model.clarity));
    stage("tile_texture", || texture::apply(&mut scene, model.texture));
    // dehaze intentionally omitted — global statistics plus a radius-60
    // transmission refine; the tile entry rejects `dehaze != 0` before this
    // function runs, until the full-frame proxy plane exists (§ 5.3).
    //
    // Local adjustments and vignette (#1157): both are point ops GIVEN the
    // tile's window in the frame — mask weights evaluate in coordinates
    // normalised to the FULL frame and the vignette ellipse is centred on
    // it — so they take `window` (origin + frame extent at this develop
    // resolution) and reproduce the whole-image field exactly. Same chain
    // positions as the full develop: after texture (where dehaze would sit),
    // before sharpen.
    stage("tile_local_adjustments", || {
        local_adjustments::apply_windowed(
            &mut scene,
            &model.local_adjustments,
            &model.mask_rasters,
            window.origin,
            window.full,
        )
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
