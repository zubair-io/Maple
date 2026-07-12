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
use crate::model::{load_xmp_model_from_doc, load_xmp_model_owned, LoadModel};
use raw_core::{
    decode::decode_bytes,
    pipeline::{
        render_from_raw_with_quality, render_from_raw_with_quality_and_source, RawInput,
        RenderQuality,
    },
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
        let quality = match quality_preview {
            1 => RenderQuality::Preview,
            2 => RenderQuality::Amaze,
            _ => RenderQuality::Full,
        };
        // Pass the RAW path through so `Profile::Auto` (#537) can read the
        // embedded JPEG. `maple_render_file` is the file-backed entry —
        // the path is guaranteed to be valid; `maple_render_bytes` below
        // is bytes-only and runs AgX unconditionally.
        let (w, h, bytes) = match render_from_raw_with_quality_and_source(
            &raw_img,
            &model,
            quality,
            Some(raw_core::pipeline::RawInput::Path(raw_path)),
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
            _ => RenderQuality::Full,
        };
        let (w, h, out_bytes) = match render_from_raw_with_quality(&raw_img, &model, quality) {
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
            crate::thumbnail::resize_long_edge(image::DynamicImage::ImageRgb8(rgb), max_px);
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

/// Number of `u32` slots in a 3×256 RGB histogram (256 R, then G, then B).
pub(crate) const HISTOGRAM_BINS_LEN: usize = 3 * 256;

/// Count 8-bit R/G/B occurrences across a tightly-packed RGB888 buffer.
///
/// Returns `[R0..=R255, G0..=G255, B0..=B255]` — the channel-major layout the
/// `maple_histogram_file` FFI entry writes into the caller's buffer. A trailing
/// partial pixel (`len % 3 != 0`) is ignored; the renderer always emits whole
/// RGB888 pixels, so the guard is purely defensive. Counts saturate at
/// `u32::MAX` (a 100 MP frame is ~1e8 px — two orders of magnitude below the
/// ceiling, so saturation never fires in practice).
pub(crate) fn bin_rgb888(rgb: &[u8]) -> [u32; HISTOGRAM_BINS_LEN] {
    let mut bins = [0u32; HISTOGRAM_BINS_LEN];
    let mut i = 0usize;
    let n = rgb.len();
    while i + 3 <= n {
        let r = rgb[i] as usize;
        let g = 256 + rgb[i + 1] as usize;
        let b = 512 + rgb[i + 2] as usize;
        bins[r] = bins[r].saturating_add(1);
        bins[g] = bins[g].saturating_add(1);
        bins[b] = bins[b].saturating_add(1);
        i += 3;
    }
    bins
}

/// Render a RAW+XMP through the full 8-bit sRGB pipeline (identical decode +
/// develop path to `maple_render_file`) and write a 3×256 channel histogram of
/// the result into the caller-provided `out_bins` buffer.
///
/// `out_bins` must point to at least [`HISTOGRAM_BINS_LEN`] (`768`) writable
/// `u32`s; the layout is channel-major (`[0,256)` = R counts, `[256,512)` = G,
/// `[512,768)` = B). It is overwritten in full on success and untouched on error.
///
/// Crucially the rendered pixel buffer never crosses the FFI boundary: it is
/// binned in Rust and only the 3 KB histogram is returned, through a buffer the
/// *caller* owns. This sidesteps the `toBuffer`-over-Rust-memory lifetime trap
/// that segfaults the JSC heap on a later GC (the same reasoning that moved the
/// thumbnail path to the `_to_file` entry — see `buffers.rs`). It also avoids
/// shipping ~300 MB of RGB across the boundary for a 100 MP frame.
///
/// Returns 0 on success, non-zero on error (call `maple_last_error`). Error
/// codes mirror `maple_render_file` plus the shared XMP-load codes:
/// 1 = null or misaligned `out_bins` pointer, 2/3 = raw/xmp path not UTF-8,
/// 4 = XMP parse, 5 = XMP read, 6 = raw read, 7 = decode, 8 = render.
/// Codes 4 and 5 surface from `load_xmp_model_owned` only when an `xmp_path`
/// is supplied (a malformed or unreadable sidecar).
///
/// # Safety
///
/// `raw_path` must be a valid C string; `xmp_path` may be null or a valid C
/// string; `out_bins` must point to >= [`HISTOGRAM_BINS_LEN`] writable `u32`s
/// that live for the duration of the call. Misalignment is rejected at runtime
/// (returns 1) rather than risking UB in the `from_raw_parts_mut` write below.
#[no_mangle]
pub unsafe extern "C" fn maple_histogram_file(
    raw_path: *const c_char,
    xmp_path: *const c_char,
    out_bins: *mut u32,
) -> i32 {
    if raw_path.is_null() || out_bins.is_null() {
        set_last_error("null pointer argument".into());
        return 1;
    }
    // `out_bins` is reinterpreted as a `*mut u32` slice below (via
    // `from_raw_parts_mut`), which is instant UB on a pointer that is not
    // `u32`-aligned. This is a public C ABI, so validate the caller's
    // alignment rather than trust it — reject with the pointer-argument
    // code (1) on a miss instead of risking the unaligned write.
    if out_bins as usize % std::mem::align_of::<u32>() != 0 {
        set_last_error("out_bins pointer is not u32-aligned".into());
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
    let out_ptr = out_bins as usize; // Send across the worker thread as a usize.
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
        // AMaZE render so the histogram reflects the authoritative export pixels
        // (mirrors `maple_render_file` with quality_preview = 2, the export path).
        let (_w, _h, bytes) = match render_from_raw_with_quality_and_source(
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
        let bins = bin_rgb888(&bytes);
        // SAFETY: the caller guarantees `out_bins` (captured as `out_ptr`)
        // points to >= HISTOGRAM_BINS_LEN writable u32s that outlive the call.
        unsafe {
            std::slice::from_raw_parts_mut(out_ptr as *mut u32, HISTOGRAM_BINS_LEN)
                .copy_from_slice(&bins);
        }
        0
    })
}

/// Bytes-source sibling of [`maple_histogram_file`] for hosts that hold the
/// RAW in memory rather than on disk (Apple PhotoKit / Self-Hosted assets,
/// which live behind an opaque identifier with no file path). Decodes
/// `raw_bytes` (dispatched by the `hint_ext` extension), develops it under the
/// adjustments in `xmp_doc`, bins the 8-bit sRGB result, and writes the 3×256
/// channel-major histogram into the caller-owned `out_bins`.
///
/// `xmp_doc` is the XMP *document text itself* (nullable), NOT a path — a
/// sourceless asset has no `.xmp` on disk, so the editor serialises its live
/// in-memory model straight to a string. `null` ⇒ `AdjustmentModel::default()`.
///
/// `quality_preview` mirrors [`maple_render_bytes`]: `1` = half-res preview
/// demosaic, `0` = full export quality. A histogram is a statistical reduction,
/// so the half-res demosaic is visually identical and ~4× cheaper — the
/// interactive Apple scope passes `1`. Either way each surviving pixel
/// contributes exactly one sample per channel, so all three channel sums equal
/// the rendered pixel count.
///
/// Auto Profile parity: the develop runs through
/// [`render_from_raw_with_quality_and_source`] with [`RawInput::Bytes`] — the
/// same source the web WASM canvas uses — so a `Profile::Auto` model fits its
/// curve from the embedded preview exactly as the displayed image does. (The
/// legacy `maple_render_bytes` passes no source and so runs AgX
/// unconditionally; the histogram wants canvas parity, hence the `_and_source`
/// form here.)
///
/// Same memory contract as `maple_histogram_file`: the rendered pixel buffer
/// never crosses the boundary — only the 3 KB histogram does, through a buffer
/// the caller owns.
///
/// Returns 0 on success, non-zero on error (call `maple_last_error`). Error
/// codes: 1 = null `raw_bytes` / null or misaligned `out_bins`, 2 = `hint_ext`
/// not UTF-8, 3 = `xmp_doc` not UTF-8, 4 = XMP parse, 7 = decode, 8 = render.
/// (No raw-read / xmp-read codes — nothing is read from disk.)
///
/// # Safety
///
/// `raw_bytes` must point to `raw_len` readable bytes for the duration of the
/// call; `hint_ext` and `xmp_doc` may be null or valid C strings; `out_bins`
/// must point to >= [`HISTOGRAM_BINS_LEN`] writable `u32`s that are
/// `u32`-aligned (rejected with code 1 otherwise) and outlive the call.
#[no_mangle]
pub unsafe extern "C" fn maple_histogram_bytes(
    raw_bytes: *const u8,
    raw_len: usize,
    hint_ext: *const c_char,
    xmp_doc: *const c_char,
    quality_preview: i32,
    out_bins: *mut u32,
) -> i32 {
    if raw_bytes.is_null() || out_bins.is_null() {
        set_last_error("null pointer argument".into());
        return 1;
    }
    // Same alignment guard as `maple_histogram_file` — `out_bins` is
    // reinterpreted as a `*mut u32` slice below, instant UB if unaligned.
    if out_bins as usize % std::mem::align_of::<u32>() != 0 {
        set_last_error("out_bins pointer is not u32-aligned".into());
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
    let xmp_doc_owned: Option<String> = if xmp_doc.is_null() {
        None
    } else {
        match CStr::from_ptr(xmp_doc).to_str() {
            Ok(s) => Some(s.to_owned()),
            Err(e) => {
                set_last_error(format!("xmp_doc not UTF-8: {}", e));
                return 3;
            }
        }
    };
    // Copy input bytes into a Vec the worker can own — the caller's pointer may
    // not live past the join() on a slow decode (mirrors `maple_render_bytes`).
    let input: Vec<u8> = std::slice::from_raw_parts(raw_bytes, raw_len).to_vec();
    let out_ptr = out_bins as usize; // Send across the worker thread as a usize.
    with_large_stack(move || {
        let model = match load_xmp_model_from_doc(xmp_doc_owned.as_deref()) {
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
            _ => RenderQuality::Full,
        };
        let (_w, _h, bytes) = match render_from_raw_with_quality_and_source(
            &raw_img,
            &model,
            quality,
            Some(RawInput::Bytes {
                bytes: &input,
                ext: &ext_owned,
            }),
        ) {
            Ok(t) => t,
            Err(e) => {
                set_last_error(format!("render: {}", e));
                return 8;
            }
        };
        let bins = bin_rgb888(&bytes);
        // SAFETY: the caller guarantees `out_bins` (captured as `out_ptr`)
        // points to >= HISTOGRAM_BINS_LEN writable u32s that outlive the call.
        unsafe {
            std::slice::from_raw_parts_mut(out_ptr as *mut u32, HISTOGRAM_BINS_LEN)
                .copy_from_slice(&bins);
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
