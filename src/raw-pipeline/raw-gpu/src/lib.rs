//! `raw-gpu` — Maple's headless GPU resource core (epic #925, P1a / #987).
//!
//! Turns P0's one-shot exposure kernel into a reusable GPU-resident substrate:
//!
//! - [`GpuContext`] — device/queue handle + lazily-cached compute pipelines.
//! - [`GpuImage`] — a scene-linear RGBA f32 image uploaded to the GPU **once**
//!   and reused for preview and full-res renders.
//! - [`Pass`] + [`ChainRunner`] — run an ordered list of passes by ping-ponging
//!   two scratch buffers, with **zero inter-pass CPU readback** (exactly one
//!   readback for the whole chain) and cooperative [`CancelToken`] cancellation.
//! - [`ExposurePass`] + [`apply_exposure_gain`] — the exposure stage and its CPU
//!   oracle; the N-pass exposure chain is the headless parity proof.
//! - [`VibrancePass`] + [`apply_vibrance`] — the P2 scene-linear template stage
//!   (epic #925 / #990): the first GPU kernel to round a pixel through Oklab, so
//!   it establishes the matrix + sign-preserving-cbrt primitives the remaining
//!   scene-linear stages fan out from. Its color matrices come from a generated
//!   WGSL module (`generated/color_matrices.wgsl`), single-sourced from the same
//!   `raw-core` constants the CPU pipeline uses.
//! - [`SaturationPass`] + [`apply_saturation`] — a P2 scene-linear stage (#990),
//!   the trickier Oklab sibling of vibrance: a uniform chroma scale plus, at
//!   positive saturation, a 24-iteration gamut-hull **bisection** with a Reinhard
//!   soft-knee that pulls out-of-gamut pixels back along the same Oklab hue line.
//!   Reuses the generated color matrices; the gamut constants are inlined in the
//!   kernel. Parity-gated directly vs `raw_core::stages::saturation::apply`.
//! - [`WhiteBalancePass`] + [`apply_white_balance`] — a P2 scene-linear stage
//!   (#990). The WB derivation (CAT16 / diagonal) runs CPU-side once into a 3×3
//!   matrix; the kernel is a pure per-pixel matmul of that matrix (uploaded as
//!   vec4 rows to dodge WGSL's column-major `mat3x3`). Parity-gated directly vs
//!   `raw_core::stages::white_balance::apply`.
//! - [`SceneToneControlsPass`] + [`apply_scene_tone_controls`] — a P2
//!   scene-linear stage (#990): the five luma-coupled tone steps (exposure /
//!   highlights / shadows / whites / blacks), applied sequentially with luma
//!   recomputed from the running pixel at each step. No Oklab, so no generated
//!   color matrices. Parity-gated directly vs
//!   `raw_core::stages::scene_tone_controls::apply`.
//! - [`DisplayEncodePass`] + [`apply_display_encode`] — a P2 view-transform
//!   stage (#990): Rec.2020 → sRGB matrix + hue-preserving Oklab gamut
//!   compression (the f32 → f32 display-encode step, NOT gamma/quantize). Reuses
//!   the generated color matrices (sRGB-only Oklab pair) + the 24-iter bisection.
//!   Parity-gated directly vs `raw_core::view::encode::rec2020_to_srgb`.
//! - [`SrgbGammaPass`] + [`apply_srgb_gamma`] — a P4a view-tail stage (#992-pre):
//!   the per-channel IEC 61966-2-1 sRGB gamma/OETF encode
//!   (`raw_core::view::encode::srgb_gamma_encode`). Clamp-to-`[0,1]`-then-
//!   piecewise; pure per-channel (no Oklab), so it compiles standalone (no
//!   generated matrices) like exposure / scene_tone_controls. Closes the view
//!   tail's transfer gap — it runs between [`DisplayEncodePass`] and
//!   [`AutoProfileCurvePass`] (the curve + residual LUT were fit in gamma space).
//!   Parity-gated directly vs `raw_core::view::encode::srgb_gamma_encode` < 1e-4,
//!   covering the negative-clamp, high-clamp (> 1), linear toe, knee, and power
//!   branch.
//! - [`AutoProfileCurvePass`] + [`apply_auto_profile_curve`] — a P2 view-transform
//!   stage (#990): the per-pixel fitted Auto Profile tone CURVE (`compress_input`
//!   soft-knee + a 32-anchor per-channel piecewise-linear curve + an optional 3×3
//!   matrix + Oklab chroma/offset/band corrections), NOT the residual 3D LUT. The
//!   whole per-image curve rides a flat-f32 STORAGE buffer; the matrix/Oklab skip
//!   flags are computed in-crate (replicating apply.rs's predicates) so the Pass
//!   gates itself with no raw-core dep. Parity-gated directly vs
//!   `raw_core::view::auto_profile::apply::apply_curve`.
//! - [`AgxPass`] + [`apply_agx`] — a P2 view-transform stage (#990): the AgX
//!   chain (inset matrix -> ratio-preserving sigmoid -> outset matrix -> Oklab
//!   hue-preserving gamut compression, the full post-#435 transform). The
//!   sigmoid is evaluated by sampling the SAME baked 512-entry LUT
//!   (`agx_lut.bin`) raw-core's `sample_lut` reads — uploaded to a storage
//!   buffer — so the GPU stays on raw-core's exact numerical path. Reuses the
//!   generated color matrices (the Oklab round-trip) + the generated AgX coeffs
//!   (inset/outset + scalars). Parity-gated directly vs
//!   `raw_core::view::agx::apply`.
//! - [`ResidualLutPass`] + [`apply_residual_lut`] — a P2 view-transform stage
//!   (#990): the per-image residual 3D LUT (#924) layered onto the Auto Profile
//!   cube, applied by **trilinear** interpolation. The grid is per-image RUNTIME
//!   data (fitted from the embedded JPEG, NOT a codegen constant), uploaded to a
//!   storage buffer per pass — the canonical "runtime 3D LUT in storage +
//!   trilinear sample" pattern (distinct from the tone-curve / WB / auto_profile
//!   family, which upload CPU-derived per-image *coefficients*). Pure lookup, so
//!   no generated color matrices. Parity-gated directly vs
//!   `raw_core::view::auto_profile::lut::ColorLut::apply`.
//! - [`ToneCurvesPass`] + [`apply_tone_curves`] — a P2 scene-linear stage (#990):
//!   the user-authored parametric region sliders + per-channel point curves
//!   (luma / R / G / B), applied in scene-linear Rec.2020. The runtime data is
//!   the PREPARED curves (sorted/clamped knots + Fritsch-Carlson tangents),
//!   derived CPU-side per curve and uploaded to a storage buffer — the
//!   white_balance / auto_profile "CPU-derived per-image coefficients" family
//!   (distinct from the residual LUT's sampled-grid shape). One kernel runs the
//!   whole sequenced apply (parametric -> luma -> per-channel, dispatched on the
//!   PerChannel / RatioPreserving mode); luma coupling uses the inlined Rec.2020
//!   weights, so no generated color matrices. Parity-gated directly vs
//!   `raw_core::stages::tone_curves::apply`.
//! - [`ClarityPass`] + [`apply_clarity`] — the first SPATIAL stage (epic #925 P2
//!   wave 3b / #990): luminance-preserving local-contrast enhancement via a
//!   self-guided **guided filter** (He, Sun, Tang 2010) at the structure scale
//!   (radius 20). NOT a per-pixel kernel — it reads pixel NEIGHBORHOODS, so it is
//!   a small DAG (several separable box blurs over intermediate planes + a
//!   multi-input recombine). It stays ONE [`Pass`] and orchestrates the DAG over
//!   scratch buffers via the [`spatial`] substrate. Parity-gated directly vs
//!   `raw_core::stages::clarity::apply` (incl. the shrinking-window box-blur
//!   border policy). The reusable spatial primitives ([`box_blur_encode`],
//!   [`guided_filter_self_encode`], [`alloc_plane`], [`encode_simple`]) are public
//!   so dehaze + the P3 spatial filters build on them.
//! - [`TexturePass`] + [`apply_texture`] — a P2 wave-3b SPATIAL stage (#990).
//!   Texture IS clarity at a different scale: `raw_core::stages::texture::apply`
//!   is clarity's body with the guided-filter radius changed from 20 to 2
//!   (fine-detail scale), so it reuses the WHOLE spatial pipeline
//!   ([`clarity_texture_encode`]) and the shared CPU oracle — only the radius
//!   constant differs. Parity-gated directly vs `raw_core::stages::texture::apply`.
//! - [`DehazePass`] + [`apply_dehaze`] — the LAST P2 stage and the hardest
//!   SPATIAL one (#990), completing the scene-linear chain on the GPU. A
//!   dark-channel-prior haze removal: a 15×15 window MIN (dark channel +
//!   transmission, CLAMP-TO-EDGE borders — a distinct policy from the box blur's
//!   shrinking window, so its own 2D min kernel), a GENERAL guided-filter
//!   transmission refine (guide=luma != p=t, so the four pre-blur means are
//!   PACKED into vec2 planes to fit the 4-storage cap), a smoothstep sky mask
//!   (issue #272), and a multi-input recovery `J=(I-A)/t_eff+A`. The GLOBAL
//!   atmospheric-light reduction (mean of orig at the top-0.1% dark-channel
//!   positions) runs CPU-side ([`compute_airlight`], byte-exact vs raw-core) and
//!   rides a uniform — the clean headless-parity path for a global reduction.
//!   Parity-gated directly vs `raw_core::stages::dehaze::apply`.
//! - [`NlmLumaPass`] / [`NlmColorPass`] — the first P3 SPATIAL stages (epic #925
//!   P3 wave 1 / #991): fast non-local-means denoising in Oklab space (luma on
//!   the L plane, color on the a/b planes with a wider search window). Unlike the
//!   guided-filter / dehaze DAGs, NLM's outer loop is over SHIFTS — each offset in
//!   the search window contributes a patch-similarity-weighted sample to a running
//!   accumulator — so it stays ONE [`Pass`] and orchestrates a per-shift dispatch
//!   loop over scratch planes. The (2P+1)² patch-SSD is recomputed DIRECTLY in the
//!   accumulate kernel (NOT via a materialised box-sum/integral plane — raw-core
//!   uses a per-shift separable sliding box-sum since #1195), because binding such
//!   a plane would need a 5th storage buffer — over the `downlevel_defaults()`
//!   4-storage cap; the direct sum is the same set of local terms (~5e-8 delta vs
//!   raw-core's box-sum). The `fast_neg_exp` LUT weight is reproduced as
//!   `lerp(exp(-x_i), exp(-x_{i+1}), frac)` on the grid it snaps to, so the GPU
//!   matches raw-core's table-interpolated weight (not raw `exp`). Parity-gated
//!   directly vs `raw_core::stages::noise_reduction::{apply_luminance,apply_color}`,
//!   plus a plane-level gate vs `raw_core::stages::nlm::denoise_plane` that
//!   isolates the NLM math from the Oklab round-trip.
//! - [`SharpenPass`] — a P3 wave-2 SPATIAL stage (#991): luminance-only
//!   unsharp-mask sharpening (`raw_core::stages::sharpen::apply`). A short linear
//!   sub-pass chain — extract luma → blur it (raw-core's
//!   `gaussian_blur_plane_sigma` = a TRUE separable Gaussian at the float PSF
//!   sigma, H+V sweeps of the shared `gaussian_blur` WGSL entry; #1083 replaced
//!   the box-blur cascade whose integer radius made the Radius slider a no-op) →
//!   per-pixel USM scale (shadow-guard smoothstep + scale clamp, luma-only so
//!   chroma ratios survive) → an edge-aware amount/masking blend (a
//!   central-difference luma gradient with clamp-to-edge borders). Stays ONE
//!   [`Pass`]; every kernel ≤ 4 storage. Parity-gated directly vs
//!   `raw_core::stages::sharpen::apply`, covering masking-off AND masking-on (the
//!   gradient branch), amount past 100, distinct radii, and a step-edge fixture
//!   (so the USM is non-vacuous — a smooth ramp is a near-fixed-point).
//! - [`CaptureSharpeningPass`] — the LAST P3 stage (#991) and the only ITERATIVE
//!   one: Richardson–Lucy deconvolution against a true Gaussian PSF, on a Rec.709
//!   luma plane (`raw_core::stages::capture_sharpening::apply_capture_sharpening`).
//!   Stays ONE [`Pass`] but its core is a fixed-point iteration — N rounds of
//!   `estimate *= blur(original / blur(estimate))` — encoded as a per-iteration
//!   DISPATCH loop over scratch planes (the NLM shift-loop precedent), all in one
//!   command encoder. The PSF is a windowed/renormalized Gaussian (`gaussian_kernel_1d`
//!   ported bit-for-bit, uploaded once) with CLAMP-TO-EDGE borders — distinct from
//!   the box-blur primitive's shrinking window. Rec.709 luma weights (raw-core's
//!   deliberate approximation here, NOT Rec.2020); both GPU skip-paths write
//!   `dst = src` (a bare return would leave stale data in the separate dst
//!   buffer). Every kernel ≤ 4 storage. Parity-gated directly vs
//!   `apply_capture_sharpening` < 1e-4, covering 1/2/3 iterations, sub-pixel and
//!   larger sigma, the highlight-fade ramp, and the full no-op guard set.
//!
//! - [`build_full_chain_passes`] / [`build_split`] + [`FullChainInputs`] — the
//!   P4a capstone (epic #925, pre-#992): compose ALL 17 GPU-ported stages into one
//!   ordered `Vec<Box<dyn Pass>>` matching `raw_core::pipeline::develop` + the
//!   `render` view tail (capture_sharpening → white_balance → scene_tone_controls
//!   → tone_curves → vibrance → saturation → clarity → texture → dehaze → sharpen
//!   → nr_luminance → nr_color → agx → display_encode → srgb_gamma →
//!   auto_profile_curve → residual_lut), run through one [`ChainRunner`] with the
//!   chain's single end-of-run readback. Composition only — no kernel changes.
//!   The end-to-end parity test (`full_chain/tests.rs`) gates the composed GPU
//!   chain vs the same
//!   real `raw-core` stage fns composed CPU-side in the same order. P4a closes the
//!   view-tail transfer gap: `srgb_gamma_encode` is now a GPU [`Pass`]
//!   ([`SrgbGammaPass`], inserted between `display_encode` and
//!   `auto_profile_curve` — the curve + LUT were fit in gamma space), so the
//!   composed f32 GPU chain now matches raw-core's full develop + view tail. What
//!   remains: `look` (a no-op post-Auto-Profile-pivot — `view::look::apply` is
//!   empty) and `dither_and_quantize` (the f32 → u8 display-OUTPUT step, P4b);
//!   `auto_exposure` / `local_adjustments` stay CPU-side. Dehaze's airlight is
//!   sourced via a mid-chain GPU readback (a headless affordance; the live P4b
//!   path needs an on-GPU reduction).
//!
//! **Headless only.** No platform display surface, no Swift, no web — the wgpu →
//! `CAMetalLayer` (Apple) and wgpu → WebGPU-canvas (web) display paths are P1b
//! (#988) / P1c (#989). The live edit loop is P4 (#992). This crate is gated
//! behind the `gpu` feature of `raw-core` / `raw-wasm`, so it is **absent from
//! their default dependency trees** — default builds never compile wgpu.

