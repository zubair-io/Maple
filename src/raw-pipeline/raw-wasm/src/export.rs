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
//! Encoding on this side of the boundary is also what keeps a 100 MP export
//! inside a browser's means. If JS asked for pixels it would take a
//! ~300 MB (8-bit) or ~600 MB (16-bit) `ArrayBuffer` onto the JS heap and then
//! need a second buffer for the encoded file. Instead only the compressed
//! result crosses, and it crosses in slices: JS pulls it with [`MapleExport::chunk`]
//! and accumulates the slices into a `Blob`, which the browser backs with its
//! own (disk-spillable) storage rather than the JS heap. Peak JS-side
//! occupancy is one chunk.

use raw_core::export::{export_from_raw, ExportFormat, ExportOptions};
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

/// The whole of [`export_bytes`] except the `JsError` conversion, factored out
/// so it is reachable from native unit tests — `JsError` can only be
/// constructed on a wasm target. Same split as `gpu_render::render_gpu_core`.
fn export_core(
    raw: &[u8],
    ext: &str,
    xmp: Option<String>,
    format: &str,
    quality: u8,
    color_space: &str,
    max_long_edge: u32,
) -> Result<MapleExport, String> {
    let format = ExportFormat::from_str(format)
        .ok_or_else(|| format!("export_bytes: unsupported format '{format}'"))?;

    let raw_img = raw_core::decode::decode_bytes(raw, ext).map_err(|e| e.to_string())?;

    let model = match xmp {
        Some(x) => xmp_mod::parse(&x).map_err(|e| e.to_string())?,
        None => xmp_mod::AdjustmentModel::default(),
    };

    let options = ExportOptions {
        format,
        quality,
        target: target_primaries(color_space),
        // 0 is the "native resolution" sentinel; anything else is a real cap.
        max_long_edge: (max_long_edge > 0).then_some(max_long_edge),
    };

    let exported = export_from_raw(
        &raw_img,
        &model,
        Some(RawInput::Bytes { bytes: raw, ext }),
        &options,
    )
    .map_err(|e| e.to_string())?;

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
mod tests {
    use super::*;

    fn export_of(bytes: Vec<u8>) -> MapleExport {
        MapleExport {
            width: 4,
            height: 2,
            mime_type: "image/jpeg".to_string(),
            extension: "jpg".to_string(),
            bytes,
        }
    }

    #[test]
    fn display_p3_is_the_only_spelling_that_selects_p3() {
        assert_eq!(target_primaries("display-p3"), TargetPrimaries::P3);
        assert_eq!(target_primaries("srgb"), TargetPrimaries::Srgb);
        assert_eq!(target_primaries("unknown"), TargetPrimaries::Srgb);
        assert_eq!(target_primaries(""), TargetPrimaries::Srgb);
        assert_eq!(target_primaries("Display-P3"), TargetPrimaries::Srgb);
    }

    /// Draining in chunks must reassemble the original file exactly — this is
    /// the contract the JS Blob accumulation depends on.
    #[test]
    fn chunked_reads_reassemble_the_whole_file() {
        let original: Vec<u8> = (0..1000).map(|i| (i % 251) as u8).collect();
        let export = export_of(original.clone());

        for chunk_size in [1u32, 7, 256, 999, 1000, 4096] {
            let mut rebuilt: Vec<u8> = Vec::new();
            let mut offset = 0u32;
            while offset < export.byte_length() {
                let piece = export.chunk(offset, chunk_size);
                assert!(
                    !piece.is_empty(),
                    "a chunk inside the file must not be empty"
                );
                rebuilt.extend_from_slice(&piece);
                offset += piece.len() as u32;
            }
            assert_eq!(rebuilt, original, "chunk size {chunk_size} lost data");
        }
    }

    #[test]
    fn a_chunk_past_the_end_is_empty_rather_than_a_panic() {
        let export = export_of(vec![1, 2, 3]);
        assert!(export.chunk(3, 16).is_empty());
        assert!(export.chunk(9999, 16).is_empty());
    }

    #[test]
    fn a_chunk_straddling_the_end_is_truncated() {
        let export = export_of(vec![1, 2, 3, 4, 5]);
        assert_eq!(export.chunk(3, 100), vec![4, 5]);
    }

    #[test]
    fn byte_length_reports_the_encoded_size() {
        assert_eq!(export_of(vec![0; 42]).byte_length(), 42);
        assert_eq!(export_of(Vec::new()).byte_length(), 0);
    }

    #[test]
    fn an_unknown_format_is_rejected() {
        // Reaching decode would need a real RAW; the format check runs first,
        // so an empty buffer is enough to prove the rejection order.
        let result = export_core(&[], "dng", None, "bmp", 92, "srgb", 0);
        let err = match result {
            Err(e) => e,
            Ok(_) => panic!("an unknown format must be rejected"),
        };
        assert!(err.contains("unsupported format"), "got: {err}");
    }

    /// Repo-root fixture path. Skip-pass when the gitignored RAW is absent,
    /// mirroring the raw-core pattern.
    fn fixture() -> Option<Vec<u8>> {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test-fixtures/raws/test_0002.dng");
        if !path.exists() {
            eprintln!("fixture missing at {path:?} — skipping");
            return None;
        }
        Some(std::fs::read(&path).expect("read fixture"))
    }

    /// **The parity gate.** A lossless sRGB 8-bit export must be BYTE-IDENTICAL
    /// to what `render_bytes` — the function that paints the canvas — produces.
    ///
    /// PNG is lossless, so decoding the exported file back to RGB recovers the
    /// exact samples the pipeline emitted. Any divergence between the export
    /// chain and the display chain shows up here as a non-zero pixel delta,
    /// with no compression noise to hide behind.
    #[test]
    #[ignore = "renders at native resolution (~2 min); run with --ignored"]
    fn a_lossless_export_is_byte_identical_to_the_canvas_render() {
        let Some(raw) = fixture() else { return };

        let canvas = crate::render_bytes(&raw, "dng", None).expect("render_bytes");
        let (canvas_w, canvas_h) = (canvas.width(), canvas.height());
        let canvas_rgb = canvas.rgb();

        let exported = export_core(&raw, "dng", None, "png", 100, "srgb", 0).expect("export");
        assert_eq!(
            (exported.width(), exported.height()),
            (canvas_w, canvas_h),
            "export dimensions must match the canvas render"
        );

        let decoded = image::load_from_memory(&exported.bytes)
            .expect("exported PNG must decode")
            .to_rgb8();
        assert_eq!(decoded.as_raw().len(), canvas_rgb.len());

        let max_delta = decoded
            .as_raw()
            .iter()
            .zip(canvas_rgb.iter())
            .map(|(a, b)| (*a as i32 - *b as i32).unsigned_abs())
            .max()
            .unwrap_or(0);
        assert_eq!(
            max_delta, 0,
            "export diverged from the canvas render by up to {max_delta}/255"
        );
    }

    /// A high-quality JPEG export must match the canvas to within JPEG's own
    /// compression noise — nothing systematic on top of it.
    #[test]
    #[ignore = "renders at native resolution (~2 min); run with --ignored"]
    fn a_jpeg_export_matches_the_canvas_within_compression_noise() {
        let Some(raw) = fixture() else { return };

        let canvas = crate::render_bytes(&raw, "dng", None).expect("render_bytes");
        let canvas_rgb = canvas.rgb();

        let exported = export_core(&raw, "dng", None, "jpeg", 95, "srgb", 0).expect("export");
        let decoded = image::load_from_memory(&exported.bytes)
            .expect("exported JPEG must decode")
            .to_rgb8();
        assert_eq!(decoded.as_raw().len(), canvas_rgb.len());

        let squared_error: f64 = decoded
            .as_raw()
            .iter()
            .zip(canvas_rgb.iter())
            .map(|(a, b)| {
                let d = *a as f64 - *b as f64;
                d * d
            })
            .sum();
        let rmse = (squared_error / canvas_rgb.len() as f64).sqrt();
        // Quality-95 4:4:4 JPEG on photographic content sits near 1 LSB RMSE;
        // a pipeline divergence would be far larger.
        assert!(
            rmse < 3.0,
            "JPEG export RMSE vs canvas was {rmse:.3}/255 — larger than compression noise"
        );
    }

    /// The resize control must actually bound the long edge, and never upscale.
    #[test]
    #[ignore = "renders at native resolution (~4 min); run with --ignored"]
    fn max_long_edge_caps_the_output_and_never_upscales() {
        let Some(raw) = fixture() else { return };

        let capped = export_core(&raw, "dng", None, "png", 100, "srgb", 512).expect("export");
        assert_eq!(
            capped.width().max(capped.height()),
            512,
            "long edge should have been capped to 512"
        );

        let native = export_core(&raw, "dng", None, "png", 100, "srgb", 0).expect("export");
        let huge = export_core(&raw, "dng", None, "png", 100, "srgb", 1_000_000).expect("export");
        assert_eq!(
            (huge.width(), huge.height()),
            (native.width(), native.height()),
            "a cap above the native long edge must not upscale"
        );
    }

    /// The 16-bit TIFF must carry real 16-bit data, not the 8-bit buffer
    /// widened by ×257 — the distinction the whole depth split exists for.
    #[test]
    fn the_tiff_export_carries_genuine_sixteen_bit_samples() {
        let Some(raw) = fixture() else { return };

        let exported = export_core(&raw, "dng", None, "tiff", 100, "srgb", 512).expect("export");
        let decoded = image::load_from_memory(&exported.bytes).expect("exported TIFF must decode");
        let samples = decoded.to_rgb16();
        assert!(
            samples.as_raw().iter().any(|v| v % 257 != 0),
            "every TIFF sample was a multiple of 257 — this is 8-bit data in a 16-bit box"
        );
    }

    /// The two colour-space options must produce genuinely different files.
    #[test]
    fn the_colour_space_option_changes_the_exported_file() {
        let Some(raw) = fixture() else { return };

        let srgb = export_core(&raw, "dng", None, "png", 100, "srgb", 256).expect("export");
        let p3 = export_core(&raw, "dng", None, "png", 100, "display-p3", 256).expect("export");
        assert_ne!(
            srgb.bytes, p3.bytes,
            "sRGB and Display P3 exports must not be identical files"
        );
    }
}
