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

use crate::chain::Pass;
use crate::context::GpuContext;
use crate::spatial;

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

// ── CPU oracle: verbatim port of raw-core's dehaze primitives ─────────────────
//
// `box_blur` / `guided_filter` / `dark_channel` / `atmospheric_light` /
// `transmission` / `sky_mask` / `recover_with_mask` are private in raw-core, so
// these copies keep the oracle self-contained. The parity test pins the GPU (and
// transitively this oracle) to the REAL `raw_core::stages::dehaze::apply`, so a
// transcription slip here cannot mask a kernel bug. Kept line-faithful.

/// Dark channel: 15×15 window min of `min(r,g,b)`, CLAMP-TO-EDGE borders.
/// Faithful to `raw_core::stages::dehaze::dark_channel`.
fn dark_channel(pixels: &[[f32; 3]], w: usize, h: usize) -> Vec<f32> {
    let wi = w as i32;
    let hi = h as i32;
    let r = DARK_RADIUS as i32;
    let mut out = vec![0.0f32; w * h];
    for y in 0..hi {
        for x in 0..wi {
            let mut m = f32::INFINITY;
            for dy in -r..=r {
                for dx in -r..=r {
                    let ux = (x + dx).clamp(0, wi - 1) as usize;
                    let uy = (y + dy).clamp(0, hi - 1) as usize;
                    let p = pixels[uy * w + ux];
                    let local_min = p[0].min(p[1]).min(p[2]);
                    if local_min < m {
                        m = local_min;
                    }
                }
            }
            out[(y * wi + x) as usize] = m;
        }
    }
    out
}

/// Atmospheric light A: mean of the original image at the brightest 0.1% of
/// dark-channel positions. Faithful to
/// `raw_core::stages::dehaze::atmospheric_light` — INCLUDING the exact
/// `sort_unstable_by` descending comparator (tie-breaks must match: on a small
/// image `top_n` is tiny, so one swapped pixel shifts A enough to fail parity).
fn atmospheric_light(pixels: &[[f32; 3]], dc: &[f32]) -> [f32; 3] {
    let n = dc.len();
    let top_n = (n / 1000).max(1);
    let mut idx: Vec<usize> = (0..n).collect();
    idx.sort_unstable_by(|&a, &b| dc[b].partial_cmp(&dc[a]).unwrap_or(std::cmp::Ordering::Equal));
    let mut sum = [0.0f32; 3];
    for &i in &idx[..top_n] {
        let p = pixels[i];
        sum[0] += p[0];
        sum[1] += p[1];
        sum[2] += p[2];
    }
    let k = top_n as f32;
    [sum[0] / k, sum[1] / k, sum[2] / k]
}

/// Transmission: `1 - ω·(15×15 window min of min(rgb/A))`, clamp-to-edge, with
/// each A floored at 1e-6. Faithful to `raw_core::stages::dehaze::transmission`.
fn transmission(pixels: &[[f32; 3]], w: usize, h: usize, a: [f32; 3]) -> Vec<f32> {
    let wi = w as i32;
    let hi = h as i32;
    let r = DARK_RADIUS as i32;
    let mut out = vec![0.0f32; w * h];
    for y in 0..hi {
        for x in 0..wi {
            let mut m = f32::INFINITY;
            for dy in -r..=r {
                for dx in -r..=r {
                    let ux = (x + dx).clamp(0, wi - 1) as usize;
                    let uy = (y + dy).clamp(0, hi - 1) as usize;
                    let p = pixels[uy * w + ux];
                    let scaled_min = (p[0] / a[0].max(A_FLOOR))
                        .min(p[1] / a[1].max(A_FLOOR))
                        .min(p[2] / a[2].max(A_FLOOR));
                    if scaled_min < m {
                        m = scaled_min;
                    }
                }
            }
            out[(y * wi + x) as usize] = 1.0 - OMEGA * m;
        }
    }
    out
}

