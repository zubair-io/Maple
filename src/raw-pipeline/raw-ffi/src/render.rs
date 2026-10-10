//! Legacy 8-bit sRGB render entries — `maple_render_file` and
//! `maple_render_bytes`. Used by the color-parity harness; reference-comparable
//! output requires the full development chain at decode time, so this
//! path does NOT apply the Apple-GPU strip (which the scene-linear
//! entries delegate to the Swift binding).
//!
//! Also home to `maple_compute_look_lut` (ticket #515) — the small entry
//! Apple Metal + Web WebGL hosts call once per render to seed a GPU 1D LUT
//! texture for the post-AgX DisplayLookCurve. It lives here (next to the
//! sRGB renderers) rather than in `scene_linear_chain.rs` because it does
//! not touch the per-tick chain — it's a one-shot byte copy.

use crate::buffers::MapleImageBuffer;
use crate::error::{set_last_error, with_large_stack};
use crate::model::{load_xmp_model_owned, LoadModel};
#[cfg(test)]
pub(crate) use crate::render_histogram::{bin_rgb888, HISTOGRAM_BINS_LEN};
pub use crate::render_histogram::{maple_histogram_bytes, maple_histogram_file};
use raw_core::{
    decode::decode_bytes,
    pipeline::{render_from_raw_with_quality, RawInput, RenderQuality},
};
use std::ffi::{c_char, CStr};

/// Render a RAW+XMP to an sRGB 8-bit RGB buffer. Returns 0 on success, non-zero
/// on error (call `maple_last_error` for a description). `xmp_path` may be null,
/// in which case AdjustmentModel::default() is used.
///
/// `quality_preview` selects the internal demosaic / downsample strategy:
///   0 → `RenderQuality::Full`    (bilinear or HA demosaic, full resolution;
///                                  legacy value kept for ABI compatibility)
///   1 → `RenderQuality::Preview` (half-res quad demosaic; the returned
///                                  buffer is at half the sensor's dimensions
///                                  in both axes — caller must scale for
///                                  display; use for interactive fast-phase
///                                  so a 100MP RAW decodes in seconds)
///   2 → `RenderQuality::Amaze`   (AMaZE demosaic, full resolution; the
///                                  export/refine path — highest quality on
///                                  Bayer sensors; same cost as Full on X-Trans
///                                  (maps to markesteijn))
///   3 → `RenderQuality::Auto`    (#3413: full resolution, kernel chosen from
///                                  the frame's noise profile and size — LMMSE
///                                  when noisy, the AMaZE+VNG4 dual on a large
///                                  clean frame, AMaZE alone on a small one.
///                                  Appended rather than renumbering, so every
///                                  existing caller's integer keeps its old
///                                  meaning)
///
/// Every value honours the model's `papp:Demosaic` override except `1`,
/// which bins before any reconstruction runs and so has no kernel to pick.
#[no_mangle]
pub unsafe extern "C" fn maple_render_file(
    raw_path: *const c_char,
    xmp_path: *const c_char,
    quality_preview: i32,
    out: *mut MapleImageBuffer,
) -> i32 {
    if raw_path.is_null() || out.is_null() {
        set_last_error("null pointer argument".into());
        return 1;
    }
    // Pull the paths into owned Strings so the worker thread can own them.
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
    let out_ptr = out as usize; // Send across the thread as a usize, cast back inside.
                                // Pass the RAW path through so `Profile::Auto` (#537) can read the
                                // embedded JPEG. `maple_render_file` is the file-backed entry — the path
                                // is guaranteed to be valid; `maple_render_bytes` below is bytes-only and
                                // runs AgX unconditionally. `film_lut: None` keeps this entry's output
                                // byte-identical to pre-#2683 — the film-look sibling that threads a
                                // decoded LUT through the same body lives in `render_film.rs`
                                // (`maple_render_file_with_film`, 600-LOC budget split).
    with_large_stack(move || {
        let raw_path = std::path::Path::new(&raw_path_str);
        crate::render_film::render_file_body(
            raw_path,
            xmp_path_str.as_deref(),
            quality_preview,
            None,
            out_ptr,
        )
    })
}

