//! Camera-native reconstruction with matching sensor saturation metadata.
use super::geometry;
use crate::pipeline::{stage, RenderQuality};
use crate::{
    cancel::CancelToken,
    demosaic,
    error::Result,
    image::{Image, RawImage},
    linearize::{self, sensor_gains::SensorGains},
    stages::hot_pixel,
    xmp::AdjustmentModel,
};

pub(super) fn prepare<'a>(
    raw: &'a RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
    cancel: CancelToken<'_>,
) -> Result<(Image, Option<SensorGains<'a>>)> {
    let prepared = match raw.cfa {
        crate::image::CfaPattern::LinearRgb => {
            // LinearRaw DNG: data is already 3-channel RGB. Skip the
            // mosaic path entirely. See ticket #07.
            let rgb = stage("linearraw_decode", || {
                linearize::linearraw_to_camera_rgb(raw)
            })?;
            (rgb, None)
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
            let rgb = stage("demosaic_xtrans", || match quality {
                RenderQuality::Preview => demosaic::xtrans_bilinear(&mosaic, raw.cfa),
                RenderQuality::Full | RenderQuality::Amaze | RenderQuality::Auto => {
                    demosaic::markesteijn(&mosaic, raw.cfa)
                }
            });
            (rgb, None)
        }
        _ => {
            let mut mosaic = stage("linearize", || linearize::sensor_linearize(raw));
            // Hot/dead-pixel suppression (#1106) — pre-demosaic, raw-domain.
            // No-op (bit-identical) at the default Off.
            stage("hot_pixel", || {
                hot_pixel::apply(&mut mosaic, raw.cfa, model.hot_pixel_suppression)
            });
            // #3411 — raw-domain, so BEFORE whichever kernel is picked below.
            let ca = geometry::lateral_ca(&mut mosaic, raw, model, cancel)?;
            let gains = crate::linearize::sensor_gains::SensorGains::for_raw(raw, (0, 0), 1)
                .map(|g| g.with_ca(ca));
            // Which kernel is `bayer_kernel`'s call (#3413): the quality
            // level's own default, overridden by the model's `demosaic`
            // field, and noise-adaptive at `Auto`. Kernels with a
            // cancellable entry unwind per band/row; the rest are not on
            // the cold-open interactive path, and the post-demosaic check
            // below bails before any downstream stage runs either way.
            let rgb = stage("demosaic", || {
                let algo = crate::pipeline::bayer_kernel(quality, model, raw);
                demosaic::demosaic_calibrated_cancellable(
                    algo,
                    &mosaic,
                    raw.cfa,
                    raw.as_shot_neutral,
                    gains,
                    cancel,
                )
            });
            (rgb, gains)
        }
    };
    Ok(prepared)
}
