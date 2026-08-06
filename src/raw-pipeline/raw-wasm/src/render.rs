//! Legacy 8-bit sRGB render surface: `MapleRender`, `render_bytes`,
//! `render_bytes_sized`, plus the `as_shot_wb` As-Shot WB estimate shared
//! with every other render family in this crate (scene-linear fp16 in
//! `scene_linear.rs`, and — gpu-gated — `gpu_render.rs` / `web_live_session.rs`).
//! Split out of `lib.rs` (file-size budget) mirroring `raw-ffi`'s own
//! `render.rs`, which carries the same "legacy 8-bit sRGB entries"
//! grouping (`maple_render_file`, `maple_render_bytes`) for the C ABI.
//!
//! wasm-bindgen exports items regardless of which module declares them (see
//! `preview.rs`'s `extract_embedded_preview`, which has never needed a
//! crate-root re-export) — `MapleRender` and `as_shot_wb` ARE re-exported
//! from `lib.rs` anyway, but only so the existing `crate::MapleRender` /
//! `crate::as_shot_wb` paths in `gpu_render.rs`, `web_live_session.rs`, and
//! `tests.rs` keep compiling unchanged; the JS-facing API surface
//! (`render_bytes`, `render_bytes_sized`, `MapleRender`'s getters) is
//! byte-identical to before this split.

use raw_core::xmp as xmp_mod;
use wasm_bindgen::prelude::*;

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
#[wasm_bindgen]
pub fn render_bytes(raw: &[u8], ext: &str, xmp: Option<String>) -> Result<MapleRender, JsError> {
    let raw_img =
        raw_core::decode::decode_bytes(raw, ext).map_err(|e| JsError::new(&e.to_string()))?;

    let (as_shot_temperature, as_shot_tint) = as_shot_wb(&raw_img);

    let model = match xmp {
        Some(x) => xmp_mod::parse(&x).map_err(|e| JsError::new(&e.to_string()))?,
        None => xmp_mod::AdjustmentModel::default(),
    };

    let (w, h, bytes) = raw_core::pipeline::render_from_raw_with_quality_and_source(
        &raw_img,
        &model,
        // Export/display path: AMaZE by default (#940) — cost-equivalent to
        // bilinear since the tiled kernel (#1887) and matches the Apple
        // refine/export selection.
        raw_core::pipeline::RenderQuality::Amaze,
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
