//! `ChainRunner` — a multi-pass GPU-resident execution engine.
//!
//! Runs an ordered list of [`Pass`]es over a [`GpuImage`], ping-ponging two
//! scratch storage buffers so every pass reads the previous pass's output
//! straight from GPU memory — **zero inter-pass CPU readback**. There is
//! exactly one readback for the whole chain, at the very end (tracked by
//! [`ChainRunner::last_readback_count`]).
//!
//! ## Two-phase contract (P1a substrate; live wiring is P4)
//!
//! The substrate supports the editor's two-phase render model: a *fast* phase
//! renders a small **preview** image and a debounced *refine* phase renders the
//! **full** image. Both phases are just [`GpuImage::upload`] at different dims —
//! the upload-once image is reused, never re-decoded — and either phase can be
//! abandoned mid-flight via a [`CancelToken`] (the refine pass is cancelled when
//! the user moves a slider again). The *resolution-selection policy* (which dims
//! count as "preview", the debounce timing) and the live edit-loop wiring are
//! **P4 (#992)**, not P1a — this layer only provides the cancellable mechanism.

use crate::context::GpuContext;
use crate::image::GpuImage;
use std::cell::Cell;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// A single GPU compute stage. `encode` records the stage's dispatch into
/// `encoder`, reading `src` and writing `dst` (both RGBA f32 storage buffers of
/// `dims.0 * dims.1` pixels). Implementors build their own bind group (a bind
/// group's buffers are fixed at creation, so each ping-pong direction needs a
/// fresh one) and any per-pass uniforms inside `encode`.
pub trait Pass {
    fn encode(
        &self,
        ctx: &GpuContext,
        encoder: &mut wgpu::CommandEncoder,
        src: &wgpu::Buffer,
        dst: &wgpu::Buffer,
        dims: (u32, u32),
    );
}

/// A cooperative cancellation flag shared with a running chain. Cheap to clone
/// (an `Arc<AtomicBool>`); the editor flips it to abandon an in-flight refine
/// pass when a newer edit arrives. [`ChainRunner`] checks it before encoding
/// each pass and bails early if set.
#[derive(Clone, Default)]
pub struct CancelToken {
    flag: Arc<AtomicBool>,
}

impl CancelToken {
    /// A fresh, un-cancelled token.
    pub fn new() -> Self {
        Self::default()
    }

    /// Share a host-owned atomic with the encode loop without polling or a
    /// forwarding task. The Arc keeps the signal alive through the last pass.
    pub fn from_flag(flag: Arc<AtomicBool>) -> Self {
        Self { flag }
    }

    /// Request cancellation. Idempotent.
    pub fn cancel(&self) {
        self.flag.store(true, Ordering::SeqCst);
    }

    /// Whether cancellation has been requested.
    pub fn is_cancelled(&self) -> bool {
        self.flag.load(Ordering::SeqCst)
    }
}

/// Runs passes over a [`GpuImage`] using two scratch ping-pong buffers.
///
/// The image buffer is never mutated: at run start it is copied into scratch
/// buffer A, passes alternate A↔B, and the final buffer is read back once. Bind
/// to a `let` and call `run_blocking` / `run_cancellable` on that instance — the
/// readback counter ([`ChainRunner::last_readback_count`]) is per-instance.
pub struct ChainRunner<'a> {
    ctx: &'a GpuContext,
    image: &'a GpuImage,
    /// Two scratch buffers sized to the image. `STORAGE | COPY_SRC | COPY_DST`
    /// so they can be ping-pong src/dst, seeded from the image, and read back.
    buffers: [wgpu::Buffer; 2],
    /// Count of CPU readbacks performed by the last run. Exactly `1` after a
    /// completed (non-cancelled) run; proves zero inter-pass readback.
    readback_count: Cell<u32>,
}