mod acr_match_pass;
mod agx;
mod airlight;
mod auto_profile_curve;
mod capture_sharpening;
mod chain;
mod clarity;
mod context;
mod context_pipelines;
mod context_pipelines_helpers;
mod dehaze;
mod display_encode;
mod dither;
mod exposure;
mod frame_pool;
mod full_chain;
mod image;
mod live_chain;
mod live_session;
mod noise_reduction;
// Passthrough display proof (P1b / #988): wgpu → CAMetalLayer present. Apple-
// only — `SurfaceTargetUnsafe::CoreAnimationLayer` is wgpu-gated on
// `#[cfg(metal)]`, which is active on the four Apple slices. Absent on wasm /
// Linux host.
#[cfg(target_vendor = "apple")]
mod present;
// The device-agnostic chain-present pipeline + pass-encode helpers (P4b — #1028
// Apple, #1029 web). Pure wgpu, no platform deps, so it compiles on every target
// and lets the native (`present_chain`) and web (`present_chain_web`) entries
// share the dither/quantize draw + the bind-group layout (single-sourced). Both
// present paths live behind `#[cfg]`s, so the helpers are only referenced from
// one of them per target.
mod present_chain_pipeline;
// Chain-output present (P4b-apple / #1028): the live chain's final f32 buffer →
// a display surface (Apple `CAMetalLayer`) or, for the host parity gate, an
// offscreen `Bgra8Unorm` texture. Native-only (the offscreen readback + its CPU
// oracle have no wasm path; the surface entry is further `target_vendor=apple`-
// gated inside). Absent on wasm.
#[cfg(not(target_arch = "wasm32"))]
mod present_chain;
// Web counterpart (P1c / #989): wgpu → HTML `<canvas>` present. wasm-only —
// `SurfaceTarget::Canvas` is wgpu-gated on `#[cfg(any(webgpu, webgl))]`, active
// on the wasm32 target. Absent on Apple / Linux host. Shares `present.wgsl`.
#[cfg(target_arch = "wasm32")]
mod present_web;
// Web chain-output present (P4b-web / #1029): the live chain's final f32 buffer →
// a WebGPU `OffscreenCanvas` surface, zero readback. wasm-only — `SurfaceTarget::
// OffscreenCanvas` is wgpu-gated on `#[cfg(any(webgpu, webgl))]`. Shares
// `present_chain.wgsl` + `present_chain_pipeline` with the Apple path.
mod grain;
mod hsl;
#[cfg(target_arch = "wasm32")]
mod present_chain_web;
#[cfg(target_arch = "wasm32")]
mod present_web_colorspace;
mod residual_lut;
mod saturation;
mod scene_tone_controls;
mod sharpen;
mod spatial;
mod split_tone;
mod srgb_gamma;
mod texture;
mod tone_curves;
mod vibrance;
mod vignette;
mod white_balance;

