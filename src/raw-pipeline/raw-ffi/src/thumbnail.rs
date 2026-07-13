//! Embedded-preview thumbnail extractor — `maple_render_thumbnail_avif_to_file`.
//!
//! Avoids the full decode → pipeline → downsample chain entirely:
//! every modern RAW container (DNG, CR3, ARW, NEF, RAF, ORF, RW2, …) embeds
//! a multi-MP JPEG preview that's exactly what we want for a grid tile.
//! Reading that takes a few MB and milliseconds; running the pipeline takes
//! gigabytes and seconds, and on Bun 1.3.12 the `with_large_stack` worker-
//! thread cleanup races against `bun:ffi` and segfaults on subsequent calls
//! after async I/O. This path stays on the calling thread end-to-end and
//! uses bounded memory (preview JPEG → decoded RGB → resized RGB → re-encoded
//! AVIF; ~tens of MB peak on a 100MP DNG).
//!
//! File-output only (no bytes-returning sibling): Rust writes the resulting
//! AVIF directly to `out_path` (atomic via .tmp + rename), so no
//! Rust-allocated memory crosses the FFI boundary as a buffer. Bun 1.3.x's
//! `bun:ffi` `toBuffer(ptr, 0, len)` returns a Node Buffer backed by external
//! memory; when the Buffer becomes unreachable JSC's GC sweep tries to free
//! the underlying ArrayBuffer using its own allocator, but the memory was
//! allocated by Rust's `Box::into_raw` — a double-free that segfaults the
//! process during a future GC cycle, sometimes minutes after the FFI call.
//! File-output sidesteps the issue: Rust owns its allocations end-to-end and
//! JS just reads the resulting file. The cost is one extra fs read, which is
//! negligible (the route writes-through to the same cache file anyway).

use crate::error::set_last_error;
use raw_core::ExifOrientation;
use std::ffi::{c_char, CStr};

/// Common rawler preview-image extraction used by both entries.
///
/// Try `preview_image` first (largest embedded), fall back to `full_image`
/// (DNG SubIFD), then `thumbnail_image` (tiny root-IFD thumb). If none
/// exists, return an error — the caller may decide to fall through to a
/// full pipeline render.
///
/// Also returns the source's EXIF orientation so the caller can bake the
/// rotation into the pixels. Embedded preview JPEGs (and the rawler decode
/// path that delivers them as a `DynamicImage`) are typically in sensor
/// orientation with no EXIF carried through; without applying the tag here
/// portrait shots end up sideways on disk.
fn extract_embedded_preview(
    raw_bytes: &[u8],
    raw_path: &std::path::Path,
) -> Result<(image::DynamicImage, ExifOrientation), String> {
    // Wrap the entire decoder + image extraction in catch_unwind. Rawler can
    // panic on malformed RAWs; if that panic unwinds across the FFI boundary
    // it's UB and Bun bus-errors the whole process. Catching it lets us
    // return a proper error code instead.
    let extract = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let source = rawler::rawsource::RawSource::new_from_slice(raw_bytes).with_path(raw_path);
        let decoder = rawler::get_decoder(&source).map_err(|e| format!("get_decoder: {}", e))?;
        let params = rawler::decoders::RawDecodeParams::default();

        // EXIF orientation. Pull from `raw_metadata().exif.orientation` —
        // the raw TIFF tag — same source the full decode path uses
        // (`decode::decode_bytes` § 1a). Works across DNG/CR2/ARW/NEF;
        // defaults to Normal when missing.
        let orientation = decoder
            .raw_metadata(&source, &params)
            .ok()
            .and_then(|md| md.exif.orientation)
            .map(ExifOrientation::from_u16)
            .unwrap_or(ExifOrientation::Normal);

        // Embedded preview hunt — different decoders put the largest
        // embedded JPEG in different rawler slots:
        //   - DNG uses `full_image()` for the SubIFD preview
        //     (NewSubFileType=1) — the multi-MP one most converters embed.
        //   - Most non-DNG formats (CR3, ARW, NEF, RAF) override
        //     `preview_image()` with the embedded JPEG.
        //   - `thumbnail_image()` is the tiny root-IFD thumb (~160px).
        // Try preview → full → thumbnail in priority order so we pick the
        // best available embedded JPEG without running the actual RAW
        // pipeline. `full_image` for non-DNG decoders may also fall through
        // to None, which is fine.
        let try_slot =
            |result: Result<Option<image::DynamicImage>, _>| -> Option<image::DynamicImage> {
                match result {
                    Ok(Some(img)) => Some(img),
                    Ok(None) | Err(_) => None,
                }
            };
        let img = try_slot(decoder.preview_image(&source, &params))
            .or_else(|| try_slot(decoder.full_image(&source, &params)))
            .or_else(|| try_slot(decoder.thumbnail_image(&source, &params)));
        match img {
            Some(i) => Ok::<(image::DynamicImage, ExifOrientation), String>((i, orientation)),
            None => Err("no embedded preview / thumbnail in RAW".into()),
        }
    }));
    match extract {
        Ok(Ok(pair)) => Ok(pair),
        Ok(Err(msg)) => Err(msg),
        Err(_) => Err("rawler panicked during preview extraction".into()),
    }
}

