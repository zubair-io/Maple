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
//! The file-output externs write the resulting image directly to `out_path`
//! (atomic via exclusive staging + rename), so no Rust-allocated memory
//! crosses the FFI boundary as a buffer. Bun 1.3.x's
//! `bun:ffi` `toBuffer(ptr, 0, len)` returns a Node Buffer backed by external
//! memory; when the Buffer becomes unreachable JSC's GC sweep tries to free
//! the underlying ArrayBuffer using its own allocator, but the memory was
//! allocated by Rust's `Box::into_raw` — a double-free that segfaults the
//! process during a future GC cycle, sometimes minutes after the FFI call.
//! File-output sidesteps the issue: Rust owns its allocations end-to-end and
//! JS just reads the resulting file. The cost is one extra fs read, which is
//! negligible (the route writes-through to the same cache file anyway).
//!
//! `maple_render_thumbnail_preview_jpeg_buf` is the in-memory sibling for
//! Apple (#6018): it copies into a caller-owned buffer, so it keeps the same
//! no-Rust-allocation-crosses rule while skipping the temp file and its
//! `fsync`. rc 100 means the buffer was too small and `*out_len` holds the
//! size needed; a null `out_buf` is a size probe.
//!
//! The actual extraction (rawler preview/full/thumbnail-slot hunt) lives in
//! `raw_core::preview::extract_embedded_preview` — shared with `raw-wasm`'s
//! browser-safe binding (#2010) so the two platforms can't drift. This file
//! is the native, file-based, dual-format (AVIF/JPEG) wrapper around it.

use crate::error::set_last_error;
use std::ffi::{c_char, CStr};

#[path = "thumbnail_raster.rs"]
mod raster;

/// Shared core for every extern below: extract the embedded preview,
/// downsample to `max_px` on the long edge, bake in EXIF orientation and
/// encode via `encode` (`raw_core::avif::encode` or `raw_core::jpeg::encode`).
///
/// `quality` is on the target codec's own scale, [1, 100]; pass 0 to use
/// `default_quality`. Values > 100 are rejected (rc 14).
///
/// `Err` carries the extern return code; the message is already set.
unsafe fn render_thumbnail_bytes(
    raw_path: &std::path::Path,
    max_px: u32,
    quality: u8,
    default_quality: u8,
    encode: fn(u32, u32, &[u8], u8) -> raw_core::error::Result<Vec<u8>>,
    encode_err_label: &str,
) -> Result<Vec<u8>, i32> {
    if max_px == 0 {
        set_last_error("max_px must be > 0".into());
        return Err(9);
    }
    if quality > 100 {
        set_last_error(format!("quality must be in [1, 100] (got {})", quality));
        return Err(14);
    }
    let q = if quality == 0 {
        default_quality
    } else {
        quality
    };
    let raw_bytes = std::fs::read(raw_path).map_err(|e| {
        set_last_error(format!("raw read: {}", e));
        6
    })?;

    // Extension hint for rawler's format detection — same derivation as
    // `raw_core::decode::decode`'s path→bytes delegation to `decode_bytes`.
    let ext = raw_path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    let (ow, oh, oriented) = if raster::is_raster(&raw_bytes, &ext) {
        raster::pixels(&raw_bytes, max_px).map_err(|error| {
            set_last_error(error.to_string());
            8
        })?
    } else {
        let (dyn_img, orientation) = raw_core::preview::extract_embedded_preview(&raw_bytes, &ext)
            .map_err(|e| match e {
                raw_core::Error::Preview(msg) => {
                    let panicked = msg.contains("panicked");
                    set_last_error(msg);
                    if panicked {
                        11
                    } else {
                        8
                    }
                }
                other => {
                    set_last_error(other.to_string());
                    8
                }
            })?;
        let rgb_img = raw_core::preview::resize_long_edge(dyn_img, max_px);
        let (rw, rh) = rgb_img.dimensions();
        // The re-encode carries no EXIF, so rotating here is the only chance
        // to land an upright thumbnail.
        raw_core::image::apply_orientation(rgb_img.as_raw(), rw, rh, orientation)
    };
    encode(ow, oh, &oriented, q).map_err(|e| {
        set_last_error(format!("{} encode: {}", encode_err_label, e));
        10
    })
}

