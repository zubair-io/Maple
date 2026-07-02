//! wasm-bindgen surface for raw-core. Intended for consumption by the
//! Angular web workspace's `maple-common` package (per spec § 00).
//!
//! Browser-safe surface (no filesystem):
//!
//!   render_bytes(raw: Uint8Array, ext: string, xmp: string | null)
//!       → MapleRender { width: u32, height: u32, rgb: Uint8Array }
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
    /// Camera-side "As Shot" correlated colour temperature in Kelvin, as
    /// determined by rawler from the RAW metadata. When the RAW lacks an
    /// explicit CCT we fall back to 6500K (D65) so callers always get a
    /// usable value.
    #[wasm_bindgen(getter)]
    pub fn as_shot_temperature(&self) -> f32 {
        self.as_shot_temperature
    }
    /// "As Shot" tint in Maple's slider units (-100 .. 100). Approximated
    /// from the camera's AsShotNeutral (blue vs red skew). 0 when the RAW
    /// does not expose enough information.
    #[wasm_bindgen(getter)]
    pub fn as_shot_tint(&self) -> f32 {
        self.as_shot_tint
    }
}

/// Rough CCT estimator from a green-normalised AsShotNeutral (R, 1, B).
///
/// Delegates to `raw_core::stages::white_balance::estimate_cct_from_neutral`
/// — single-sourced there so WASM, FFI, and tests all use the same math.
/// The behaviour is unchanged: anchors log2(B/R) = 0 → 5500K, ±1 → ±2500K.
fn estimate_cct_from_neutral(as_shot_neutral: [f32; 3]) -> f32 {
    raw_core::stages::white_balance::estimate_cct_from_neutral(as_shot_neutral)
}

