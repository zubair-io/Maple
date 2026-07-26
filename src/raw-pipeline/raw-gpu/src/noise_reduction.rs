//! Noise-reduction stage — the P3 wave-1 SPATIAL WGSL port (epic #925 / #991).
//!
//! Fast non-local-means denoising in Oklab space. The first P3 spatial filter:
//! like clarity/dehaze it reads pixel NEIGHBOURHOODS, so it stays ONE chain
//! [`Pass`] and orchestrates its own sub-passes over scratch planes. NLM's outer
//! loop is over SHIFTS (offsets in a search window), each contributing a
//! patch-similarity-weighted sample to a running accumulator — so the orchestration
//! is a per-shift dispatch loop, distinct from clarity's box-blur DAG and dehaze's
//! linear chain.
//!
//! Two stages, mirroring `raw_core::stages::noise_reduction`:
//! 1. [`NlmLumaPass`] / [`NlmColorPass`] — the GPU-resident stages. Each carries
//!    only its slider amount; drives the shift loop inside `encode`.
//! 2. The headless parity tests (`noise_reduction/tests.rs`) — gated DIRECTLY vs
//!    the real `raw_core::stages::noise_reduction::{apply_luminance,apply_color}`
//!    `< 1e-4`, PLUS a plane-level gate vs `raw_core::stages::nlm::denoise_plane`
//!    (which isolates the NLM math from the Oklab round-trip).
//!
//! Unlike clarity (which ships a small local CPU oracle), NLM has NO non-test CPU
//! oracle: porting `denoise_plane` + the full Oklab round-trip into this crate
//! would duplicate hundreds of lines for no runtime caller. The parity gate runs
//! GPU-vs-the-real-raw-core directly via the test-only `raw-core` dev-dep.
//!
//! ## NLM = non-local means (Buades/Coll/Morel 2005; Darbon 2008 fast variant)
//!
//! `out(p) = (1/Z) · Σ_{q ∈ search}  w(p,q) · I(q)`, where
//! `w(p,q) = exp(-‖patch(p) - patch(q)‖² / (h²·patch_area))` and the centre pixel
//! `q = p` is added at the end with weight = running max weight (self-similarity
//! correction). raw-core computes the patch-SSD with a per-shift separable
//! sliding box-sum (#1195; it previously used a per-shift integral image);
//! either way the patch SSD is a sum of `(I(q) - I(q+d))²` over the (2P+1)²
//! patch. We recompute that sum DIRECTLY in registers (see
//! `noise_reduction.wgsl`) — a materialised-intermediate accumulate would need
//! a 5th storage buffer, over the `downlevel_defaults()` 4-storage cap. The
//! direct register sum matches raw-core's local box-sum to the f32 floor
//! (plane-parity max abs diff ~5e-8). Correctness-only; perf is P4.
//!
//! ## Per-pixel noise-profile modulation (#1714)
//!
//! When the DNG carries a NoiseProfile, raw-core filters each pixel with its OWN
//! `h` and search radius, derived from that pixel's Oklab L (shot noise grows
//! with signal). The GPU used to push one `inv_norm` scalar per dispatch, so the
//! two paths denoised differently on any frame that isn't uniformly bright. The
//! per-pixel `scale` rides in the SECOND LANE of the `max_w` accumulator (widened
//! to `vec2<f32>`), which keeps the accumulate kernel at four storage bindings —
//! see `noise_reduction.wgsl`'s header for the full argument. [`NoiseModulation`]
//! carries the two profile coefficients from the host to the prepare kernel.
//!
//! ## Buffer budget (every kernel ≤ 4 storage)
//!
//! - extract: RGBA-src + plane-out (2).
//! - prepare: L-plane + (max_w, scale) packed plane (2).
//! - accumulate (per shift): plane + acc + wsum + (max_w, scale) (4).
//! - finalize: plane + acc(rw, becomes the denoised plane) + wsum + (max_w, scale) (4).
//! - writeback luma: src + denoised-L + dst (3); color: src + a + b + dst (4).

