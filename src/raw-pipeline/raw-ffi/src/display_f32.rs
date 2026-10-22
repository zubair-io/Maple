//! Cold full-size export through the shared f32 display terminal (#5163).
//! `maple_render_file_display_f32` hands a destination encoder the
//! display-encoded RGBA f32 buffer `render_export_f32` produces, so the one
//! quantization happens in that encoder rather than in a baked host cube.
use crate::error::{catch_panic, catch_panic_rc, set_last_error, with_large_stack};
use crate::model::{load_xmp_model_owned, LoadModel};
use raw_core::{
    decode::decode_bytes,
    film::FilmLut,
    pipeline::{render_export_f32, RawInput},
    view::encode::TargetPrimaries,
};
use std::ffi::{c_char, CStr};

/// Display-encoded, straight-alpha RGBA f32 in the requested primaries, with
/// EXIF orientation, manual geometry and crop already applied. Free only
/// through `maple_free_display_buffer_f32`; this is not a scene-linear buffer.
#[repr(C)]
pub struct MapleDisplayBufferF32 {
    pub rgba: *mut f32,
    /// Number of f32 lanes (four per pixel), not bytes.
    pub len: usize,
    pub width: u32,
    pub height: u32,
}

impl MapleDisplayBufferF32 {
    pub(crate) fn empty() -> Self {
        Self {
            rgba: std::ptr::null_mut(),
            len: 0,
            width: 0,
            height: 0,
        }
    }
}

/// Free and reset an output. A null `out`, a null buffer and a repeated free
/// are all harmless.
///
/// # Safety
/// `out` must be null or point to a buffer last written by
/// `maple_render_file_display_f32` (or already freed / empty).
#[no_mangle]
pub unsafe extern "C" fn maple_free_display_buffer_f32(out: *mut MapleDisplayBufferF32) {
    catch_panic("maple_free_display_buffer_f32", (), || {
        if let Some(out) = out.as_mut() {
            if !out.rgba.is_null() {
                drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(
                    out.rgba, out.len,
                )));
            }
            *out = MapleDisplayBufferF32::empty();
        }
    })
}

/// Native-resolution display f32 render of a RAW + optional XMP sidecar, with
/// an optional film LUT. `quality_preview` mirrors `maple_render_file`
/// (0 Full / 1 Preview / 2 AMaZE / 3 Auto); `target` is 0 sRGB / 1 Display-P3.
/// Film is absent only for `(null, 0, 0)`; a malformed requested LUT fails
/// closed rather than rendering without it.
///
/// Returns 0 on success. 1 null `out` or `raw_path`, 2/3 non-UTF-8 raw/xmp
/// path, 4/5 XMP parse/read, 6 raw read, 7 decode, 8 render, 9 unknown
/// primaries, 10 invalid film LUT, 98/99 worker failure (`maple_last_error`).
/// Every failure leaves `out` empty.
///
/// # Safety
/// `raw_path` must be a valid C string and `xmp_path` null or a valid C
/// string. `film_ptr` must point to `film_len` readable f32 lanes (or be null
/// with `film_len == film_size == 0`). `out` must be writable and hold no
/// owned allocation (free a previous output first); the allocation it receives
/// returns to Rust through `maple_free_display_buffer_f32`.
#[no_mangle]
pub unsafe extern "C" fn maple_render_file_display_f32(
    raw_path: *const c_char,
    xmp_path: *const c_char,
    quality_preview: i32,
    target: u32,
    film_ptr: *const f32,
    film_len: usize,
    film_size: u32,
    out: *mut MapleDisplayBufferF32,
) -> i32 {
    catch_panic_rc("maple_render_file_display_f32", || {
        if out.is_null() {
            set_last_error("null float export output".into());
            return 1;
        }
        *out = MapleDisplayBufferF32::empty();
        if raw_path.is_null() {
            set_last_error("null RAW path".into());
            return 1;
        }
        let raw_path = match CStr::from_ptr(raw_path).to_str() {
            Ok(path) => path.to_owned(),
            Err(error) => {
                set_last_error(format!("raw_path not UTF-8: {error}"));
                return 2;
            }
        };
        let xmp_path = if xmp_path.is_null() {
            None
        } else {
            match CStr::from_ptr(xmp_path).to_str() {
                Ok(path) => Some(path.to_owned()),
                Err(error) => {
                    set_last_error(format!("xmp_path not UTF-8: {error}"));
                    return 3;
                }
            }
        };
        let target = match target {
            0 => TargetPrimaries::Srgb,
            1 => TargetPrimaries::P3,
            _ => {
                set_last_error("unknown export primaries".into());
                return 9;
            }
        };
        let film = if film_ptr.is_null() && film_len == 0 && film_size == 0 {
            None
        } else {
            let n = film_size as usize;
            let expected = n
                .checked_mul(n)
                .and_then(|v| v.checked_mul(n))
                .and_then(|v| v.checked_mul(3));
            if film_ptr.is_null() || n < 2 || expected != Some(film_len) {
                set_last_error("invalid requested film LUT extent".into());
                return 10;
            }
            let data = std::slice::from_raw_parts(film_ptr, film_len);
            if data.iter().any(|v| !v.is_finite()) {
                set_last_error("requested film LUT has non-finite values".into());
                return 10;
            }
            Some(FilmLut {
                size: n,
                data: data.to_vec(),
            })
        };
        let out = out as usize;
        with_large_stack(move || {
            let model = match load_xmp_model_owned(xmp_path.as_deref()) {
                LoadModel::Ok(model) => model,
                LoadModel::Err(rc) => return rc,
            };
            let path = std::path::Path::new(&raw_path);
            let bytes = match raw_core::pipeline::stage("ffi_raw_read", || std::fs::read(path)) {
                Ok(bytes) => bytes,
                Err(error) => {
                    set_last_error(format!("raw read: {error}"));
                    return 6;
                }
            };
            let ext = path.extension().and_then(|v| v.to_str()).unwrap_or("");
            let raw = match raw_core::pipeline::stage("ffi_rawler_decode", || {
                decode_bytes(&bytes, ext)
            }) {
                Ok(raw) => raw,
                Err(error) => {
                    set_last_error(format!("decode: {error}"));
                    return 7;
                }
            };
            let quality = crate::auto_profile::quality_from_wire(quality_preview);
            let rendered = render_export_f32(
                &raw,
                &model,
                quality,
                Some(RawInput::Path(path)),
                target,
                film.as_ref(),
            );
            match rendered {
                Ok((width, height, rgba)) => {
                    let mut data = rgba.into_boxed_slice();
                    let buffer = MapleDisplayBufferF32 {
                        rgba: data.as_mut_ptr(),
                        len: data.len(),
                        width,
                        height,
                    };
                    std::mem::forget(data);
                    // SAFETY: `out` was validated non-null before dispatch and the
                    // caller keeps it alive for the duration of the call.
                    unsafe {
                        *(out as *mut MapleDisplayBufferF32) = buffer;
                    }
                    0
                }
                Err(error) => {
                    set_last_error(format!("render: {error}"));
                    8
                }
            }
        })
    })
}