impl<'a> ChainRunner<'a> {
    /// Allocate the two ping-pong scratch buffers for `image`'s dimensions.
    pub fn new(ctx: &'a GpuContext, image: &'a GpuImage) -> Self {
        let byte_len = image.byte_len();
        let make = |label: &str| {
            ctx.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some(label),
                size: byte_len,
                usage: wgpu::BufferUsages::STORAGE
                    | wgpu::BufferUsages::COPY_SRC
                    | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            })
        };
        Self {
            ctx,
            image,
            buffers: [make("chain-ping-a"), make("chain-ping-b")],
            readback_count: Cell::new(0),
        }
    }

    /// Readbacks performed by the most recent run (`1` after a completed run,
    /// `0` on a fresh runner or a fully-cancelled run).
    pub fn last_readback_count(&self) -> u32 {
        self.readback_count.get()
    }

    /// Run `passes` to completion and read the result back. Native blocking.
    /// Panics on a GPU readback failure — this is the headless test/harness
    /// path, never the interactive one (which rides [`crate::LiveSession`]'s
    /// `Result`-returning renders).
    #[cfg(not(target_arch = "wasm32"))]
    pub fn run_blocking(&self, passes: &[&dyn Pass]) -> Vec<f32> {
        pollster::block_on(self.run_async(passes))
            .expect("GPU chain readback failed")
            .expect("run_async without a cancel token never returns None")
    }

    /// Run `passes`, bailing early if `token` is cancelled before a pass is
    /// encoded. Returns `None` if cancelled. Native blocking; panics on a GPU
    /// readback failure (test/harness path, like [`ChainRunner::run_blocking`]).
    #[cfg(not(target_arch = "wasm32"))]
    pub fn run_cancellable(&self, passes: &[&dyn Pass], token: &CancelToken) -> Option<Vec<f32>> {
        pollster::block_on(self.run_cancellable_async(passes, Some(token)))
            .expect("GPU chain readback failed")
    }

    /// Async run with no cancellation. Shared by native (`run_blocking`) and
    /// wasm callers. Always `Ok(Some(..))` on success (kept `Option` to share
    /// the core); `Err` on a GPU readback failure (#1079).
    pub async fn run_async(&self, passes: &[&dyn Pass]) -> Result<Option<Vec<f32>>, String> {
        self.run_cancellable_async(passes, None).await
    }

    /// The shared execution core. Encodes every pass into one command buffer
    /// (ping-ponging the two scratch buffers), submits once, and performs a
    /// single readback. With `token` set, returns `Ok(None)` as soon as the
    /// token is cancelled before encoding a pass (checked before each pass);
    /// `Err` if the end-of-run readback map fails (#1079).
    pub async fn run_cancellable_async(
        &self,
        passes: &[&dyn Pass],
        token: Option<&CancelToken>,
    ) -> Result<Option<Vec<f32>>, String> {
        self.readback_count.set(0);
        let dims = self.image.dims();
        let byte_len = self.image.byte_len();

        let mut encoder = self
            .ctx
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("chain-encoder"),
            });

        // Seed scratch buffer A from the (immutable) image buffer.
        encoder.copy_buffer_to_buffer(&self.image.buffer, 0, &self.buffers[0], 0, byte_len);

        // Ping-pong: pass i reads buffers[i % 2], writes buffers[(i + 1) % 2].
        // After N passes the result is in buffers[N % 2].
        let mut final_idx = 0usize;
        for (i, pass) in passes.iter().enumerate() {
            // Cooperative cancellation: bail before doing this pass's work.
            if let Some(t) = token {
                if t.is_cancelled() {
                    return Ok(None);
                }
            }
            let src_idx = i % 2;
            let dst_idx = (i + 1) % 2;
            let (lo, hi) = self.buffers.split_at(1); // borrow two buffers disjointly
            let (src, dst) = if src_idx == 0 {
                (&lo[0], &hi[0])
            } else {
                (&hi[0], &lo[0])
            };
            pass.encode(self.ctx, &mut encoder, src, dst, dims);
            final_idx = dst_idx;
        }

        // An empty chain reads the seeded copy back from buffers[0].
        let result_buf = &self.buffers[final_idx];
        let readback = self.ctx.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("chain-readback"),
            size: byte_len,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        encoder.copy_buffer_to_buffer(result_buf, 0, &readback, 0, byte_len);
        self.ctx.queue.submit(Some(encoder.finish()));

        let out = map_readback_async(self.ctx, &readback).await?;
        self.readback_count.set(1);
        Ok(Some(out))
    }
}

/// Map a `MAP_READ` buffer and cast its contents to `Vec<f32>`. The buffer must
/// already have been filled (its `copy_buffer_to_buffer` submitted). `ctx` is
/// used only on native (to poll the queue); on wasm the browser drives the map.
/// A failed map (device loss / OOM) is an `Err`, not a panic (#1079).
#[cfg_attr(target_arch = "wasm32", allow(unused_variables))]
pub(crate) async fn map_readback_async(
    ctx: &GpuContext,
    readback: &wgpu::Buffer,
) -> Result<Vec<f32>, String> {
    let slice = readback.slice(..);
    let (tx, rx) = futures_channel::oneshot::channel();
    slice.map_async(wgpu::MapMode::Read, move |res| {
        let _ = tx.send(res);
    });
    // Native: drive the queue to completion so the map resolves. On wasm this is
    // a no-op and the await resolves when the browser completes the map.
    #[cfg(not(target_arch = "wasm32"))]
    ctx.device.poll(wgpu::Maintain::Wait);
    rx.await
        .map_err(|_| "chain readback: map channel dropped".to_string())?
        .map_err(|e| format!("chain readback: buffer map failed: {e}"))?;
    let data = slice.get_mapped_range();
    let out: Vec<f32> = bytemuck::cast_slice(&data).to_vec();
    drop(data);
    readback.unmap();
    Ok(out)
}

