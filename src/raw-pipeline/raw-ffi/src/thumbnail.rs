//! Embedded-preview thumbnail extractor — two sibling externs sharing one
//! extraction/resize/orientation core, differing only in output format:
//!   - `maple_render_thumbnail_avif_to_file` — the 256px grid-thumbnail tier
//!     (`.maple/thumbs/`). AVIF, default quality 55.
//!   - `maple_render_thumbnail_preview_jpeg_to_file` — the 1280px VLM
//!     describe/OCR preview tier (`src/api/src/indexer/previewer.ts`).
//!     JPEG, default quality 85 — every describe provider (Anthropic,
//!     Gemini, Ollama, OpenAI) hardcodes `image/jpeg` as the media type it
//!     sends upstream, so this tier must keep emitting real JPEG bytes
//!     regardless of the grid-thumbnail format.
//!
//! Avoids the full decode → pipeline → downsample chain entirely:
//! every modern RAW container (DNG, CR3, ARW, NEF, RAF, ORF, RW2, …) embeds
//! a multi-MP JPEG preview that's exactly what we want for a grid tile.
//! Reading that takes a few MB and milliseconds; running the pipeline takes
//! gigabytes and seconds, and on Bun 1.3.12 the `with_large_stack` worker-
//! thread cleanup races against `bun:ffi` and segfaults on subsequent calls
//! after async I/O. This path stays on the calling thread end-to-end and
//! uses bounded memory (preview JPEG → decoded RGB → resized RGB →
//! re-encoded output; ~tens of MB peak on a 100MP DNG).
//!
//! File-output only (no bytes-returning sibling): Rust writes the resulting
//! image directly to `out_path` (atomic via .tmp + rename), so no
//! Rust-allocated memory crosses the FFI boundary as a buffer. Bun 1.3.x's
//! `bun:ffi` `toBuffer(ptr, 0, len)` returns a Node Buffer backed by external
//! memory; when the Buffer becomes unreachable JSC's GC sweep tries to free
//! the underlying ArrayBuffer using its own allocator, but the memory was
//! allocated by Rust's `Box::into_raw` — a double-free that segfaults the
//! process during a future GC cycle, sometimes minutes after the FFI call.
//! File-output sidesteps the issue: Rust owns its allocations end-to-end and
//! JS just reads the resulting file. The cost is one extra fs read, which is
//! negligible (the route writes-through to the same cache file anyway).
//!
//! The actual extraction (rawler preview/full/thumbnail-slot hunt) lives in
//! `raw_core::preview::extract_embedded_preview` — shared with `raw-wasm`'s
//! browser-safe binding (#2010) so the two platforms can't drift. This file
//! is the native, file-based, dual-format (AVIF/JPEG) wrapper around it.

use crate::error::set_last_error;
use std::ffi::{c_char, CStr};

