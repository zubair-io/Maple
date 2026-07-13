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
//!   - `buffers`            — `MapleImageBuffer` / `MapleSceneLinearBuffer`
//!                            (+ free fns).
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
//!   - `thumbnail`          — embedded-preview AVIF thumbnail fast path.
//!   - `id`                 — `maple_blake3_hex`, `maple_id_primary`,
//!                            `maple_id_fallback` pure-function entries.

#![allow(clippy::missing_safety_doc)]

mod auto_adjustments;
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
mod render;
mod render_develop;
mod scene_linear;
mod scene_linear_chain;
mod scene_linear_f32;
mod thumbnail;
// Epic #1234 / M3 (#1235) + M6 (#1244): panorama stitch C-FFI.
//
// Gated behind `pano` (macOS slices, load-dynamic ort) or `pano-ios` (iOS
// slices, static ort, M6 #1244). The two features select different
// maple-pano dep variants (`ml` vs `ml-static`) but compile the same
// `pano.rs` + `pano_apple.rs` module. The xcframework build uses
// `--features gpu,pano` for macOS and `--features gpu,pano-ios` for iOS.
#[cfg(any(feature = "pano", feature = "pano-ios"))]
mod pano;

// Re-export every C ABI type so cbindgen sees the same surface it always has.
// `#[no_mangle] extern "C"` functions are exported regardless of `pub use`,
// but cbindgen also needs visibility on the `#[repr(C)]` structs to emit
// their typedefs.
pub use auto_adjustments::MapleAutoAdjustments;
pub use auto_tone::MapleAutoTone;
pub use buffers::{MapleImageBuffer, MapleSceneLinearBuffer};
pub use cancel::MapleCancelFlag;
pub use handle::MapleRawHandle;
pub use scene_linear_chain::MapleAdjustmentParams;
// gpu-gated: the live-session FFI structs (absent from the default xcframework).
#[cfg(feature = "gpu")]
pub use gpu_live::{MapleGpuLiveParams, MapleGpuLiveSession};
// pano-gated: the panorama stitch ABI types + entry point (epic #1234 / M3
// + M6 #1244). `maple_pano_stitch` is exported via `#[no_mangle]` (C ABI);
// the `pub use` also makes it reachable from Rust integration tests.
// Enabled by `pano` (macOS) or `pano-ios` (iOS static-link, M6 #1244).
#[cfg(any(feature = "pano", feature = "pano-ios"))]
pub use pano::{
    maple_pano_stitch, MaplePanoLocalAlign, MaplePanoProgressFn, MaplePanoRetention,
    MaplePanoStrategy,
};
// ORT smoke test entry (iOS + iOS-sim only, M6 #1244). Gated on `pano-ios`
// AND `target_os = "ios"` — macOS uses load-dynamic ORT so `ort::init()` (no
// dylib path) is incorrect there. cbindgen maps `target_os = ios` →
// `TARGET_OS_IOS` (see cbindgen.toml), so the header declaration appears only
// on iOS targets. The Swift test target can therefore call this without
// triggering a link error on macOS.
#[cfg(all(feature = "pano-ios", target_os = "ios"))]
pub use pano::maple_pano_ort_selftest;
// Re-exported for the pano integration tests that read it after a failed stitch.
pub use error::maple_last_error;
// Re-exported so the `render_develop_jpeg` integration test (#1950) can call
// the developed-preview extern directly; the `#[no_mangle]` C-ABI export is
// unaffected either way.
pub use render_develop::maple_render_develop_jpeg_to_file;

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