/// Render a RAW from bytes (WASM-friendly — no filesystem path needed).
///
/// `ext` is a lowercase file extension like `"dng"`, `"cr2"`, `"arw"` so
/// rawler can disambiguate formats when magic is ambiguous.
///
/// `xmp` is optional XMP sidecar content as a UTF-8 string (not a path).
/// When `xmp` is `None` we assume the caller is opening a brand-new RAW
/// (no prior user adjustments) and substitute the camera's AsShotNeutral-
/// derived white balance for Maple's 6500K default — otherwise every fresh
/// import would render with a strong colour cast before the user has
/// touched the Temperature slider.
#[wasm_bindgen]
pub fn render_bytes(raw: &[u8], ext: &str, xmp: Option<String>) -> Result<MapleRender, JsError> {
    let raw_img =
        raw_core::decode::decode_bytes(raw, ext).map_err(|e| JsError::new(&e.to_string()))?;

    // rawler 0.7 doesn't surface AsShotTemperature, so `as_shot_cct` is
    // always None today. Fall back to estimating the CCT from the camera's
    // AsShotNeutral reading — same signal the reference renderer uses when the DNG lacks a
    // baked Kelvin tag.
    let as_shot_temperature = raw_img
        .as_shot_cct
        .unwrap_or_else(|| estimate_cct_from_neutral(raw_img.as_shot_neutral));
    // Tint is best left at 0 on cold open — deriving it from a single
    // neutral reading without the camera's DCP hue map misleads the slider.
    // The user can nudge it manually once the temperature is in the ballpark.
    let as_shot_tint = 0.0_f32;

    let fresh_open = xmp.is_none();
    let mut model = match xmp {
        Some(x) => xmp_mod::parse(&x).map_err(|e| JsError::new(&e.to_string()))?,
        None => xmp_mod::AdjustmentModel::default(),
    };
    // Fresh open (no sidecar) → render at the camera's As Shot WB, not the
    // 6500K default the struct carries. User edits always come in through
    // `xmp = Some(..)` once they've moved a slider, so this branch only
    // kicks in for a first-render cold open.
    if fresh_open {
        model.temperature = as_shot_temperature;
        model.tint = as_shot_tint;
    }

    let (w, h, bytes) = raw_core::pipeline::render_from_raw_with_quality_and_source(
        &raw_img,
        &model,
        // Export/display path: bilinear Full by default. AMaZE is opt-in via
        // the Apple AmazeFlag / CLI --demosaic amaze. Web live path deferred
        // — see render_bytes_scene_linear (#846/#321).
        raw_core::pipeline::RenderQuality::Full,
        Some(raw_core::pipeline::RawInput::Bytes { bytes: raw, ext }),
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
/// runs Full (the refine phase). `max_long_edge` must be > 0.
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

    // As-shot derivation + fresh-open WB substitution — IDENTICAL to
    // `render_bytes` so a sized cold open seeds the same sliders.
    let as_shot_temperature = raw_img
        .as_shot_cct
        .unwrap_or_else(|| estimate_cct_from_neutral(raw_img.as_shot_neutral));
    let as_shot_tint = 0.0_f32;

    let fresh_open = xmp.is_none();
    let mut model = match xmp {
        Some(x) => xmp_mod::parse(&x).map_err(|e| JsError::new(&e.to_string()))?,
        None => xmp_mod::AdjustmentModel::default(),
    };
    if fresh_open {
        model.temperature = as_shot_temperature;
        model.tint = as_shot_tint;
    }

    let quality = if quality_preview {
        raw_core::pipeline::RenderQuality::Preview
    } else {
        // Export path: bilinear Full by default. AMaZE is opt-in via
        // AmazeFlag (Apple) or CLI --demosaic amaze.
        raw_core::pipeline::RenderQuality::Full
    };
    let (full_width, full_height) = raw_core::pipeline::native_render_dims(&raw_img);
    let (w, h, bytes) = raw_core::pipeline::render_sized_from_raw_with_quality_and_source(
        &raw_img,
        &model,
        quality,
        Some(raw_core::pipeline::RawInput::Bytes { bytes: raw, ext }),
        max_long_edge,
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

/// Scene-linear FFI return type — Rec.2020 fp16 RGBA, straight alpha,
/// row-major. Mirrors Apple's `MapleSceneLinearBuffer` C struct at
/// `raw-ffi/src/lib.rs:283-308` minus the raw pointer (wasm-bindgen owns
/// the `Vec<u16>`; the JS getter exposes it as a `Uint16Array` view, which
/// is the same bit pattern as the Apple buffer).
///
/// Plan 3 M1 — see .archived-plans/plans/2026-04-25-plan-3-web-ffi-split-m1.md.
#[wasm_bindgen]
pub struct MapleSceneLinearRender {
    width: u32,
    height: u32,
    full_width: u32,
    full_height: u32,
    fp16_rgba: Vec<u16>,
    as_shot_temperature: f32,
    as_shot_tint: f32,
}

#[wasm_bindgen]
impl MapleSceneLinearRender {
    #[wasm_bindgen(getter)]
    pub fn width(&self) -> u32 {
        self.width
    }
    #[wasm_bindgen(getter)]
    pub fn height(&self) -> u32 {
        self.height
    }
    /// Oriented dimensions a full-resolution render of the SAME RAW would
    /// produce — see [`MapleRender::full_width`]. Equal to `width`/`height`
    /// on the full-res entry; the sized entry carries the native dims here.
    #[wasm_bindgen(getter)]
    pub fn full_width(&self) -> u32 {
        self.full_width
    }
    #[wasm_bindgen(getter)]
    pub fn full_height(&self) -> u32 {
        self.full_height
    }
    /// fp16 RGBA lanes (4 channels, 2 bytes per lane). Length is always
    /// `4 * width * height`. Alpha lane is fp16 1.0 (`0x3c00`).
    /// Returned as `Uint16Array` over the WASM heap on the JS side.
    /// **Clones the full frame on every JS access** (the wasm-side buffer stays
    /// alive alongside the JS copy until `free()` / GC) — prefer the consuming
    /// [`MapleSceneLinearRender::take_fp16_rgba`] when the render is only read
    /// once (#1080).
    #[wasm_bindgen(getter)]
    pub fn fp16_rgba(&self) -> Vec<u16> {
        self.fp16_rgba.clone()
    }
    /// Consume the fp16 RGBA buffer WITHOUT cloning: moves the lanes out to JS
    /// and leaves an empty buffer behind, so peak memory is one frame, not two
    /// (#1080). The scalar getters stay valid after the take; a subsequent
    /// `fp16_rgba`/`take_fp16_rgba` returns an empty array.
    pub fn take_fp16_rgba(&mut self) -> Vec<u16> {
        std::mem::take(&mut self.fp16_rgba)
    }
    /// Bytes per pixel — always 8. Exposed for symmetry with Apple's
    /// `MapleSceneLinearBuffer.bytes_per_pixel` so future bit-depth
    /// changes (HDR / fp32) don't break the JS consumer.
    #[wasm_bindgen(getter)]
    pub fn bytes_per_pixel(&self) -> u32 {
        8
    }
    /// Channels per pixel — always 4 (R, G, B, A).
    #[wasm_bindgen(getter)]
    pub fn channels(&self) -> u32 {
        4
    }
    /// Camera "As Shot" CCT in Kelvin — see `MapleRender::as_shot_temperature`.
    #[wasm_bindgen(getter)]
    pub fn as_shot_temperature(&self) -> f32 {
        self.as_shot_temperature
    }
    /// Camera "As Shot" tint in slider units (-100..100).
    #[wasm_bindgen(getter)]
    pub fn as_shot_tint(&self) -> f32 {
        self.as_shot_tint
    }
}

/// Render a RAW from bytes to a scene-linear Rec.2020 fp16 RGBA buffer.
/// Pre-AgX, pre-Rec.2020->sRGB — the caller (Plan 3 M2 GLSL chain) is
/// expected to apply the AgX view transform and gamut convert before
/// display. **Mirrors the legacy `render_bytes` semantics** for the
/// non-rendering arguments (`ext`, `xmp`, fresh-open WB substitution)
/// but returns fp16 instead of sRGB u8.
///
/// `quality_preview = true` runs the half-res Preview pipeline; `false`
/// runs AMaZE for the export path. Web live/preview keeps Preview; AMaZE
/// on the web live path is deferred until the develop cache lands
/// (see issue #846 / #321) so demosaic runs once per open, not per slider tick.
///
/// Plan 3 M1 — see .archived-plans/plans/2026-04-25-plan-3-web-ffi-split-m1.md.
#[wasm_bindgen]
pub fn render_bytes_scene_linear(
    raw: &[u8],
    ext: &str,
    xmp: Option<String>,
    quality_preview: bool,
) -> Result<MapleSceneLinearRender, JsError> {
    let raw_img =
        raw_core::decode::decode_bytes(raw, ext).map_err(|e| JsError::new(&e.to_string()))?;

    // Same as_shot derivation as the legacy entry — rawler 0.7 still doesn't
    // surface AsShotTemperature, so we estimate from AsShotNeutral and pass
    // tint through as 0 on cold open. See raw-wasm/src/lib.rs:106-112.
    let as_shot_temperature = raw_img
        .as_shot_cct
        .unwrap_or_else(|| estimate_cct_from_neutral(raw_img.as_shot_neutral));
    let as_shot_tint = 0.0_f32;

    let fresh_open = xmp.is_none();
    let mut model = match xmp {
        Some(x) => xmp_mod::parse(&x).map_err(|e| JsError::new(&e.to_string()))?,
        None => xmp_mod::AdjustmentModel::default(),
    };
    if fresh_open {
        model.temperature = as_shot_temperature;
        model.tint = as_shot_tint;
    }

    let quality = if quality_preview {
        raw_core::pipeline::RenderQuality::Preview
    } else {
        // Export path: bilinear Full by default. AMaZE is opt-in via
        // AmazeFlag (Apple) or CLI --demosaic amaze.
        // Web live/interactive path deferred (#846 / #321).
        raw_core::pipeline::RenderQuality::Full
    };
    let (w, h, fp16_rgba) =
        raw_core::pipeline::render_scene_linear_from_raw_with_quality(&raw_img, &model, quality)
            .map_err(|e| JsError::new(&e.to_string()))?;
    Ok(MapleSceneLinearRender {
        width: w,
        height: h,
        full_width: w,
        full_height: h,
        fp16_rgba,
        as_shot_temperature,
        as_shot_tint,
    })
}

/// Sized variant of [`render_bytes_scene_linear`] — the WASM mirror of the
/// Apple FFI's `maple_render_bytes_scene_linear_sized` (#1101, spec §5.1):
/// the SAME raw-core path
/// (`render_scene_linear_sized_from_raw_with_quality`), which downsamples to
/// fit within `max_long_edge` immediately after demosaic so every later
/// stage runs on the viewport-sized buffer. Never upscales. Output contract
/// matches the full-size entry (packed Rec.2020 fp16 RGBA, straight alpha
/// 1.0, EXIF-oriented); `full_width`/`full_height` carry the native oriented
/// dims so the caller keeps its fit/zoom math without a full-res decode.
///
/// `max_long_edge` is a single long-edge scalar (the Plan 1 v2 Task 8 API
/// decision — one scalar keeps the JS binding signature shorter; aspect math
/// stays inside the renderer). Must be > 0.
#[wasm_bindgen]
pub fn render_bytes_scene_linear_sized(
    raw: &[u8],
    ext: &str,
    xmp: Option<String>,
    quality_preview: bool,
    max_long_edge: u32,
) -> Result<MapleSceneLinearRender, JsError> {
    if max_long_edge == 0 {
        return Err(JsError::new(
            "render_bytes_scene_linear_sized: max_long_edge must be > 0",
        ));
    }
    let raw_img =
        raw_core::decode::decode_bytes(raw, ext).map_err(|e| JsError::new(&e.to_string()))?;

    // Same as_shot derivation + fresh-open WB substitution as the full-size
    // entry — see `render_bytes_scene_linear`.
    let as_shot_temperature = raw_img
        .as_shot_cct
        .unwrap_or_else(|| estimate_cct_from_neutral(raw_img.as_shot_neutral));
    let as_shot_tint = 0.0_f32;

    let fresh_open = xmp.is_none();
    let mut model = match xmp {
        Some(x) => xmp_mod::parse(&x).map_err(|e| JsError::new(&e.to_string()))?,
        None => xmp_mod::AdjustmentModel::default(),
    };
    if fresh_open {
        model.temperature = as_shot_temperature;
        model.tint = as_shot_tint;
    }

    let quality = if quality_preview {
        raw_core::pipeline::RenderQuality::Preview
    } else {
        // Export path: bilinear Full by default. AMaZE is opt-in via
        // AmazeFlag (Apple) or CLI --demosaic amaze.
        // Web live path deferred (#846/#321).
        raw_core::pipeline::RenderQuality::Full
    };
    let (full_width, full_height) = raw_core::pipeline::native_render_dims(&raw_img);
    let (w, h, fp16_rgba) = raw_core::pipeline::render_scene_linear_sized_from_raw_with_quality(
        &raw_img,
        &model,
        quality,
        max_long_edge,
    )
    .map_err(|e| JsError::new(&e.to_string()))?;
    Ok(MapleSceneLinearRender {
        width: w,
        height: h,
        full_width,
        full_height,
        fp16_rgba,
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