pub use acr_match_pass::{apply_acr_match, AcrMatchPass};
pub use agx::{apply_agx, AgxPass};
pub use airlight::{encode_airlight, AIRLIGHT_BINS};
pub use auto_profile_curve::{
    apply_auto_profile_curve, AutoProfileCurvePass, PROFILE_CURVE_FLAT_LEN,
};
pub use capture_sharpening::{CaptureSharpeningParams, CaptureSharpeningPass};
pub use chain::{CancelToken, ChainRunner, Pass};
pub use clarity::{apply_clarity, ClarityPass, CLARITY_GUIDED_RADIUS};
pub use context::GpuContext;
pub use dehaze::{apply_dehaze, compute_airlight, AirlightSource, DehazePass};
pub use display_encode::{apply_display_encode, DisplayEncodePass};
pub use dither::{alloc_packed_rgb, dither_and_quantize, encode_dither, unpack_rgb_u8};
pub use exposure::{apply_exposure_gain, run_exposure_gpu_async, ExposurePass};
pub use full_chain::{
    build_full_chain_passes, build_split, BoxedPasses, FullChainInputs, InputShape,
    PROFILE_ID_ACR_MATCH,
};
pub use grain::{apply_grain, GrainOptions, GrainPass};
pub use hsl::{apply_hsl, HslPass};
pub use image::GpuImage;
pub use live_chain::{
    build_live_chain, build_live_split, chain_signature, dehaze_is_active, VIEW_TAIL_PASS_COUNT,
};
pub use live_session::LiveSession;
pub use noise_reduction::{NlmColorPass, NlmLumaPass};
pub use residual_lut::{apply_residual_lut, residual_lut_flat_len, ResidualLutPass};
pub use saturation::{apply_saturation, SaturationPass};
pub use scene_tone_controls::{apply_scene_tone_controls, SceneToneControlsPass, SceneToneOptions};
pub use sharpen::SharpenPass;
pub use spatial::{
    alloc_plane, alloc_plane_vec2, alloc_rgba, box_blur_encode, box_blur_vec2_encode,
    clarity_texture_encode, encode_simple, guided_filter_self_encode, luma_extract_encode,
    plane_byte_len, plane_vec2_byte_len, pool_data_storage, ClarityTextureArgs, GuidedFilterArgs,
    Plane,
};
pub use split_tone::{apply_split_tone, SplitTonePass};
pub use srgb_gamma::{apply_srgb_gamma, SrgbGammaPass};
pub use texture::{apply_texture, TexturePass, TEXTURE_GUIDED_RADIUS};
pub use tone_curves::{apply_tone_curves, CurveMode, ToneCurveInputs, ToneCurvesPass};
pub use vibrance::{apply_vibrance, VibrancePass};
pub use vignette::{apply_vignette, VignetteOptions, VignettePass};
pub use white_balance::{apply_white_balance, WhiteBalancePass};

