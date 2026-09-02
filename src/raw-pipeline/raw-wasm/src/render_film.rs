//! `render_bytes_with_film` / `render_bytes_sized_with_film` — the film-look
//! siblings of `render.rs`'s `render_bytes`/`render_bytes_sized`. Split out
//! of `render.rs` (#3182 — that file was at the file-size budget ceiling)
//! into their own module; nothing about the JS-facing API changes, since
//! wasm-bindgen exports items regardless of which module declares them (see
//! `render.rs`'s own module doc for the precedent). Builds `MapleRender` via
//! its `pub(crate) fn new` constructor rather than the struct-literal syntax
//! `render.rs`'s own entries use — the fields are private to that module, so
//! a same-crate, different-module caller has to go through the ctor, the
//! same way `gpu_render.rs` already does.

use crate::render::{as_shot_wb, MapleRender};
use raw_core::xmp as xmp_mod;
use wasm_bindgen::prelude::*;

/// Sibling of [`crate::render::render_bytes`] that also threads a baked
/// film-look LUT through to the `film_look` stage (epic #2683, Task 9) — the
/// WASM-CPU fallback's counterpart of `WebLiveSession::set_film_lut`'s
/// live-preview upload, used on browsers without WebGPU (or as the
/// GPU-adapter-failure fallback, see `raw-pipeline.worker.ts`'s
/// `handleLegacyDecode`).
///
/// `film_lut_bytes` is a `.mlut` v1 buffer ([`raw_core::film::decode_mlut`]);
/// empty renders byte-identically to [`crate::render::render_bytes`]
/// regardless of `model.film_look` / `model.film_strength`, mirroring
/// `set_film_lut`'s empty-bytes-clears contract.
#[wasm_bindgen]
pub fn render_bytes_with_film(
    raw: &[u8],
    ext: &str,
    xmp: Option<String>,
    film_lut_bytes: &[u8],
) -> Result<MapleRender, JsError> {
    let raw_img =
        raw_core::decode::decode_bytes(raw, ext).map_err(|e| JsError::new(&e.to_string()))?;

    let (as_shot_temperature, as_shot_tint) = as_shot_wb(&raw_img);
    let has_lens_corrections = raw_img.has_lens_corrections(); // #3182
    let lens_correction_ca_inert = raw_img.lens_correction_ca_inert();

    let model = match xmp {
        Some(x) => xmp_mod::parse(&x).map_err(|e| JsError::new(&e.to_string()))?,
        None => xmp_mod::AdjustmentModel::default(),
    };

    let film_lut = if film_lut_bytes.is_empty() {
        None
    } else {
        Some(
            raw_core::film::decode_mlut(film_lut_bytes)
                .map_err(|e| JsError::new(&e.to_string()))?,
        )
    };

    // Same #2661 memory clamp as `render_bytes` — this entry serves the very
    // same unsized CPU-fallback requests, just with a film LUT threaded
    // through, so an unclamped large sensor would trap here identically.
    let quality = raw_core::pipeline::RenderQuality::Amaze;
    let source = Some(raw_core::pipeline::RawInput::Bytes { bytes: raw, ext });
    match crate::cpu_budget::clamp_develop_long_edge(raw_img.width, raw_img.height, None) {
        None => {
            let (w, h, bytes) = raw_core::pipeline::render_from_raw_with_quality_source_and_film(
                &raw_img,
                &model,
                quality,
                source,
                film_lut.as_ref(),
            )
            .map_err(|e| JsError::new(&e.to_string()))?;
            Ok(MapleRender::new(
                w,
                h,
                w,
                h,
                bytes,
                as_shot_temperature,
                as_shot_tint,
                has_lens_corrections,
                lens_correction_ca_inert,
            ))
        }
        Some(cap) => {
            let (full_width, full_height) = raw_core::pipeline::native_render_dims(&raw_img);
            let (w, h, bytes) =
                raw_core::pipeline::render_sized_from_raw_with_quality_source_and_film(
                    &raw_img,
                    &model,
                    quality,
                    source,
                    cap,
                    film_lut.as_ref(),
                )
                .map_err(|e| JsError::new(&e.to_string()))?;
            Ok(MapleRender::new(
                w,
                h,
                full_width,
                full_height,
                bytes,
                as_shot_temperature,
                as_shot_tint,
                has_lens_corrections,
                lens_correction_ca_inert,
            ))
        }
    }
}

