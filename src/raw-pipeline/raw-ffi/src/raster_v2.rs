//! Second-generation raster C ABI: one general render entry point (fit,
//! filter, orientation, format, quality, AVIF effort), the same from
//! caller-supplied pixels, and a native-size RGB8 decode. The first-generation
//! functions in `raster.rs` keep their signatures for existing callers.

use crate::error::set_last_error;
use raw_core::export::{encode_raster_with, ExportFormat};
use raw_core::raster::{
    decode_raster, resize_raster, FilterAlg, RasterImage, ResizeFit, ResizeOptions,
};
use std::ffi::{c_char, CStr};

const NEED_LARGER_BUFFER: i32 = 100;
const FLAG_FILL: u32 = 1;
const FLAG_AUTO_ORIENT: u32 = 2;
const FLAG_ALLOW_ENLARGE: u32 = 4;
const FLAG_COVER: u32 = 8;

unsafe fn cstr<'a>(ptr: *const c_char) -> Option<&'a str> {
    if ptr.is_null() {
        None
    } else {
        CStr::from_ptr(ptr).to_str().ok()
    }
}

fn fit_from(flags: u32) -> ResizeFit {
    if flags & FLAG_COVER != 0 {
        ResizeFit::Cover
    } else if flags & FLAG_FILL != 0 {
        ResizeFit::Fill
    } else {
        ResizeFit::Inside
    }
}

fn filter_from(filter: u32) -> FilterAlg {
    match filter {
        1 => FilterAlg::Bilinear,
        2 => FilterAlg::Nearest,
        _ => FilterAlg::Lanczos3,
    }
}

/// sharp-style effort 0 (fastest) … 9 (slowest) → rav1e speed 10 … 1; 0 = default 6.
fn avif_speed_from(effort: u8) -> u8 {
    if effort == 0 {
        6
    } else {
        (10 - effort.min(9)).max(1)
    }
}

struct RenderParams {
    width: u32,
    height: u32,
    flags: u32,
    filter: u32,
    format: ExportFormat,
    quality: u8,
    effort: u8,
}

/// Shared body: orient → resize → encode → copy out (or report size).
unsafe fn render_into(
    mut raster: RasterImage,
    p: &RenderParams,
    out_buf: *mut u8,
    out_cap: usize,
    out_len: *mut usize,
) -> i32 {
    if p.flags & FLAG_AUTO_ORIENT != 0 {
        raster.auto_orient();
    }
    let opts = ResizeOptions {
        width: if p.width == 0 { raster.width } else { p.width },
        height: if p.height == 0 {
            raster.height
        } else {
            p.height
        },
        fit: fit_from(p.flags),
        filter: filter_from(p.filter),
        without_enlargement: p.flags & FLAG_ALLOW_ENLARGE == 0,
    };
    let resized = match resize_raster(&raster, &opts) {
        Ok(r) => r,
        Err(e) => {
            set_last_error(format!("resizing failed: {e}"));
            return 4;
        }
    };
    let quality = if p.quality == 0 {
        85
    } else {
        p.quality.clamp(1, 100)
    };
    let bytes = match encode_raster_with(&resized, p.format, quality, avif_speed_from(p.effort)) {
        Ok(b) => b,
        Err(e) => {
            set_last_error(format!("encoding raster failed: {e}"));
            return 6;
        }
    };
    *out_len = bytes.len();
    if out_buf.is_null() || out_cap < bytes.len() {
        return NEED_LARGER_BUFFER;
    }
    std::ptr::copy_nonoverlapping(bytes.as_ptr(), out_buf, bytes.len());
    0
}

unsafe fn parse_format(format_ptr: *const c_char) -> Result<ExportFormat, i32> {
    if format_ptr.is_null() {
        return Ok(ExportFormat::Jpeg);
    }
    cstr(format_ptr)
        .and_then(ExportFormat::from_str)
        .ok_or_else(|| {
            set_last_error("unrecognized export format string".into());
            5
        })
}

