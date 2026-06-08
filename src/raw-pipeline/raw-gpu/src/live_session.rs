//! `LiveSession` — the persistent, pooled live-render runner (epic #925,
//! P4b-core / #1027).
//!
//! The editor's hot path: the same image is rendered every slider tick. A
//! `LiveSession` uploads that image to the GPU ONCE (`GpuImage`, the P1a
//! upload-once substrate) and keeps it resident across ticks; each render runs
//! the GATED live chain ([`crate::build_live_chain`]) over persistent ping-pong
//! buffers, then the C2 terminal dither, then ONE end-of-run readback of the u8
//! surface bytes.
//!
//! ## The zero-render-loop-allocation invariant (CLAUDE.md)
//!
//! "If a new feature adds allocation inside the render loop, it does not ship."
//! A second render at the SAME dims must allocate **zero** new GPU buffers / bind
//! groups. Three allocation sources existed before this module:
//!   1. `ChainRunner::new` allocs two ping-pong buffers per construction →
//!      the session owns them persistently (created once at the session's dims).
//!   2. `spatial::encode_simple` allocs a uniform + bind group PER DISPATCH →
//!      pulled from a dims-keyed pool on [`GpuContext`] ([`crate::FramePool`]),
//!      rewound at the start of each render so the same dispatch sequence reuses
//!      the same resources.
//!   3. spatial / dehaze / NR `Pass::encode` alloc scratch planes per encode →
//!      also pooled (same mechanism).
//! The readback buffer + the dither-output buffer are session-owned (fixed count
//! → "create once, reuse"). The bind-group / uniform pool is keyed by the chain
//! SIGNATURE (active-stage set + dims + capture-sharpening iterations), so a
//! slider crossing a gating threshold (e.g. dehaze 0→0.5) lands in a fresh bucket
//! — allocating once for the new shape, zero thereafter — and never binds a
//! stale buffer to the wrong kernel. See [`crate::FramePool`].
//!
//! ## Correctness tie-back
//!
//! [`LiveSession::render_to_buffer`] runs the chain + dither + single readback;
//! its output is gated BIT-IDENTICAL to running `build_live_chain` through a plain
//! `ChainRunner` + `encode_dither` directly (tying C3 back to C1/C2 — see
//! `live_session/tests.rs`), and a same-signature re-render is gated ZERO-ALLOC.
//! So neither the fused chain+dither encoding nor the pool moves a pixel.

use crate::chain::{CancelToken, Pass};
use crate::context::GpuContext;
use crate::dither::{alloc_packed_rgb, encode_dither, unpack_rgb_u8};
use crate::full_chain::FullChainInputs;
use crate::image::GpuImage;
use crate::live_chain::{build_live_chain, chain_signature};

/// A persistent live-render session bound to one uploaded image at one set of
/// dims. Owns the GPU-resident image, the ping-pong scratch pair, the readback
/// buffer, and the packed-u8 dither-output buffer — all created once, reused
/// every render. Drive it with [`LiveSession::render_to_buffer`] per slider tick.
///
/// Not `Send`/`Sync` — like [`GpuContext`], the session is single-threaded around
/// the GPU (one render in flight). A new image or a dims change = a new session.
pub struct LiveSession {
    /// The upload-once image (resident across ticks; never mutated by a render).
    image: GpuImage,
    /// The two ping-pong scratch buffers, sized to the image. Persistent — the
    /// chain seeds buffer A from the image and alternates A↔B every render,
    /// reusing these instead of allocating a fresh pair per `ChainRunner::new`.
    /// `STORAGE | COPY_SRC | COPY_DST` (seed / ping-pong / feed dither).
    ping_pong: [wgpu::Buffer; 2],
    /// The packed-u8 dither output (one u32 per pixel, RGB in the low 24 bits).
    /// `STORAGE | COPY_SRC`. Session-owned (fixed count → create once).
    dither_out: wgpu::Buffer,
    /// The `MAP_READ` staging buffer for the single end-of-run readback of
    /// `dither_out`. Session-owned (fixed count → create once).
    readback: wgpu::Buffer,
}

