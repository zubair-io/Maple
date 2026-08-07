//! Film-look sibling of `maple_render_file` (epic #2683, Task 8) — the
//! full-render entry Apple's refine/export path calls, plus an
//! `_with_film` twin that threads a decoded film-look LUT through to
//! `render_from_raw_with_quality_source_and_film` (Task 4's core entry).
//!
//! `render_file_body` is shared by both `maple_render_file` (`render.rs`,
//! `film_lut: None`) and `maple_render_file_with_film` below — pulled out of
//! `render.rs` to keep it under the 600-LOC file-size budget rather than
//! duplicating the decode-develop-render-pack sequence twice.

use crate::buffers::MapleImageBuffer;
use crate::error::{set_last_error, with_large_stack};
use crate::model::{load_xmp_model_owned, LoadModel};
use raw_core::{
    decode::decode_bytes,
    film,
    pipeline::{render_from_raw_with_quality_source_and_film, RawInput, RenderQuality},
};
use std::ffi::{c_char, CStr};
use std::path::Path;

/// Decode + develop + render a RAW file at `raw_path` under `xmp_path`'s
/// adjustments (or the default model when absent), optionally blending
/// `film_lut` per the film_look stage, and write the packed RGB888 result
/// into `*out_ptr` (a `*mut MapleImageBuffer` sent across the worker thread
/// as a `usize` by both callers).
///
/// Returns the same rc space `maple_render_file` documents: `6` raw read,
/// `7` decode, `8` render (plus whatever `load_xmp_model_owned` returns for
/// an unreadable/malformed sidecar), `0` on success.
pub(crate) fn render_file_body(
    raw_path: &Path,
    xmp_path: Option<&str>,
    quality_preview: i32,
    film_lut: Option<&film::FilmLut>,
    out_ptr: usize,
) -> i32 {
    let model = match load_xmp_model_owned(xmp_path) {
        LoadModel::Ok(m) => m,
        LoadModel::Err(rc) => return rc,
    };
    let raw_bytes = match raw_core::pipeline::stage("ffi_raw_read", || std::fs::read(raw_path)) {
        Ok(b) => b,
        Err(e) => {
            set_last_error(format!("raw read: {}", e));
            return 6;
        }
    };
    let ext = raw_path.extension().and_then(|e| e.to_str()).unwrap_or("");
    let raw_img =
        match raw_core::pipeline::stage("ffi_rawler_decode", || decode_bytes(&raw_bytes, ext)) {
            Ok(r) => r,
            Err(e) => {
                set_last_error(format!("decode: {}", e));
                return 7;
            }
        };
    let quality = match quality_preview {
        1 => RenderQuality::Preview,
        2 => RenderQuality::Amaze,
        _ => RenderQuality::Full,
    };
    let (w, h, bytes) = match render_from_raw_with_quality_source_and_film(
        &raw_img,
        &model,
        quality,
        Some(RawInput::Path(raw_path)),
        film_lut,
    ) {
        Ok(t) => t,
        Err(e) => {
            set_last_error(format!("render: {}", e));
            return 8;
        }
    };
    let (rgb, len) = raw_core::pipeline::stage("ffi_pack", || {
        let mut boxed = bytes.into_boxed_slice();
        let p = boxed.as_mut_ptr();
        let n = boxed.len();
        std::mem::forget(boxed);
        (p, n)
    });
    // SAFETY: both callers guarantee `out_ptr` is a valid, live
    // `*mut MapleImageBuffer` for the duration of the call (validated
    // non-null before dispatch).
    unsafe {
        *(out_ptr as *mut MapleImageBuffer) = MapleImageBuffer {
            rgb,
            len,
            width: w,
            height: h,
        };
    }
    0
}

/// Build a [`film::FilmLut`] from the caller's flat `(ptr, len)` grid + its
/// declared `size`, or `None` when the pointer is null, `size < 2`
/// (degenerate — mirrors `MlutError::DegenerateGrid`), or `len` doesn't
/// match `size³·3` exactly. A mismatch is logged (debug builds) and treated
/// as "off" rather than risking a read past the caller's slice — the same
/// gate `gpu_live::params::film_lut_or_off` applies to the per-tick params.
///
/// # Safety
/// `ptr` must be valid for `len` f32 reads, or null.
unsafe fn film_lut_from_parts(ptr: *const f32, len: usize, size: u32) -> Option<film::FilmLut> {
    if ptr.is_null() || size < 2 {
        return None;
    }
    let s = size as usize;
    let expected = s
        .checked_mul(s)
        .and_then(|s2| s2.checked_mul(s))
        .and_then(|s3| s3.checked_mul(3));
    if expected != Some(len) {
        #[cfg(debug_assertions)]
        eprintln!(
            "maple_render_file_with_film: film_lut_len {len} != size³·3 for size {size} \
             (expected {expected:?}) — rendering without the look"
        );
        return None;
    }
    Some(film::FilmLut {
        size: s,
        data: std::slice::from_raw_parts(ptr, len).to_vec(),
    })
}

/// Sibling of `maple_render_file` that also blends a film-look LUT into the
/// export/refine render (epic #2683). Identical decode/develop/render/pack
/// sequence, plus a caller-supplied flat `size³·3` grid.
///
/// `film_lut_ptr`/`film_lut_len`/`film_lut_size` mirror
/// [`crate::film::maple_film_lut_decode`]'s output layout exactly — the host
/// decodes the `.mlut` once (caching the flat grid) and passes it straight
/// through here on every render. A null `film_lut_ptr`, `film_lut_size < 2`,
/// or a `film_lut_len` that doesn't match `film_lut_size³·3` all render
/// WITHOUT the look (byte-identical to `maple_render_file`) rather than
/// erroring — a host that failed to load/cache a look should still get a
/// correct plain render.
///
/// Returns the same rc space as `maple_render_file`: `1` null `raw_path`/`out`,
/// `2`/`3` non-UTF-8 path, `4`/`5` XMP parse/read, `6` raw read, `7` decode,
/// `8` render, `0` success.
///
/// # Safety
/// `raw_path` must be a valid UTF-8 C string; `xmp_path` may be null or a
/// valid UTF-8 C string; `film_lut_ptr` must be valid for `film_lut_len` f32
/// reads, or null; `out` must be a valid, writable `*mut MapleImageBuffer`
/// for the duration of the call.
#[no_mangle]
pub unsafe extern "C" fn maple_render_file_with_film(
    raw_path: *const c_char,
    xmp_path: *const c_char,
    quality_preview: i32,
    film_lut_ptr: *const f32,
    film_lut_len: usize,
    film_lut_size: u32,
    out: *mut MapleImageBuffer,
) -> i32 {
    if raw_path.is_null() || out.is_null() {
        set_last_error("null pointer argument".into());
        return 1;
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
    // Copy the film LUT out now (the caller's pointer need not outlive the
    // worker-thread render below), mirroring the raw_path/xmp_path pattern.
    let film_lut = film_lut_from_parts(film_lut_ptr, film_lut_len, film_lut_size);
    let out_ptr = out as usize;
    with_large_stack(move || {
        let raw_path = Path::new(&raw_path_str);
        render_file_body(
            raw_path,
            xmp_path_str.as_deref(),
            quality_preview,
            film_lut.as_ref(),
            out_ptr,
        )
    })
}
