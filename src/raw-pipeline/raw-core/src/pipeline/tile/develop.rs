//! Develop chain used by the tile path — mirrors
//! `super::super::develop::develop_scene_linear_from_raw_with_quality`
//! without the leading `linearize` call (the tile entry linearises only
//! the padded crop region) and **without** the stages that exclude
//! themselves architecturally (see the per-stage notes at each chain
//! position):
//!
//! * dehaze, vignette, deep_denoise, local_adjustments,
//!   capture_sharpening — rejected loudly at the tile entry
//!   (`super::render_scene_linear_tile_from_raw_with_quality`) so the
//!   host falls back to the full-image render (#1084, #1105, #1109),
//! * auto_exposure — omitted; parity follow-up tracked in #1167.
//!
//! Split out of `super::mod` so the tile entry stays under the file-size
//! budget (#114).

use crate::{
    color::dcp,
    demosaic,
    error::Result,
    image::RawImage,
    stages::{
        chroma_prefilter, clarity, highlight_recovery, highlight_recovery_oklab, noise_reduction,
        saturation, scene_tone_controls, sharpen, texture, tone_curves, vibrance, wb_camera,
        white_balance,
    },
    xmp::AdjustmentModel,
};

use crate::pipeline::{stage, RenderQuality};

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
pub(super) fn develop_scene_linear_from_padded_mosaic(
    mosaic: &crate::image::Image,
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
    decoded_wb_anchor: Option<(f32, f32)>,
) -> Result<crate::image::Image> {
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
                let (target_temperature, target_tint) = wb_camera::resolve_target(model, &frame);
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
    if let Some(pgtm) = raw.profile_gain_table_map.as_ref() {
        stage("tile_profile_gain_table_map", || {
            crate::color::profile_gain_table_map::apply(&mut scene, pgtm)
        });
    }
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
    // capture_sharpening intentionally omitted — the iterated Richardson–
    // Lucy stencil reaches up to ~2·iterations·3σ ≈ 96 px at the σ = 8
    // helper clamp, past TILE_OVERLAP_PX (48). The tile entry errors before
    // this fn runs when the model carries an active capture-sharpening
    // amount — same loud-rejection contract as dehaze (#1084).
    //
    // NOTE: auto_exposure intentionally omitted on the tile path. A tile is
    // a sub-region of the image, so its histogram is not representative of
    // the whole scene — running AE here would give a different gain per
    // tile, producing visible discontinuities at tile borders. Wiring AE
    // into the tile path correctly requires precomputing the EV from the
    // full image once and threading it through. Today the tile path will
    // render slightly darker than the full-image path (by whatever EV the
    // full path's AE picked); follow-up tracked in #1167. The same
    // architectural reason already excludes dehaze from this path.
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
    stage("tile_scene_tone_controls", || {
        scene_tone_controls::apply(&mut scene, model)
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
    stage("tile_clarity", || clarity::apply(&mut scene, model.clarity));
    stage("tile_texture", || texture::apply(&mut scene, model.texture));
    // dehaze intentionally omitted — the tile entry asserts dehaze == 0
    // before this function runs (radius 67 px > TILE_OVERLAP_PX overlap pad).
    //
    // local_adjustments intentionally omitted — mask weights evaluate in
    // coordinates normalized to the FULL image (`mask::evaluate(nx, ny)`
    // with `nx = x / (w-1)`), so running the stage on a padded crop would
    // place every mask relative to the tile instead of the image. Wiring it
    // needs mask-coordinate offset plumbing; until then the tile entry
    // rejects any model with a non-identity local adjustment — same loud
    // contract as dehaze (#1084).
    //
    // vignette intentionally omitted — full-frame-anchored radial gain
    // (#1109); the tile entry rejects `vignette_amount != 0` until the
    // tile window is threaded through (`apply_windowed`, #11).
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
    Ok(scene)
}
