//! Non-RAW raster image C ABI exports.
//!
//! Provides file-based and caller-buffered endpoints for resizing, format transcoding,
//! metadata probing, and AI/ML tensor extraction without external libvips/sharp dependencies.

use crate::error::set_last_error;
use raw_core::export::{encode_raster, ExportFormat};
use raw_core::raster::{
    decode_raster, extract_tensor, probe_raster_metadata, resize_raster, FilterAlg, ResizeFit,
    ResizeOptions, TensorLayout, TensorNormalize,
};
use std::ffi::{c_char, CStr};
use std::path::Path;

unsafe fn cstr_to_str<'a>(ptr: *const c_char) -> Option<&'a str> {
    if ptr.is_null() {
        return None;
    }
    CStr::from_ptr(ptr).to_str().ok()
}

/// Resize a raster image file (JPEG, PNG, WebP, TIFF) and encode to `out_path`.
///
/// `fit`: 0 = Inside (preserve aspect ratio), 1 = Fill (exact dimensions).
/// `format`: "jpeg", "png", "avif", "webp", "tiff" (or null to infer from `out_path`).
/// `quality`: 1..100 (0 uses default 85).
///
/// Returns 0 on success; non-zero on error.
#[no_mangle]
pub unsafe extern "C" fn maple_raster_resize_to_file(
    input_path: *const c_char,
    out_path: *const c_char,
    width: u32,
    height: u32,
    fit: u32,
    format_ptr: *const c_char,
    quality: u8,
) -> i32 {
    let in_str = match cstr_to_str(input_path) {
        Some(s) => s,
        None => {
            set_last_error("input_path is null or invalid UTF-8".into());
            return 1;
        }
    };
    let out_str = match cstr_to_str(out_path) {
        Some(s) => s,
        None => {
            set_last_error("out_path is null or invalid UTF-8".into());
            return 2;
        }
    };

    if width == 0 || height == 0 {
        set_last_error("target width and height must be non-zero".into());
        return 3;
    }

    let in_path = Path::new(in_str);
    let in_bytes = match std::fs::read(in_path) {
        Ok(b) => b,
        Err(e) => {
            set_last_error(format!("failed to read input file {in_str}: {e}"));
            return 4;
        }
    };

    let ext_hint = in_path.extension().and_then(|e| e.to_str());
    let mut raster = match decode_raster(&in_bytes, ext_hint) {
        Ok(r) => r,
        Err(e) => {
            set_last_error(format!("failed to decode raster: {e}"));
            return 5;
        }
    };

    if (fit & 2) != 0 {
        raster.auto_orient();
    }

    let resize_fit = if (fit & 1) == 1 {
        ResizeFit::Fill
    } else {
        ResizeFit::Inside
    };
    let without_enlargement = (fit & 4) == 0;

    let resize_opts = ResizeOptions {
        width,
        height,
        fit: resize_fit,
        filter: FilterAlg::Lanczos3,
        without_enlargement,
    };

    let resized = match resize_raster(&raster, &resize_opts) {
        Ok(r) => r,
        Err(e) => {
            set_last_error(format!("resizing failed: {e}"));
            return 6;
        }
    };

    let out_format = if !format_ptr.is_null() {
        match cstr_to_str(format_ptr).and_then(ExportFormat::from_str) {
            Some(f) => f,
            None => {
                set_last_error("unrecognized export format string".into());
                return 7;
            }
        }
    } else {
        match Path::new(out_str)
            .extension()
            .and_then(|e| e.to_str())
            .and_then(ExportFormat::from_str)
        {
            Some(f) => f,
            None => ExportFormat::Jpeg,
        }
    };

    let q = if quality == 0 {
        85
    } else {
        quality.clamp(1, 100)
    };
    let out_bytes = match encode_raster(&resized, out_format, q) {
        Ok(b) => b,
        Err(e) => {
            set_last_error(format!("encoding raster failed: {e}"));
            return 8;
        }
    };

    // Atomic write
    let tmp_path = format!("{}.{}.tmp", out_str, std::process::id());
    if let Err(e) = std::fs::write(&tmp_path, &out_bytes) {
        set_last_error(format!("writing tmp file failed: {e}"));
        return 9;
    }
    if let Err(e) = std::fs::rename(&tmp_path, out_str) {
        set_last_error(format!("renaming to {out_str} failed: {e}"));
        let _ = std::fs::remove_file(&tmp_path);
        return 10;
    }

    0
}

