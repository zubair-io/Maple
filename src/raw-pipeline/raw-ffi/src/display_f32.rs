//! Cold native full export through the shared float display terminal (#1472).
use crate::error::{set_last_error, with_large_stack};
use crate::model::{load_xmp_model_owned, LoadModel};
use raw_core::{
    decode_cache::{decode_bytes_cached, CacheKey},
    pipeline::{render_export_f32, RawInput},
    view::encode::TargetPrimaries,
};
use std::ffi::{c_char, CStr};

/// Display-encoded, straight-alpha RGBA f32 in the requested primaries.
/// Full EXIF, manual geometry and crop are already applied. Free only through
/// `maple_free_display_buffer_f32`; this is not a scene-linear decode buffer.
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

/// Free/reset an output. Null pointers and repeated frees are harmless.
#[no_mangle]
pub unsafe extern "C" fn maple_free_display_buffer_f32(out: *mut MapleDisplayBufferF32) {
    if let Some(out) = out.as_mut() {
        if !out.rgba.is_null() {
            drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(
                out.rgba, out.len,
            )));
        }
        *out = MapleDisplayBufferF32::empty();
    }
}

/// Full-resolution display f32, including optional film and verified saved
/// removals beside the original. The XMP may be an immutable temporary snapshot.
/// `quality`: 0 Full / 1 Preview / 2 AMaZE / 3 Auto; `target`: 0 sRGB / 1 P3.
/// Film is absent only for `(null, 0, 0)`; malformed requested LUTs fail closed.
/// RC: 1 null, 2/3 path encoding, 4/5 XMP, 6 read, 7 decode, 8 render,
/// 9 primaries, 10 film, 98/99 worker failure. Failure leaves empty output.
///
/// # Safety
/// Paths must be valid C strings, optional XMP may be null. Film must point to
/// `film_len` readable f32 lanes. `out` must be writable and contain no owned
/// allocation (free previous output first). Ownership returns to Rust on free.
#[no_mangle]
pub unsafe extern "C" fn maple_render_file_display_f32(
    raw_path: *const c_char,
    xmp_path: *const c_char,
    quality: i32,
    target: u32,
    film_ptr: *const f32,
    film_len: usize,
    film_size: u32,
    out: *mut MapleDisplayBufferF32,
) -> i32 {
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
        Err(_) => {
            set_last_error("RAW path is not UTF-8".into());
            return 2;
        }
    };
    let xmp_path = if xmp_path.is_null() {
        None
    } else {
        match CStr::from_ptr(xmp_path).to_str() {
            Ok(path) => Some(path.to_owned()),
            Err(_) => {
                set_last_error("XMP path is not UTF-8".into());
                return 3;
            }
        }
    };
    let target = match target {
        0 => TargetPrimaries::Srgb,
        1 => TargetPrimaries::P3,
        _ => {
            set_last_error("Unknown export primaries".into());
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
            set_last_error("Invalid requested film LUT extent".into());
            return 10;
        }
        let data = std::slice::from_raw_parts(film_ptr, film_len);
        if data.iter().any(|v| !v.is_finite()) {
            set_last_error("Requested film LUT has non-finite values".into());
            return 10;
        }
        Some(raw_core::film::FilmLut {
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
        let bytes = match std::fs::read(path) {
            Ok(bytes) => bytes,
            Err(error) => {
                set_last_error(format!("raw read: {error}"));
                return 6;
            }
        };
        let ext = path.extension().and_then(|v| v.to_str()).unwrap_or("");
        // Bind both the mosaic and embedded preview to this exact read.
        let raw = match decode_bytes_cached(&CacheKey::from_bytes(&bytes), &bytes, ext) {
            Ok(raw) => raw,
            Err(error) => {
                set_last_error(format!("decode: {error}"));
                return 7;
            }
        };
        let quality = crate::auto_profile::quality_from_wire(quality);
        let source = Some(RawInput::Bytes { bytes: &bytes, ext });
        let result = match crate::removal_file::prepare_saved(&raw, &bytes, &model, path.parent()) {
            Some(saved) => saved.and_then(|(saved, original)| {
                saved.render_export_f32(
                    &raw,
                    &original,
                    &model,
                    quality,
                    source,
                    target,
                    film.as_ref(),
                )
            }),
            None => render_export_f32(&raw, &model, quality, source, target, film.as_ref()),
        };
        match result {
            Ok((width, height, rgba)) => {
                let mut data = rgba.into_boxed_slice();
                let buffer = MapleDisplayBufferF32 {
                    rgba: data.as_mut_ptr(),
                    len: data.len(),
                    width,
                    height,
                };
                std::mem::forget(data);
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
}
