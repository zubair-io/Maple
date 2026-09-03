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
use crate::dehaze::AirlightSource;
use crate::dither::{alloc_packed_rgb, encode_dither, unpack_rgb_u8};
use crate::full_chain::FullChainInputs;
use crate::image::GpuImage;
use crate::live_chain::{build_live_chain, chain_signature, dehaze_is_active};
use std::sync::atomic::{AtomicU64, Ordering};

/// Process-wide monotonic counter handing out a unique [`LiveSession::session_id`]
/// to every session constructed anywhere in the process (#1929). Not reset on
/// close — only monotonic uniqueness matters, never reuse. Starts at 1 so `0`
/// stays available as an obviously-invalid sentinel for tests that don't care
/// about session identity.
static NEXT_LIVE_SESSION_ID: AtomicU64 = AtomicU64::new(1);

/// A persistent live-render session bound to one uploaded image at one set of
/// dims. Owns the GPU-resident image, the ping-pong scratch pair, the readback
/// buffer, and the packed-u8 dither-output buffer — all created once, reused
/// every render. Drive it with [`LiveSession::render_to_buffer`] per slider tick.
///
/// Not `Send`/`Sync` — like [`GpuContext`], the session is single-threaded around
/// the GPU (one render in flight). A new image or a dims change = a new session.
pub struct LiveSession {
    #[cfg(target_vendor = "apple")]
    pub(crate) histogram: crate::display_histogram::DisplayHistogram,
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
    /// The `MAP_READ` staging buffer for the MID-CHAIN airlight readback — the C5a
    /// FALLBACK path only (`airlight_readback_fallback == true`). When dehaze is
    /// engaged AND the fallback is selected, the post-prefix buffer is copied here
    /// and mapped so `compute_airlight` can measure A from the EXACT buffer dehaze
    /// sees. Sized to the f32 image (`width × height × 4` f32). Session-owned
    /// (zero-alloc). UNUSED on the default on-GPU path (#1033 — A is reduced
    /// on-device, no readback) and when dehaze is inactive.
    airlight_staging: wgpu::Buffer,
    /// Whether to use the C5a CPU-readback airlight path instead of the default
    /// on-GPU reduction (#1033). `false` (the default, via [`LiveSession::new`]):
    /// the dehaze airlight is computed on-device with NO per-tick GPU→CPU readback,
    /// so the dehaze-active chain meets the 16ms budget and runs in ONE submit.
    /// `true` (via [`LiveSession::new_with_airlight_readback`]): the legacy
    /// prefix→readback→`compute_airlight`→suffix split — kept as a fallback and for
    /// the parity test that pins the on-GPU A against the CPU A.
    airlight_readback_fallback: bool,
    /// This session's unique identity (#1929), salted into every
    /// [`chain_signature`] this session computes so it can never share a
    /// [`crate::FramePool`] bucket with another session — see
    /// [`chain_signature`]'s "Session-identity salt" doc section for the
    /// cross-session buffer-reuse hazard this closes. Drawn from
    /// [`NEXT_LIVE_SESSION_ID`] at construction; stable for the session's whole
    /// lifetime.
    session_id: u64,
    /// The vectorscope scope-pass histogram + double-buffered `MAP_READ`
    /// staging (#3272) — see `live_session/scope.rs`. Session-owned
    /// (zero-alloc), like every other buffer above; unused (never read or
    /// written) when a render's `inputs.scope.enabled` is `false`.
    scope: scope::ScopeBuffers,
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
    ///
    /// Fallible (#1079): the dims are validated against the DEVICE's actual
    /// limits BEFORE any GPU allocation ([`limits::validate_dims`]) — an image
    /// past the storage-binding / buffer-size ceilings would otherwise hit
    /// wgpu's fatal validation panic mid-render. The `Err` is a descriptive
    /// message hosts surface (and CPU-fallback on).
    pub fn new(ctx: &GpuContext, pixels: &[f32], width: u32, height: u32) -> Result<Self, String> {
        Self::new_inner(ctx, pixels, width, height, false)
    }

    /// Like [`LiveSession::new`] but forces the C5a CPU-readback airlight path (the
    /// fallback / parity-reference path; see [`Self::airlight_readback_fallback`]).
    /// The default [`LiveSession::new`] uses the on-GPU reduction (#1033).
    pub fn new_with_airlight_readback(
        ctx: &GpuContext,
        pixels: &[f32],
        width: u32,
        height: u32,
    ) -> Result<Self, String> {
        Self::new_inner(ctx, pixels, width, height, true)
    }

