//! Clarity stage — the P2 wave-3b SPATIAL WGSL template (epic #925 / #990).
//!
//! The first GPU kernel to read pixel NEIGHBORHOODS. Per-pixel stages (vibrance,
//! …) thread one `src` → `dst` through the linear [`ChainRunner`]; clarity is a
//! small DAG — a self-guided guided filter (several box blurs over intermediate
//! planes) plus a base/detail recombine that reads the original image and three
//! derived planes at once. It stays ONE [`Pass`] from the chain's point of view
//! and orchestrates the DAG over scratch buffers via the [`crate::spatial`]
//! substrate (which dehaze + P3 reuse).
//!
//! Three pieces, mirroring the per-pixel template:
//! 1. [`apply_clarity`] — the CPU oracle (parity reference): a faithful port of
//!    `raw_core::stages::clarity::apply` over a flat RGBA f32 buffer, including a
//!    local copy of `box_blur_channel` / `guided_filter` (both `pub(crate)` in
//!    raw-core, so unreachable from this crate's dev-dep — the copy keeps the
//!    oracle honest and is itself pinned to `raw_core::stages::clarity::apply` by
//!    the parity test).
//! 2. [`ClarityPass`] — the GPU-resident stage. Carries only its `clarity` slider
//!    value; drives the spatial pipeline (`spatial::clarity_texture_encode` at the
//!    structure-scale radius 20) inside `encode`.
//! 3. The headless parity test (`clarity/tests.rs`) — GPU vs the real
//!    `raw_core::stages::clarity::apply` `< 1e-4` on a 64×64 image whose content
//!    varies near the borders (so the shrinking-window box-blur edge handling is
//!    exercised non-vacuously) AND whose interior pixels have full windows.
//!
//! ## Parity-critical: box-blur border handling
//!
//! `raw_core::stages::blur::box_blur_channel` is a serial running accumulator
//! whose window at coordinate `c` spans `[max(0, c - r) ..= min(dim - 1, c + r)]`
//! and divides by the EXACT in-bounds count — a shrinking partial average at the
//! borders, NOT zero-pad, NOT clamp. `box_blur.wgsl` computes a fresh window sum
//! over those exact bounds; the only difference from raw-core is float summation
//! order (~1e-6, well under 1e-4).

use crate::chain::Pass;
use crate::context::GpuContext;
use crate::spatial;

/// Guided-filter window radius for clarity's structure scale (effective reach
/// `2r = 40` px per side). Mirrors `raw_core::stages::clarity::CLARITY_GUIDED_RADIUS`.
pub const CLARITY_GUIDED_RADIUS: u32 = 20;

/// Guided-filter regularisation — `raw_core::stages::clarity::CLARITY_EPS`.
const CLARITY_EPS: f32 = 1e-3;

/// Rec.2020 luminance coefficients — `raw_core`'s `LUMA_REC2020`.
const LUMA_REC2020: [f32; 3] = [0.2627, 0.6780, 0.0593];

/// Luma identity threshold — `raw_core`'s `LUMA_FLOOR`. Pixels with
/// `luma <= LUMA_FLOOR` (including negative luma) pass through unchanged
/// (#1088): below the floor the boost/luma quotient stops being a ratio,
/// and the old pinned-divisor form exploded near-black pixels beside
/// bright content to `scale ≈ -3e5` at clarity +100.
const LUMA_FLOOR: f32 = 1e-6;

// ── Local copies of raw-core's `pub(crate)` blur primitives ───────────────────
//
// `box_blur_channel` / `guided_filter` are `pub(crate)` in raw-core, so they are
// unreachable from raw-gpu's (dev-dep) tests. These copies keep the CPU oracle
// (`apply_clarity`) self-contained; the parity test pins the GPU output to the
// REAL `raw_core::stages::clarity::apply`, so a transcription error here cannot
// mask a kernel bug. Kept line-faithful to `raw_core::stages::blur`.

