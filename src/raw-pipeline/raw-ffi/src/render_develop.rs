//! Developed-preview FFI — `maple_render_develop_jpeg_to_file` (#1950).
//!
//! Split from `render.rs` for the file-size budget. This is the DEVELOPED
//! JPEG-to-file extern behind the self-hosted `display-preview` stage: it
//! composes the XMP-applied develop path (as in `maple_render_file`) with the
//! downsample + JPEG-encode + atomic file write of the embedded-preview
//! thumbnail path.

use crate::error::{set_last_error, with_large_stack};
use crate::model::{load_xmp_model_owned, LoadModel};
use raw_core::{
    decode::decode_bytes,
    pipeline::{render_from_raw_with_quality_and_source, RawInput, RenderQuality},
};
use std::ffi::{c_char, CStr};

/// Develop a RAW with its XMP sidecar applied, downsample to `max_px` on the
/// long edge, JPEG-encode, and write the result atomically to `out_path`.
///
/// This is the DEVELOPED counterpart to `maple_render_thumbnail_jpeg_to_file`:
/// where that extracts the camera's *embedded* preview and applies no
/// adjustments, this runs the full raw-core develop chain — the same pixels
/// the editor and `maple-cli` produce — so a server-side preview of an EDITED
/// asset reflects its sidecar (#1950, the self-hosted `display-preview` stage).
///
/// `xmp_path` may be null, in which case `AdjustmentModel::default()` renders
/// the neutral develop. The develop output is already display-oriented
/// (raw-core applies EXIF orientation as its final render stage), so — unlike
/// the embedded-preview thumbnail path — no orientation is baked here.
///
/// Uses AMaZE demosaic (`RenderQuality::Amaze`): this is a cache-populating
/// background stage, not the interactive fast path, so it favours quality.
///
/// File-output (rather than a returned `MapleByteBuffer`) for the same
/// `bun:ffi` double-free reason documented on
/// `maple_render_thumbnail_jpeg_to_file`: Rust owns every allocation
/// end-to-end and JS just reads the file. `quality` is JPEG quality in
/// [1, 100]; pass 0 for the default (82). The parent dir of `out_path` must
/// already exist. Returns 0 on success; non-zero on error (call
/// `maple_last_error`).
#[no_mangle]
pub unsafe extern "C" fn maple_render_develop_jpeg_to_file(
    raw_path: *const c_char,
    xmp_path: *const c_char,
    max_px: u32,
    quality: u8,
    out_path: *const c_char,
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
    let xmp_path_str: Option<String> = if xmp_path.is_null() {
        None
    } else {
        match CStr::from_ptr(xmp_path).to_str() {
            Ok(s) => Some(s.to_owned()),
            Err(e) => {
                set_last_error(format!("xmp_path not UTF-8: {}", e));
                return 3;
            }
        }
    };
    let out_path_str = match CStr::from_ptr(out_path).to_str() {
        Ok(s) => s.to_owned(),
        Err(e) => {
            set_last_error(format!("out_path not UTF-8: {}", e));
            return 4;
        }
    };
    let q = if quality == 0 { 82 } else { quality };

    with_large_stack(move || {
        let raw_path = std::path::Path::new(&raw_path_str);
        let model = match load_xmp_model_owned(xmp_path_str.as_deref()) {
            LoadModel::Ok(m) => m,
            LoadModel::Err(rc) => return rc,
        };
        let raw_bytes = match raw_core::pipeline::stage("ffi_raw_read", || std::fs::read(raw_path))
        {
            Ok(b) => b,
            Err(e) => {
                set_last_error(format!("raw read: {}", e));
                return 6;
            }
        };
        let ext = raw_path.extension().and_then(|e| e.to_str()).unwrap_or("");
        let raw_img = match raw_core::pipeline::stage("ffi_rawler_decode", || {
            decode_bytes(&raw_bytes, ext)
        }) {
            Ok(r) => r,
            Err(e) => {
                set_last_error(format!("decode: {}", e));
                return 7;
            }
        };
        let (w, h, bytes) = match render_from_raw_with_quality_and_source(
            &raw_img,
            &model,
            RenderQuality::Amaze,
            Some(RawInput::Path(raw_path)),
        ) {
            Ok(t) => t,
            Err(e) => {
                set_last_error(format!("render: {}", e));
                return 8;
            }
        };
        // The develop output is a tightly-packed, display-oriented RGB888
        // buffer. Wrap → resize to the long-edge target → JPEG-encode.
        let rgb = match image::RgbImage::from_raw(w, h, bytes) {
            Some(img) => img,
            None => {
                set_last_error("develop buffer size mismatch".into());
                return 10;
            }
        };
        let resized =
            raw_core::preview::resize_long_edge(image::DynamicImage::ImageRgb8(rgb), max_px);
        let rgb_img = resized.to_rgb8();
        let (rw, rh) = rgb_img.dimensions();
        let jpeg = match raw_core::jpeg::encode(rw, rh, rgb_img.as_raw(), q) {
            Ok(b) => b,
            Err(e) => {
                set_last_error(format!("jpeg encode: {}", e));
                return 10;
            }
        };

        // Atomic write: .tmp + rename. Parent dir is the caller's contract.
        let out_path = std::path::Path::new(&out_path_str);
        let mut tmp_path = std::ffi::OsString::from(out_path);
        tmp_path.push(".tmp");
        let tmp_path = std::path::PathBuf::from(tmp_path);
        if let Err(e) = std::fs::write(&tmp_path, &jpeg) {
            set_last_error(format!("tmp write: {}", e));
            return 12;
        }
        if let Err(e) = std::fs::rename(&tmp_path, out_path) {
            let _ = std::fs::remove_file(&tmp_path);
            set_last_error(format!("rename: {}", e));
            return 13;
        }
        0
    })
}
