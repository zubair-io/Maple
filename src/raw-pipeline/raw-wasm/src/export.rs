//! Edited-image export for the web editor (#943).
//!
//! ## Why the encode happens here rather than in JS or on the API
//!
//! The browser already holds the RAW bytes — that is how the canvas is
//! rendered — so the export can reuse the pipeline that produced the picture
//! the user just approved, at the depth and primaries they asked for, without
//! a second implementation of the colour chain. That matters for the
//! Hosted deployment in particular, where the user's files sit behind a File
//! System Access handle and the server never sees them: a server-side render
//! endpoint could not serve Hosted at all without first uploading the whole
//! RAW.
//!
//! Encoding here keeps full-resolution output pixels off the JavaScript heap.
//! The CPU renderer's separate wasm32 budget can still reject large exports.
//! If JS asked for pixels a 100 MP output would take a
//! ~300 MB (8-bit) or ~600 MB (16-bit) `ArrayBuffer` onto the JS heap and then
//! need a second buffer for the encoded file. Instead only the compressed
//! result crosses, and it crosses in slices: JS pulls it with [`MapleExport::chunk`]
//! and accumulates the slices into a `Blob`, which the browser backs with its
//! own (disk-spillable) storage rather than the JS heap. Peak JS-side
//! occupancy is one chunk.

use raw_core::export::{export_from_raw_with_film, ExportFormat, ExportOptions};
use raw_core::export_recipe::{export_bytes_with_recipe, ExportRecipe};
use raw_core::pipeline::RawInput;
use raw_core::view::encode::TargetPrimaries;
use raw_core::xmp as xmp_mod;
use wasm_bindgen::prelude::*;

/// An encoded export, held on the wasm side so JS can drain it in slices.
///
/// Call [`MapleExport::chunk`] until [`MapleExport::byte_length`] bytes have
/// been read, then `free()` the handle — the bytes stay resident until you do.
#[wasm_bindgen]
pub struct MapleExport {
    width: u32,
    height: u32,
    mime_type: String,
    extension: String,
    bytes: Vec<u8>,
}

impl MapleExport {
    pub(crate) fn from_image(image: raw_core::export::ExportedImage, format: ExportFormat) -> Self {
        Self {
            width: image.width,
            height: image.height,
            bytes: image.bytes,
            mime_type: format.mime_type().to_owned(),
            extension: format.extension().to_owned(),
        }
    }
}

#[wasm_bindgen]
impl MapleExport {
    /// Width of the encoded image, after any resize / crop / orientation.
    #[wasm_bindgen(getter)]
    pub fn width(&self) -> u32 {
        self.width
    }

    /// Height of the encoded image, after any resize / crop / orientation.
    #[wasm_bindgen(getter)]
    pub fn height(&self) -> u32 {
        self.height
    }

    /// MIME type to tag the resulting `Blob` with.
    #[wasm_bindgen(getter, js_name = mimeType)]
    pub fn mime_type(&self) -> String {
        self.mime_type.clone()
    }

    /// Filename extension for the chosen format, without the dot.
    #[wasm_bindgen(getter)]
    pub fn extension(&self) -> String {
        self.extension.clone()
    }

    /// Total size of the encoded file in bytes.
    #[wasm_bindgen(getter, js_name = byteLength)]
    pub fn byte_length(&self) -> u32 {
        self.bytes.len() as u32
    }

    /// Copy out `[offset, offset + len)` of the encoded file.
    ///
    /// A request past the end is truncated rather than rejected, so a caller
    /// can loop on a fixed chunk size without special-casing the tail. An
    /// offset past the end yields an empty slice.
    pub fn chunk(&self, offset: u32, len: u32) -> Vec<u8> {
        let start = (offset as usize).min(self.bytes.len());
        let end = start.saturating_add(len as usize).min(self.bytes.len());
        self.bytes[start..end].to_vec()
    }
}

/// Render a RAW at export quality and encode it to a deliverable file.
///
/// - `format` — `"jpeg"`, `"tiff"` (16-bit) or `"png"`.
/// - `quality` — JPEG quality in `[1, 100]`; ignored by the lossless formats.
/// - `color_space` — `"display-p3"` selects Display P3 primaries; anything
///   else selects sRGB. Matches the spelling the canvas reports from
///   `GPUCanvasContext.getConfiguration()`, so the UI can offer the space the
///   user has been looking at.
/// - `max_long_edge` — long-edge cap in pixels; `0` renders native full
///   resolution. Never upscales.
///
/// `xmp` is the sidecar content as a string (not a path), exactly as
/// `render_bytes` takes it — so the export reads the same adjustments the
/// canvas was showing.
#[wasm_bindgen]
pub fn export_bytes(
    raw: &[u8],
    ext: &str,
    xmp: Option<String>,
    format: &str,
    quality: u8,
    color_space: &str,
    max_long_edge: u32,
) -> Result<MapleExport, JsError> {
    export_core(raw, ext, xmp, format, quality, color_space, max_long_edge)
        .map_err(|e| JsError::new(&e))
}

/// Sibling of [`export_bytes`] that also threads a baked film-look LUT through
/// to the export render (epic #2683, Task 9), so a deliverable file carries
/// the SAME look the canvas showed — the export counterpart of
/// `WebLiveSession::set_film_lut`'s live-preview upload.
///
/// `film_lut_bytes` is a `.mlut` v1 buffer; empty (the "no look selected" /
/// "None" case) exports byte-identically to [`export_bytes`] regardless of
/// `model.film_look` / `model.film_strength`, mirroring `set_film_lut`'s
/// empty-bytes-clears contract.
#[wasm_bindgen]
pub fn export_bytes_with_film(
    raw: &[u8],
    ext: &str,
    xmp: Option<String>,
    format: &str,
    quality: u8,
    color_space: &str,
    max_long_edge: u32,
    film_lut_bytes: &[u8],
) -> Result<MapleExport, JsError> {
    export_core_with_film(
        raw,
        ext,
        xmp,
        format,
        quality,
        color_space,
        max_long_edge,
        film_lut_bytes,
    )
    .map_err(|e| JsError::new(&e))
}

