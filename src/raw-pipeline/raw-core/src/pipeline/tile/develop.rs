//! Develop chain used by the tile path — mirrors
//! `super::super::develop::develop_scene_linear_from_raw_with_quality`
//! without the leading `linearize` call (the tile entry linearises only
//! the padded crop region) and **without** dehaze / auto-exposure (both
//! exclude themselves architecturally; see per-stage notes).
//!
//! Split out of `super::mod` so the tile entry stays under the file-size
//! budget (#114).

use crate::{
    color::dcp,
    demosaic,
    error::Result,
    image::RawImage,
    stages::{
        clarity, highlight_recovery, highlight_recovery_oklab, noise_reduction, saturation,
        scene_tone_controls, sharpen, texture, vibrance, white_balance,
    },
    xmp::AdjustmentModel,
};

use crate::pipeline::{stage, RenderQuality};

/// Run the development chain from a pre-cropped `CameraNativeMosaic`
/// `Image` (as produced by `linearize::sensor_linearize_region`). Used by
/// the tile path so the linearize + crop pair runs once on the padded
/// crop and the develop chain runs on a small image. Mirrors
/// `develop_scene_linear_from_raw_with_quality` but without the leading
/// `linearize` call and **without** dehaze (the tile entry errors before
/// this fn runs when `model.dehaze != 0`).
pub(super) fn develop_scene_linear_from_padded_mosaic(
    mosaic: &crate::image::Image,
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
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
                .into()
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
        highlight_recovery::apply(&mut camera_rgb, model.highlight_recovery, raw.as_shot_neutral)
    });
    let profile = stage("tile_dcp_profile_for", || dcp::profile_for(raw))?;
    // Colorimetry-only DCP per #425 — PLT and PTC no longer run on any
    // path (see `pipeline::develop` for the strategic rationale).
    let mut scene = stage("tile_dcp_apply", || dcp::apply_colorimetry(
        &camera_rgb, &profile,
    ))?;
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
    // NOTE: auto_exposure intentionally omitted on the tile path. A tile is
    // a sub-region of the image, so its histogram is not representative of
    // the whole scene — running AE here would give a different gain per
    // tile, producing visible discontinuities at tile borders. Wiring AE
    // into the tile path correctly requires precomputing the EV from the
    // full image once and threading it through. Today the tile path will
    // render slightly darker than the full-image path (by whatever EV the
    // full path's AE picked); this is a known follow-up. The same
    // architectural reason already excludes dehaze from this path.
    stage("tile_white_balance", || white_balance::apply(&mut scene, model.temperature, model.tint));
    stage("tile_scene_tone_controls", || scene_tone_controls::apply(&mut scene, model));
    stage("tile_vibrance", || vibrance::apply(&mut scene, model.vibrance));
    stage("tile_saturation", || saturation::apply(&mut scene, model.saturation));
    stage("tile_clarity", || clarity::apply(&mut scene, model.clarity));
    stage("tile_texture", || texture::apply(&mut scene, model.texture));
    // dehaze intentionally omitted — the tile entry asserts dehaze == 0
    // before this function runs (radius 67 px > TILE_OVERLAP_PX overlap pad).
    stage("tile_sharpen", || sharpen::apply(&mut scene, model.sharpen_amount, model.sharpen_radius, model.sharpen_detail, model.sharpen_masking));
    stage("tile_nr_luminance", || noise_reduction::apply_luminance(&mut scene, model.nr_luminance));
    stage("tile_nr_color", || noise_reduction::apply_color(&mut scene, model.nr_color));
    Ok(scene)
}