impl LiveSession {
    /// Create a session for `pixels` (interleaved RGBA f32, `width × height × 4`).
    /// Uploads the image and allocates the persistent ping-pong / dither-out /
    /// readback buffers ONCE — every subsequent render reuses them.
    ///
    /// The session does NOT borrow `ctx` — it holds only GPU buffers (independent
    /// of the device handle once created), so it can outlive any single `&ctx`
    /// borrow and be owned alongside a `GpuContext` in an FFI handle (C4). Every
    /// render method takes `&GpuContext` per call.
    pub fn new(ctx: &GpuContext, pixels: &[f32], width: u32, height: u32) -> Self {
        let image = GpuImage::upload(ctx, pixels, width, height);
        let f32_byte_len = image.byte_len();
        let make_ping = |label: &str| {
            ctx.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some(label),
                size: f32_byte_len,
                usage: wgpu::BufferUsages::STORAGE
                    | wgpu::BufferUsages::COPY_SRC
                    | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            })
        };
        let dither_out = alloc_packed_rgb(ctx, width, height, "live-session-dither-out");
        let packed_byte_len = (width as u64) * (height as u64) * std::mem::size_of::<u32>() as u64;
        let readback = ctx.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("live-session-readback"),
            size: packed_byte_len,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        // Drop any cache from a prior session on this ctx — its bind groups
        // reference the OLD session's (now-dropped) ping-pong buffers (stale-
        // reference safety; see `FramePool::reset`).
        ctx.frame_pool.borrow_mut().reset();
        Self {
            image,
            ping_pong: [make_ping("live-ping-a"), make_ping("live-ping-b")],
            dither_out,
            readback,
        }
    }

    /// The session's image dimensions.
    pub fn dims(&self) -> (u32, u32) {
        self.image.dims()
    }

    /// Cumulative pool allocation count (the honest zero-alloc hook): the number
    /// of actual `create_buffer` / `create_bind_group` calls the pool has made
    /// (misses). Snapshot it across a same-signature re-render — the delta must be
    /// 0 (no render-loop allocation). See [`crate::frame_pool`].
    pub fn pool_alloc_count(&self, ctx: &GpuContext) -> u64 {
        ctx.frame_pool.borrow().alloc_count()
    }

    /// Render one frame: the GATED live chain for `inputs` (airlight seeding the
    /// dehaze pass when engaged) → the terminal dither → a SINGLE readback of the
    /// packed-u8 RGB surface, unpacked to the flat `3·w·h` u8 layout. `None` if
    /// `cancel` fires before a pass is encoded (the refine pass abandoned by a
    /// newer edit). `ctx` is the same context the session was created with.
    #[cfg(not(target_arch = "wasm32"))]
    pub fn render_to_buffer(
        &self,
        ctx: &GpuContext,
        inputs: &FullChainInputs,
        airlight: [f32; 3],
        cancel: &CancelToken,
    ) -> Option<Vec<u8>> {
        pollster::block_on(self.render_async(ctx, inputs, airlight, Some(cancel)))
    }

    /// The async render core, shared by native (`render_to_buffer`) and wasm
    /// callers. `cancel` is checked before each pass is encoded; `None` ⇒ no
    /// cancellation. Returns the unpacked `3·w·h` u8 RGB buffer, or `None` if
    /// cancelled mid-encode.
    pub async fn render_async(
        &self,
        ctx: &GpuContext,
        inputs: &FullChainInputs,
        airlight: [f32; 3],
        cancel: Option<&CancelToken>,
    ) -> Option<Vec<u8>> {
        let dims = self.image.dims();
        let (width, height) = dims;
        let f32_byte_len = self.image.byte_len();

        let passes = build_live_chain(inputs, airlight);
        let pass_refs: Vec<&dyn Pass> = passes.iter().map(|p| p.as_ref()).collect();

        // Open the pooled render window for THIS chain shape: the pool rewinds its
        // cursors and serves cached resources for this signature. Every
        // `encode_simple` / `alloc_plane` / pooled-data call below draws from it,
        // so a same-signature re-render allocates ZERO new GPU resources.
        let sig = chain_signature(inputs, dims);
        ctx.frame_pool.borrow_mut().begin_frame(sig);

        let mut encoder = ctx
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("live-session-encoder"),
            });

        // Seed ping-pong buffer A from the immutable image.
        encoder.copy_buffer_to_buffer(&self.image.buffer, 0, &self.ping_pong[0], 0, f32_byte_len);

        // Ping-pong: pass i reads ping_pong[i % 2], writes ping_pong[(i+1) % 2].
        // After N passes the chain's f32 result is in ping_pong[N % 2].
        let mut final_idx = 0usize;
        for (i, pass) in pass_refs.iter().enumerate() {
            if let Some(t) = cancel {
                if t.is_cancelled() {
                    // Close the pooled window before bailing so the pool isn't
                    // left mid-frame for the next render.
                    ctx.frame_pool.borrow_mut().end_frame();
                    return None;
                }
            }
            let src_idx = i % 2;
            let dst_idx = (i + 1) % 2;
            let (lo, hi) = self.ping_pong.split_at(1);
            let (src, dst) = if src_idx == 0 {
                (&lo[0], &hi[0])
            } else {
                (&hi[0], &lo[0])
            };
            pass.encode(ctx, &mut encoder, src, dst, dims);
            final_idx = dst_idx;
        }

        // Terminal: dither the chain's final f32 buffer → packed-u8 dither_out,
        // on-device (no intermediate f32 readback). Also pool-routed, so its
        // uniform + bind group are cached like every other dispatch.
        encode_dither(
            ctx,
            &mut encoder,
            &self.ping_pong[final_idx],
            &self.dither_out,
            dims,
        );

        // Close the pooled window — all dispatches for this render are encoded.
        ctx.frame_pool.borrow_mut().end_frame();

        // The single end-of-run readback: copy the packed-u8 surface to the
        // MAP_READ staging buffer.
        let packed_byte_len =
            (width as u64) * (height as u64) * std::mem::size_of::<u32>() as u64;
        encoder.copy_buffer_to_buffer(&self.dither_out, 0, &self.readback, 0, packed_byte_len);
        ctx.queue.submit(Some(encoder.finish()));

        let packed = map_packed_readback(ctx, &self.readback).await;
        Some(unpack_rgb_u8(&packed))
    }
}

/// Map the packed-u32 readback staging buffer and cast it to `Vec<u32>`. Native
/// polls the queue; wasm awaits the browser-driven map. Mirrors
/// `chain::map_readback_async` but for the u32 surface (not f32).
#[cfg_attr(target_arch = "wasm32", allow(unused_variables))]
async fn map_packed_readback(ctx: &GpuContext, readback: &wgpu::Buffer) -> Vec<u32> {
    let slice = readback.slice(..);
    let (tx, rx) = futures_channel::oneshot::channel();
    slice.map_async(wgpu::MapMode::Read, move |res| {
        let _ = tx.send(res);
    });
    #[cfg(not(target_arch = "wasm32"))]
    ctx.device.poll(wgpu::Maintain::Wait);
    rx.await
        .expect("map channel dropped")
        .expect("buffer map failed");
    let data = slice.get_mapped_range();
    let out: Vec<u32> = bytemuck::cast_slice(&data).to_vec();
    drop(data);
    readback.unmap();
    out
}

// Tests live in a sibling file (600-LOC budget). Native test builds only.
#[cfg(all(test, not(target_arch = "wasm32")))]
#[path = "live_session/tests.rs"]
mod tests;