/// Sized variant of [`render_bytes_with_film`] — the sized-plus-film sibling
/// `raw-pipeline.worker.ts`'s routing has documented as a gap since epic
/// #2683 Task 9 (#2719): a non-WebGPU browser's live canvas renders through
/// [`crate::render::render_bytes_sized`] for the fast/refine phases, and
/// until this entry existed a loaded film look had no sized route to ride —
/// the look only ever reached the canvas via export
/// ([`render_bytes_with_film`]'s unsized path) or the GPU live session's
/// `set_film_lut`.
///
/// Byte-for-byte the union of the two siblings, not a new code path:
/// [`crate::render::render_bytes_sized`]'s sizing/clamp contract (the
/// `max_long_edge` validation, `quality_preview` branch, and #2661 sensor
/// clamp, keyed off `Some(max_long_edge)` so a >32 MP sensor develops at the
/// requested cap rather than auto-detecting one the way the unsized film
/// entry does) plus [`render_bytes_with_film`]'s `.mlut` decode and
/// empty-bytes-clears contract. Shares
/// `raw_core::pipeline::render_sized_from_raw_with_quality_source_and_film`
/// with `render_bytes_with_film`'s own sized-cap branch — same function,
/// same view tail, so this can never drift from what the film-look math
/// produces there.
#[wasm_bindgen]
pub fn render_bytes_sized_with_film(
    raw: &[u8],
    ext: &str,
    xmp: Option<String>,
    quality_preview: bool,
    max_long_edge: u32,
    film_lut_bytes: &[u8],
) -> Result<MapleRender, JsError> {
    if max_long_edge == 0 {
        return Err(JsError::new(
            "render_bytes_sized_with_film: max_long_edge must be > 0",
        ));
    }
    let raw_img =
        raw_core::decode::decode_bytes(raw, ext).map_err(|e| JsError::new(&e.to_string()))?;

    // As-shot derivation — IDENTICAL to `render_bytes_sized` so a sized cold
    // open seeds the same sliders regardless of whether a look is loaded.
    let (as_shot_temperature, as_shot_tint) = as_shot_wb(&raw_img);
    let has_lens_corrections = raw_img.has_lens_corrections(); // #3182
    let lens_correction_ca_inert = raw_img.lens_correction_ca_inert();

    let model = match xmp {
        Some(x) => xmp_mod::parse(&x).map_err(|e| JsError::new(&e.to_string()))?,
        None => xmp_mod::AdjustmentModel::default(),
    };

    let film_lut = if film_lut_bytes.is_empty() {
        None
    } else {
        Some(
            raw_core::film::decode_mlut(film_lut_bytes)
                .map_err(|e| JsError::new(&e.to_string()))?,
        )
    };

    let quality = if quality_preview {
        raw_core::pipeline::RenderQuality::Preview
    } else {
        // Full-quality path: AMaZE by default (#940).
        raw_core::pipeline::RenderQuality::Amaze
    };
    // #2661 clamp — identical to `render_bytes_sized`'s (keyed off the
    // REQUESTED cap, not the unsized film entry's auto-detect-only-if-huge
    // clamp), so a film-look request never falls out of the CPU memory
    // budget the plain sized entry already respects.
    let effective_long_edge = crate::cpu_budget::clamp_develop_long_edge(
        raw_img.width,
        raw_img.height,
        Some(max_long_edge),
    )
    .unwrap_or(max_long_edge);
    let (full_width, full_height) = raw_core::pipeline::native_render_dims(&raw_img);
    let (w, h, bytes) = raw_core::pipeline::render_sized_from_raw_with_quality_source_and_film(
        &raw_img,
        &model,
        quality,
        Some(raw_core::pipeline::RawInput::Bytes { bytes: raw, ext }),
        effective_long_edge,
        film_lut.as_ref(),
    )
    .map_err(|e| JsError::new(&e.to_string()))?;
    Ok(MapleRender::new(
        w,
        h,
        full_width,
        full_height,
        bytes,
        as_shot_temperature,
        as_shot_tint,
        has_lens_corrections,
        lens_correction_ca_inert,
    ))
}
