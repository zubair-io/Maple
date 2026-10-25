//! The capture refine (#5381): S0's capture passes (#5217) run back to back
//! on a host's capture base when a chroma prefilter, deep denoise or
//! capture-sharpening value changes, so the host replaces its capture result
//! without re-developing the RAW.
//!
//! The run is one-off, not a slider tick: its scratch lives in a transient
//! pool bucket released when it ends, so the live sessions' warm buckets are
//! untouched and nothing the refine allocated stays resident. The result is
//! read back whole, or not at all when `cancel` fires, so a host never sees a
//! partially refined frame.

use crate::chain::{CancelToken, ChainRunner, Pass};
use crate::{
    CaptureSharpeningParams, CaptureSharpeningPass, ChromaPrefilterPass, DeepDenoisePass,
    GpuContext, GpuImage,
};
use std::sync::atomic::{AtomicU64, Ordering};

/// The refinable capture stages, in raw-core's units and order.
#[derive(Clone, Copy, Debug, Default)]
pub struct CaptureRefinePasses {
    pub chroma_prefilter: f32,
    pub deep_denoise: f32,
    pub sharpening: Option<CaptureSharpeningParams>,
}

/// Each refine pools in its own bucket key, so a refine cannot inherit
/// another's bindings.
static NEXT_REFINE: AtomicU64 = AtomicU64::new(1);

/// What one refine used, for budgets and qualification.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct CaptureRefineUsage {
    /// Pooled scratch and uniforms, released when the refine returns.
    pub transient_bytes: u64,
    /// The uploaded base, the ping-pong pair and the readback.
    pub image_bytes: u64,
}

impl CaptureRefinePasses {
    /// Whether any pass would change pixels, at the thresholds the passes
    /// themselves copy through on.
    pub fn engaged(&self) -> bool {
        self.chroma_prefilter >= 1e-3 || self.deep_denoise >= 1e-3 || self.sharpening.is_some()
    }
}

/// Refine `pixels` (interleaved RGBA f32, `width × height`, the sensor-frame
/// capture base). `Ok(None)` when `cancel` fired. A frame with no engaged
/// pass is returned unchanged without touching the GPU.
pub async fn capture_refine_async(
    ctx: &GpuContext,
    pixels: &[f32],
    (width, height): (u32, u32),
    passes: &CaptureRefinePasses,
    cancel: &CancelToken,
) -> Result<Option<(Vec<f32>, CaptureRefineUsage)>, String> {
    let lanes = (width as usize) * (height as usize) * 4;
    if pixels.len() != lanes {
        return Err(format!(
            "capture refine: {} lanes for {width}x{height}",
            pixels.len()
        ));
    }
    if cancel.is_cancelled() {
        return Ok(None);
    }
    if !passes.engaged() {
        return Ok(Some((pixels.to_vec(), CaptureRefineUsage::default())));
    }
    let image_bytes = crate::live_session::limits::validate_dims(ctx, width, height)?;
    let chroma = ChromaPrefilterPass {
        strength: passes.chroma_prefilter,
    };
    let denoise = DeepDenoisePass {
        strength: passes.deep_denoise,
        cancel: Some(cancel.clone()),
    };
    let sharpen = passes
        .sharpening
        .map(|params| CaptureSharpeningPass { params });
    let mut chain: Vec<&dyn Pass> = Vec::with_capacity(3);
    if passes.chroma_prefilter >= 1e-3 {
        chain.push(&chroma);
    }
    if passes.deep_denoise >= 1e-3 {
        chain.push(&denoise);
    }
    if let Some(sharpen) = &sharpen {
        chain.push(sharpen);
    }
    let image = GpuImage::upload(ctx, pixels, width, height);
    let frame = TransientFrame::begin(ctx);
    let result = ChainRunner::new(ctx, &image)
        .run_cancellable_async(&chain, Some(cancel))
        .await;
    let usage = CaptureRefineUsage {
        transient_bytes: ctx.frame_pool.borrow().transient_bytes(frame.key),
        image_bytes: 4 * image_bytes,
    };
    drop(frame);
    Ok(result?.map(|refined| (refined, usage)))
}

/// Ends the transient pool frame however the refine exits, so a contained
/// panic cannot leave the pool pointed at a dropped bucket.
struct TransientFrame<'a> {
    ctx: &'a GpuContext,
    key: u64,
}

impl<'a> TransientFrame<'a> {
    fn begin(ctx: &'a GpuContext) -> Self {
        let key = NEXT_REFINE.fetch_add(1, Ordering::Relaxed);
        ctx.frame_pool.borrow_mut().begin_transient_frame(key);
        Self { ctx, key }
    }
}

impl Drop for TransientFrame<'_> {
    fn drop(&mut self) {
        self.ctx
            .frame_pool
            .borrow_mut()
            .end_transient_frame(self.key);
    }
}

/// Blocking [`capture_refine_async`] for native hosts.
#[cfg(not(target_arch = "wasm32"))]
pub fn capture_refine(
    ctx: &GpuContext,
    pixels: &[f32],
    dims: (u32, u32),
    passes: &CaptureRefinePasses,
    cancel: &CancelToken,
) -> Result<Option<(Vec<f32>, CaptureRefineUsage)>, String> {
    pollster::block_on(capture_refine_async(ctx, pixels, dims, passes, cancel))
}

#[cfg(all(test, not(target_arch = "wasm32")))]
#[path = "capture_refine_tests.rs"]
mod tests;