/// Bake the EXIF orientation into the pixels of an already-decoded RGB8
/// buffer. Returns `(width, height, bytes)`, where width/height are swapped
/// for transpose-family orientations. A `Normal` input is the identity but
/// still allocates a fresh buffer — at thumbnail resolutions this is
/// cheaper than threading an `Option` through the encode call site.
fn bake_orientation(
    w: u32,
    h: u32,
    rgb: &[u8],
    orientation: ExifOrientation,
) -> (u32, u32, Vec<u8>) {
    raw_core::image::apply_orientation(rgb, w, h, orientation)
}

/// Resize `img` so the long edge is at most `max_px`, preserving aspect
/// ratio, never upscaling. Triangle filter: cheap and visually fine for
/// grid thumbs; Lanczos would be sharper but ~3× slower with no
/// perceptible win at 512px.
pub(crate) fn resize_long_edge(img: image::DynamicImage, max_px: u32) -> image::DynamicImage {
    use image::GenericImageView;
    let (w, h) = img.dimensions();
    let long_edge = w.max(h);
    if long_edge <= max_px {
        return img;
    }
    let scale = max_px as f32 / long_edge as f32;
    let new_w = ((w as f32) * scale).round().max(1.0) as u32;
    let new_h = ((h as f32) * scale).round().max(1.0) as u32;
    img.resize_exact(new_w, new_h, image::imageops::FilterType::Triangle)
}

/// Extract an embedded JPEG preview / thumbnail from `raw_path`, downsample
/// to `max_px` on the long edge if necessary, then AVIF-encode the result to
/// `out_path` (atomic via .tmp + rename).
///
/// `quality` is AVIF quality in [1, 100] (AVIF's own scale, not JPEG's —
/// see `raw_core::avif::encode`'s doc comment); pass 0 to use the default
/// (55). Values > 100 are rejected (rc 14) — `u8` allows up to 255 and the
/// AVIF encoder clamps anything > 100 silently, which is not what callers
/// mean.
///
/// Returns 0 on success; non-zero on error (call `maple_last_error`).
#[no_mangle]
pub unsafe extern "C" fn maple_render_thumbnail_avif_to_file(
    raw_path: *const c_char,
    out_path: *const c_char,
    max_px: u32,
    quality: u8,
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
    let q = if quality == 0 { 55 } else { quality };

    let raw_path = std::path::Path::new(&raw_path_str);
    let out_path = std::path::Path::new(&out_path_str);
    let raw_bytes = match std::fs::read(raw_path) {
        Ok(b) => b,
        Err(e) => {
            set_last_error(format!("raw read: {}", e));
            return 6;
        }
    };

    let (dyn_img, orientation) = match extract_embedded_preview(&raw_bytes, raw_path) {
        Ok(pair) => pair,
        Err(msg) => {
            let panicked = msg.contains("panicked");
            set_last_error(msg);
            return if panicked { 11 } else { 8 };
        }
    };

    let resized = resize_long_edge(dyn_img, max_px);
    let rgb_img = resized.to_rgb8();
    let (rw, rh) = rgb_img.dimensions();
    // Bake EXIF orientation into the pixels — rawler hands back the
    // embedded preview in its native (usually sensor) orientation and the
    // AVIF re-encode below carries no EXIF, so rotating here is the only
    // chance to land an upright thumb on disk.
    let (ow, oh, oriented) = bake_orientation(rw, rh, rgb_img.as_raw(), orientation);
    let avif = match raw_core::avif::encode(ow, oh, &oriented, q) {
        Ok(b) => b,
        Err(e) => {
            set_last_error(format!("avif encode: {}", e));
            return 10;
        }
    };

    // Atomic write: write to .tmp, then rename. The parent dir must exist
    // (the caller ensures `.maple/thumbs/` is mkdir'd before calling).
    let mut tmp_path = std::ffi::OsString::from(out_path);
    tmp_path.push(".tmp");
    let tmp_path = std::path::PathBuf::from(tmp_path);
    if let Err(e) = std::fs::write(&tmp_path, &avif) {
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