/// Separable box blur (shrinking partial average) — faithful to
/// `raw_core::stages::dehaze::box_blur` (the same running accumulator as
/// clarity's `box_blur_channel`). `r` here is always > 0 in the dehaze path.
fn box_blur(buf: &[f32], w: usize, h: usize, r: usize) -> Vec<f32> {
    let mut tmp = vec![0.0f32; buf.len()];
    for y in 0..h {
        let row = &buf[y * w..(y + 1) * w];
        let out_row = &mut tmp[y * w..(y + 1) * w];
        let right0 = r.min(w - 1);
        let mut acc: f32 = row[0..=right0].iter().sum();
        let mut count = right0 + 1;
        out_row[0] = acc / count as f32;
        for x in 1..w {
            if x + r < w {
                acc += row[x + r];
                count += 1;
            }
            if x > r {
                acc -= row[x - r - 1];
                count -= 1;
            }
            out_row[x] = acc / count as f32;
        }
    }
    let mut out = vec![0.0f32; buf.len()];
    for x in 0..w {
        let bot0 = r.min(h - 1);
        let mut acc: f32 = (0..=bot0).map(|i| tmp[i * w + x]).sum();
        let mut count = bot0 + 1;
        out[x] = acc / count as f32;
        for y in 1..h {
            if y + r < h {
                acc += tmp[(y + r) * w + x];
                count += 1;
            }
            if y > r {
                acc -= tmp[(y - r - 1) * w + x];
                count -= 1;
            }
            out[y * w + x] = acc / count as f32;
        }
    }
    out
}

/// GENERAL guided filter (guide != p) — faithful to
/// `raw_core::stages::dehaze::guided_filter`. Six box blurs over the cross terms.
fn guided_filter(guide: &[f32], p: &[f32], w: usize, h: usize, r: usize, eps: f32) -> Vec<f32> {
    let n = guide.len();
    let mean_i = box_blur(guide, w, h, r);
    let mean_p = box_blur(p, w, h, r);
    let ip: Vec<f32> = guide.iter().zip(p.iter()).map(|(&a, &b)| a * b).collect();
    let mean_ip = box_blur(&ip, w, h, r);
    let ii: Vec<f32> = guide.iter().map(|&a| a * a).collect();
    let mean_ii = box_blur(&ii, w, h, r);

    let cov_ip: Vec<f32> = (0..n).map(|i| mean_ip[i] - mean_i[i] * mean_p[i]).collect();
    let var_i: Vec<f32> = (0..n).map(|i| mean_ii[i] - mean_i[i] * mean_i[i]).collect();
    let a: Vec<f32> = (0..n).map(|i| cov_ip[i] / (var_i[i] + eps)).collect();
    let b: Vec<f32> = (0..n).map(|i| mean_p[i] - a[i] * mean_i[i]).collect();

    let mean_a = box_blur(&a, w, h, r);
    let mean_b = box_blur(&b, w, h, r);
    (0..n).map(|i| mean_a[i] * guide[i] + mean_b[i]).collect()
}

