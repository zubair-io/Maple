//! wasm-bindgen surface for raw-core. Intended for consumption by the
//! Angular web workspace's `maple-common` package (per spec § 00).
//!
//! Browser-safe surface (no filesystem):
//!
//!   render_bytes(raw: Uint8Array, ext: string, xmp: string | null)
//!       → MapleRender { width: u32, height: u32, rgb: Uint8Array }
//!
//!   new FallbackIdHasher() .update(chunk: Uint8Array) .finalize(filesize: bigint)
//!       → 32-char lowercase hex fallback-form maple_id (#1995, `id.rs`) —
//!         streams `File.slice()` chunks instead of buffering a whole RAW.
//!
//!   extract_embedded_preview(raw: Uint8Array, ext: string, maxLongEdge: u32, quality: u32)
//!       → EmbeddedPreview { width: u32, height: u32, take_jpeg(): Uint8Array }
//!         (#2010, `preview.rs`) — extracts the RAW's camera-embedded
//!         preview JPEG (not a re-render), matching Apple/server's
//!         `maple_render_thumbnail_preview_jpeg_to_file` derivation.
//!
//!   render_filename_template(template, originalStem, ext, capturedAt, seqStart, seqIndex, seqPadWidth)
//!       → string (#2628, `filename.rs`) — batch-rename template engine,
//!         shared with Apple/Windows via `raw-ffi` over the same
//!         `raw_core::filename` implementation. `validate_filename(name)`
//!         checks a manually-typed name against the same rules. Rejections
//!         throw a JS `Error` carrying a `.kind` string property (e.g.
//!         `"reserved_name"`) alongside the usual `.message`, so callers can
//!         switch on the reason without parsing prose — see `filename.rs`'s
//!         module doc.
//!
//! `render_bytes`/`render_bytes_sized` (legacy 8-bit sRGB) live in
//! `render.rs`; `render_bytes_scene_linear`/`render_bytes_scene_linear_sized`
//! (fp16 RGBA) live in `scene_linear.rs` — both re-exported here so the flat
//! `crate::`-root surface (and the wasm-bindgen JS exports, which don't care
//! about Rust module nesting to begin with) are unchanged by that split.
//!
//! Threading (T10):
//! When compiled with `--features parallel` and the `+atomics,+bulk-memory`
//! target features, `initThreadPool(num_threads)` is re-exported from
//! `wasm-bindgen-rayon`. JS callers invoke it only when
//! `crossOriginIsolated` is true (COOP: same-origin + COEP: require-corp).
//! Without those headers (Safari/Firefox default, or any host without them),
//! the decode path continues to work single-threaded — no feature detection
//! is needed on the Rust side.

use wasm_bindgen::prelude::*;

pub mod auto_adjustments;
pub mod auto_tone;
/// Edited-image export — full-res render + in-wasm encode, drained in chunks
/// so a 100 MP deliverable never lands on the JS heap in one piece (#943).
pub mod export;
/// Batch-rename filename-template engine (#2628) — thin wasm-bindgen
/// pass-through over `raw_core::filename`, shared with Apple/Windows via
/// `raw-ffi` so a template renders byte-identically on every surface.
pub mod filename;
pub mod id;
pub mod preview;
/// Legacy 8-bit sRGB render surface — `MapleRender`, `render_bytes`,
/// `render_bytes_sized`, plus the `as_shot_wb` helper shared with every
/// other render family in this crate. Split out of this file for the
/// file-size budget (#2628); mirrors `raw-ffi`'s own `render.rs` grouping.
pub mod render;
/// Scene-linear fp16 RGBA render surface — `MapleSceneLinearRender`,
/// `render_bytes_scene_linear`, `render_bytes_scene_linear_sized`. Split out
/// of this file for the file-size budget (#2628); mirrors `raw-ffi`'s own
/// `scene_linear.rs` grouping.
pub mod scene_linear;

// BM3D deep-denoise progress bridge (#1153) — wasm-only: it hands raw-core's
// stage progress to a JS callback the render worker re-broadcasts, and the
// native-host build (the gpu_render parity test) has no JS to call into.
#[cfg(target_arch = "wasm32")]
pub mod deep_denoise_progress;

#[cfg(feature = "gpu")]
pub mod gpu;

// The GPU-resident web live-render entry (`render_bytes_gpu`, P4b-web / #1029).
// gpu-gated alongside `gpu`; absent from default builds. Its `#[wasm_bindgen]`
// export is picked up by wasm-bindgen from this module.
#[cfg(feature = "gpu")]
mod gpu_render;

// The persistent, zero-readback web live-render handle (`WebLiveSession`, P4b-web
// / #1038): keeps the GPU context + uploaded image resident across slider ticks
// and presents straight to a WebGPU `OffscreenCanvas` surface. wasm-only (it owns
// an `OffscreenCanvas` + drives WebGPU via `wasm_bindgen_futures`); gpu-gated. The
// native-host build (the `gpu_render` parity test) does not compile it — its core
// helpers are shared from `gpu_render`, which the test drives directly.
#[cfg(all(feature = "gpu", target_arch = "wasm32"))]
mod web_live_session;

// Re-export wasm-bindgen-rayon's `initThreadPool` when the `parallel` feature
// is enabled. JS imports it as `initThreadPool` from the generated bindings.
#[cfg(all(target_arch = "wasm32", feature = "parallel"))]
pub use wasm_bindgen_rayon::init_thread_pool;

