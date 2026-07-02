//! Dehaze stage — the LAST P2 stage and the hardest SPATIAL one (epic #925 P2
//! wave 3b / #990). Completes the scene-linear chain on the GPU.
//!
//! Dehaze is a dark-channel-prior (He, Sun, Tang 2009) haze removal with a
//! guided-filter transmission refine and a sky-preservation mask (issue #272).
//! Unlike clarity/texture (a self-guided guided filter), dehaze layers several
//! distinct sub-stages, two of which are new substrate beats:
//!
//!   1. **Dark channel** — a 15×15 window MIN over `min(r,g,b)`. CLAMP-TO-EDGE
//!      borders (full window, replicate the edge), NOT the box blur's shrinking
//!      window — so it's a direct 2D min kernel (`dehaze_min.wgsl`, mode 0).
//!   2. **Atmospheric light A** — a GLOBAL reduction: the mean of the original
//!      image at the brightest top-0.1% of dark-channel positions. Computed
//!      CPU-side ([`compute_airlight`]) replicating raw-core's exact sort +
//!      top-N average, then passed into the kernels as a uniform — the cleanest
//!      headless-parity path for a global reduction (the WhiteBalancePass
//!      CPU-derive pattern). A is byte-exact vs raw-core.
//!   3. **Transmission** — `1 - ω·(15×15 window min of min(rgb/A))`, clamp-to-edge
//!      (`dehaze_min.wgsl`, mode 1; A in the uniform, clamped per-channel HERE only).
//!   4. **Guided refine** — a GENERAL guided filter (guide = luma, p = t), four
//!      independent blurred means. Packed into vec2 planes so the a/b kernel fits
//!      the 4-storage cap (`dehaze_products` → `box_blur_vec2` → `dehaze_guided_ab`
//!      → `box_blur_vec2`).
//!   5. **Sky mask** — `smoothstep(0.40, 0.60, dark_channel)` then a radius-8 box
//!      blur (`dehaze_sky_mask.wgsl` + the scalar [`spatial::box_blur_encode`]).
//!   6. **Recovery** — `J = (I - A)/t_eff + A` (RAW A) blended with `I` by the sky
//!      mask (`dehaze_recover.wgsl`, the MULTI-INPUT tail — exactly 4 storage).
//!
//! Three pieces, like every wave-3b stage:
//! - [`apply_dehaze`] — the CPU oracle: a faithful port of
//!   `raw_core::stages::dehaze::apply` (incl. local copies of its `pub(crate)`
//!   blur primitives), pinned to the real stage by the parity test.
//! - [`DehazePass`] — the GPU-resident stage; carries the slider, drives the
//!   sub-pass DAG over [`spatial`] scratch buffers inside `encode`.
//! - The headless parity test (`dehaze/tests.rs`) — GPU vs the real
//!   `raw_core::stages::dehaze::apply` `< 1e-4` across the strength range, with
//!   non-vacuous border coverage.

use crate::airlight;
use crate::chain::Pass;
use crate::context::GpuContext;
use crate::spatial;

// The CPU oracle (the verbatim raw-core port + the public `apply_dehaze` /
// `compute_airlight` entry points) lives in a sibling file to keep this module
// under the 600-LOC budget (#1033). It shares the stage constants below via
// `use super::*`. Re-exported so the crate API is unchanged.
mod oracle;
pub use oracle::{apply_dehaze, compute_airlight};

/// Dark-channel / transmission window radius (15×15) — `raw_core`'s `DARK_RADIUS`.
const DARK_RADIUS: usize = 7;
/// Transmission strength — `raw_core::stages::dehaze`'s `OMEGA`.
const OMEGA: f32 = 0.95;
/// Guided-filter window radius for the transmission refine — raw-core uses 60.
const GUIDED_RADIUS: u32 = 60;
/// Guided-filter regularisation — raw-core's `1e-3` in `apply`.
const GUIDED_EPS: f32 = 1e-3;
/// Sky-mask smoothstep edges (issue #272) — raw-core's `SKY_MASK_LOW`/`HIGH`.
const SKY_MASK_LOW: f32 = 0.40;
const SKY_MASK_HIGH: f32 = 0.60;
/// Sky-mask softening blur radius — raw-core's `SKY_MASK_BLUR_RADIUS`.
const SKY_MASK_BLUR_RADIUS: u32 = 8;
/// Transmission floor in recovery — raw-core's `t0`.
const T0: f32 = 0.1;
/// Rec.2020 luma weights — raw-core's guide weights (same add order).
const LUMA_REC2020: [f32; 3] = [0.2627, 0.6780, 0.0593];
/// Per-channel airlight floor applied INSIDE transmission only.
const A_FLOOR: f32 = 1e-6;