    fn new_inner(
        ctx: &GpuContext,
        pixels: &[f32],
        width: u32,
        height: u32,
        airlight_readback_fallback: bool,
    ) -> Result<Self, String> {
        limits::validate_dims(ctx, width, height)?;
        let expected_lanes = (width as usize) * (height as usize) * 4;
        if pixels.len() != expected_lanes {
            return Err(format!(
                "LiveSession: pixel buffer len {} != width*height*4 ({width}x{height} = \
                 {expected_lanes})",
                pixels.len()
            ));
        }
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
        let airlight_staging = ctx.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("live-session-airlight-staging"),
            size: f32_byte_len,
            // MAP_READ may only combine with COPY_DST (wgpu rule): the prefix
            // output is copied IN, then mapped for `compute_airlight`. The suffix
            // is seeded directly from the (still-resident) ping-pong buffer, not
            // from here, so this never needs COPY_SRC.
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        // Drop any cache from a prior session on this ctx — its bind groups
        // reference the OLD session's (now-dropped) ping-pong buffers (stale-
        // reference safety; see `FramePool::reset`). This guards a CLOSED
        // session's leftovers; it does NOT protect against a second session
        // opening and rendering while this one is still alive (#1929) — that's
        // what `session_id` (salted into every `chain_signature` this session
        // computes) closes instead.
        ctx.frame_pool.borrow_mut().reset();
        let session_id = NEXT_LIVE_SESSION_ID.fetch_add(1, Ordering::Relaxed);
        let ping_pong = [make_ping("live-ping-a"), make_ping("live-ping-b")];
        Ok(Self {
            #[cfg(target_vendor = "apple")]
            histogram: crate::display_histogram::DisplayHistogram::new(
                ctx, &ping_pong, width, height,
            ),
            image,
            ping_pong,
            dither_out,
            readback,
            airlight_staging,
            airlight_readback_fallback,
            session_id,
            scope: scope::ScopeBuffers::new(ctx),
        })
    }

    /// A monotonic identity that cannot alias a retired upload's buffers.
    #[cfg(target_vendor = "apple")]
    pub(crate) fn identity(&self) -> u64 {
        self.session_id
    }

    /// The session's image dimensions.
    pub fn dims(&self) -> (u32, u32) {
        self.image.dims()
    }

    /// Update the resident image pixels directly without reallocating buffers or invalidating context cache.
    pub fn update_image(&mut self, ctx: &GpuContext, pixels: &[f32]) {
        let expected = (self.image.width as usize) * (self.image.height as usize) * 4;
        assert_eq!(
            pixels.len(),
            expected,
            "LiveSession::update_image: pixel buffer len {} != width*height*4",
            pixels.len()
        );
        ctx.queue
            .write_buffer(&self.image.buffer, 0, bytemuck::cast_slice(pixels));
    }

    /// Cumulative pool allocation count (the honest zero-alloc hook): the number
    /// of actual `create_buffer` / `create_bind_group` calls the pool has made
    /// (misses). Snapshot it across a same-signature re-render — the delta must be
    /// 0 (no render-loop allocation). See [`crate::frame_pool`].
    pub fn pool_alloc_count(&self, ctx: &GpuContext) -> u64 {
        ctx.frame_pool.borrow().alloc_count()
    }

    /// Render one frame: the GATED live chain for `inputs` → the terminal dither
    /// → a readback of the packed-u8 RGB surface, unpacked to the flat `3·w·h` u8
    /// layout. `Ok(None)` if `cancel` fires before a pass is encoded (the refine
    /// pass abandoned by a newer edit); `Err` if a GPU readback fails (#1079).
    /// `ctx` is the same context the session was created with.
    ///
    /// AIRLIGHT (#1033): on the DEFAULT on-GPU path the dehaze atmospheric light A
    /// is computed ON-DEVICE — the `DehazePass` reduces it from the post-prefix
    /// buffer it sees (raw-core measures A at dehaze's position, not from the
    /// original input) with NO GPU→CPU readback, so the whole chain runs in ONE
    /// submit whether or not dehaze is engaged. The C5a CPU-readback split survives
    /// only behind [`Self::new_with_airlight_readback`].
    #[cfg(not(target_arch = "wasm32"))]
    pub fn render_to_buffer(
        &self,
        ctx: &GpuContext,
        inputs: &FullChainInputs<'_>,
        cancel: &CancelToken,
    ) -> Result<Option<Vec<u8>>, String> {
        pollster::block_on(self.render_async(ctx, inputs, Some(cancel)))
    }