/// Shared core for both externs below: extract the embedded preview,
/// downsample to `max_px` on the long edge, bake in EXIF orientation, encode
/// via `encode` (either `raw_core::avif::encode` or `raw_core::jpeg::encode`
/// — same `(width, height, rgb, quality) -> Result<Vec<u8>>` shape), and
/// atomic-write the result to `out_path` (.tmp + rename).
///
/// `quality` is on the target codec's own scale, [1, 100]; pass 0 to use
/// `default_quality`. Values > 100 are rejected (rc 14).
///
/// Returns 0 on success; non-zero on error (call `maple_last_error`).
unsafe fn render_thumbnail_to_file(
    raw_path: *const c_char,
    out_path: *const c_char,
    max_px: u32,
    quality: u8,
    default_quality: u8,
    encode: fn(u32, u32, &[u8], u8) -> raw_core::error::Result<Vec<u8>>,
    encode_err_label: &str,
) -> i32 {
    if raw_path.is_null() || out_path.is_null() {
        set_last_error("null pointer argument".into());
        return 1;
    }
    if max_px == 0 {
        set_last_error("max_px must be > 0".into());
        return 9;
    }
    if quality > 100 {
        set_last_error(format!("quality must be in [1, 100] (got {})", quality));
        return 14;
    }
    let raw_path_str = match CStr::from_ptr(raw_path).to_str() {
        Ok(s) => s.to_owned(),
        Err(e) => {
            set_last_error(format!("raw_path not UTF-8: {}", e));
            return 2;
        }
    };
    let out_path_str = match CStr::from_ptr(out_path).to_str() {
        Ok(s) => s.to_owned(),
        Err(e) => {
            set_last_error(format!("out_path not UTF-8: {}", e));
            return 3;
        }
    };
    let q = if quality == 0 {
        default_quality
    } else {
        quality
    };

    let raw_path = std::path::Path::new(&raw_path_str);
    let out_path = std::path::Path::new(&out_path_str);
    let raw_bytes = match std::fs::read(raw_path) {
        Ok(b) => b,
        Err(e) => {
            set_last_error(format!("raw read: {}", e));
            return 6;
        }
    };

    // Extension hint for rawler's format detection — same derivation as
    // `raw_core::decode::decode`'s path→bytes delegation to `decode_bytes`.
    let ext = raw_path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    let (dyn_img, orientation) = match raw_core::preview::extract_embedded_preview(&raw_bytes, &ext)
    {
        Ok(pair) => pair,
        Err(raw_core::Error::Preview(msg)) => {
            let panicked = msg.contains("panicked");
            set_last_error(msg);
            return if panicked { 11 } else { 8 };
        }
        Err(e) => {
            // Unreachable in practice — `extract_embedded_preview` only ever
            // returns `Error::Preview` — but handled defensively so a future
            // change to that contract can't silently drop the message here.
            set_last_error(e.to_string());
            return 8;
        }
    };

    let resized = raw_core::preview::resize_long_edge(dyn_img, max_px);
    let rgb_img = resized.to_rgb8();
    let (rw, rh) = rgb_img.dimensions();
    // Bake EXIF orientation into the pixels — rawler hands back the
    // embedded preview in its native (usually sensor) orientation and the
    // re-encode below carries no EXIF, so rotating here is the only chance
    // to land an upright thumb on disk.
    let (ow, oh, oriented) =
        raw_core::image::apply_orientation(rgb_img.as_raw(), rw, rh, orientation);
    let encoded = match encode(ow, oh, &oriented, q) {
        Ok(b) => b,
        Err(e) => {
            set_last_error(format!("{} encode: {}", encode_err_label, e));
            return 10;
        }
    };

    // Atomic write: write to .tmp, then rename. The parent dir must exist
    // (the caller ensures the cache directory is mkdir'd before calling).
    let mut tmp_path = std::ffi::OsString::from(out_path);
    tmp_path.push(".tmp");
    let tmp_path = std::path::PathBuf::from(tmp_path);
    if let Err(e) = std::fs::write(&tmp_path, &encoded) {
        set_last_error(format!("tmp write: {}", e));
        return 12;
    }
    if let Err(e) = std::fs::rename(&tmp_path, out_path) {
        let _ = std::fs::remove_file(&tmp_path);
        set_last_error(format!("rename: {}", e));
        return 13;
    }
    0
}

/// Extract an embedded JPEG preview / thumbnail from `raw_path`, downsample
/// to `max_px` on the long edge if necessary, then AVIF-encode the result to
/// `out_path` (atomic via .tmp + rename). The 256px grid-thumbnail tier.
///
/// `quality` is AVIF quality in [1, 100] (AVIF's own scale, not JPEG's —
/// see `raw_core::avif::encode`'s doc comment); pass 0 to use the default
/// (55).
///
/// Returns 0 on success; non-zero on error (call `maple_last_error`).
#[no_mangle]
pub unsafe extern "C" fn maple_render_thumbnail_avif_to_file(
    raw_path: *const c_char,
    out_path: *const c_char,
    max_px: u32,
    quality: u8,
) -> i32 {
    render_thumbnail_to_file(
        raw_path,
        out_path,
        max_px,
        quality,
        55,
        raw_core::avif::encode,
        "avif",
    )
}

/// Extract an embedded JPEG preview / thumbnail from `raw_path`, downsample
/// to `max_px` on the long edge if necessary, then JPEG-encode the result to
/// `out_path` (atomic via .tmp + rename). The 1280px VLM describe/OCR
/// preview tier (`previewer.ts`) — kept JPEG because every describe
/// provider hardcodes `image/jpeg` as the media type sent upstream.
///
/// `quality` is JPEG quality in [1, 100]; pass 0 to use the default (85).
///
/// Returns 0 on success; non-zero on error (call `maple_last_error`).
#[no_mangle]
pub unsafe extern "C" fn maple_render_thumbnail_preview_jpeg_to_file(
    raw_path: *const c_char,
    out_path: *const c_char,
    max_px: u32,
    quality: u8,
) -> i32 {
    render_thumbnail_to_file(
        raw_path,
        out_path,
        max_px,
        quality,
        85,
        raw_core::jpeg::encode,
        "jpeg",
    )
}
