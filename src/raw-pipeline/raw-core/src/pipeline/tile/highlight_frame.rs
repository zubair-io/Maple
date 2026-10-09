//! Exact bounded native-density scene evidence for guided highlight tiles.
//! No resized proxy or full-frame RGB retention: visit canonical sampling
//! rows in full-width strips, retaining only the eligible stride-8 samples
//! that the shared decimation reduces to the full render's selection.
use crate::{
    image::{CropRect, RawImage},
    pipeline::RenderQuality,
    stages::highlight_recovery::{FrameAnchor, ScenePrior, SceneSamples},
    xmp::{AdjustmentModel, HighlightRecoveryMode},
};

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
    // One128-row output band plus128 output rows of prefix support each side.
    u64::from(raw.width) * u64::from(raw.height.min(384 * divisor + raw.height % divisor))
}

/// Lazily sampled frame prior for a tile rendered without a retained context.
pub(super) struct LazyScene<'a> {
    raw: &'a RawImage,
    model: &'a AdjustmentModel,
    quality: RenderQuality,
    scene: std::sync::OnceLock<Option<[f32; 3]>>,
}
impl<'a> LazyScene<'a> {
    pub(super) fn new(
        raw: &'a RawImage,
        model: &'a AdjustmentModel,
        quality: RenderQuality,
    ) -> Self {
        Self {
            raw,
            model,
            quality,
            scene: std::sync::OnceLock::new(),
        }
    }
}
impl ScenePrior for LazyScene<'_> {
    fn scene(&self) -> Option<[f32; 3]> {
        *self
            .scene
            .get_or_init(|| scene_prior(self.raw, self.model, self.quality))
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

pub(super) fn scene_prior(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
) -> Option<[f32; 3]> {
    if !enabled(model) {
        return None;
    }
    let divisor = crate::pipeline::develop::effective_quality_divisor(quality, raw.cfa);
    let (aa, w, h) = active_area(raw, quality);
    let mut samples = SceneSamples::new(raw.as_shot_neutral, raw.baseline_exposure);
    let right = aa.x.saturating_add(aa.w).min(w);
    let bottom = aa.y.saturating_add(aa.h).min(h);
    let mut y = aa.y.min(h);
    while y < bottom {
        let band = y / 128 * 128;
        let start = band.saturating_sub(128);
        let end = (band + 256).min(h);
        // Strip origins are 128 px phased, preserving both AMaZE's native
        // tile grid and the 2x2 Bayer phase. Artificial strip boundaries are
        // beyond the original prefix stencil of every sampled row.
        let camera = super::prefix::from_window(
            raw,
            model,
            quality,
            (
                0,
                start * divisor,
                raw.width,
                if end == h {
                    raw.height - start * divisor
                } else {
                    (end - start) * divisor
                },
            ),
        );
        while y < bottom.min(band + 128) {
            let mut x = aa.x.min(w);
            while x < right {
                samples.push(camera.pixels[((y - start) * camera.width + x) as usize]);
                x += 8;
            }
            y += 8;
        }
    }
    samples.finish()
}