    /// The async render core, shared by native (`render_to_buffer`) and wasm
    /// callers. On the default on-GPU airlight path (#1033) this is ALWAYS the
    /// single-submit path — dehaze self-computes A on-device — so there is no
    /// per-tick readback. Only the explicit readback fallback
    /// ([`Self::new_with_airlight_readback`]) takes the C5a mid-chain split when
    /// dehaze is engaged. `cancel` is checked before each pass; `None` ⇒ no
    /// cancellation. Returns the `3·w·h` u8 RGB buffer, `Ok(None)` if cancelled,
    /// or `Err` on a GPU readback failure (#1079).
    pub async fn render_async(
        &self,
        ctx: &GpuContext,
        inputs: &FullChainInputs<'_>,
        cancel: Option<&CancelToken>,
    ) -> Result<Option<Vec<u8>>, String> {
        let dims = self.image.dims();

        // Open the pooled render window for THIS chain shape — it SPANS both the
        // prefix and suffix encoders (the cursor runs prefix→suffix continuously),
        // so a same-signature re-render allocates ZERO new GPU resources.
        let sig = chain_signature(inputs, dims, self.session_id);
        ctx.frame_pool.borrow_mut().begin_frame(sig);

        let result = if self.airlight_readback_fallback && dehaze_is_active(inputs) {
            self.render_dehaze_split(ctx, inputs, cancel).await
        } else {
            // On-GPU airlight (or dehaze inactive): one submit, no readback.
            self.render_single(ctx, inputs, cancel).await
        };

        ctx.frame_pool.borrow_mut().end_frame();
        result
    }

    /// The single-submit path: the gated chain + dither in ONE command encoder, one
    /// readback of the u8 surface, no mid-chain stall. On the default path dehaze
    /// (if active) self-computes its airlight on-GPU ([`AirlightSource::OnGpu`]); on
    /// the no-dehaze chain the airlight source is unused.
    async fn render_single(
        &self,
        ctx: &GpuContext,
        inputs: &FullChainInputs<'_>,
        cancel: Option<&CancelToken>,
    ) -> Result<Option<Vec<u8>>, String> {
        let dims = self.image.dims();
        let f32_byte_len = self.image.byte_len();
        let passes = build_live_chain(inputs, AirlightSource::OnGpu);
        let pass_refs: Vec<&dyn Pass> = passes.iter().map(|p| p.as_ref()).collect();

        let mut encoder = ctx
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("live-session-encoder"),
            });
        // Seed ping-pong A from the immutable image, run the chain, dither.
        encoder.copy_buffer_to_buffer(&self.image.buffer, 0, &self.ping_pong[0], 0, f32_byte_len);
        let final_idx = match self.encode_chain(ctx, &mut encoder, &pass_refs, 0, cancel) {
            Some(idx) => idx,
            None => return Ok(None), // cancelled mid-encode
        };
        // Scope pass (#3272): reads the chain's final buffer, same as the
        // present/chain-only sibling `encode_chain_f32_single` — before
        // dither, which only concerns the u8 SURFACE this path additionally
        // produces.
        if inputs.scope.enabled {
            self.encode_scope(
                ctx,
                &mut encoder,
                &self.ping_pong[final_idx],
                inputs.scope.layer >= 0,
            );
        }
        encode_dither(
            ctx,
            &mut encoder,
            &self.ping_pong[final_idx],
            &self.dither_out,
            dims,
        );
        let out = self.submit_and_read_surface(ctx, encoder).await?;
        if inputs.scope.enabled {
            self.scope_after_submit();
        }
        Ok(Some(out))
    }

    /// Run the GATED live chain for `inputs` to its FINAL f32 buffer and STOP —
    /// no dither, no readback. Returns the ping-pong index holding the chain's
    /// sRGB-gamma-encoded f32-RGBA output (read it via [`Self::ping_pong_buffer`]),
    /// `Ok(None)` if `cancel` fired before a pass was encoded, or `Err` if the
    /// fallback path's mid-chain readback fails (#1079). The f32 result is
    /// left RESIDENT on the GPU so a present pass (P4b-apple #1028 / P4b-web #1029)
    /// can sample it directly into a display surface — the surface-bound sibling of
    /// [`Self::render_to_buffer`] (which appends dither + reads the u8 surface back).
    ///
    /// AIRLIGHT (C5a): identical to [`Self::render_to_buffer`] — when dehaze is
    /// engaged the chain runs as a prefix→mid-chain-readback→suffix split (A is
    /// measured from the post-prefix buffer); otherwise it is one submit. The
    /// chain command buffers are submitted before this returns; queue ordering
    /// makes the named buffer available to the present pass's separate submit.
    /// This does not wait for GPU completion or display scanout.
    ///
    /// Opens/closes the SAME signature-keyed pool window as [`Self::render_async`],
    /// so a warm same-signature re-render reuses its pooled GPU resources.
    #[cfg(not(target_arch = "wasm32"))]
    pub fn render_chain_to_f32(
        &self,
        ctx: &GpuContext,
        inputs: &FullChainInputs<'_>,
        cancel: &CancelToken,
    ) -> Result<Option<usize>, String> {
        pollster::block_on(self.render_chain_to_f32_async(ctx, inputs, Some(cancel)))
    }

    /// The async core of [`Self::render_chain_to_f32`], shared by native and the
    /// wasm present caller. Runs the gated chain to its final f32 buffer
    /// WITHOUT the terminal dither/readback, returning the ping-pong index that
    /// holds the result. `cancel` is checked before each pass; `None` ⇒ no
    /// cancellation.
    pub async fn render_chain_to_f32_async(
        &self,
        ctx: &GpuContext,
        inputs: &FullChainInputs<'_>,
        cancel: Option<&CancelToken>,
    ) -> Result<Option<usize>, String> {
        let dims = self.image.dims();
        let sig = chain_signature(inputs, dims, self.session_id);
        ctx.frame_pool.borrow_mut().begin_frame(sig);

        let result = if self.airlight_readback_fallback && dehaze_is_active(inputs) {
            self.encode_chain_f32_dehaze_split(ctx, inputs, cancel)
                .await
        } else {
            // On-GPU airlight (or dehaze inactive): one submit, no readback.
            Ok(self.encode_chain_f32_single(ctx, inputs, cancel))
        };

        ctx.frame_pool.borrow_mut().end_frame();
        result
    }

    /// The single-submit chain-only path: seed ping-pong A from the image, run the
    /// gated chain in ONE submit, leave the f32 result resident. Returns the final
    /// ping-pong index (the present pass reads it). On the default path dehaze (if
    /// active) self-computes its airlight on-GPU ([`AirlightSource::OnGpu`]); no
    /// readback, no mid-chain stall.
    fn encode_chain_f32_single(
        &self,
        ctx: &GpuContext,
        inputs: &FullChainInputs<'_>,
        cancel: Option<&CancelToken>,
    ) -> Option<usize> {
        let f32_byte_len = self.image.byte_len();
        let passes = build_live_chain(inputs, AirlightSource::OnGpu);
        let pass_refs: Vec<&dyn Pass> = passes.iter().map(|p| p.as_ref()).collect();

        let mut encoder = ctx
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("live-present-chain-encoder"),
            });
        encoder.copy_buffer_to_buffer(&self.image.buffer, 0, &self.ping_pong[0], 0, f32_byte_len);
        let final_idx = self.encode_chain(ctx, &mut encoder, &pass_refs, 0, cancel)?;
        // Scope pass (#3272): encoded into this SAME submit, reading the
        // chain's final buffer — no extra submit, no stall.
        if inputs.scope.enabled {
            self.encode_scope(
                ctx,
                &mut encoder,
                &self.ping_pong[final_idx],
                inputs.scope.layer >= 0,
            );
        }
        ctx.queue.submit(Some(encoder.finish()));
        if inputs.scope.enabled {
            self.scope_after_submit();
        }
        Some(final_idx)
    }

    /// Borrow the ping-pong buffer at `idx` (0 or 1) — the f32 chain output a
    /// present pass samples after [`Self::render_chain_to_f32`]. `STORAGE |
    /// COPY_SRC | COPY_DST`, so it binds as read-only storage in the present
    /// fragment shader. Panics on an out-of-range index (only 0/1 are valid).
    pub fn ping_pong_buffer(&self, idx: usize) -> &wgpu::Buffer {
        &self.ping_pong[idx]
    }
}