/// Separable box blur of a scalar plane (row-major `w×h`). Faithful port of
/// `raw_core::stages::blur::box_blur_channel`: shrinking-window partial average
/// (`r == 0` is identity). Serial — mirrors raw-core's running accumulator so the
/// oracle is bit-identical to it.
fn box_blur_channel(buf: &[f32], w: usize, h: usize, r: usize) -> Vec<f32> {
    if r == 0 {
        return buf.to_vec();
    }
    // Horizontal sweep.
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
    // Vertical sweep.
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

#[derive(Clone, Copy)]
struct GuidedFilterConfig {
    w: usize,
    h: usize,
    r: usize,
    eps: f32,
}

/// Self-guided guided filter. Faithful port of
/// `raw_core::stages::blur::guided_filter` for the `guide == p` case (the only
/// case clarity / texture use). Operation order matches raw-core.
fn guided_filter(guide: &[f32], p: &[f32], config: GuidedFilterConfig) -> Vec<f32> {
    let GuidedFilterConfig { w, h, r, eps } = config;
    let n = guide.len();
    if r == 0 {
        return p.to_vec();
    }
    let ip: Vec<f32> = guide.iter().zip(p.iter()).map(|(&a, &b)| a * b).collect();
    let ii: Vec<f32> = guide.iter().map(|&a| a * a).collect();
    let mean_i = box_blur_channel(guide, w, h, r);
    let mean_p = box_blur_channel(p, w, h, r);
    let mean_ip = box_blur_channel(&ip, w, h, r);
    let mean_ii = box_blur_channel(&ii, w, h, r);
    let mut a = vec![0.0f32; n];
    let mut b = vec![0.0f32; n];
    for i in 0..n {
        let cov_ip = mean_ip[i] - mean_i[i] * mean_p[i];
        // Negative-variance clamp (#1088) — line-faithful to
        // `raw_core::stages::blur::guided_filter` (variance can never be
        // physically negative; the clamp keeps the `var_i + eps`
        // denominator positive when box-mean roundoff goes negative).
        let var_i = (mean_ii[i] - mean_i[i] * mean_i[i]).max(0.0);
        let a_i = cov_ip / (var_i + eps);
        a[i] = a_i;
        b[i] = mean_p[i] - a_i * mean_i[i];
    }
    let mean_a = box_blur_channel(&a, w, h, r);
    let mean_b = box_blur_channel(&b, w, h, r);
    (0..n).map(|i| mean_a[i] * guide[i] + mean_b[i]).collect()
}

/// Luminance-preserving local-contrast enhancement at the structure scale (~40 px
/// effective reach), on an interleaved RGBA f32 buffer (alpha untouched). The CPU
/// oracle — a line-for-line port of `raw_core::stages::clarity::apply`. `width` ×
/// `height` must match `buf.len() / 4`. `clarity` in [-100, +100]; the
/// `|clarity| < 1e-3` short-circuit (a no-op) is handled here, as in raw-core.
pub fn apply_clarity(buf: &mut [f32], width: usize, height: usize, clarity: f32) {
    apply_guided_clarity(buf, width, height, clarity, CLARITY_GUIDED_RADIUS as usize);
}

/// Shared CPU oracle for clarity / texture — they differ only by `radius`.
/// Mirrors the body of `raw_core::stages::{clarity,texture}::apply`.
pub(crate) fn apply_guided_clarity(
    buf: &mut [f32],
    width: usize,
    height: usize,
    amount_slider: f32,
    radius: usize,
) {
    assert_eq!(
        buf.len(),
        width * height * 4,
        "clarity oracle: buffer/dims mismatch"
    );
    if amount_slider.abs() < 1e-3 {
        return;
    }
    let amount = amount_slider / 100.0;
    let n = width * height;

    let luma_plane: Vec<f32> = (0..n)
        .map(|i| {
            LUMA_REC2020[0] * buf[i * 4]
                + LUMA_REC2020[1] * buf[i * 4 + 1]
                + LUMA_REC2020[2] * buf[i * 4 + 2]
        })
        .collect();
    let base = guided_filter(
        &luma_plane,
        &luma_plane,
        GuidedFilterConfig {
            w: width,
            h: height,
            r: radius,
            eps: CLARITY_EPS,
        },
    );

    for i in 0..n {
        let luma = luma_plane[i];
        // Identity at/below the luma floor (#1088) — mirrors
        // `raw_core::stages::{clarity,texture}::apply`. Above the floor,
        // dividing by `luma` is bit-identical to the old
        // `luma.max(LUMA_FLOOR)` divisor.
        if luma <= LUMA_FLOOR {
            continue;
        }
        let detail = luma - base[i];
        let boost = luma + detail * amount;
        let scale = boost / luma;
        buf[i * 4] *= scale;
        buf[i * 4 + 1] *= scale;
        buf[i * 4 + 2] *= scale;
        // alpha (buf[i*4+3]) untouched
    }
}

/// A GPU-resident clarity stage. Carries only its `clarity` slider value
/// ([-100, +100]); device, pipelines, and scratch buffers come from the
/// [`GpuContext`] / spatial substrate at encode time. Drives the shared
/// clarity/texture spatial pipeline at the structure-scale radius (20).
pub struct ClarityPass {
    pub clarity: f32,
}

impl Pass for ClarityPass {
    fn encode(
        &self,
        ctx: &GpuContext,
        encoder: &mut wgpu::CommandEncoder,
        src: &wgpu::Buffer,
        dst: &wgpu::Buffer,
        dims: (u32, u32),
    ) {
        let (width, height) = dims;
        // |clarity| < 1e-3 is identity in raw-core — copy src → dst and bail so
        // the chain's ping-pong still threads the (unchanged) image through.
        if self.clarity.abs() < 1e-3 {
            let byte_len = (width as u64) * (height as u64) * 4 * std::mem::size_of::<f32>() as u64;
            encoder.copy_buffer_to_buffer(src, 0, dst, 0, byte_len);
            return;
        }
        spatial::clarity_texture_encode(
            ctx,
            encoder,
            src,
            dst,
            width,
            height,
            CLARITY_GUIDED_RADIUS,
            self.clarity / 100.0,
        );
    }
}

// Parity tests live in a sibling file to keep this module under the 600-LOC
// budget (mirrors residual_lut's `tests.rs` split). Native test builds only.
#[cfg(all(test, not(target_arch = "wasm32")))]
#[path = "clarity/tests.rs"]
mod tests;
