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
//!   - `handle`             — `MapleRawHandle` (cached decoded RAW +
//!                            model) + render_handle_tile.
//!   - `scene_linear_chain` — `maple_apply_scene_linear_chain` per-tick
//!                            cheap-stage chain + `MapleAdjustmentParams`.
//!   - `thumbnail`          — embedded-JPEG fast path.
//!   - `id`                 — `maple_blake3_hex`, `maple_id_primary`,
//!                            `maple_id_fallback` pure-function entries.

#![allow(clippy::missing_safety_doc)]

mod buffers;
mod error;
mod handle;
mod id;
mod model;
mod render;
mod scene_linear;
mod scene_linear_chain;
mod thumbnail;

// Re-export every C ABI type so cbindgen sees the same surface it always has.
// `#[no_mangle] extern "C"` functions are exported regardless of `pub use`,
// but cbindgen also needs visibility on the `#[repr(C)]` structs to emit
// their typedefs.
pub use buffers::{MapleByteBuffer, MapleImageBuffer, MapleSceneLinearBuffer};
pub use handle::MapleRawHandle;
pub use scene_linear_chain::MapleAdjustmentParams;


// Tests are split per-topic so each file stays well under the 600-LOC
// per-file budget; the `#[path]` references keep them as plain siblings
// under `src/` rather than scattering them in a `tests/` integration
// directory (the FFI entries they exercise are crate-private through
// `#[no_mangle]`, not `pub`, so integration-test access is awkward).
#[cfg(test)]
#[path = "render_tests.rs"]
mod render_tests;
#[cfg(test)]
#[path = "scene_linear_tests.rs"]
mod scene_linear_tests;
#[cfg(test)]
#[path = "handle_tests.rs"]
mod handle_tests;
#[cfg(test)]
#[path = "id_tests.rs"]
mod id_tests;