use crate::chain::Pass;
use crate::context::GpuContext;
use crate::spatial::{alloc_plane, alloc_plane_vec2, encode_simple};

// ── Parameters at amount = 100, mirroring raw_core::stages::noise_reduction ────
//
// These MUST match raw-core's constants exactly — the slider→params map is the
// parity contract for the strength `h`, the patch radius, and the search radius.
// (raw-core: `LUMA_PATCH_RADIUS` … `CHROMA_H_MAX` in `stages::noise_reduction`.)
const LUMA_PATCH_RADIUS: usize = 2;
const LUMA_SEARCH_RADIUS: usize = 2;
const LUMA_H_MAX: f32 = 0.04;
const CHROMA_PATCH_RADIUS: usize = 2;
const CHROMA_SEARCH_RADIUS: usize = 3;
const CHROMA_H_MAX: f32 = 0.05;

/// NLM parameters for one plane — the raw-gpu mirror of
/// `raw_core::stages::nlm::NlmParams` (kept local so the non-test module carries
/// no `raw-core` dependency; the test gates against the real raw-core type).
/// `pub(crate)` so the parity test can drive [`encode_nlm_on_plane`] directly.
#[derive(Clone, Copy)]
pub(crate) struct NlmParams {
    patch_radius: usize,
    search_radius: usize,
    h: f32,
}

/// Luma NLM params for a slider `amount` — line-faithful to
/// `raw_core::stages::noise_reduction::luma_params` (private there).
fn luma_params(amount: f32) -> NlmParams {
    let t = (amount / 100.0).clamp(0.0, 1.0);
    NlmParams {
        patch_radius: LUMA_PATCH_RADIUS,
        search_radius: LUMA_SEARCH_RADIUS,
        h: t * LUMA_H_MAX,
    }
}

/// Chroma NLM params for a slider `amount` — line-faithful to
/// `raw_core::stages::noise_reduction::chroma_params` (private there).
fn chroma_params(amount: f32) -> NlmParams {
    let t = (amount / 100.0).clamp(0.0, 1.0);
    NlmParams {
        patch_radius: CHROMA_PATCH_RADIUS,
        search_radius: CHROMA_SEARCH_RADIUS,
        h: t * CHROMA_H_MAX,
    }
}

// ── Noise-profile modulation (#1714) ──────────────────────────────────────────

/// The two DNG-NoiseProfile coefficients the per-pixel modulation needs, plus
/// whether it engages at all. Line-faithful to
/// `raw_core::stages::nlm::get_noise_params` — kept local for the same reason
/// [`NlmParams`] is (the non-test module carries no `raw-core` dependency); the
/// plane-level parity test gates the whole derivation end-to-end against the real
/// `denoise_plane`, so a drift here shows up as a failing gate, not silently.
#[derive(Clone, Copy, Default)]
pub(crate) struct NoiseModulation {
    s_coeff: f32,
    o_coeff: f32,
    /// `noise_profile.is_some()` — matching raw-core's `use_dynamic`. Note this
    /// is TRUE even at `iso == 0` (where both coefficients are zero and every
    /// pixel lands on the `scale = 0.1` clamp), because that is what raw-core
    /// does.
    dynamic: bool,
}

impl NoiseModulation {
    /// Mirror of `raw_core::stages::nlm::get_noise_params` + its `use_dynamic`
    /// flag. `is_chroma` selects the a/b channel combination (mean of the R and B
    /// coefficients) over the luma one (BT.2020-weighted). A `None` profile is
    /// the FLAT filter — `scale ≡ 1`, i.e. the classic constant-`h`, full-`S`
    /// NLM, bit-identical to the pre-#1714 GPU behaviour.
    pub(crate) fn from_profile(profile: Option<&[f32]>, iso: u32, is_chroma: bool) -> Self {
        let dynamic = profile.is_some();
        let (s_coeff, o_coeff) = noise_params(profile, iso, is_chroma);
        Self {
            s_coeff,
            o_coeff,
            dynamic,
        }
    }
}

