//! Scene-linear fp16 RGBA render surface: `MapleSceneLinearRender`,
//! `render_bytes_scene_linear`, `render_bytes_scene_linear_sized`. Split out
//! of `lib.rs` (file-size budget) mirroring `raw-ffi`'s own
//! `scene_linear.rs`, which carries the same "scene-linear fp16 RGBA
//! entries" grouping for the C ABI. Shares the As-Shot WB estimate
//! (`as_shot_wb`) with the legacy 8-bit path in `render.rs` rather than
//! duplicating it — both families derive the identical display-seeding
//! pair from the same raw-core call (#1892).

use raw_core::xmp as xmp_mod;
use wasm_bindgen::prelude::*;

use crate::render::as_shot_wb;

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
    /// produce — see [`crate::render::MapleRender::full_width`]. Equal to
    /// `width`/`height` on the full-res entry; the sized entry carries the
    /// native dims here.
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
    /// Camera "As Shot" CCT in Kelvin — see
    /// `crate::render::MapleRender::as_shot_temperature`.
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
/// non-rendering arguments (`ext`, `xmp`, the fresh-open As-Shot-sentinel
/// contract — #1892) but returns fp16 instead of sRGB u8.
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

    // Same as-shot derivation as the legacy entry (#1892) — display-only; a
    // fresh open renders at the As-Shot sentinel, never at a pushed pair.
    let (as_shot_temperature, as_shot_tint) = as_shot_wb(&raw_img);

    let model = match xmp {
        Some(x) => xmp_mod::parse(&x).map_err(|e| JsError::new(&e.to_string()))?,
        None => xmp_mod::AdjustmentModel::default(),
    };

    let quality = if quality_preview {
        raw_core::pipeline::RenderQuality::Preview
    } else {
        // Refine / full-quality develop: AMaZE by default (#940). This runs
        // once per image open (the GPU-live session keeps the developed
        // frame; edits re-run GPU stages only), so the cost is not on the
        // slider-tick path.
        raw_core::pipeline::RenderQuality::Amaze
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

    // Same as-shot derivation as the full-size entry — see
    // `render_bytes_scene_linear` (#1892: display-only, no model push).
    let (as_shot_temperature, as_shot_tint) = as_shot_wb(&raw_img);

    let model = match xmp {
        Some(x) => xmp_mod::parse(&x).map_err(|e| JsError::new(&e.to_string()))?,
        None => xmp_mod::AdjustmentModel::default(),
    };

    let quality = if quality_preview {
        raw_core::pipeline::RenderQuality::Preview
    } else {
        // Refine / full-quality develop: AMaZE by default (#940). This runs
        // once per image open (the GPU-live session keeps the developed
        // frame; edits re-run GPU stages only), so the cost is not on the
        // slider-tick path.
        raw_core::pipeline::RenderQuality::Amaze
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
