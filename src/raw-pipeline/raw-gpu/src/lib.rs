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
//! - [`WhiteBalancePass`] + [`apply_white_balance`] — a P2 scene-linear stage
//!   (#990). The WB derivation (CAT16 / diagonal) runs CPU-side once into a 3×3
//!   matrix; the kernel is a pure per-pixel matmul of that matrix (uploaded as
//!   vec4 rows to dodge WGSL's column-major `mat3x3`). Parity-gated directly vs
//!   `raw_core::stages::white_balance::apply`.
//!
//! **Headless only.** No platform display surface, no Swift, no web — the wgpu →
//! `CAMetalLayer` (Apple) and wgpu → WebGPU-canvas (web) display paths are P1b
//! (#988) / P1c (#989). The live edit loop is P4 (#992). This crate is gated
//! behind the `gpu` feature of `raw-core` / `raw-wasm`, so it is **absent from
//! their default dependency trees** — default builds never compile wgpu.

mod chain;
mod context;
mod exposure;
mod image;
mod vibrance;
mod white_balance;

pub use chain::{CancelToken, ChainRunner, Pass};
pub use context::GpuContext;
pub use exposure::{apply_exposure_gain, run_exposure_gpu_async, ExposurePass};
pub use image::GpuImage;
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
