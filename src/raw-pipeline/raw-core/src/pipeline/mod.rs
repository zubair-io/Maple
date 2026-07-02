//! Pipeline orchestrators and shared utilities.
//!
//! This module owns the scene-linear development chain. The per-stage math
//! (white-balance, scene-tone-controls, vibrance, …) lives under
//! `crate::stages::*`; the per-platform GPU code lives in the consumers
//! (Apple Metal, Web WebGL2). What sits here is the **glue** that runs
//! those stages in the right order from each entry point:
//!
//! * [`develop`] — the canonical develop chain that every entry point
//!   funnels through (full-res and the early-downsample "sized" variant).
//! * [`render`] — the legacy display-encoded entry, plus the scene-linear
//!   fp16 RGBA FFI entries used by the Apple / Web shells.
//! * [`scene_linear_chain`] — the per-tick FFI chain that re-applies the
//!   user-tweakable stages on top of an already-decoded fp16 RGBA buffer.
//! * [`tile`] — the tile path used by the deep-zoom renderer.
//! * [`downsample`], [`fp16`], [`orient`] — shared utilities consumed by
//!   the entry points above.
//!
//! The submodule split is a pure mechanical re-organisation of what was
//! previously one 1,708-line `pipeline.rs` (issue #127). Everything is
//! re-exported here so call sites that say `raw_core::pipeline::stage`,
//! `raw_core::pipeline::RenderQuality`, etc. continue to compile unchanged.

mod capture_sharpening_helper;
mod develop;
mod develop_sized;
mod downsample;
mod fp16;
mod inpaint_store;
mod orient;
pub(crate) mod pano;
mod render;
mod scene_linear_chain;
mod tile;

pub use inpaint_store::{patch_from_bytes, patch_to_bytes};

/// Phase-1 end-to-end seam test (#1484): baked patch composited at the
/// pre-grade seam via the real stages re-grades like sensor data. Test-only.
#[cfg(test)]
#[path = "inpaint_seam_tests.rs"]
mod inpaint_seam_tests;

pub use develop::{
    develop_scene_linear_from_raw_with_quality,
    develop_scene_linear_from_raw_with_quality_cancellable,
};
pub use develop_sized::{
    develop_scene_linear_sized_from_raw_with_quality,
    develop_scene_linear_sized_from_raw_with_quality_cancellable,
};
pub use downsample::downsample_image_area;
pub use pano::{decode_for_pano, read_pano_metadata, PanoIngest, PanoSourceMetadata};
pub use render::{
    fit_auto_profile_from_raw, fit_profile_curve_from_raw, native_render_dims, render_from_raw,
    render_from_raw_with_quality, render_from_raw_with_quality_and_source,
    render_from_scene_linear, render_from_scene_linear_with_chain,
    render_scene_linear_from_raw_with_quality, render_scene_linear_from_raw_with_quality_f32,
    render_scene_linear_from_raw_with_quality_f32_cancellable,
    render_scene_linear_sized_from_raw_with_quality,
    render_scene_linear_sized_from_raw_with_quality_f32,
    render_scene_linear_sized_from_raw_with_quality_f32_cancellable,
    render_sized_from_raw_with_quality_and_source, RawInput,
};
pub use scene_linear_chain::{
    apply_scene_linear_chain, apply_scene_linear_chain_f32,
    apply_scene_linear_chain_f32_with_patches, apply_scene_linear_chain_with_patches,
    encode_display_srgb_f32,
};
pub use tile::{render_scene_linear_tile_from_raw_with_quality, TILE_OVERLAP_PX};

