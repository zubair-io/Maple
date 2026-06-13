//! C ABI surface for raw-core. Intended for consumption by Apple's
//! `MapleCore` Swift package via `RawPipeline.xcframework` (per spec § 00).
//!
//! Per ticket #124 this crate is **thin marshalling only** — type ABI
//! shims, pointer helpers, error codes. No business logic. The Apple-side
//! decision of "which AdjustmentModel fields to strip before decode so
//! the GPU chain doesn't double-apply them" lives in the Swift binding
//! (`MapleCore/Sources/MapleCore/RawCoreBridge.swift`), not here.
//!
//! Module map:
//!   - `error`              — `LAST_ERROR` thread-local, `with_large_stack`
//!                            worker plumbing, `maple_last_error`.
//!   - `buffers`            — `MapleImageBuffer` / `MapleByteBuffer` /
//!                            `MapleSceneLinearBuffer` (+ free fns).
//!   - `model`              — shared XMP load helper + tile dehaze guard.
//!   - `render`             — legacy 8-bit sRGB entries
//!                            (`maple_render_file`, `maple_render_bytes`).
//!   - `scene_linear`       — scene-linear fp16 RGBA entries
//!                            (file/bytes × full/sized/tile).
//!   - `scene_linear_f32`   — scene-linear f32 RGBA entries (#482)
//!                            (file/bytes × full/sized).
//!   - `handle`             — `MapleRawHandle` (cached decoded RAW +
//!                            model) + render_handle_tile.
//!   - `scene_linear_chain` — `maple_apply_scene_linear_chain` per-tick
//!                            cheap-stage chain + `MapleAdjustmentParams`.
//!   - `thumbnail`          — embedded-JPEG fast path.
//!   - `id`                 — `maple_blake3_hex`, `maple_id_primary`,
//!                            `maple_id_fallback` pure-function entries.

#![allow(clippy::missing_safety_doc)]

mod auto_profile;
mod auto_tone;
mod buffers;
mod cancel;
mod error;
// Epic #925 / P1b (#988): GPU parity FFI (`maple_gpu_exposure_parity`). Gated
// behind the `gpu` feature so wgpu is absent from the default xcframework.
#[cfg(feature = "gpu")]
mod gpu;
// Epic #925 / P4b-core (#1027): the gpu-gated LIVE-session FFI (the pooled
// zero-alloc render runner + its `MapleGpuLiveParams` struct). Same `gpu` gate.
#[cfg(feature = "gpu")]
mod gpu_live;
// Epic #925 / P4b-apple (#1028): the gpu-gated Auto Profile artifact FFI — fit
// the per-image curve + residual LUT as SEPARATE artifacts (the un-composed
// inputs the wgpu live chain's curve + residual-LUT passes consume), vs the
// default cube FFI's pre-composed CIColorCube. Same `gpu` gate.
#[cfg(feature = "gpu")]
mod gpu_auto_profile;
mod handle;
mod id;
mod model;
// Epic #1234 / M3 (#1235): panorama stitch C-FFI. Gated behind the `pano`
// feature — `maple-pano` (with `ml`) is absent from default builds so
// `cargo build -p raw-ffi` without features stays small. The xcframework
// build turns it on via `--features gpu,pano`. The `maple_pano_stitch` symbol
// is present in all 4 slices; iOS/iOS-sim returns error −3 (pending M6 #1234).
#[cfg(feature = "pano")]
mod pano;
mod render;
mod scene_linear;
mod scene_linear_chain;
mod scene_linear_f32;
mod thumbnail;

// Re-export every C ABI type so cbindgen sees the same surface it always has.
// `#[no_mangle] extern "C"` functions are exported regardless of `pub use`,
// but cbindgen also needs visibility on the `#[repr(C)]` structs to emit
// their typedefs.
pub use auto_tone::MapleAutoTone;
pub use buffers::{MapleByteBuffer, MapleImageBuffer, MapleSceneLinearBuffer};
pub use cancel::MapleCancelFlag;
pub use handle::MapleRawHandle;
pub use scene_linear_chain::MapleAdjustmentParams;
// gpu-gated: the live-session FFI structs (absent from the default xcframework).
#[cfg(feature = "gpu")]
pub use gpu_live::{MapleGpuLiveParams, MapleGpuLiveSession};
// pano-gated: the panorama stitch ABI types and entry point (epic #1234 / M3 #1235).
// `maple_pano_stitch` is also exported via its `#[no_mangle]` attribute (C ABI),
// but the `pub use` here makes it accessible to Rust integration tests that call
// the FFI through the rlib form of the crate.
#[cfg(feature = "pano")]
pub use pano::{
    maple_pano_stitch, MaplePanoLocalAlign, MaplePanoProgressFn, MaplePanoRetention,
    MaplePanoStrategy,
};
// `maple_last_error` is exported for integration tests too (re-export from error).
pub use error::maple_last_error;

// Tests are split per-topic so each file stays well under the 600-LOC
// per-file budget; the `#[path]` references keep them as plain siblings
// under `src/` rather than scattering them in a `tests/` integration
// directory (the FFI entries they exercise are crate-private through
// `#[no_mangle]`, not `pub`, so integration-test access is awkward).
#[cfg(test)]
#[path = "auto_tone_tests.rs"]
mod auto_tone_tests;
#[cfg(test)]
#[path = "handle_tests.rs"]
mod handle_tests;
#[cfg(test)]
#[path = "id_tests.rs"]
mod id_tests;
#[cfg(test)]
#[path = "render_tests.rs"]
mod render_tests;
#[cfg(test)]
#[path = "scene_linear_chain_tests.rs"]
mod scene_linear_chain_tests;
#[cfg(test)]
#[path = "scene_linear_tests.rs"]
mod scene_linear_tests;
#[cfg(test)]
#[path = "thumbnail_tests.rs"]
mod thumbnail_tests;
