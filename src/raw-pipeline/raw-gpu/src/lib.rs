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
//!
//! **Headless only.** No platform display surface, no Swift, no web — the wgpu →
//! `CAMetalLayer` (Apple) and wgpu → WebGPU-canvas (web) display paths are P1b
//! (#988) / P1c (#989). The live edit loop is P4 (#992). This crate is gated
//! behind the `gpu` feature of `raw-core` / `raw-wasm`, so it is **absent from
//! their default dependency trees** — default builds never compile wgpu.

mod agx;
mod auto_profile_curve;
mod chain;
mod clarity;
mod context;
mod display_encode;
mod exposure;
mod image;
mod residual_lut;
mod saturation;
mod scene_tone_controls;
mod spatial;
mod texture;
mod tone_curves;
mod vibrance;
mod white_balance;

pub use agx::{apply_agx, AgxPass};
pub use auto_profile_curve::{
    apply_auto_profile_curve, AutoProfileCurvePass, PROFILE_CURVE_FLAT_LEN,
};
pub use chain::{CancelToken, ChainRunner, Pass};
pub use clarity::{apply_clarity, ClarityPass, CLARITY_GUIDED_RADIUS};
pub use context::GpuContext;
pub use display_encode::{apply_display_encode, DisplayEncodePass};
pub use exposure::{apply_exposure_gain, run_exposure_gpu_async, ExposurePass};
pub use image::GpuImage;
pub use residual_lut::{apply_residual_lut, residual_lut_flat_len, ResidualLutPass};
pub use saturation::{apply_saturation, SaturationPass};
pub use scene_tone_controls::{apply_scene_tone_controls, SceneToneControlsPass};
pub use spatial::{
    alloc_plane, alloc_rgba, box_blur_encode, clarity_texture_encode, encode_simple,
    guided_filter_self_encode, luma_extract_encode, plane_byte_len,
};
pub use texture::{apply_texture, TexturePass, TEXTURE_GUIDED_RADIUS};
pub use tone_curves::{apply_tone_curves, CurveMode, ToneCurveInputs, ToneCurvesPass};
pub use vibrance::{apply_vibrance, VibrancePass};
pub use white_balance::{apply_white_balance, WhiteBalancePass};

#[cfg(not(target_arch = "wasm32"))]
pub use exposure::run_exposure_gpu;

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
