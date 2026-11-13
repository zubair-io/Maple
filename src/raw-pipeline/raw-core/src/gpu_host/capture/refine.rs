//! The GPU capture refine every host shares (#5381): a [`CaptureBase`]
//! through raw-gpu's chroma prefilter, BM3D and capture-sharpening passes.
//! Apple calls it through raw-ffi; Windows, Web (the async form) and Android
//! call the same functions when they move to the capture decode.
//!
//! The GPU half returns the refined sensor-frame RGBA; the host packs it with
//! [`crate::pipeline::finish_capture_refine`] (exposure re-measured, EXIF
//! orientation applied) after releasing its GPU lock, so slider ticks on
//! other sessions are not held behind that CPU work.

use crate::pipeline::{CaptureBase, CaptureRefineStages};
use crate::xmp::AdjustmentModel;
use raw_gpu::{CancelToken, CaptureRefinePasses, CaptureRefineUsage, GpuContext};

fn passes(model: &AdjustmentModel) -> CaptureRefinePasses {
    let stages = CaptureRefineStages::of(model);
    CaptureRefinePasses {
        chroma_prefilter: stages.chroma_prefilter,
        deep_denoise: stages.deep_denoise,
        sharpening: stages.sharpening.map(|p| raw_gpu::CaptureSharpeningParams {
            sigma: p.sigma,
            iterations: p.iterations,
            highlight_threshold: p.highlight_threshold,
            strength: p.strength,
            noise_floor: p.noise_floor,
        }),
    }
}

/// Refine `base` at `model` (from [`CaptureBase::refine_model`]). `Ok(None)`
/// when `cancel` fired; a partial result is never returned.
pub async fn refine_capture_rgba_async(
    ctx: &GpuContext,
    base: &CaptureBase,
    model: &AdjustmentModel,
    cancel: &CancelToken,
) -> Result<Option<(Vec<f32>, CaptureRefineUsage)>, String> {
    raw_gpu::capture_refine_async(ctx, &base.rgba(), base.dims(), &passes(model), cancel).await
}

/// Blocking [`refine_capture_rgba_async`] for native hosts.
#[cfg(not(target_arch = "wasm32"))]
pub fn refine_capture_rgba(
    ctx: &GpuContext,
    base: &CaptureBase,
    model: &AdjustmentModel,
    cancel: &CancelToken,
) -> Result<Option<(Vec<f32>, CaptureRefineUsage)>, String> {
    raw_gpu::capture_refine(ctx, &base.rgba(), base.dims(), &passes(model), cancel)
}