/// Render a RAW from a byte slice (PhotoKit, self-hosted API, etc.) through
/// the pipeline. Identical to `maple_render_file` except the caller hands us
/// bytes instead of a path, and supplies an extension hint (e.g. "dng", "cr2",
/// "arw") so the decoder can dispatch.
///
/// `xmp_path` may be null, in which case `AdjustmentModel::default()` is used.
/// `hint_ext` must be a UTF-8 C string naming the RAW extension (without dot).
/// `quality_preview` mirrors `maple_render_file` — 1 = half-res preview
/// demosaic for the fast interactive path (returned buffer is at half the
/// sensor's dimensions in both axes; caller must scale for display),
/// 2 = AMaZE demosaic for the export/refine path, 0 = legacy Full.
#[no_mangle]
pub unsafe extern "C" fn maple_render_bytes(
    raw_bytes: *const u8,
    raw_len: usize,
    hint_ext: *const c_char,
    xmp_path: *const c_char,
    quality_preview: i32,
    out: *mut MapleImageBuffer,
) -> i32 {
    if raw_bytes.is_null() || out.is_null() {
        set_last_error("null pointer argument".into());
        return 1;
    }
    let ext_owned: String = if hint_ext.is_null() {
        String::new()
    } else {
        match CStr::from_ptr(hint_ext).to_str() {
            Ok(s) => s.to_owned(),
            Err(e) => {
                set_last_error(format!("hint_ext not UTF-8: {}", e));
                return 2;
            }
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
    // Copy input bytes into a Vec the worker can own — the caller's pointer
    // may not live past the join() on a slow decode.
    let input: Vec<u8> = std::slice::from_raw_parts(raw_bytes, raw_len).to_vec();
    let out_ptr = out as usize;
    with_large_stack(move || {
        let model = match load_xmp_model_owned(xmp_path_str.as_deref()) {
            LoadModel::Ok(m) => m,
            LoadModel::Err(rc) => return rc,
        };
        let raw_img = match raw_core::pipeline::stage("ffi_rawler_decode", || {
            decode_bytes(&input, &ext_owned)
        }) {
            Ok(r) => r,
            Err(e) => {
                set_last_error(format!("decode: {}", e));
                return 7;
            }
        };
        let quality = match quality_preview {
            1 => RenderQuality::Preview,
            2 => RenderQuality::Amaze,
            3 => RenderQuality::Auto,
            _ => RenderQuality::Full,
        };
        let rendered = crate::removal_file::render_saved(
            &raw_img,
            &input,
            &model,
            xmp_path_str
                .as_deref()
                .and_then(|path| std::path::Path::new(path).parent()),
            Some(RawInput::Bytes {
                bytes: &input,
                ext: &ext_owned,
            }),
            quality,
            None,
        )
        .unwrap_or_else(|| render_from_raw_with_quality(&raw_img, &model, quality));
        let (w, h, out_bytes) = match rendered {
            Ok(t) => t,
            Err(e) => {
                set_last_error(format!("render: {}", e));
                return 8;
            }
        };
        let (rgb, len) = raw_core::pipeline::stage("ffi_pack", || {
            let mut boxed = out_bytes.into_boxed_slice();
            let p = boxed.as_mut_ptr();
            let n = boxed.len();
            std::mem::forget(boxed);
            (p, n)
        });
        unsafe {
            *(out_ptr as *mut MapleImageBuffer) = MapleImageBuffer {
                rgb,
                len,
                width: w,
                height: h,
            };
        }
        0
    })
}

/// Writes 768 bytes (256 R, then 256 G, then 256 B) into `out` — the byte
/// layout an Apple Metal `MTLTexture` (3 × `r8Unorm`, 256×1) or a Web
/// WebGL2 `R8` 1D LUT texture expects, packed in channel-major order so
/// the host can upload three contiguous 256-byte regions in one staging
/// buffer.
///
/// `look_mode` matches the `Look::from(u8)` mapping (`0` = `Neutral`,
/// `1` = `Default`). Unknown bytes return `-1` without touching `out`.
///
/// Returns `0` on success, `-1` if `out` is null OR `look_mode` is not
/// one of the documented variants. The error path does not set
/// `maple_last_error` — the caller has the look_mode in hand and a null
/// pointer is its own diagnostic; this entry is deliberately small.
///
/// Apple + Web hosts call this once per render to seed a GPU LUT texture
/// (the texture stays valid until the user changes `look_mode`, so this
/// is not per-tick — see ticket #515 § L3).
///
/// # Safety
///
/// `out` must point to a writable buffer of at least 768 bytes that lives
/// for the duration of the call. The buffer is overwritten unconditionally
/// on success and is not touched on error.
#[no_mangle]
pub unsafe extern "C" fn maple_compute_look_lut(look_mode: u8, out: *mut u8) -> i32 {
    if out.is_null() {
        return -1;
    }
    // Reject unknown modes BEFORE materialising the slice — the caller
    // gets an unambiguous error rather than a silent fall-through to the
    // default LUT.
    if look_mode > 1 {
        return -1;
    }
    let slice = std::slice::from_raw_parts_mut(out, 768);
    match look_mode {
        0 => {
            // Neutral / identity LUT — channel-major `[0, 1, …, 255]`
            // repeated three times. Hosts uploading this still get a
            // working sampler-with-LUT pipeline (no shader fork between
            // "LUT enabled" / "LUT disabled") at the cost of one tiny
            // texture upload.
            for c in 0..3 {
                let base = c * 256;
                for i in 0..256 {
                    slice[base + i] = i as u8;
                }
            }
            0
        }
        1 => {
            // Empirical DisplayLookCurve — the bytes derived from the 14
            // training fixtures at #371. Source of truth lives in
            // `raw_core::view::look::LUT_{R,G,B}` so the CPU path
            // (`pipeline::render` → `view::look::apply`) and the GPU
            // path here cannot drift.
            slice[0..256].copy_from_slice(&raw_core::view::look::LUT_R);
            slice[256..512].copy_from_slice(&raw_core::view::look::LUT_G);
            slice[512..768].copy_from_slice(&raw_core::view::look::LUT_B);
            0
        }
        _ => -1,
    }
}