/// `(slope, offset)` for the per-pixel variance model `var = slope·L + offset`.
/// Line-faithful to `raw_core::stages::nlm::get_noise_params`.
fn noise_params(profile: Option<&[f32]>, iso: u32, is_chroma: bool) -> (f32, f32) {
    if iso == 0 {
        return (0.0, 0.0);
    }
    let Some(prof) = profile else {
        return fallback_noise_params(iso);
    };
    if prof.len() >= 6 {
        let (sr, or, sg, og, sb, ob) = if prof.len() >= 8 {
            let sg = 0.5 * (prof[2] + prof[4]);
            let og = 0.5 * (prof[3] + prof[5]);
            (prof[0], prof[1], sg, og, prof[6], prof[7])
        } else {
            (prof[0], prof[1], prof[2], prof[3], prof[4], prof[5])
        };
        if is_chroma {
            (0.5 * (sr + sb), 0.5 * (or + ob))
        } else {
            let s_luma = 0.2627 * sr + 0.6780 * sg + 0.0593 * sb;
            let o_luma = 0.2627 * 0.2627 * or + 0.6780 * 0.6780 * og + 0.0593 * 0.0593 * ob;
            (s_luma, o_luma)
        }
    } else if prof.len() >= 2 {
        (prof[0], prof[1])
    } else {
        fallback_noise_params(iso)
    }
}

/// ISO-only fallback when the DNG carries no usable profile row — mirror of
/// `raw_core::stages::nlm::fallback_noise_params`.
fn fallback_noise_params(iso: u32) -> (f32, f32) {
    let ratio = iso as f32 / 100.0;
    (0.00002 * ratio, 0.000002 * ratio * ratio)
}

/// The passes carry the profile as a `Vec<f32>` (a C-FFI / WASM caller has no
/// `Option`), so EMPTY is the "no profile" encoding — it maps to raw-core's
/// `None`, i.e. the flat filter. A decoder that found a NoiseProfile always
/// yields at least one `(slope, offset)` pair, so no real profile is lost here.
fn profile_slice(profile: &[f32]) -> Option<&[f32]> {
    (!profile.is_empty()).then_some(profile)
}

// ── `repr(C)` uniforms for the WGSL kernels ───────────────────────────────────

/// `extract_channel` uniform: pixel count + the Oklab channel (0=L, 1=a, 2=b).
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct ExtractParams {
    count: u32,
    channel: u32,
    _pad0: u32,
    _pad1: u32,
}

/// `prepare_scale` uniform: pixel count, the modulation flag, and the two
/// noise-profile coefficients. 16 bytes.
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct PrepareParams {
    count: u32,
    dynamic: u32,
    s_coeff: f32,
    o_coeff: f32,
}

/// `accumulate_shift` uniform: dims, patch radius, the UNMODULATED strength `h`
/// (the kernel scales it per pixel), the shift, the CPU-computed valid pixel
/// range, and the search radius the per-pixel `local_s` clamps to. 48 bytes
/// (multiple of 16).
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct AccumParams {
    width: u32,
    height: u32,
    p: i32,
    h: f32,
    dx: i32,
    dy: i32,
    x_lo: i32,
    x_hi: i32,
    y_lo: i32,
    y_hi: i32,
    s: i32,
    _pad0: u32,
}

/// `finalize` / `writeback_*` uniform: just the pixel count.
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct CountParams {
    count: u32,
    _pad0: u32,
    _pad1: u32,
    _pad2: u32,
}

// ── The shared shift-loop encoder (denoise ONE plane on the GPU) ───────────────

/// Channel selector for [`encode_denoise_plane`] — which Oklab channel the
/// extract kernel pulls and the writeback kernel later restores.
#[derive(Clone, Copy)]
enum Channel {
    L = 0,
    A = 1,
    B = 2,
}