// ── `repr(C)` uniforms for the dehaze kernels ─────────────────────────────────

/// `dehaze_min.wgsl` uniform: dims + mode. The airlight rides a SEPARATE uniform
/// (#1033), so it isn't packed here.
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct MinParams {
    width: u32,
    height: u32,
    mode: u32, // 0 = dark channel, 1 = transmission
    _pad0: u32,
}

/// The standalone airlight uniform (#1033) shared by the transmission min kernel
/// (mode 1) and the recovery kernel: one `vec4<f32>` (rgb = A, .a unused). The
/// SAME 16-byte layout the airlight-reduce kernel writes, so an on-GPU A can be
/// copied straight in via `copy_buffer_to_buffer` (no readback) — or the CPU A is
/// written via `queue.write_buffer`.
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct AirlightUniform {
    value: [f32; 4],
}

/// `dehaze_products.wgsl` / `dehaze_sky_mask.wgsl` uniform: just the pixel count.
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct CountParams {
    count: u32,
    _pad0: u32,
    _pad1: u32,
    _pad2: u32,
}

/// `dehaze_guided_ab.wgsl` uniform: pixel count + regularisation.
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct AbParams {
    count: u32,
    eps: f32,
    _pad0: u32,
    _pad1: u32,
}

/// `dehaze_recover.wgsl` uniform: count + precomputed scale. The RAW airlight
/// rides a SEPARATE uniform (#1033), so it isn't packed here.
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct RecoverParams {
    count: u32,
    scale: f32, // clamp(dehaze / 100, -1, 1)
    _pad0: u32,
    _pad1: u32,
}

/// Where a [`DehazePass`] gets its atmospheric light A from.
///
/// A is a GLOBAL reduction over the EXACT pixels the chain feeds dehaze as `src`
/// (the post-prefix buffer in a real chain — unlike [`crate::WhiteBalancePass`]'s
/// position-independent matrix, A depends on the running pixel content). Two
/// sources, both ending at the same airlight UNIFORM the transmission + recovery
/// kernels read:
///
/// - [`AirlightSource::Cpu`] — a pre-computed `[f32; 3]` (via [`compute_airlight`],
///   byte-exact vs raw-core's sort + top-N average). Written into the uniform with
///   `queue.write_buffer`. The headless / P4a path: the caller supplies A measured
///   from the buffer dehaze will see.
/// - [`AirlightSource::OnGpu`] — compute A on-device during `encode` from `src` +
///   the dark channel this pass already produces ([`crate::airlight::encode_airlight`]),
///   copied (GPU→GPU) into the uniform. The LIVE path (#1033): no GPU→CPU readback,
///   so the dehaze-active chain meets the 16ms budget and runs in one submit.
#[derive(Clone)]
pub enum AirlightSource {
    /// CPU-computed RAW airlight `[r, g, b]` (the headless / P4a path).
    Cpu([f32; 3]),
    /// Compute the airlight on-GPU during `encode` (the live path, #1033).
    OnGpu,
}

/// A GPU-resident dehaze stage. Carries the `dehaze` slider value ([-100, +100])
/// and an [`AirlightSource`]; the per-pixel pipeline runs entirely on the GPU over
/// [`spatial`] scratch buffers inside `encode`.
pub struct DehazePass {
    pub dehaze: f32,
    /// How A is sourced — a pre-computed CPU value or an on-GPU reduction (#1033).
    /// See [`AirlightSource`].
    pub airlight: AirlightSource,
}