/// `smoothstep(edge0, edge1, x)` — faithful to raw-core's helper / the WGSL builtin.
#[inline]
fn smoothstep(edge0: f32, edge1: f32, x: f32) -> f32 {
    let t = ((x - edge0) / (edge1 - edge0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// Sky mask: `smoothstep(0.40, 0.60, dc)` then a radius-8 box blur. Faithful to
/// `raw_core::stages::dehaze::sky_mask`.
fn sky_mask(dc: &[f32], w: usize, h: usize) -> Vec<f32> {
    let raw: Vec<f32> = dc
        .iter()
        .map(|&v| smoothstep(SKY_MASK_LOW, SKY_MASK_HIGH, v))
        .collect();
    box_blur(&raw, w, h, SKY_MASK_BLUR_RADIUS as usize)
}

/// The per-pixel recovery + sky-mask blend. Faithful to
/// `raw_core::stages::dehaze::recover_with_mask` (RAW A in the recovery divide).
fn recover_with_mask(
    pixels: &mut [[f32; 3]],
    dehaze: f32,
    t_refined: &[f32],
    a: [f32; 3],
    mask: &[f32],
) {
    let scale = (dehaze / 100.0).clamp(-1.0, 1.0);
    for (i, p) in pixels.iter_mut().enumerate() {
        let t = t_refined[i].clamp(0.0, 1.0);
        let t_eff = if scale >= 0.0 {
            (t + (1.0 - t) * (1.0 - scale)).max(T0)
        } else {
            (t + (1.0 - t) * (-scale)).min(1.0).max(T0)
        };
        let j_r = (p[0] - a[0]) / t_eff + a[0];
        let j_g = (p[1] - a[1]) / t_eff + a[1];
        let j_b = (p[2] - a[2]) / t_eff + a[2];
        let m = mask[i].clamp(0.0, 1.0);
        let inv_m = 1.0 - m;
        *p = [
            inv_m * j_r + m * p[0],
            inv_m * j_g + m * p[1],
            inv_m * j_b + m * p[2],
        ];
    }
}

/// Compute the atmospheric light A for `buf` (interleaved RGBA f32) EXACTLY as
/// `raw_core::stages::dehaze::apply` does: the dark channel, then the mean of the
/// original RGB at the brightest top-0.1% of dark-channel positions. Public so
/// [`DehazePass`] can run this global reduction CPU-side and pass A into the
/// kernels as a uniform (the cleanest headless-parity path for a global
/// reduction). The returned A is RAW (unclamped); the per-channel 1e-6 floor is
/// the transmission kernel's concern only.
pub fn compute_airlight(buf: &[f32], width: usize, height: usize) -> [f32; 3] {
    let pixels = to_rgb(buf);
    let dc = dark_channel(&pixels, width, height);
    atmospheric_light(&pixels, &dc)
}

/// Convert an interleaved RGBA f32 buffer to `[[f32;3]]` (drop alpha).
fn to_rgb(buf: &[f32]) -> Vec<[f32; 3]> {
    buf.chunks_exact(4).map(|c| [c[0], c[1], c[2]]).collect()
}

/// The CPU oracle: dehaze an interleaved RGBA f32 buffer (alpha untouched), a
/// line-for-line port of `raw_core::stages::dehaze::apply`. `dehaze` in
/// [-100, +100]; the `|dehaze| < 1e-3` no-op short-circuit is handled here as in
/// raw-core. `width × height` must equal `buf.len() / 4`.
pub fn apply_dehaze(buf: &mut [f32], width: usize, height: usize, dehaze: f32) {
    assert_eq!(buf.len(), width * height * 4, "dehaze oracle: buffer/dims mismatch");
    if dehaze.abs() < 1e-3 {
        return;
    }
    let mut pixels = to_rgb(buf);

    let dc = dark_channel(&pixels, width, height);
    let a = atmospheric_light(&pixels, &dc);
    let t_raw = transmission(&pixels, width, height, a);

    let guide: Vec<f32> = pixels
        .iter()
        .map(|p| LUMA_REC2020[0] * p[0] + LUMA_REC2020[1] * p[1] + LUMA_REC2020[2] * p[2])
        .collect();
    let t_refined = guided_filter(&guide, &t_raw, width, height, GUIDED_RADIUS as usize, GUIDED_EPS);

    let sky = sky_mask(&dc, width, height);
    recover_with_mask(&mut pixels, dehaze, &t_refined, a, &sky);

    for (i, p) in pixels.iter().enumerate() {
        buf[i * 4] = p[0];
        buf[i * 4 + 1] = p[1];
        buf[i * 4 + 2] = p[2];
        // alpha (buf[i*4+3]) untouched
    }
}

// ── `repr(C)` uniforms for the dehaze kernels ─────────────────────────────────

/// `dehaze_min.wgsl` uniform: dims + mode + the (clamped-in-kernel) airlight.
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct MinParams {
    width: u32,
    height: u32,
    mode: u32, // 0 = dark channel, 1 = transmission
    _pad0: u32,
    airlight: [f32; 4], // .a unused; vec4 for 16-byte alignment
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

/// `dehaze_recover.wgsl` uniform: count + precomputed scale + RAW airlight.
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct RecoverParams {
    count: u32,
    scale: f32, // clamp(dehaze / 100, -1, 1)
    _pad0: u32,
    _pad1: u32,
    airlight: [f32; 4], // RAW A; .a unused
}

/// A GPU-resident dehaze stage. Carries the `dehaze` slider value ([-100, +100])
/// and a pre-computed atmospheric light; the per-pixel pipeline runs entirely on
/// the GPU over [`spatial`] scratch buffers inside `encode`.
pub struct DehazePass {
    pub dehaze: f32,
    /// Pre-computed atmospheric light A for the image being processed, RAW
    /// (unclamped). Computed CPU-side via [`compute_airlight`] so the global
    /// top-0.1% reduction is byte-exact vs raw-core; passed into the min (clamped
    /// there) and recovery (raw) kernels as a uniform. It rides the struct rather
    /// than being derived in `encode` because `encode` only *records* commands —
    /// it cannot read `src` back, and a global reduction is awkward to express as
    /// a single dispatch.
    ///
    /// COMPOSITION CAVEAT (a P4 wiring concern, not a parity defect): A must be
    /// derived from the EXACT pixels the chain feeds this pass as `src`. Unlike
    /// [`crate::WhiteBalancePass`] (whose matrix comes from slider settings and is
    /// position-independent), dehaze's A depends on the running pixel content, so
    /// in a real multi-stage chain — where dehaze's `src` is the post-WB /
    /// post-tone-controls buffer — A must be recomputed from the buffer at
    /// dehaze's position (a GPU reduction or a readback). The headless tests run
    /// dehaze first (or behind an identity stage), so `new(pixels, …)` from the
    /// uploaded image is exact there. Live-chain placement is P4 (#992).
    pub airlight: [f32; 3],
}

impl DehazePass {
    /// Construct a [`DehazePass`], computing the airlight from `pixels`
    /// (interleaved RGBA f32 for `width × height`) via [`compute_airlight`]. The
    /// convenience path the parity test uses: `pixels` MUST be the exact buffer
    /// the chain feeds this pass as `src` (see the COMPOSITION CAVEAT on
    /// [`DehazePass::airlight`]).
    pub fn new(pixels: &[f32], width: usize, height: usize, dehaze: f32) -> Self {
        Self {
            dehaze,
            airlight: compute_airlight(pixels, width, height),
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
        let a4 = [self.airlight[0], self.airlight[1], self.airlight[2], 0.0];

        // 1. Dark channel (mode 0) — direct 2D 15×15 window min, clamp-to-edge.
        let dc = spatial::alloc_plane(ctx, width, height, "dehaze-dc");
        let dc_params = MinParams {
            width,
            height,
            mode: 0,
            _pad0: 0,
            airlight: [0.0; 4],
        };
        spatial::encode_simple(
            ctx,
            encoder,
            ctx.dehaze_min_pipeline(),
            bytemuck::bytes_of(&dc_params),
            &[src, &dc],
            count,
            "dehaze-dark-channel",
        );

        // 2. Transmission (mode 1) — same window, A in the uniform (clamped in-kernel).
        let t_raw = spatial::alloc_plane(ctx, width, height, "dehaze-t-raw");
        let t_params = MinParams {
            width,
            height,
            mode: 1,
            _pad0: 0,
            airlight: a4,
        };
        spatial::encode_simple(
            ctx,
            encoder,
            ctx.dehaze_min_pipeline(),
            bytemuck::bytes_of(&t_params),
            &[src, &t_raw],
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
        spatial::box_blur_encode(ctx, encoder, &sky_raw, &sky, width, height, SKY_MASK_BLUR_RADIUS);

        // 5. Recovery (MULTI-INPUT, 4 storage): orig + mean_ab + sky → dst.
        let scale = (self.dehaze / 100.0).clamp(-1.0, 1.0);
        let rec_params = RecoverParams {
            count,
            scale,
            _pad0: 0,
            _pad1: 0,
            airlight: a4,
        };
        spatial::encode_simple(
            ctx,
            encoder,
            ctx.dehaze_recover_pipeline(),
            bytemuck::bytes_of(&rec_params),
            &[src, &mean_ab, &sky, dst],
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
