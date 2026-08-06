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
//! Threading (T10):
//! When compiled with `--features parallel` and the `+atomics,+bulk-memory`
//! target features, `initThreadPool(num_threads)` is re-exported from
//! `wasm-bindgen-rayon`. JS callers invoke it only when
//! `crossOriginIsolated` is true (COOP: same-origin + COEP: require-corp).
//! Without those headers (Safari/Firefox default, or any host without them),
//! the decode path continues to work single-threaded — no feature detection
//! is needed on the Rust side.

use raw_core::xmp as xmp_mod;
use wasm_bindgen::prelude::*;

pub mod auto_adjustments;
pub mod auto_tone;
// wasm32 CPU develop memory budget (#2661) — the sensor-aware long-edge clamp
// every CPU render entry applies so a develop can never exceed the 4 GiB heap.
pub mod cpu_budget;
// Scene-linear render surface (fp16 RGBA) — split from this file for the
// file-size budget; re-exported so `crate::`-level paths keep resolving.
pub mod scene_linear;
pub use scene_linear::*;
/// Edited-image export — full-res render + in-wasm encode, drained in chunks
/// so a 100 MP deliverable never lands on the JS heap in one piece (#943).
pub mod export;
pub mod id;
pub mod preview;

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

#[wasm_bindgen]
pub struct MapleRender {
    width: u32,
    height: u32,
    full_width: u32,
    full_height: u32,
    rgb: Vec<u8>,
    as_shot_temperature: f32,
    as_shot_tint: f32,
}

impl MapleRender {
    /// Internal constructor so the gpu-gated `render_bytes_gpu` entry
    /// (`gpu_render.rs`) can build the same return type as `render_bytes`
    /// without naming the private fields across the submodule boundary. wasm-only
    /// with `render_bytes_gpu` itself (the native host parity test drives
    /// `render_gpu_core`, which returns a raw `(w, h, Vec<u8>)`). The GPU
    /// one-shot develops fit to a viewport target (#1080), so the caller passes
    /// the NATIVE oriented dims (`native_render_dims`) for `full_*` explicitly —
    /// the same contract `render_bytes_sized` fills (#1101).
    #[cfg(all(feature = "gpu", target_arch = "wasm32"))]
    pub(crate) fn new(
        width: u32,
        height: u32,
        full_width: u32,
        full_height: u32,
        rgb: Vec<u8>,
        as_shot_temperature: f32,
        as_shot_tint: f32,
    ) -> Self {
        Self {
            width,
            height,
            full_width,
            full_height,
            rgb,
            as_shot_temperature,
            as_shot_tint,
        }
    }
}

#[wasm_bindgen]
impl MapleRender {
    #[wasm_bindgen(getter)]
    pub fn width(&self) -> u32 {
        self.width
    }
    #[wasm_bindgen(getter)]
    pub fn height(&self) -> u32 {
        self.height
    }
    /// Oriented dimensions a full-resolution render of the SAME RAW would
    /// produce (`raw_core::pipeline::native_render_dims`). Equal to
    /// `width`/`height` on the full-res entries; on `render_bytes_sized` they
    /// carry the native dims so the caller can do fit/100% zoom math while
    /// holding only a viewport-sized buffer (#1101).
    #[wasm_bindgen(getter)]
    pub fn full_width(&self) -> u32 {
        self.full_width
    }
    #[wasm_bindgen(getter)]
    pub fn full_height(&self) -> u32 {
        self.full_height
    }
    /// RGB bytes (3 per pixel). **Clones the full frame on every JS access**
    /// (the wasm-side buffer stays alive alongside the JS copy until `free()` /
    /// GC) — prefer the consuming [`MapleRender::take_rgb`] when the render is
    /// only read once (#1080).
    #[wasm_bindgen(getter)]
    pub fn rgb(&self) -> Vec<u8> {
        self.rgb.clone()
    }
    /// Consume the RGB buffer WITHOUT cloning: moves the bytes out to JS and
    /// leaves an empty buffer behind, so peak memory is one frame, not two
    /// (#1080). The scalar getters (`width`/`height`/As-Shot WB) stay valid
    /// after the take; a subsequent `rgb`/`take_rgb` returns an empty array.
    pub fn take_rgb(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.rgb)
    }
    /// Camera "As Shot" correlated colour temperature in Kelvin, in the WB
    /// slider frame (`dcp::estimate_as_shot_cct_tint` — the temperature at
    /// which the WB stage is an identity for this image). Seeds the UI's
    /// Temperature slider on a fresh open; display-only (#1892).
    #[wasm_bindgen(getter)]
    pub fn as_shot_temperature(&self) -> f32 {
        self.as_shot_temperature
    }
    /// Camera "As Shot" tint in slider units (±150, ACR's span), from the
    /// same frame-consistent estimate as `as_shot_temperature`. Seeds the
    /// UI's Tint slider on a fresh open; display-only (#1892).
    #[wasm_bindgen(getter)]
    pub fn as_shot_tint(&self) -> f32 {
        self.as_shot_tint
    }
}

