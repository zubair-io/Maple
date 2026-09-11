//! Second-generation raster C ABI: one general render entry point (fit,
//! filter, orientation, format, quality, AVIF effort), the same from
//! caller-supplied pixels, and a native-size RGB8 decode. The first-generation
//! functions in `raster.rs` keep their signatures for existing callers.

use crate::error::{catch_panic_rc, set_last_error};
use raw_core::export::ExportFormat;
use raw_core::raster::{
    decode_raster, resize_raster, FilterAlg, RasterImage, ResizeFit, ResizeOptions,
};
use raw_core::raster_encode::{encode_raster_opts, RasterEncodeOptions};
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

/// AVIF effort, one-based on the wire so "unset" is distinguishable from
/// sharp's `effort: 0`: `0` = unset (rav1e speed 6, the encoder default),
/// `1..=10` = sharp effort 0 (fastest) … 9 (slowest), mapped to rav1e speed
/// `11 - wire` (10 = fastest … 1 = slowest). Values above 10 clamp to 10.
fn avif_speed_from(wire_effort: u8) -> u8 {
    if wire_effort == 0 {
        6
    } else {
        11 - wire_effort.min(10)
    }
}

struct RenderParams {
    width: u32,
    height: u32,
    flags: u32,
    filter: u32,
    format: ExportFormat,
    quality: u8,
    /// One-based wire value — see [`avif_speed_from`].
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
        ..Default::default()
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
    // `encode_raster_opts`, not `encode_raster_rgb`: the latter drops alpha
    // via `to_rgb_bytes` with no compositing, so a transparent pixel's
    // stored colour (not black) leaked straight into a JPEG/TIFF encode —
    // this symbol pre-dates the recipe pipeline's alpha-aware encode
    // (#3505's `raster_encode::encode_raster_opts`) and was never migrated
    // when that landed. `encode_raster_opts` keeps alpha for PNG/WebP/AVIF
    // and composites over black for JPEG/TIFF, matching every other encode
    // path in the crate.
    //
    // The C ABI has no colourspace parameter yet (#3503) — every render
    // through this entry point stays sRGB, byte-identical to before.
    let bytes = match encode_raster_opts(
        &resized,
        &RasterEncodeOptions {
            format: p.format,
            quality,
            avif_speed: avif_speed_from(p.effort),
            primaries: raw_core::view::encode::TargetPrimaries::Srgb,
        },
    ) {
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
/// null (= jpeg). `effort`: one-based AVIF effort — 0 = unset (rav1e speed 6), 1-10 = sharp
/// effort 0-9 mapped to rav1e speed `11 - effort` (1 = fastest, 10 = slowest); above 10 clamps.
/// Returns 100 with `*out_len` set when `out_buf` is too small, and 99 if the body panicked
/// (message in `maple_last_error()`) — a panic must never unwind through this `extern "C"` frame.
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
    catch_panic_rc("maple_raster_render_buf", || {
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
    })
}

/// Same as `maple_raster_render_buf` from caller-decoded interleaved 8-bit pixels
/// (`channels` 1, 3 or 4; a 4-channel input's alpha is kept for PNG/WebP/AVIF and
/// composited over black for JPEG/TIFF, same as every other encode path — #3501).
/// The auto-orient flag is ignored (no metadata). `effort` uses the same one-based wire
/// encoding as `maple_raster_render_buf`, and a panic likewise becomes rc 99.
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
    catch_panic_rc("maple_raster_from_raw_render_buf", || {
        if pixels.is_null() || pixels_len == 0 || out_len.is_null() {
            set_last_error("pixel buffer or out_len is null".into());
            return 1;
        }
        let format = match parse_format(format_ptr) {
            Ok(f) => f,
            Err(rc) => return rc,
        };
        let data = std::slice::from_raw_parts(pixels, pixels_len).to_vec();
        let raster =
            match RasterImage::from_raw(src_width, src_height, channels.min(255) as u8, data) {
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
    })
}

/// Decode to native-size interleaved RGB8 (alpha dropped, grey expanded).
/// Returns 100 with `*out_len`/`*out_width`/`*out_height` set when `out_buf` is too small —
/// so one probe call with a null `out_buf` sizes the buffer — and 99 if the body panicked
/// (message in `maple_last_error()`).
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
    catch_panic_rc("maple_raster_decode_rgb8_buf", || {
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
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The wire encoding reserves 0 for "unset" so sharp's `effort: 0`
    /// (fastest) is reachable — it arrives as wire 1.
    #[test]
    fn avif_speed_maps_the_one_based_wire_effort() {
        assert_eq!(avif_speed_from(0), 6);
        assert_eq!(avif_speed_from(1), 10);
        assert_eq!(avif_speed_from(10), 1);
        assert_eq!(avif_speed_from(255), 1);
    }

    /// Regression pin (#3501): `render_into` used to call `encode_raster_rgb`
    /// directly, which drops alpha via `to_rgb_bytes` with no compositing —
    /// a fully-transparent red pixel came out of a JPEG encode as red, not
    /// black, contradicting `raster_encode`'s rule (every JPEG/TIFF encode
    /// composites alpha over black). Exercises the raw-pixel entry point
    /// directly, the same call a caller-decoded 4-channel source takes.
    #[test]
    fn from_raw_render_buf_composites_transparent_pixels_over_black_for_jpeg() {
        // 2x1: fully-transparent red, then opaque black.
        let pixels: [u8; 8] = [255, 0, 0, 0, 0, 0, 0, 255];
        let mut out_len = 0usize;
        // SAFETY: every pointer borrows a live local for the call; a null
        // out_buf/out_cap probes the required size.
        let probe_rc = unsafe {
            maple_raster_from_raw_render_buf(
                pixels.as_ptr(),
                pixels.len(),
                2,
                1,
                4,
                0,
                0,
                0,
                0,
                std::ptr::null(),
                90,
                0,
                std::ptr::null_mut(),
                0,
                &mut out_len,
            )
        };
        assert_eq!(probe_rc, NEED_LARGER_BUFFER);
        let mut out = vec![0u8; out_len];
        // SAFETY: `out` is sized from the probe above.
        let rc = unsafe {
            maple_raster_from_raw_render_buf(
                pixels.as_ptr(),
                pixels.len(),
                2,
                1,
                4,
                0,
                0,
                0,
                0,
                std::ptr::null(),
                90,
                0,
                out.as_mut_ptr(),
                out.len(),
                &mut out_len,
            )
        };
        assert_eq!(rc, 0);
        let decoded = raw_core::raster::decode_raster(&out[..out_len], Some("jpeg")).unwrap();
        let (r, g, b) = (decoded.data[0], decoded.data[1], decoded.data[2]);
        assert!(
            r < 24 && g < 24 && b < 24,
            "transparent red pixel encoded as ({r},{g},{b}), expected near-black"
        );
    }

    /// A panic inside an FFI body must come out as rc 99 with the message in
    /// `maple_last_error()`, never as an unwind through the `extern "C"`
    /// frame (undefined behaviour; an abort in practice).
    #[test]
    fn panics_become_rc_99() {
        let rc = catch_panic_rc("raster_v2_test", || panic!("decoder invariant violated"));
        assert_eq!(rc, 99);
        // SAFETY: reading the thread-local message set on the panic path.
        let msg = unsafe { crate::error::maple_last_error() };
        assert!(!msg.is_null());
        // SAFETY: `maple_last_error` returns a live NUL-terminated string.
        let msg = unsafe { CStr::from_ptr(msg) }.to_string_lossy().to_string();
        assert!(msg.contains("decoder invariant violated"), "got: {msg}");
    }
}

#[cfg(test)]
#[path = "raster_v2_pin_tests.rs"]
mod pin_tests;