/// The whole of [`export_bytes`] except the `JsError` conversion, factored out
/// so it is reachable from native unit tests — `JsError` can only be
/// constructed on a wasm target. Same split as `gpu_render::render_gpu_core`.
/// Delegates to [`export_core_with_film`] with no LUT bytes.
fn export_core(
    raw: &[u8],
    ext: &str,
    xmp: Option<String>,
    format: &str,
    quality: u8,
    color_space: &str,
    max_long_edge: u32,
) -> Result<MapleExport, String> {
    export_core_with_film(
        raw,
        ext,
        xmp,
        format,
        quality,
        color_space,
        max_long_edge,
        &[],
    )
}

/// The whole of [`export_bytes_with_film`] except the `JsError` conversion —
/// see [`export_core`]'s doc for why this split exists.
#[allow(clippy::too_many_arguments)]
fn export_core_with_film(
    raw: &[u8],
    ext: &str,
    xmp: Option<String>,
    format: &str,
    quality: u8,
    color_space: &str,
    max_long_edge: u32,
    film_lut_bytes: &[u8],
) -> Result<MapleExport, String> {
    let format_name = format;
    let format = ExportFormat::from_str(format_name)
        .ok_or_else(|| format!("export_bytes: unsupported format '{format_name}'"))?;
    let requested_edge = (max_long_edge > 0).then_some(max_long_edge);

    // The editor can develop an ordinary JPEG/PNG/WebP, but the RAW decoder
    // used below cannot. Route those baked containers through the shared
    // raster export chain. TIFF is ambiguous (camera RAWs use it too), so
    // retain the RAW path when it decodes and fall back to raster otherwise.
    let baked_container = raw.starts_with(&[0xff, 0xd8])
        || raw.starts_with(b"\x89PNG\r\n\x1a\n")
        || (raw.starts_with(b"RIFF") && raw.get(8..12) == Some(b"WEBP"));
    let raw_img = if baked_container {
        None
    } else {
        match raw_core::decode::decode_bytes(raw, ext) {
            Ok(image) => Some(image),
            Err(_) if matches!(ext.to_ascii_lowercase().as_str(), "tif" | "tiff") => None,
            Err(error) => return Err(error.to_string()),
        }
    };
    let (width, height) = if let Some(image) = &raw_img {
        (image.width, image.height)
    } else {
        let metadata = raw_core::raster::probe_raster_metadata(raw).map_err(|e| e.to_string())?;
        (metadata.width, metadata.height)
    };
    crate::cpu_budget::validate_export_dimensions(width, height, requested_edge)?;
    if raw_img.is_none() {
        crate::cpu_budget::validate_raster_export_dimensions(width, height)?;
    }

    let model = crate::mask_registry::parse_model(xmp.as_deref()).map_err(|e| e.to_string())?;
    crate::removal_saved::require_no_unresolved_removals(&model).map_err(|e| e)?;

    let options = ExportOptions {
        format,
        quality,
        target: target_primaries(color_space),
        // 0 is the "native resolution" sentinel; anything else is a real cap.
        max_long_edge: requested_edge,
    };

    // Empty bytes ⇒ no look loaded — the same "None" contract
    // `WebLiveSession::set_film_lut` uses, so a caller that always threads the
    // currently-selected look's bytes (or an empty buffer when none is
    // selected) doesn't need a separate branch.
    let film_lut = if film_lut_bytes.is_empty() {
        None
    } else {
        Some(raw_core::film::decode_mlut(film_lut_bytes).map_err(|e| e.to_string())?)
    };

    let exported = if let Some(raw_img) = &raw_img {
        export_from_raw_with_film(
            raw_img,
            &model,
            Some(RawInput::Bytes { bytes: raw, ext }),
            &options,
            film_lut.as_ref(),
        )
        .map_err(|e| e.to_string())?
    } else {
        let recipe = ExportRecipe {
            format: format_name.to_string(),
            quality: matches!(format, ExportFormat::Jpeg | ExportFormat::Avif)
                .then_some(quality as u32),
            bit_depth: if format == ExportFormat::Tiff16 {
                16
            } else {
                8
            },
            max_long_edge: requested_edge,
            output_profile: if color_space == "display-p3" {
                "display-p3"
            } else {
                "srgb"
            }
            .to_string(),
            ..ExportRecipe::default()
        };
        export_bytes_with_recipe(raw, ext, &model, &recipe, film_lut.as_ref())?
    };

    Ok(MapleExport {
        width: exported.width,
        height: exported.height,
        mime_type: format.mime_type().to_string(),
        extension: format.extension().to_string(),
        bytes: exported.bytes,
    })
}

/// Map the canvas colour-space spelling onto the pipeline's target primaries.
///
/// Defensive default to sRGB for any unrecognised value, matching
/// [`TargetPrimaries::from_u32`] and the `"display-p3"` check the GPU present
/// path already uses (#1913).
fn target_primaries(color_space: &str) -> TargetPrimaries {
    if color_space == "display-p3" {
        TargetPrimaries::P3
    } else {
        TargetPrimaries::Srgb
    }
}

#[cfg(test)]
#[path = "export_tests.rs"]
mod tests;