/// Extract one Oklab channel from `src` into a fresh scratch plane. The entry
/// both NR passes share; the L plane it produces for luma doubles as the
/// modulation guide, and the color pass extracts L separately for the same role.
fn encode_extract_channel(
    ctx: &GpuContext,
    encoder: &mut wgpu::CommandEncoder,
    src: &wgpu::Buffer,
    width: u32,
    height: u32,
    channel: Channel,
    label: &str,
) -> crate::spatial::Plane {
    let count = width * height;
    let plane = alloc_plane(ctx, width, height, label);
    let ex_params = ExtractParams {
        count,
        channel: channel as u32,
        _pad0: 0,
        _pad1: 0,
    };
    encode_simple(
        ctx,
        encoder,
        ctx.nr_extract_pipeline(),
        bytemuck::bytes_of(&ex_params),
        &[src, &plane],
        count,
        "nr-extract",
    );
    plane
}

/// The NLM core on an ALREADY-EXTRACTED scalar plane (mirrors
/// `raw_core::stages::nlm::denoise_plane`): build the per-pixel modulation plane,
/// zero the accumulators, run the shift loop, finalize. Returns the buffer
/// holding the denoised plane (the `acc` plane, written in place by `finalize`).
/// `pub(crate)` so the parity test can gate this in ISOLATION against
/// `denoise_plane` — no Oklab round-trip — which separates the two independent
/// error sources (NLM math vs the color transform).
///
/// `l_plane` is the Oklab L plane the modulation reads (raw-core's `l_plane`
/// argument): the plane ITSELF for luma NR, the separately-extracted L for the
/// chroma planes. It is unread when `modulation` is [`NoiseModulation::flat`],
/// but still bound — the kernel takes one path, not two.
pub(crate) fn encode_nlm_on_plane(
    ctx: &GpuContext,
    encoder: &mut wgpu::CommandEncoder,
    plane: &wgpu::Buffer,
    l_plane: &wgpu::Buffer,
    width: u32,
    height: u32,
    params: NlmParams,
    modulation: NoiseModulation,
) -> crate::spatial::Plane {
    let count = width * height;

    // Accumulators, zeroed (raw-core's `vec![0.0; n]`). `max_w` is the `.x` lane
    // of the packed (max_w, scale) plane, which `prepare_scale` writes in full —
    // so it needs no clear of its own.
    let acc = alloc_plane(ctx, width, height, "nr-acc");
    let wsum = alloc_plane(ctx, width, height, "nr-wsum");
    let max_w_scale = alloc_plane_vec2(ctx, width, height, "nr-max-w-scale");
    encoder.clear_buffer(&acc, 0, None);
    encoder.clear_buffer(&wsum, 0, None);

    // Per-pixel modulation plane: `scale` from the L plane (or ≡ 1 when flat).
    let pr_params = PrepareParams {
        count,
        dynamic: u32::from(modulation.dynamic),
        s_coeff: modulation.s_coeff,
        o_coeff: modulation.o_coeff,
    };
    encode_simple(
        ctx,
        encoder,
        ctx.nr_prepare_pipeline(),
        bytemuck::bytes_of(&pr_params),
        &[l_plane, &max_w_scale],
        count,
        "nr-prepare-scale",
    );

    // Shift loop. dx, dy ∈ [-s, s]², skipping (0, 0) and any shift whose valid
    // pixel range is empty — both mirror raw-core's `process_shift` (the centre
    // is added in `finalize`, empty ranges early-return there). The per-pixel
    // `local_s` gate lives in the kernel: a shift outside a pixel's own radius is
    // still dispatched, that pixel just returns early (raw-core's `continue`).
    let p = params.patch_radius as i32;
    let s = params.search_radius as i32;
    let wi = width as i32;
    let hi = height as i32;

    for dy in -s..=s {
        for dx in -s..=s {
            if dx == 0 && dy == 0 {
                continue;
            }
            // Valid range: patch at p AND patch at p+d must fit (raw-core's isize
            // max/min). Empty range → skip the dispatch (raw-core early-returns).
            let x_lo = p.max(p - dx);
            let x_hi = (wi - 1 - p).min(wi - 1 - dx - p);
            let y_lo = p.max(p - dy);
            let y_hi = (hi - 1 - p).min(hi - 1 - dy - p);
            if x_lo > x_hi || y_lo > y_hi {
                continue;
            }
            let ac_params = AccumParams {
                width,
                height,
                p,
                h: params.h,
                dx,
                dy,
                x_lo,
                x_hi,
                y_lo,
                y_hi,
                s,
                _pad0: 0,
            };
            encode_simple(
                ctx,
                encoder,
                ctx.nr_accumulate_pipeline(),
                bytemuck::bytes_of(&ac_params),
                &[plane, &acc, &wsum, &max_w_scale],
                count,
                "nr-accumulate-shift",
            );
        }
    }

    // Finalize: out = (acc + mw·plane) / (wsum + mw), written in place to acc.
    let fin_params = CountParams {
        count,
        _pad0: 0,
        _pad1: 0,
        _pad2: 0,
    };
    encode_simple(
        ctx,
        encoder,
        ctx.nr_finalize_pipeline(),
        bytemuck::bytes_of(&fin_params),
        &[plane, &acc, &wsum, &max_w_scale],
        count,
        "nr-finalize",
    );

    acc
}

