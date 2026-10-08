//! Canonical pre-recovery Bayer camera prefix for tiles and frame sampling.
use crate::{
    image::{Image, RawImage},
    pipeline::{stage, RenderQuality},
    stages::{hot_pixel, white_balance},
    xmp::AdjustmentModel,
};

pub(super) fn from_window(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
    rect: (u32, u32, u32, u32),
) -> Image {
    let (x, y, w, h) = rect;
    let mut mosaic = crate::linearize::sensor_linearize_region(raw, x, y, w, h);
    hot_pixel::apply(&mut mosaic, raw.cfa, model.hot_pixel_suppression);
    from_mosaic(&mosaic, raw, model, quality, crate::CancelToken::never())
}

pub(super) fn from_mosaic(
    mosaic: &Image,
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
    cancel: crate::CancelToken<'_>,
) -> Image {
    let mut camera = stage("tile_demosaic", || {
        crate::demosaic::demosaic_cancellable(
            crate::pipeline::bayer_kernel(quality, model, raw),
            mosaic,
            raw.cfa,
            cancel,
        )
    });
    if raw.baseline_exposure.abs() > 1e-4 {
        stage("tile_baseline_exposure", || {
            let gain = raw.baseline_exposure.exp2();
            for p in &mut camera.pixels {
                p[0] *= gain;
                p[1] *= gain;
                p[2] *= gain;
            }
        });
    }
    stage("tile_white_balance::apply_pre_gain", || {
        white_balance::apply_pre_gain(&mut camera, raw.as_shot_neutral)
    });
    camera
}