/// Fast metadata probing for raster image files.
///
/// Returns 0 on success, populating `out_width`, `out_height`, `out_channels`, `out_orientation`.
#[no_mangle]
pub unsafe extern "C" fn maple_raster_probe_metadata(
    input_path: *const c_char,
    out_width: *mut u32,
    out_height: *mut u32,
    out_channels: *mut u32,
    out_orientation: *mut u32,
) -> i32 {
    let in_str = match cstr_to_str(input_path) {
        Some(s) => s,
        None => {
            set_last_error("input_path is null or invalid UTF-8".into());
            return 1;
        }
    };

    let in_bytes = match std::fs::read(Path::new(in_str)) {
        Ok(b) => b,
        Err(e) => {
            set_last_error(format!("failed to read file {in_str}: {e}"));
            return 2;
        }
    };

    let meta = match probe_raster_metadata(&in_bytes) {
        Ok(m) => m,
        Err(e) => {
            set_last_error(format!("metadata probing failed: {e}"));
            return 3;
        }
    };

    if !out_width.is_null() {
        *out_width = meta.width;
    }
    if !out_height.is_null() {
        *out_height = meta.height;
    }
    if !out_channels.is_null() {
        *out_channels = meta.channels as u32;
    }
    if !out_orientation.is_null() {
        *out_orientation = meta.orientation as u32;
    }

    0
}

/// Extract Float32 tensor for AI/ML inference into a caller-allocated buffer.
///
/// `layout`: 0 = NCHW (planar), 1 = HWC (interleaved).
/// `normalize`: 0 = None (raw 0..255), 1 = InsightFace ((px-127.5)/128), 2 = ZeroToOne (px/255).
///
/// Returns 0 on success; non-zero on error.
#[no_mangle]
pub unsafe extern "C" fn maple_raster_extract_tensor_buf(
    input_bytes: *const u8,
    input_len: usize,
    target_size: u32,
    layout: u32,
    normalize: u32,
    out_buf: *mut f32,
    out_cap: usize,
    out_len: *mut usize,
) -> i32 {
    if input_bytes.is_null() || input_len == 0 {
        set_last_error("input buffer is null or empty".into());
        return 1;
    }
    if out_buf.is_null() || out_len.is_null() {
        set_last_error("out_buf or out_len is null".into());
        return 2;
    }

    let bytes = std::slice::from_raw_parts(input_bytes, input_len);
    let raster = match decode_raster(bytes, None) {
        Ok(r) => r,
        Err(e) => {
            set_last_error(format!("failed to decode raster: {e}"));
            return 3;
        }
    };

    let target_w = if target_size == 0 {
        raster.width
    } else {
        target_size
    };
    let target_h = if target_size == 0 {
        raster.height
    } else {
        target_size
    };

    let resized = if target_w != raster.width || target_h != raster.height {
        let resize_opts = ResizeOptions {
            width: target_w,
            height: target_h,
            fit: ResizeFit::Fill,
            filter: FilterAlg::Bilinear,
            without_enlargement: false,
        };
        match resize_raster(&raster, &resize_opts) {
            Ok(r) => r,
            Err(e) => {
                set_last_error(format!("tensor resize failed: {e}"));
                return 4;
            }
        }
    } else {
        raster
    };

    let t_layout = if layout == 1 {
        TensorLayout::Hwc
    } else {
        TensorLayout::Nchw
    };
    let t_norm = match normalize {
        1 => TensorNormalize::InsightFace,
        2 => TensorNormalize::ZeroToOne,
        _ => TensorNormalize::None,
    };

    let tensor = match extract_tensor(&resized, t_layout, t_norm) {
        Ok(t) => t,
        Err(e) => {
            set_last_error(format!("tensor extraction failed: {e}"));
            return 5;
        }
    };

    let needed_len = tensor.data.len();
    *out_len = needed_len;

    if out_cap < needed_len {
        set_last_error(format!(
            "out_buf capacity {out_cap} is smaller than required {needed_len}"
        ));
        return 6;
    }

    std::ptr::copy_nonoverlapping(tensor.data.as_ptr(), out_buf, needed_len);
    0
}

