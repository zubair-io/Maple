//! GPU non-local-means denoising in Oklab space (#991, #1714, #3363).
//!
//! The luma and color passes mirror raw-core's noise-reduction stages. Their
//! plane and full-stage CPU oracle gates cover flat and DNG-profile-modulated
//! noise, border handling, strength, and the Oklab round-trip (max error 1e-4).
//!
//! One workgroup loads an 8×8 source tile plus the patch/search halo once.
//! Each pixel evaluates shifts in the CPU's order with register accumulators,
//! preserving patch validity, profile modulation and max-weight center correction.
//! The plane filter uses four storage bindings (source, L guide, output, exp LUT) and
//! eliminates per-shift dispatch barriers and full-plane accumulator traffic.
//! Completion timing includes GPU execution and readback in noise_reduction/bench.rs.

use crate::chain::Pass;
use crate::context::GpuContext;
use crate::spatial::prepare_simple_dispatch;
use crate::spatial::{alloc_plane, encode_simple, pool_data_storage};

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

/// Same 513 grid endpoints as raw-core's `fast_exp_table`. The immutable 2KB
/// table is generated once per process, then retained by the GPU content cache;
/// each weight needs two lookup reads instead of two GPU exponentials.
fn fast_exp_table() -> &'static [f32; 513] {
    static TABLE: std::sync::OnceLock<[f32; 513]> = std::sync::OnceLock::new();
    TABLE.get_or_init(|| std::array::from_fn(|i| (-(i as f32 * 8.0 / 512.0)).exp()))
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

/// Fused plane-filter uniform. Radius ceilings are checked before dispatch so
/// the shader's fixed workgroup halo always contains both patches. 32 bytes.
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct PlaneParams {
    width: u32,
    height: u32,
    p: i32,
    s: i32,
    h: f32,
    dynamic: u32,
    s_coeff: f32,
    o_coeff: f32,
}

/// `writeback_*` uniform: just the pixel count.
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct CountParams {
    count: u32,
    _pad0: u32,
    _pad1: u32,
    _pad2: u32,
}

// ── Tiled plane filter and Oklab adapter ──────────────────────────────────────

/// Channel selector for extraction — which Oklab channel the
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

/// Denoise an extracted scalar plane in one tiled GPU dispatch. `l_plane` is
/// raw-core's Oklab L modulation guide (the source itself for luma). Flat noise
/// never samples the guide, but a valid binding is still required. Exposed to
/// the independent CPU oracle tests to separate NLM math from Oklab conversion.
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
    assert!(params.patch_radius == 2 && params.search_radius <= 3);
    let output = alloc_plane(ctx, width, height, "nr-denoised");
    let uniform = PlaneParams {
        width,
        height,
        p: params.patch_radius as i32,
        s: params.search_radius as i32,
        h: params.h,
        dynamic: u32::from(modulation.dynamic),
        s_coeff: modulation.s_coeff,
        o_coeff: modulation.o_coeff,
    };
    let exp_lut = pool_data_storage(ctx, bytemuck::cast_slice(fast_exp_table()), "nr-exp-lut");
    let pipeline = ctx.nr_denoise_pipeline();
    let resources = prepare_simple_dispatch(
        ctx,
        pipeline,
        bytemuck::bytes_of(&uniform),
        &[plane, l_plane, &output, &exp_lut],
        "nr-denoise-plane",
    );
    let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
        label: Some("nr-denoise-plane"),
        timestamp_writes: None,
    });
    pass.set_pipeline(pipeline);
    pass.set_bind_group(0, resources.bind_group.as_ref(), &[]);
    pass.dispatch_workgroups(width.div_ceil(8), height.div_ceil(8), 1);
    drop(pass);
    output
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
        // chroma calls — so L is extracted ONCE, and only when a profile is
        // present: without one the fused plane kernel uses `scale ≡ 1` without
        // reading the guide, so extracting L would be a wasted full-plane
        // dispatch on every profile-less render. The a plane stands in as the
        // (unread) binding there. A frame's profile is fixed for the session, so
        // the two shapes never alternate under one pooled chain signature.
        let modulation =
            NoiseModulation::from_profile(profile_slice(&self.noise_profile), self.iso, true);
        let l = modulation
            .dynamic
            .then(|| encode_extract_channel(ctx, encoder, src, width, height, Channel::L, "nr-l"));
        let a = encode_extract_channel(ctx, encoder, src, width, height, Channel::A, "nr-plane-a");
        let guide = l.as_ref().unwrap_or(&a);
        let denoised_a = encode_nlm_on_plane(
            ctx,
            encoder,
            a.as_ref(),
            guide.as_ref(),
            width,
            height,
            params,
            modulation,
        );
        let b = encode_extract_channel(ctx, encoder, src, width, height, Channel::B, "nr-plane-b");
        let guide = l.as_ref().unwrap_or(&b);
        let denoised_b = encode_nlm_on_plane(
            ctx,
            encoder,
            b.as_ref(),
            guide.as_ref(),
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

#[cfg(all(test, not(target_arch = "wasm32")))]
#[path = "noise_reduction/bench.rs"]
mod bench;

// The PER-PIXEL noise-profile modulation gates (#1714) split further into their
// own sibling — same 600-LOC budget reason, and they are the gate the flat
// `tests.rs` cases are structurally unable to be.
#[cfg(all(test, not(target_arch = "wasm32")))]
#[path = "noise_reduction/tests_profile.rs"]
mod tests_profile;
