//! Shared bounded camera prefix before user WB / DCP (#3955).
use crate::{
    demosaic,
    error::Result,
    image::{CropRect, Image, RawImage},
    pipeline::{stage, RenderQuality},
    stages::{highlight_recovery, white_balance},
    xmp::AdjustmentModel,
};

pub(super) fn prepare(
    mosaic: &Image,
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
    active_area: Option<CropRect>,
) -> Result<Image> {
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
    // Full uses RCD like every other on-screen path (#3412). Its 5-px
    // stencil sits far inside `TILE_OVERLAP_PX` (48), so the padded crop's
    // interior — the part `trim_image_to_inner` keeps — is reconstructed
    // from real neighbours and a tile matches the same region of the
    // full-image render.
    let mut camera_rgb = stage("tile_demosaic", || {
        let algo = crate::pipeline::bayer_kernel(quality, model, raw);
        demosaic::demosaic(algo, mosaic, raw.cfa)
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
        highlight_recovery::apply_in_region(
            &mut camera_rgb,
            model.highlight_recovery,
            raw.as_shot_neutral,
            raw.baseline_exposure,
            active_area,
        )
    });
    Ok(camera_rgb)
}