/// Wraps a pipeline stage with `Instant::now()` timing, emitting one line
/// to stderr when `MAPLE_PROFILE` is set in the environment. When unset
/// the only cost is a single `Instant::now()` call and a `getenv` —
/// negligible relative to per-pixel work, so we leave it on in release
/// builds and let the env var gate the actual output.
///
/// Format: `[raw-core] <stage_name>            <elapsed>`. The width is
/// chosen so a 30-char name and a 10-char duration line up in a
/// monospace terminal — easy to eyeball "demosaic dominates" vs.
/// "every stage is 200 ms."
///
/// Note: any value of `MAPLE_PROFILE` enables logging (`is_some()`
/// gates on existence, not value). `MAPLE_PROFILE=0` and `MAPLE_PROFILE=`
/// both turn it on. `unset MAPLE_PROFILE` is the only way to disable.
///
/// `wasm32-unknown-unknown` has no `std::time::Instant` (`time not
/// implemented on this platform` panic), so the timing wrapper is a
/// pass-through there. `MAPLE_PROFILE` would also be meaningless in a
/// browser worker — there's no env-var to set.
#[cfg(not(target_arch = "wasm32"))]
#[inline]
pub fn stage<T>(name: &'static str, f: impl FnOnce() -> T) -> T {
    let t = std::time::Instant::now();
    let r = f();
    if std::env::var_os("MAPLE_PROFILE").is_some() {
        eprintln!("[raw-core] {:<30} {:>10.2?}", name, t.elapsed());
    }
    r
}

#[cfg(target_arch = "wasm32")]
#[inline]
pub fn stage<T>(_name: &'static str, f: impl FnOnce() -> T) -> T {
    f()
}

/// NaN/Inf scrub for the scene-linear FFI pack endcaps (#1088).
///
/// The scene-linear chain deliberately never clips (nothing before the
/// view transform may clamp), and Rust's `f32::clamp` passes NaN through
/// anyway — so a non-finite value produced anywhere upstream (0/0 in a
/// ratio, an overflowed multiply) would otherwise be packed verbatim
/// into the fp16/f32 RGBA buffers handed to Metal / wgpu / WebGPU
/// (`fp16::f32_to_f16_bits` preserves NaN by design). Sampling NaN in a
/// GPU texture is implementation-defined; scrub to 0.0 at the pack
/// boundary instead. One exponent-mask compare per lane — branch-cheap
/// for the warm pack loops (the value is finite in the overwhelming
/// common case, so the branch predicts perfectly).
#[inline(always)]
pub(crate) fn finite_or_zero(v: f32) -> f32 {
    if v.is_finite() {
        v
    } else {
        0.0
    }
}

/// Per-stage diagnostic dump. No-op when the `stage-dump` feature is
/// disabled or the `MAPLE_STAGE_DUMP` env var is unset. Called after each
/// stage that produces or modifies the in-flight `Image`.
#[cfg(feature = "stage-dump")]
#[inline]
pub(crate) fn dump_after(name: &str, image: &crate::image::Image) {
    if let Some(dir) = crate::stage_dump::dump_dir() {
        crate::stage_dump::dump_image(name, image, &dir);
    }
}

#[cfg(not(feature = "stage-dump"))]
#[inline]
pub(crate) fn dump_after(_name: &str, _image: &crate::image::Image) {}

/// Quality knob for the interactive-vs-export split. `Preview` uses the
/// half-resolution quad demosaic — 4× fewer pixels feed every downstream
/// stage, memory peak drops from ~6 GB to ~1.5 GB on a 100 MP RAW, and a
/// cold decode lands in seconds rather than minutes. `Full` is the export
/// path — same pixel-exact output the parity harness locks down (uses
/// Hamilton-Adams when compiled with `high-quality-demosaic`, bilinear
/// otherwise). `Amaze` is a higher-quality export option backed by the
/// AMaZE demosaic — slower than HA, but resolves finer detail and resists
/// moiré on Bayer-pattern-prone content (fabric, building façades, etc.);
/// for X-Trans / `LinearRgb` fixtures the AMaZE path falls through to the
/// CFA-aware path that doesn't run AMaZE at all (linearraw_to_camera_rgb
/// or hamilton_adams), so requesting `Amaze` on a non-Bayer source is
/// safe — it just doesn't do anything different from `Full`.
/// `Preview` returns the buffer at the half-res rendered dimensions —
/// callers must scale to display dimensions themselves (CIImage transform
/// on Apple, texture upload on Web).
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum RenderQuality {
    Preview,
    Full,
    Amaze,
}