/// Resize a raster image from memory buffer and encode to output buffer.
///
/// `fit`: bit 0 = Fill (vs Inside), bit 1 = auto_orient, bit 2 = allow enlargement.
///
/// If `out_buf` is null or `out_cap < needed_len`, sets `*out_len = needed_len`
/// and returns error code `100` so caller can allocate buffer of exact size.
#[no_mangle]
pub unsafe extern "C" fn maple_raster_resize_to_buf(
    input_bytes: *const u8,
    input_len: usize,
    width: u32,
    height: u32,
    fit: u32,
    format_ptr: *const c_char,
    quality: u8,
    out_buf: *mut u8,
    out_cap: usize,
    out_len: *mut usize,
) -> i32 {
    if input_bytes.is_null() || input_len == 0 {
        set_last_error("input buffer is null or empty".into());
        return 1;
    }
    if out_len.is_null() {
        set_last_error("out_len is null".into());
        return 2;
    }

    let bytes = std::slice::from_raw_parts(input_bytes, input_len);
    let mut raster = match decode_raster(bytes, None) {
        Ok(r) => r,
        Err(e) => {
            set_last_error(format!("failed to decode raster: {e}"));
            return 3;
        }
    };

    if (fit & 2) != 0 {
        raster.auto_orient();
    }

    let target_w = if width == 0 { raster.width } else { width };
    let target_h = if height == 0 { raster.height } else { height };

    let resize_fit = if (fit & 1) == 1 {
        ResizeFit::Fill
    } else {
        ResizeFit::Inside
    };
    let without_enlargement = (fit & 4) == 0;

    let resize_opts = ResizeOptions {
        width: target_w,
        height: target_h,
        fit: resize_fit,
        filter: FilterAlg::Lanczos3,
        without_enlargement,
    };
    let resized = match resize_raster(&raster, &resize_opts) {
        Ok(r) => r,
        Err(e) => {
            set_last_error(format!("resizing failed: {e}"));
            return 4;
        }
    };

    let out_format = if !format_ptr.is_null() {
        match cstr_to_str(format_ptr).and_then(ExportFormat::from_str) {
            Some(f) => f,
            None => {
                set_last_error("unrecognized export format string".into());
                return 5;
            }
        }
    } else {
        ExportFormat::Jpeg
    };

    let q = if quality == 0 {
        85
    } else {
        quality.clamp(1, 100)
    };
    let out_bytes = match encode_raster(&resized, out_format, q) {
        Ok(b) => b,
        Err(e) => {
            set_last_error(format!("encoding raster failed: {e}"));
            return 6;
        }
    };

    let needed_len = out_bytes.len();
    *out_len = needed_len;

    if out_buf.is_null() || out_cap < needed_len {
        return 100;
    }

    std::ptr::copy_nonoverlapping(out_bytes.as_ptr(), out_buf, needed_len);
    0
}

/// Fast metadata probing for raster image buffer in memory.
#[no_mangle]
pub unsafe extern "C" fn maple_raster_probe_metadata_buf(
    input_bytes: *const u8,
    input_len: usize,
    out_width: *mut u32,
    out_height: *mut u32,
    out_channels: *mut u32,
    out_orientation: *mut u32,
    out_format: *mut c_char,
    out_format_cap: usize,
) -> i32 {
    if input_bytes.is_null() || input_len == 0 {
        set_last_error("input buffer is null or empty".into());
        return 1;
    }

    let bytes = std::slice::from_raw_parts(input_bytes, input_len);
    let meta = match probe_raster_metadata(bytes) {
        Ok(m) => m,
        Err(e) => {
            set_last_error(format!("metadata probing failed: {e}"));
            return 2;
        }
    };

    if !out_width.is_null() {
        *out_width = meta.width;
    }
    if !out_height.is_null() {
        *out_height = meta.height;
    }
    if !out_channels.is_null() {
        *out_channels = meta.channels as u32;
    }
    if !out_orientation.is_null() {
        *out_orientation = meta.orientation as u32;
    }
    if !out_format.is_null() && out_format_cap > 0 {
        let fmt_bytes = meta.format.as_bytes();
        let copy_len = fmt_bytes.len().min(out_format_cap.saturating_sub(1));
        std::ptr::copy_nonoverlapping(fmt_bytes.as_ptr(), out_format as *mut u8, copy_len);
        *out_format.add(copy_len) = 0;
    }

    0
}