#[cfg(not(target_arch = "wasm32"))]
pub use exposure::run_exposure_gpu;

#[cfg(target_vendor = "apple")]
pub use present::present_test_pattern;

// Chain-output present (P4b-apple / #1028). The offscreen entry is the host
// parity path (any native target); the surface entry is Apple-only.
#[cfg(not(target_arch = "wasm32"))]
pub use present_chain::present_chain_to_offscreen;
#[cfg(target_vendor = "apple")]
pub use present_chain::{present_chain_to_surface, PersistentPresentSurface};

#[cfg(target_arch = "wasm32")]
pub use present_web::{present_test_pattern_web, PresentReport, TARGET_COLOR_SPACE};
// Web chain-output present (P4b-web / #1029, #1038): the live chain's resident f32
// buffer → a persistent WebGPU `OffscreenCanvas` surface, zero readback, recompiling
// nothing per tick. wasm-only.
#[cfg(target_arch = "wasm32")]
pub use present_chain_web::WebPresentSurface;

/// Deterministic RGBA f32 test buffer spanning values < 1, = 1, > 1 (some
/// channels exceed 1 so the multiply is exercised in scene-linear range).
/// Shared by the `image` / `chain` / `exposure` test modules; only compiled for
/// tests. `pub(crate)` so each module's `#[cfg(test)]` block can reach it.
#[cfg(test)]
pub(crate) fn test_buffer(n: usize) -> Vec<f32> {
    let mut v = Vec::with_capacity(n * 4);
    for i in 0..n {
        let t = i as f32 / (n.max(2) - 1) as f32; // 0..=1
        v.extend_from_slice(&[t * 2.0, t, t * 0.5 + 0.25, 1.0]);
    }
    v
}