/// A GPU-resident luminance-NR stage. Carries its `nr_luminance` slider value
/// ([0, 100]) plus the frame's DNG NoiseProfile + ISO; device, pipelines, and
/// scratch planes come from the [`GpuContext`] / spatial substrate at encode
/// time. NLM-denoises the Oklab L channel, leaves a/b untouched. Mirrors
/// `raw_core::stages::noise_reduction::apply_luminance`.
pub struct NlmLumaPass {
    pub nr_luminance: f32,
    /// The DNG NoiseProfile row(s) from `RawImage::noise_profile`, empty when the
    /// file carries none. Drives the per-pixel modulation (#1714); empty means
    /// the classic constant-`h` filter, matching raw-core at `noise_profile:
    /// None`.
    pub noise_profile: Vec<f32>,
    /// `RawImage::iso`. Zero is raw-core's "unknown ISO" sentinel and zeroes both
    /// profile coefficients.
    pub iso: u32,
}

impl Pass for NlmLumaPass {
    fn encode(
        &self,
        ctx: &GpuContext,
        encoder: &mut wgpu::CommandEncoder,
        src: &wgpu::Buffer,
        dst: &wgpu::Buffer,
        dims: (u32, u32),
    ) {
        let (width, height) = dims;
        let params = luma_params(self.nr_luminance);
        // |amount| < 1e-3 (or h <= 0 / search_radius == 0) is identity in
        // raw-core — copy src → dst and bail so the ping-pong threads it through.
        if self.nr_luminance.abs() < 1e-3 || params.h <= 0.0 || params.search_radius == 0 {
            copy_through(encoder, src, dst, width, height);
            return;
        }
        // Luma NR denoises the L plane, and the modulation guide IS that plane —
        // raw-core passes `&l_plane` for both arguments here.
        let l = encode_extract_channel(ctx, encoder, src, width, height, Channel::L, "nr-plane-l");
        let denoised_l = encode_nlm_on_plane(
            ctx,
            encoder,
            l.as_ref(),
            l.as_ref(),
            width,
            height,
            params,
            NoiseModulation::from_profile(profile_slice(&self.noise_profile), self.iso, false),
        );
        let count = width * height;
        let wb_params = CountParams {
            count,
            _pad0: 0,
            _pad1: 0,
            _pad2: 0,
        };
        encode_simple(
            ctx,
            encoder,
            ctx.nr_writeback_luma_pipeline(),
            bytemuck::bytes_of(&wb_params),
            &[src, &denoised_l, dst],
            count,
            "nr-writeback-luma",
        );
    }
}