// Re-exported at the crate root so `crate::MapleRender` / `crate::as_shot_wb`
// / `crate::MapleSceneLinearRender` (used by `gpu_render.rs`,
// `web_live_session.rs`, and `tests.rs`) and the flat
// `render_bytes`/`render_bytes_sized`/`render_bytes_scene_linear`/
// `render_bytes_scene_linear_sized` call sites in `tests.rs` all keep
// compiling unchanged after the `render`/`scene_linear` split (#2628) — see
// those modules' doc comments for why wasm-bindgen itself doesn't need this.
pub use render::{render_bytes, render_bytes_sized, MapleRender};
// Only consumed by `#[cfg(test)]` (`tests.rs`) and `#[cfg(feature = "gpu")]`
// (`gpu_render.rs`/`web_live_session.rs`) call sites — a default `cargo
// build` with neither active has no consumer, hence the allow.
#[allow(unused_imports)]
pub(crate) use render::as_shot_wb;
pub use scene_linear::{
    render_bytes_scene_linear, render_bytes_scene_linear_sized, MapleSceneLinearRender,
};

// #2516 — safe Rayon restoration on Chromium: grow the shared WASM memory
// ONCE, before any Rayon worker isolate exists, so no growth ever races an
// idle worker's stale cross-isolate bounds. `parallel`-gated: only relevant
// to the threaded build, and the intrinsics it uses only exist for the
// `parallel` feature's caller (raw-wasm-init.ts calls it right before
// `initThreadPool`).
#[cfg(feature = "parallel")]
pub mod shared_heap;
#[cfg(feature = "parallel")]
pub use shared_heap::{prepare_threaded_heap, wasm_memory_mib};

/// `true` when this WASM binary was built with atomics + the parallel feature.
/// JS can still override by refusing to call `initThreadPool` when
/// `crossOriginIsolated` is false (e.g. Safari or Firefox without COOP/COEP).
#[wasm_bindgen]
pub fn is_threaded() -> bool {
    cfg!(all(
        target_arch = "wasm32",
        target_feature = "atomics",
        feature = "parallel"
    ))
}

/// One-shot panic hook installer. Safe to call multiple times. JS calls this
/// once immediately after `init()` so that Rust panics surface in DevTools
/// instead of becoming opaque `RuntimeError: unreachable` traps.
#[wasm_bindgen]
pub fn install_panic_hook() {
    #[cfg(target_arch = "wasm32")]
    {
        console_error_panic_hook::set_once();
    }
}

/// Bake a fitted Auto Profile curve into a display-space `n³` 3D LUT (#817).
///
/// `curve_flat` is the flat serialization of a
/// `raw_core::view::auto_profile::ProfileCurve` (its `to_flat()`, length
/// `PROFILE_CURVE_FLAT_LEN`). Returns `n * n * n * 3` f32 values — the
/// canonical `apply_curve` sampled over a regular `[0, 1]³` grid, identical
/// bytes to the Apple `maple_compute_profile_lut` FFI because both call the
/// same `raw_core::view::auto_profile::bake_profile_lut`. `wasm_bindgen`
/// surfaces the returned `Vec<f32>` to JS as a `Float32Array` that is a COPY
/// into the JS heap; the WASM-side allocation is freed once the value crosses
/// the boundary, so JS owns an independent buffer.
///
/// **Layout:** `n³` RGB triplets, R fastest, then G, then B —
/// `out[((b*n + g)*n + r)*3 + c]`, grid coordinate `k` → `k / (n - 1)`. The
/// WebGL2 sampler (#394) uploads this as an `n × n × n` RGB float 3D texture.
///
/// **Per-image, one-shot.** The fitted curve is keyed on the embedded JPEG
/// (stable across slider edits), so JS bakes once when the curve is first fit
/// and re-samples the GPU texture every slider tick WITHOUT re-baking. Do not
/// call this per tick.
///
/// Errors (thrown as `JsError`): `n < 2`, `n > MAX_LUT_SIZE`, or
/// `curve_flat.len()` is not exactly `PROFILE_CURVE_FLAT_LEN`.
#[wasm_bindgen]
pub fn compute_profile_lut(curve_flat: &[f32], n: u32) -> Result<Vec<f32>, JsError> {
    use raw_core::view::auto_profile::{bake_profile_lut, ProfileCurve, MAX_LUT_SIZE};
    let n = n as usize;
    if n < 2 {
        return Err(JsError::new("compute_profile_lut: n must be >= 2"));
    }
    // Bound `n` from above BEFORE baking: a large `n` overflows the `n³ * 3`
    // sizing and triggers a massive allocation that can trap or hang the WASM
    // main thread. `MAX_LUT_SIZE` is the shared core constant (core / FFI /
    // WASM all agree on the accepted range).
    if n > MAX_LUT_SIZE {
        return Err(JsError::new(
            "compute_profile_lut: n must be <= MAX_LUT_SIZE (256)",
        ));
    }
    let curve = ProfileCurve::from_flat(curve_flat).ok_or_else(|| {
        JsError::new("compute_profile_lut: curve_flat length != PROFILE_CURVE_FLAT_LEN")
    })?;
    Ok(bake_profile_lut(&curve, n))
}

/// Version string (for build verification from JS).
#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

// Native-target tests live in `src/tests.rs` (file-size budget split —
// same pattern as `gpu_render/tests.rs`).
#[cfg(test)]
mod tests;