/// See module docs. `flags`: bit0 fill, bit1 auto-orient, bit2 allow enlargement, bit3 cover
/// (bit3 wins over bit0). `filter`: 0 lanczos3, 1 bilinear, 2 nearest. `format`: C string or
/// null (= jpeg). `effort`: 0 default, else 0-9 sharp-style, mapped to rav1e speed `10 - effort`.
/// Returns 100 with `*out_len` set when `out_buf` is too small.
#[no_mangle]
pub unsafe extern "C" fn maple_raster_render_buf(
    input: *const u8,
    input_len: usize,
    width: u32,
    height: u32,
    flags: u32,
    filter: u32,
    format_ptr: *const c_char,
    quality: u8,
    effort: u8,
    out_buf: *mut u8,
    out_cap: usize,
    out_len: *mut usize,
) -> i32 {
    if input.is_null() || input_len == 0 || out_len.is_null() {
        set_last_error("input buffer or out_len is null".into());
        return 1;
    }
    let format = match parse_format(format_ptr) {
        Ok(f) => f,
        Err(rc) => return rc,
    };
    let raster = match decode_raster(std::slice::from_raw_parts(input, input_len), None) {
        Ok(r) => r,
        Err(e) => {
            set_last_error(format!("failed to decode raster: {e}"));
            return 3;
        }
    };
    render_into(
        raster,
        &RenderParams {
            width,
            height,
            flags,
            filter,
            format,
            quality,
            effort,
        },
        out_buf,
        out_cap,
        out_len,
    )
}

/// Same as `maple_raster_render_buf` from caller-decoded interleaved 8-bit pixels
/// (`channels` 1, 3 or 4). The auto-orient flag is ignored (no metadata).
#[no_mangle]
pub unsafe extern "C" fn maple_raster_from_raw_render_buf(
    pixels: *const u8,
    pixels_len: usize,
    src_width: u32,
    src_height: u32,
    channels: u32,
    width: u32,
    height: u32,
    flags: u32,
    filter: u32,
    format_ptr: *const c_char,
    quality: u8,
    effort: u8,
    out_buf: *mut u8,
    out_cap: usize,
    out_len: *mut usize,
) -> i32 {
    if pixels.is_null() || pixels_len == 0 || out_len.is_null() {
        set_last_error("pixel buffer or out_len is null".into());
        return 1;
    }
    let format = match parse_format(format_ptr) {
        Ok(f) => f,
        Err(rc) => return rc,
    };
    let data = std::slice::from_raw_parts(pixels, pixels_len).to_vec();
    let raster = match RasterImage::from_raw(src_width, src_height, channels.min(255) as u8, data) {
        Ok(r) => r,
        Err(e) => {
            set_last_error(format!("invalid raw pixel input: {e}"));
            return 3;
        }
    };
    let flags = flags & !FLAG_AUTO_ORIENT;
    render_into(
        raster,
        &RenderParams {
            width,
            height,
            flags,
            filter,
            format,
            quality,
            effort,
        },
        out_buf,
        out_cap,
        out_len,
    )
}

/// Decode to native-size interleaved RGB8 (alpha dropped, grey expanded).
/// Returns 100 with `*out_len`/`*out_width`/`*out_height` set when `out_buf` is too small.
#[no_mangle]
pub unsafe extern "C" fn maple_raster_decode_rgb8_buf(
    input: *const u8,
    input_len: usize,
    auto_orient: u32,
    out_buf: *mut u8,
    out_cap: usize,
    out_len: *mut usize,
    out_width: *mut u32,
    out_height: *mut u32,
) -> i32 {
    if input.is_null()
        || input_len == 0
        || out_len.is_null()
        || out_width.is_null()
        || out_height.is_null()
    {
        set_last_error("input buffer or an out pointer is null".into());
        return 1;
    }
    let mut raster = match decode_raster(std::slice::from_raw_parts(input, input_len), None) {
        Ok(r) => r,
        Err(e) => {
            set_last_error(format!("failed to decode raster: {e}"));
            return 3;
        }
    };
    if auto_orient != 0 {
        raster.auto_orient();
    }
    let rgb = raster.into_rgb8();
    *out_width = rgb.width;
    *out_height = rgb.height;
    *out_len = rgb.data.len();
    if out_buf.is_null() || out_cap < rgb.data.len() {
        return NEED_LARGER_BUFFER;
    }
    std::ptr::copy_nonoverlapping(rgb.data.as_ptr(), out_buf, rgb.data.len());
    0
}