impl DehazePass {
    /// Construct a [`DehazePass`] with a CPU-computed airlight from `pixels`
    /// (interleaved RGBA f32 for `width × height`) via [`compute_airlight`]. The
    /// convenience path the parity test uses: `pixels` MUST be the exact buffer
    /// the chain feeds this pass as `src` (see [`AirlightSource`]).
    pub fn new(pixels: &[f32], width: usize, height: usize, dehaze: f32) -> Self {
        Self {
            dehaze,
            airlight: AirlightSource::Cpu(compute_airlight(pixels, width, height)),
        }
    }

    /// Construct a [`DehazePass`] that computes its airlight on-GPU (#1033) — the
    /// live path. A is measured during `encode` from the `src` buffer the chain
    /// hands this pass (exactly the post-prefix pixels raw-core measures from), so
    /// there is no GPU→CPU readback and the dehaze-active chain runs in one submit.
    pub fn new_on_gpu(dehaze: f32) -> Self {
        Self {
            dehaze,
            airlight: AirlightSource::OnGpu,
        }
    }
}

impl Pass for DehazePass {
    fn encode(
        &self,
        ctx: &GpuContext,
        encoder: &mut wgpu::CommandEncoder,
        src: &wgpu::Buffer,
        dst: &wgpu::Buffer,
        dims: (u32, u32),
    ) {
        let (width, height) = dims;
        // |dehaze| < 1e-3 is identity in raw-core — copy src → dst and bail so
        // the chain's ping-pong still threads the (unchanged) image through.
        if self.dehaze.abs() < 1e-3 {
            let byte_len = (width as u64) * (height as u64) * 4 * std::mem::size_of::<f32>() as u64;
            encoder.copy_buffer_to_buffer(src, 0, dst, 0, byte_len);
            return;
        }
        let count = width * height;

        // The standalone airlight UNIFORM (#1033) the transmission + recovery
        // kernels read (binding 3 / binding 5). Pooled (zero-alloc re-render) with
        // `UNIFORM | COPY_DST | COPY_SRC` — `COPY_DST` so it can be filled by EITHER
        // a CPU `write_buffer` or an on-GPU `copy_buffer_to_buffer`.
        let airlight_uniform = airlight::alloc_airlight_uniform(ctx);

        // 1. Dark channel (mode 0) — direct 2D 15×15 window min, clamp-to-edge.
        // Mode 0 ignores the airlight; bind the (still-to-be-filled) uniform anyway
        // so every `dehaze_min` dispatch uses the SAME 4-binding layout.
        let dc = spatial::alloc_plane(ctx, width, height, "dehaze-dc");
        let dc_params = MinParams {
            width,
            height,
            mode: 0,
            _pad0: 0,
        };
        spatial::encode_simple(
            ctx,
            encoder,
            ctx.dehaze_min_pipeline(),
            bytemuck::bytes_of(&dc_params),
            &[src, &dc, &airlight_uniform],
            count,
            "dehaze-dark-channel",
        );

        // 1b. Fill the airlight uniform from the chosen source (#1033). CPU: write
        //     the pre-computed A directly. On-GPU: run the histogram + reduce over
        //     `src` and its dark channel `dc`, then copy the result (GPU→GPU, no
        //     readback) into the uniform. Either way the transmission + recovery
        //     dispatches below read A from the same binding.
        match &self.airlight {
            AirlightSource::Cpu(a) => {
                let a_uniform = AirlightUniform {
                    value: [a[0], a[1], a[2], 0.0],
                };
                ctx.queue
                    .write_buffer(&airlight_uniform, 0, bytemuck::bytes_of(&a_uniform));
            }
            AirlightSource::OnGpu => {
                let a_out = airlight::encode_airlight(ctx, encoder, src, &dc, count);
                encoder.copy_buffer_to_buffer(
                    &a_out,
                    0,
                    &airlight_uniform,
                    0,
                    airlight::AIRLIGHT_BYTE_LEN,
                );
            }
        }

        // 2. Transmission (mode 1) — same window, A in the uniform (clamped in-kernel).
        let t_raw = spatial::alloc_plane(ctx, width, height, "dehaze-t-raw");
        let t_params = MinParams {
            width,
            height,
            mode: 1,
            _pad0: 0,
        };
        spatial::encode_simple(
            ctx,
            encoder,
            ctx.dehaze_min_pipeline(),
            bytemuck::bytes_of(&t_params),
            &[src, &t_raw, &airlight_uniform],
            count,
            "dehaze-transmission",
        );

        // 3. Guided refine (GENERAL, guide=luma p=t): pack pre-blur products into
        //    two vec2 planes, blur each, derive a/b, blur a/b.
        let m1 = spatial::alloc_plane_vec2(ctx, width, height, "dehaze-m1");
        let m2 = spatial::alloc_plane_vec2(ctx, width, height, "dehaze-m2");
        let prod_params = CountParams {
            count,
            _pad0: 0,
            _pad1: 0,
            _pad2: 0,
        };
        spatial::encode_simple(
            ctx,
            encoder,
            ctx.dehaze_products_pipeline(),
            bytemuck::bytes_of(&prod_params),
            &[src, &t_raw, &m1, &m2],
            count,
            "dehaze-products",
        );

        let mean_m1 = spatial::alloc_plane_vec2(ctx, width, height, "dehaze-mean-m1");
        let mean_m2 = spatial::alloc_plane_vec2(ctx, width, height, "dehaze-mean-m2");
        spatial::box_blur_vec2_encode(ctx, encoder, &m1, &mean_m1, width, height, GUIDED_RADIUS);
        spatial::box_blur_vec2_encode(ctx, encoder, &m2, &mean_m2, width, height, GUIDED_RADIUS);

        let ab = spatial::alloc_plane_vec2(ctx, width, height, "dehaze-ab");
        let ab_params = AbParams {
            count,
            eps: GUIDED_EPS,
            _pad0: 0,
            _pad1: 0,
        };
        spatial::encode_simple(
            ctx,
            encoder,
            ctx.dehaze_guided_ab_pipeline(),
            bytemuck::bytes_of(&ab_params),
            &[&mean_m1, &mean_m2, &ab],
            count,
            "dehaze-guided-ab",
        );

        let mean_ab = spatial::alloc_plane_vec2(ctx, width, height, "dehaze-mean-ab");
        spatial::box_blur_vec2_encode(ctx, encoder, &ab, &mean_ab, width, height, GUIDED_RADIUS);

        // 4. Sky mask: raw smoothstep over the dark channel, then a radius-8 blur.
        let sky_raw = spatial::alloc_plane(ctx, width, height, "dehaze-sky-raw");
        let sky_params = CountParams {
            count,
            _pad0: 0,
            _pad1: 0,
            _pad2: 0,
        };
        spatial::encode_simple(
            ctx,
            encoder,
            ctx.dehaze_sky_mask_pipeline(),
            bytemuck::bytes_of(&sky_params),
            &[&dc, &sky_raw],
            count,
            "dehaze-sky-mask",
        );
        let sky = spatial::alloc_plane(ctx, width, height, "dehaze-sky");
        spatial::box_blur_encode(
            ctx,
            encoder,
            &sky_raw,
            &sky,
            width,
            height,
            SKY_MASK_BLUR_RADIUS,
        );

        // 5. Recovery (MULTI-INPUT, 4 storage + 2 uniforms): orig + mean_ab + sky →
        //    dst, with A read from the airlight uniform (binding 5, #1033 — so A is
        //    NOT a 5th storage binding; storage stays at the 4-cap).
        let scale = (self.dehaze / 100.0).clamp(-1.0, 1.0);
        let rec_params = RecoverParams {
            count,
            scale,
            _pad0: 0,
            _pad1: 0,
        };
        spatial::encode_simple(
            ctx,
            encoder,
            ctx.dehaze_recover_pipeline(),
            bytemuck::bytes_of(&rec_params),
            &[src, &mean_ab, &sky, dst, &airlight_uniform],
            count,
            "dehaze-recover",
        );
    }
}

// Parity tests live in a sibling file to keep this module under the 600-LOC
// budget (mirrors clarity's tests.rs split). Native test builds only.
#[cfg(all(test, not(target_arch = "wasm32")))]
#[path = "dehaze/tests.rs"]
mod tests;