/// Copy an arbitrary GPU buffer to the CPU as `Vec<f32>` via a one-shot
/// `MAP_READ` staging buffer. Used by [`GpuImage::read_back_blocking`], which is
/// native-only (test/export), so this helper is too.
#[cfg(not(target_arch = "wasm32"))]
pub(crate) async fn read_buffer_async(
    ctx: &GpuContext,
    buffer: &wgpu::Buffer,
    byte_len: u64,
) -> Result<Vec<f32>, String> {
    let readback = ctx.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("image-readback"),
        size: byte_len,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut encoder = ctx
        .device
        .create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("image-readback-encoder"),
        });
    encoder.copy_buffer_to_buffer(buffer, 0, &readback, 0, byte_len);
    ctx.queue.submit(Some(encoder.finish()));
    map_readback_async(ctx, &readback).await
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;
    use crate::exposure::ExposurePass;
    use crate::test_buffer;

    /// An identity pass: copy `src` → `dst` unchanged, no compute.
    struct IdentityPass;
    impl Pass for IdentityPass {
        fn encode(
            &self,
            _ctx: &GpuContext,
            encoder: &mut wgpu::CommandEncoder,
            src: &wgpu::Buffer,
            dst: &wgpu::Buffer,
            dims: (u32, u32),
        ) {
            let byte_len =
                (dims.0 as u64) * (dims.1 as u64) * 4 * std::mem::size_of::<f32>() as u64;
            encoder.copy_buffer_to_buffer(src, 0, dst, 0, byte_len);
        }
    }

    #[test]
    fn chain_runner_two_identity_passes_round_trip() {
        let ctx = GpuContext::new_blocking().expect("gpu context");
        let input = test_buffer(256);
        let img = GpuImage::upload(&ctx, &input, 16, 16);
        let runner = ChainRunner::new(&ctx, &img);
        let out = runner.run_blocking(&[&IdentityPass, &IdentityPass]);
        assert_eq!(input, out);
    }

    #[test]
    fn chain_runner_reports_single_readback() {
        // Structural proof of zero inter-pass readback: an N-pass run performs
        // exactly one readback regardless of pass count.
        let ctx = GpuContext::new_blocking().expect("gpu context");
        let input = test_buffer(256);
        let img = GpuImage::upload(&ctx, &input, 16, 16);

        let runner = ChainRunner::new(&ctx, &img);
        assert_eq!(
            runner.last_readback_count(),
            0,
            "fresh runner: no readbacks"
        );

        let _ = runner.run_blocking(&[&IdentityPass, &IdentityPass, &IdentityPass]);
        assert_eq!(
            runner.last_readback_count(),
            1,
            "3-pass run must read back exactly once"
        );
    }

    #[test]
    fn chain_runner_immutable_image_supports_rerun() {
        // The upload-once invariant: re-running the same image (e.g. preview
        // then refine) yields the same result — the image buffer is not mutated.
        let ctx = GpuContext::new_blocking().expect("gpu context");
        let input = test_buffer(256);
        let img = GpuImage::upload(&ctx, &input, 16, 16);
        let runner = ChainRunner::new(&ctx, &img);

        let first = runner.run_blocking(&[&ExposurePass { ev: 1.0 }]);
        let second = runner.run_blocking(&[&ExposurePass { ev: 1.0 }]);
        assert_eq!(first, second, "image buffer must survive a run unchanged");
    }

    #[test]
    fn chain_runner_cancels_between_passes() {
        let ctx = GpuContext::new_blocking().expect("gpu context");
        let img = GpuImage::upload(&ctx, &test_buffer(256), 16, 16);
        let token = CancelToken::new();
        token.cancel(); // pre-cancelled
        let runner = ChainRunner::new(&ctx, &img);
        let out = runner.run_cancellable(
            &[&ExposurePass { ev: 1.0 }, &ExposurePass { ev: 1.0 }],
            &token,
        );
        assert!(out.is_none(), "pre-cancelled run must return None");
        assert_eq!(
            runner.last_readback_count(),
            0,
            "cancelled run performs no readback"
        );
    }

    #[test]
    fn chain_runner_uncancelled_token_completes() {
        // A live (un-cancelled) token runs to completion and reads back once.
        let ctx = GpuContext::new_blocking().expect("gpu context");
        let input = test_buffer(256);
        let img = GpuImage::upload(&ctx, &input, 16, 16);
        let token = CancelToken::new();
        let runner = ChainRunner::new(&ctx, &img);
        let out = runner.run_cancellable(&[&ExposurePass { ev: 0.0 }], &token);
        assert!(out.is_some());
        assert_eq!(runner.last_readback_count(), 1);
    }
}