/// As-shot `(temperature, tint)` in the WB SLIDER FRAME — the pair the app's
/// WB sliders display for an untouched image (#1892).
///
/// Delegates to `raw_core::color::dcp::estimate_as_shot_cct_tint`, the same
/// frame-consistent estimate the Apple decode export (#1781) hydrates
/// sliders from: `SliderFrame::scene_cct` plus the perpendicular-axis tint
/// projection of the scene illuminant — NOT the old log2(B/R) heuristic,
/// which on off-locus bodies disagreed with the render's identity point by
/// thousands of Kelvin and the whole tint range (test_0002, H2D-39: 7625 K /
/// 0 vs the frame's 5520 K / −144.4).
///
/// This value is for DISPLAY seeding only — the render paths leave a fresh
/// open at `AdjustmentModel::default()` so `wb_camera::resolve_target`'s
/// As-Shot sentinel makes the develop an exact no-op; pushing the estimate
/// into the model would round-trip it through the explicit-target math
/// instead (see `resolve_target`'s doc).
///
/// The estimator's `Result` is never `Err` in practice (every profile
/// resolver tier constructs `Ok`); the fallback keeps this total without a
/// second error path.
pub(crate) fn as_shot_wb(raw_img: &raw_core::image::RawImage) -> (f32, f32) {
    raw_core::color::dcp::estimate_as_shot_cct_tint(raw_img).unwrap_or_else(|_| {
        (
            raw_core::stages::white_balance::estimate_cct_from_neutral(raw_img.as_shot_neutral),
            0.0,
        )
    })
}

/// Render a RAW from bytes (WASM-friendly — no filesystem path needed).
///
/// `ext` is a lowercase file extension like `"dng"`, `"cr2"`, `"arw"` so
/// rawler can disambiguate formats when magic is ambiguous.
///
/// `xmp` is optional XMP sidecar content as a UTF-8 string (not a path).
/// When `xmp` is `None` the caller is opening a brand-new RAW (no prior
/// user adjustments): the model stays at `AdjustmentModel::default()`, whose
/// untouched `(6500, 0)` pair is `wb_camera::resolve_target`'s As-Shot
/// sentinel — the develop resolves it to the slider frame's own as-shot
/// point and white balance is an exact no-op. The frame-consistent as-shot
/// estimate rides the return value (`as_shot_temperature`/`as_shot_tint`)
/// purely so the UI can seed its sliders; it is deliberately NOT written
/// into the model, which would demote the exact sentinel into a
/// float-rounded explicit target (#1892 — the pre-fix push used a crude
/// log2(B/R) heuristic and shifted every fresh open).
///
/// Memory budget (#2661): a full-native-resolution CPU develop of a sensor
/// over [`cpu_budget::FULL_DEVELOP_MAX_SENSOR_PX`] cannot fit the 4 GiB
/// wasm32 heap (9.2 GB measured peak on the 100 MP reference — the alloc
/// abort is an unrecoverable trap that poisons the instance). Such sensors
/// develop through the sized chain at the clamp instead; the buffer's real
/// dims ride `width`/`height` and the native dims `full_width`/`full_height`,
/// exactly like [`render_bytes_sized`].
#[wasm_bindgen]
pub fn render_bytes(raw: &[u8], ext: &str, xmp: Option<String>) -> Result<MapleRender, JsError> {
    let raw_img =
        raw_core::decode::decode_bytes(raw, ext).map_err(|e| JsError::new(&e.to_string()))?;

    let (as_shot_temperature, as_shot_tint) = as_shot_wb(&raw_img);

    let model = match xmp {
        Some(x) => xmp_mod::parse(&x).map_err(|e| JsError::new(&e.to_string()))?,
        None => xmp_mod::AdjustmentModel::default(),
    };

    // Export/display path: AMaZE by default (#940) — cost-equivalent to
    // bilinear since the tiled kernel (#1887) and matches the Apple
    // refine/export selection.
    let quality = raw_core::pipeline::RenderQuality::Amaze;
    let source = Some(raw_core::pipeline::RawInput::Bytes { bytes: raw, ext });
    match cpu_budget::clamp_develop_long_edge(raw_img.width, raw_img.height, None) {
        None => {
            let (w, h, bytes) = raw_core::pipeline::render_from_raw_with_quality_and_source(
                &raw_img, &model, quality, source,
            )
            .map_err(|e| JsError::new(&e.to_string()))?;
            Ok(MapleRender {
                width: w,
                height: h,
                full_width: w,
                full_height: h,
                rgb: bytes,
                as_shot_temperature,
                as_shot_tint,
            })
        }
        Some(cap) => {
            let (full_width, full_height) = raw_core::pipeline::native_render_dims(&raw_img);
            let (w, h, bytes) = raw_core::pipeline::render_sized_from_raw_with_quality_and_source(
                &raw_img, &model, quality, source, cap,
            )
            .map_err(|e| JsError::new(&e.to_string()))?;
            Ok(MapleRender {
                width: w,
                height: h,
                full_width,
                full_height,
                rgb: bytes,
                as_shot_temperature,
                as_shot_tint,
            })
        }
    }
}

