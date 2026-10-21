//! Bayer guided-highlight scene evidence shared by native tiles and the
//! full frame. The prior is sampled at Preview density whatever the render
//! quality (#5049): visit full-width half-res strips with prefix support,
//! retaining only the eligible stride-8 samples that the shared decimation
//! reduces to at most 4096, so a first zoom tile never demosaics the frame.
use crate::{
    image::{CropRect, Image, RawImage},
    pipeline::RenderQuality,
    stages::highlight_recovery::{FrameAnchor, ScenePrior, SceneSamples},
    types::adjustment::AutoLateralCa,
    xmp::{AdjustmentModel, HighlightRecoveryMode},
};

/// Half-res output rows per sampling strip, and prefix rows each side. The
/// half-res window and hot-pixel stencil reach two rows; a strip spans at
/// most 368 mosaic rows plus an odd sensor tail, within `scratch_pixels`.
const BAND_ROWS: u32 = 160;
const SUPPORT_ROWS: u32 = 12;

fn enabled(model: &AdjustmentModel) -> bool {
    matches!(
        model.highlight_recovery,
        HighlightRecoveryMode::ChromaticAdaptation
            | HighlightRecoveryMode::Blend
            | HighlightRecoveryMode::Luminance
    )
}

pub(super) fn grain(raw: &RawImage, model: &AdjustmentModel, quality: RenderQuality) -> u32 {
    let divisor = crate::pipeline::develop::effective_quality_divisor(quality, raw.cfa);
    match crate::pipeline::bayer_kernel(quality, model, raw) {
        crate::demosaic::DemosaicAlgorithm::Amaze
        | crate::demosaic::DemosaicAlgorithm::DualAmazeVng4 => 128,
        _ => 16 * divisor,
    }
}

pub(super) fn padded_rect(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
    rect: (u32, u32, u32, u32),
    pad: u32,
) -> ((u32, u32, u32, u32), (u32, u32)) {
    let (sx, sy, sw, sh) = rect;
    let ((x, y, w, h), _) =
        super::region::pad_and_clamp_mosaic_rect(sx, sy, sw, sh, pad, raw.width, raw.height);
    let g = grain(raw, model, quality);
    let (x0, y0) = (x / g * g, y / g * g);
    let (x1, y1) = (
        (x + w).div_ceil(g).saturating_mul(g).min(raw.width),
        (y + h).div_ceil(g).saturating_mul(g).min(raw.height),
    );
    ((x0, y0, x1 - x0, y1 - y0), (sx - x0, sy - y0))
}

pub(super) fn scratch_pixels(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
) -> u64 {
    if !enabled(model) {
        return 0;
    }
    let divisor = crate::pipeline::develop::effective_quality_divisor(quality, raw.cfa);
    // Admits the Preview-density sampling strip at every quality.
    u64::from(raw.width) * u64::from(raw.height.min(384 * divisor + raw.height % divisor))
}

/// Lazily sampled frame prior for a tile rendered without a retained context.
pub(super) struct LazyScene<'a> {
    raw: &'a RawImage,
    model: &'a AdjustmentModel,
    cancel: crate::CancelToken<'a>,
    scene: std::sync::OnceLock<Option<[f32; 3]>>,
}
impl<'a> LazyScene<'a> {
    pub(super) fn new(
        raw: &'a RawImage,
        model: &'a AdjustmentModel,
        cancel: crate::CancelToken<'a>,
    ) -> Self {
        Self {
            raw,
            model,
            cancel,
            scene: std::sync::OnceLock::new(),
        }
    }
}
impl ScenePrior for LazyScene<'_> {
    fn scene(&self) -> Option<[f32; 3]> {
        *self
            .scene
            .get_or_init(|| scene_prior(self.raw, self.model, self.cancel))
    }
}

fn active_area(raw: &RawImage, quality: RenderQuality) -> (CropRect, u32, u32) {
    let divisor = crate::pipeline::develop::effective_quality_divisor(quality, raw.cfa);
    let (w, h) = (raw.width / divisor, raw.height / divisor);
    let aa = crate::pipeline::develop::highlight_active_area(raw, divisor).unwrap_or(CropRect {
        x: 0,
        y: 0,
        w,
        h,
    });
    (aa, w, h)
}

pub(super) fn anchor<'a>(
    raw: &RawImage,
    quality: RenderQuality,
    origin: (u32, u32),
    prior: &'a dyn ScenePrior,
) -> FrameAnchor<'a> {
    let (aa, _, _) = active_area(raw, quality);
    FrameAnchor {
        prior,
        origin: (origin.0 as i32, origin.1 as i32),
        active_origin: (aa.x as i32, aa.y as i32),
    }
}

/// Full-frame recovery at native Bayer density takes the Preview-density
/// prior a native tile takes, so the two agree. A Preview render already
/// samples exactly that prior from its own buffer. A cancel that cut the
/// prior short is reported, never rendered with the fallback.
pub(in crate::pipeline) fn recover_full_frame(
    img: &mut Image,
    raw: &RawImage,
    model: &AdjustmentModel,
    divisor: u32,
    cancel: crate::CancelToken<'_>,
) -> crate::error::Result<()> {
    let tileable =
        raw.cfa.is_bayer_2x2() && divisor == 1 && model.auto_lateral_ca != AutoLateralCa::On;
    let lazy = LazyScene::new(raw, model, cancel);
    crate::pipeline::develop::recover_sensor_highlights(
        img,
        raw,
        model.highlight_recovery,
        divisor,
        tileable.then_some(&lazy as &dyn ScenePrior),
    );
    if cancel.is_cancelled() {
        return Err(crate::error::Error::Cancelled);
    }
    Ok(())
}

/// A cancelled sampling stops early; its render is discarded as cancelled.
pub(super) fn scene_prior(
    raw: &RawImage,
    model: &AdjustmentModel,
    cancel: crate::CancelToken<'_>,
) -> Option<[f32; 3]> {
    if !enabled(model) {
        return None;
    }
    let quality = RenderQuality::Preview;
    let divisor = crate::pipeline::develop::effective_quality_divisor(quality, raw.cfa);
    let (aa, w, h) = active_area(raw, quality);
    let (left, top) = (aa.x.min(w), aa.y.min(h));
    let right = aa.x.saturating_add(aa.w).min(w);
    let bottom = aa.y.saturating_add(aa.h).min(h);
    let mut samples = SceneSamples::new(raw.as_shot_neutral, raw.baseline_exposure);
    for band in (top..bottom).step_by(BAND_ROWS as usize) {
        if cancel.is_cancelled() {
            return None;
        }
        let start = band.saturating_sub(SUPPORT_ROWS);
        let end = (band + BAND_ROWS + SUPPORT_ROWS).min(h);
        let rows = if end == h {
            raw.height - start * divisor
        } else {
            (end - start) * divisor
        };
        let camera = super::prefix::from_window(
            raw,
            model,
            quality,
            (0, start * divisor, raw.width, rows),
            cancel,
        );
        let gains =
            crate::sensor_gain_maps::ClipGainContext::new(raw, (0, start * divisor), divisor);
        for y in (band..bottom.min(band + BAND_ROWS)).step_by(8) {
            for x in (left..right).step_by(8) {
                let index = ((y - start) * camera.width + x) as usize;
                match gains {
                    Some(gains) => samples
                        .push_with_scale(camera.pixels[index], gains.scale(index, camera.width)),
                    None => samples.push(camera.pixels[index]),
                }
            }
        }
    }
    (!cancel.is_cancelled()).then(|| samples.finish()).flatten()
}