unsafe fn utf8_path(ptr: *const c_char, label: &str, rc: i32) -> Result<std::path::PathBuf, i32> {
    CStr::from_ptr(ptr)
        .to_str()
        .map(std::path::PathBuf::from)
        .map_err(|e| {
            set_last_error(format!("{label} not UTF-8: {e}"));
            rc
        })
}

/// File-output wrapper around [`render_thumbnail_bytes`]: atomic-writes the
/// result to `out_path` (exclusive staging + rename).
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
    let paths = utf8_path(raw_path, "raw_path", 2)
        .and_then(|raw| utf8_path(out_path, "out_path", 3).map(|out| (raw, out)));
    let (raw_path, out_path) = match paths {
        Ok(pair) => pair,
        Err(rc) => return rc,
    };
    let inputs = [raw_path.as_path()];
    if let Err(e) = raw_core::output_file::validate_destination(&out_path, &inputs) {
        set_last_error(format!("output: {e}"));
        return 12;
    }
    let encoded = match render_thumbnail_bytes(
        &raw_path,
        max_px,
        quality,
        default_quality,
        encode,
        encode_err_label,
    ) {
        Ok(bytes) => bytes,
        Err(rc) => return rc,
    };
    if let Err(e) = raw_core::output_file::write_derived(&out_path, &inputs, &encoded) {
        set_last_error(format!("output write: {e}"));
        return 12;
    }
    0
}

/// Extract an embedded JPEG preview / thumbnail from `raw_path`, downsample
/// to `max_px` on the long edge if necessary, then AVIF-encode the result to
/// `out_path` (atomic via exclusive staging + rename). The 256px grid-thumbnail tier.
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
    crate::error::catch_panic_rc("maple_render_thumbnail_avif_to_file", || {
        render_thumbnail_to_file(
            raw_path,
            out_path,
            max_px,
            quality,
            55,
            raw_core::avif::encode,
            "avif",
        )
    })
}

/// Extract an embedded JPEG preview / thumbnail from `raw_path`, downsample
/// to `max_px` on the long edge if necessary, then JPEG-encode the result to
/// `out_path` (atomic via exclusive staging + rename). The 1280px VLM describe/OCR
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
    crate::error::catch_panic_rc("maple_render_thumbnail_preview_jpeg_to_file", || {
        render_thumbnail_to_file(
            raw_path,
            out_path,
            max_px,
            quality,
            85,
            raw_core::jpeg::encode,
            "jpeg",
        )
    })
}

const NEED_LARGER_BUFFER: i32 = 100;

/// In-memory sibling of [`maple_render_thumbnail_preview_jpeg_to_file`]:
/// the same 1280px-tier JPEG, copied into `out_buf` instead of a file.
///
/// Returns 0 on success, 100 when `out_cap` is too small (`*out_len` holds
/// the size needed), and otherwise the file extern's codes.
///
/// # Safety
/// `raw_path` must be a NUL-terminated string and `out_len` non-null. A
/// non-null `out_buf` must hold `out_cap` bytes.
#[no_mangle]
pub unsafe extern "C" fn maple_render_thumbnail_preview_jpeg_buf(
    raw_path: *const c_char,
    max_px: u32,
    quality: u8,
    out_buf: *mut u8,
    out_cap: usize,
    out_len: *mut usize,
) -> i32 {
    crate::error::catch_panic_rc("maple_render_thumbnail_preview_jpeg_buf", || {
        if raw_path.is_null() || out_len.is_null() {
            set_last_error("null pointer argument".into());
            return 1;
        }
        let encoded = match utf8_path(raw_path, "raw_path", 2).and_then(|path| {
            render_thumbnail_bytes(&path, max_px, quality, 85, raw_core::jpeg::encode, "jpeg")
        }) {
            Ok(bytes) => bytes,
            Err(rc) => return rc,
        };
        *out_len = encoded.len();
        if out_buf.is_null() || out_cap < encoded.len() {
            return NEED_LARGER_BUFFER;
        }
        std::ptr::copy_nonoverlapping(encoded.as_ptr(), out_buf, encoded.len());
        0
    })
}