/// Sized variant of [`render_bytes`] — the display-encoded counterpart of the
/// Apple FFI's `maple_render_bytes_scene_linear_sized` sizing contract (#1101,
/// spec §5.1): develops through raw-core's early-downsample chain so every
/// post-demosaic stage runs on a buffer capped at `max_long_edge`, then runs
/// the IDENTICAL view tail (`render_sized_from_raw_with_quality_and_source`
/// shares its body with the unsized entry). Never upscales — a cap at or
/// above the native long edge renders byte-identically to [`render_bytes`].
///
/// `quality_preview = true` runs the half-res Preview demosaic (the web
/// fast-phase cost profile, matching Apple's editor first paint); `false`
/// runs AMaZE (the refine phase; the full-quality default since #940).
/// `max_long_edge` must be > 0.
///
/// The returned [`MapleRender`] carries the sized buffer in `width`/`height`
/// and the NATIVE oriented dims in `full_width`/`full_height`
/// (`native_render_dims`), so the editor can do fit/100% zoom math without a
/// full-res decode.
#[wasm_bindgen]
pub fn render_bytes_sized(
    raw: &[u8],
    ext: &str,
    xmp: Option<String>,
    quality_preview: bool,
    max_long_edge: u32,
) -> Result<MapleRender, JsError> {
    if max_long_edge == 0 {
        return Err(JsError::new(
            "render_bytes_sized: max_long_edge must be > 0",
        ));
    }
    let raw_img =
        raw_core::decode::decode_bytes(raw, ext).map_err(|e| JsError::new(&e.to_string()))?;

    // As-shot derivation — IDENTICAL to `render_bytes` so a sized cold open
    // seeds the same sliders. Display-only; a fresh open renders at the
    // As-Shot sentinel, never at a pushed pair (#1892 — see `render_bytes`).
    let (as_shot_temperature, as_shot_tint) = as_shot_wb(&raw_img);

    let model = match xmp {
        Some(x) => xmp_mod::parse(&x).map_err(|e| JsError::new(&e.to_string()))?,
        None => xmp_mod::AdjustmentModel::default(),
    };

    let quality = if quality_preview {
        raw_core::pipeline::RenderQuality::Preview
    } else {
        // Full-quality path: AMaZE by default (#940).
        raw_core::pipeline::RenderQuality::Amaze
    };
    // #2661: clamp the request so the develop fits the 4 GiB wasm32 heap —
    // a cap near the native long edge of a >32 MP sensor otherwise runs the
    // full-res demosaic branch and aborts the instance (7.2 GB measured at
    // cap 8192 on the 100 MP reference).
    let effective_long_edge =
        cpu_budget::clamp_develop_long_edge(raw_img.width, raw_img.height, Some(max_long_edge))
            .unwrap_or(max_long_edge);
    let (full_width, full_height) = raw_core::pipeline::native_render_dims(&raw_img);
    let (w, h, bytes) = raw_core::pipeline::render_sized_from_raw_with_quality_and_source(
        &raw_img,
        &model,
        quality,
        Some(raw_core::pipeline::RawInput::Bytes { bytes: raw, ext }),
        effective_long_edge,
    )
    .map_err(|e| JsError::new(&e.to_string()))?;
    Ok(MapleRender {
        width: w,
        height: h,
        full_width,
        full_height,
        rgb: bytes,
        as_shot_temperature,
        as_shot_tint,
    })
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