// Sibling modules (600-LOC budget): `limits` = the #1079 containment cluster
// (device-limit dim validation + fallible readback maps); tests are native
// builds only — the airlight end-to-end gates (C5a + C5b, #1033) live in their
// own file and reuse `tests::reference_u8` (pub(super) there).
#[cfg(all(test, not(target_arch = "wasm32")))]
#[path = "live_session/airlight_tests.rs"]
mod airlight_tests;
mod encode;
// The C5a CPU-readback airlight fallback (`render_dehaze_split` /
// `encode_chain_f32_dehaze_split`) — split out purely for the file-size
// budget; see that file's own header.
mod dehaze_split;
mod limits;
// The vectorscope scope-pass buffers + `take_scope_stats` (#3272) — split
// out purely for the file-size budget; see that file's own header.
mod scope;
#[cfg(all(test, not(target_arch = "wasm32")))]
#[path = "live_session/tests.rs"]
mod tests;
// Pooled zero-alloc gate — own file (600-LOC budget), reuses `tests`' `pub(super)`
// fixtures. Same split shape as `gpu_render`'s `tests` / `tests_sizing`.
#[cfg(all(test, not(target_arch = "wasm32")))]
#[path = "live_session/tests_pool.rs"]
mod tests_pool;
// The double-buffered scope readback gate (#3272) — own file (600-LOC
// budget), reuses `limits` (`pub(super)` there).
#[cfg(all(test, not(target_arch = "wasm32")))]
#[path = "live_session/tests_scope.rs"]
mod tests_scope;