/// A GPU-resident color-NR stage. Carries its `nr_color` slider value ([0, 100])
/// plus the frame's DNG NoiseProfile + ISO. NLM-denoises the Oklab a and b
/// channels with a wider search window than luma, leaves L untouched. Mirrors
/// `raw_core::stages::noise_reduction::apply_color`.
pub struct NlmColorPass {
    pub nr_color: f32,
    /// See [`NlmLumaPass::noise_profile`]. The chroma planes take the a/b
    /// coefficient combination (`is_chroma`), not the luma one.
    pub noise_profile: Vec<f32>,
    pub iso: u32,
}

impl Pass for NlmColorPass {
    fn encode(
        &self,
        ctx: &GpuContext,
        encoder: &mut wgpu::CommandEncoder,
        src: &wgpu::Buffer,
        dst: &wgpu::Buffer,
        dims: (u32, u32),
    ) {
        let (width, height) = dims;
        let params = chroma_params(self.nr_color);
        if self.nr_color.abs() < 1e-3 || params.h <= 0.0 || params.search_radius == 0 {
            copy_through(encoder, src, dst, width, height);
            return;
        }
        // Denoise a and b independently (raw-core runs them as two
        // `denoise_plane` calls); then a single writeback restores both. Both
        // read the SAME L plane as their modulation guide — chroma noise is
        // modelled off luminance, exactly as raw-core hands `&l_plane` to both
        // chroma calls — so L is extracted once here.
        let l = encode_extract_channel(ctx, encoder, src, width, height, Channel::L, "nr-plane-l");
        let modulation =
            NoiseModulation::from_profile(profile_slice(&self.noise_profile), self.iso, true);
        let a = encode_extract_channel(ctx, encoder, src, width, height, Channel::A, "nr-plane-a");
        let denoised_a = encode_nlm_on_plane(
            ctx,
            encoder,
            a.as_ref(),
            l.as_ref(),
            width,
            height,
            params,
            modulation,
        );
        let b = encode_extract_channel(ctx, encoder, src, width, height, Channel::B, "nr-plane-b");
        let denoised_b = encode_nlm_on_plane(
            ctx,
            encoder,
            b.as_ref(),
            l.as_ref(),
            width,
            height,
            params,
            modulation,
        );
        let count = width * height;
        let wb_params = CountParams {
            count,
            _pad0: 0,
            _pad1: 0,
            _pad2: 0,
        };
        encode_simple(
            ctx,
            encoder,
            ctx.nr_writeback_color_pipeline(),
            bytemuck::bytes_of(&wb_params),
            &[src, &denoised_a, &denoised_b, dst],
            count,
            "nr-writeback-color",
        );
    }
}

/// Copy `src` → `dst` (the identity short-circuit shared by both passes, so the
/// chain's ping-pong still threads the unchanged image through).
fn copy_through(
    encoder: &mut wgpu::CommandEncoder,
    src: &wgpu::Buffer,
    dst: &wgpu::Buffer,
    width: u32,
    height: u32,
) {
    let byte_len = (width as u64) * (height as u64) * 4 * std::mem::size_of::<f32>() as u64;
    encoder.copy_buffer_to_buffer(src, 0, dst, 0, byte_len);
}

// Parity tests live in a sibling file to keep this module under the 600-LOC
// budget (mirrors clarity / dehaze's tests.rs split). Native test builds only.
#[cfg(all(test, not(target_arch = "wasm32")))]
#[path = "noise_reduction/tests.rs"]
mod tests;

// The PER-PIXEL noise-profile modulation gates (#1714) split further into their
// own sibling — same 600-LOC budget reason, and they are the gate the flat
// `tests.rs` cases are structurally unable to be.
#[cfg(all(test, not(target_arch = "wasm32")))]
#[path = "noise_reduction/tests_profile.rs"]
mod tests_profile;
