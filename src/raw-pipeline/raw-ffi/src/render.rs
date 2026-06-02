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
use raw_core::{
    decode::decode_bytes,
    pipeline::{
        fit_profile_curve_from_raw, render_from_raw_with_quality,
        render_from_raw_with_quality_and_source, RawInput, RenderQuality,
    },
};
use std::ffi::{CStr, c_char};

/// Render a RAW+XMP to an sRGB 8-bit RGB buffer. Returns 0 on success, non-zero
/// on error (call `maple_last_error` for a description). `xmp_path` may be null,
/// in which case AdjustmentModel::default() is used.
///
/// `quality_preview` selects the internal demosaic / downsample strategy:
///   0 → `RenderQuality::Full`    (bilinear or HA demosaic, full resolution;
///                                  export path, matches the parity harness)
///   1 → `RenderQuality::Preview` (half-res quad demosaic; the returned
///                                  buffer is at half the sensor's dimensions
///                                  in both axes — caller must scale for
///                                  display; use for interactive fast-phase
///                                  so a 100MP RAW decodes in seconds)
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
        Err(e) => { set_last_error(format!("raw_path not UTF-8: {}", e)); return 2; }
    };
    let xmp_path_str: Option<String> = if xmp_path.is_null() {
        None
    } else {
        match CStr::from_ptr(xmp_path).to_str() {
            Ok(s) => Some(s.to_owned()),
            Err(e) => { set_last_error(format!("xmp_path not UTF-8: {}", e)); return 3; }
        }
    };
    let out_ptr = out as usize;  // Send across the thread as a usize, cast back inside.
    with_large_stack(move || {
        let raw_path = std::path::Path::new(&raw_path_str);
        let model = match load_xmp_model_owned(xmp_path_str.as_deref()) {
            LoadModel::Ok(m) => m,
            LoadModel::Err(rc) => return rc,
        };
        let raw_bytes = match raw_core::pipeline::stage("ffi_raw_read", || std::fs::read(raw_path)) {
            Ok(b) => b,
            Err(e) => { set_last_error(format!("raw read: {}", e)); return 6; }
        };
        let ext = raw_path.extension().and_then(|e| e.to_str()).unwrap_or("");
        let raw_img = match raw_core::pipeline::stage("ffi_rawler_decode", || decode_bytes(&raw_bytes, ext)) {
            Ok(r) => r,
            Err(e) => { set_last_error(format!("decode: {}", e)); return 7; }
        };
        let quality = if quality_preview != 0 {
            RenderQuality::Preview
        } else {
            RenderQuality::Full
        };
        // Pass the RAW path through so `Profile::Auto` (#537) can read the
        // embedded JPEG. `maple_render_file` is the file-backed entry —
        // the path is guaranteed to be valid; `maple_render_bytes` below
        // is bytes-only and runs AgX unconditionally.
        let (w, h, bytes) = match render_from_raw_with_quality_and_source(
            &raw_img, &model, quality, Some(raw_core::pipeline::RawInput::Path(raw_path)),
        ) {
            Ok(t) => t,
            Err(e) => { set_last_error(format!("render: {}", e)); return 8; }
        };
        let (rgb, len) = raw_core::pipeline::stage("ffi_pack", || {
            let mut boxed = bytes.into_boxed_slice();
            let p = boxed.as_mut_ptr();
            let n = boxed.len();
            std::mem::forget(boxed);
            (p, n)
        });
        unsafe {
            *(out_ptr as *mut MapleImageBuffer) =
                MapleImageBuffer { rgb, len, width: w, height: h };
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
/// 0 = full export quality.
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
            Err(e) => { set_last_error(format!("hint_ext not UTF-8: {}", e)); return 2; }
        }
    };
    let xmp_path_str: Option<String> = if xmp_path.is_null() {
        None
    } else {
        match CStr::from_ptr(xmp_path).to_str() {
            Ok(s) => Some(s.to_owned()),
            Err(e) => { set_last_error(format!("xmp_path not UTF-8: {}", e)); return 3; }
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
        let raw_img = match raw_core::pipeline::stage("ffi_rawler_decode", || decode_bytes(&input, &ext_owned)) {
            Ok(r) => r,
            Err(e) => { set_last_error(format!("decode: {}", e)); return 7; }
        };
        let quality = if quality_preview != 0 {
            RenderQuality::Preview
        } else {
            RenderQuality::Full
        };
        let (w, h, out_bytes) = match render_from_raw_with_quality(&raw_img, &model, quality) {
            Ok(t) => t,
            Err(e) => { set_last_error(format!("render: {}", e)); return 8; }
        };
        let (rgb, len) = raw_core::pipeline::stage("ffi_pack", || {
            let mut boxed = out_bytes.into_boxed_slice();
            let p = boxed.as_mut_ptr();
            let n = boxed.len();
            std::mem::forget(boxed);
            (p, n)
        });
        unsafe {
            *(out_ptr as *mut MapleImageBuffer) =
                MapleImageBuffer { rgb, len, width: w, height: h };
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
/// codes mirror `maple_render_file`: 1 = null arg, 2/3 = path not UTF-8,
/// 6 = read, 7 = decode, 8 = render.
///
/// # Safety
///
/// `raw_path` must be a valid C string; `xmp_path` may be null or a valid C
/// string; `out_bins` must point to >= [`HISTOGRAM_BINS_LEN`] writable `u32`s
/// that live for the duration of the call.
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
    let raw_path_str = match CStr::from_ptr(raw_path).to_str() {
        Ok(s) => s.to_owned(),
        Err(e) => { set_last_error(format!("raw_path not UTF-8: {}", e)); return 2; }
    };
    let xmp_path_str: Option<String> = if xmp_path.is_null() {
        None
    } else {
        match CStr::from_ptr(xmp_path).to_str() {
            Ok(s) => Some(s.to_owned()),
            Err(e) => { set_last_error(format!("xmp_path not UTF-8: {}", e)); return 3; }
        }
    };
    let out_ptr = out_bins as usize; // Send across the worker thread as a usize.
    with_large_stack(move || {
        let raw_path = std::path::Path::new(&raw_path_str);
        let model = match load_xmp_model_owned(xmp_path_str.as_deref()) {
            LoadModel::Ok(m) => m,
            LoadModel::Err(rc) => return rc,
        };
        let raw_bytes = match raw_core::pipeline::stage("ffi_raw_read", || std::fs::read(raw_path)) {
            Ok(b) => b,
            Err(e) => { set_last_error(format!("raw read: {}", e)); return 6; }
        };
        let ext = raw_path.extension().and_then(|e| e.to_str()).unwrap_or("");
        let raw_img = match raw_core::pipeline::stage("ffi_rawler_decode", || decode_bytes(&raw_bytes, ext)) {
            Ok(r) => r,
            Err(e) => { set_last_error(format!("decode: {}", e)); return 7; }
        };
        // Full-quality render so the histogram reflects the authoritative
        // export pixels (mirrors `maple_render_file` with quality_preview = 0).
        let (_w, _h, bytes) = match render_from_raw_with_quality_and_source(
            &raw_img, &model, RenderQuality::Full, Some(RawInput::Path(raw_path)),
        ) {
            Ok(t) => t,
            Err(e) => { set_last_error(format!("render: {}", e)); return 8; }
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

/// Bake a fitted Auto Profile curve into a display-space `n³` 3D LUT (#817)
/// and write it as `n * n * n * 3` f32 values into `out`.
///
/// `curve` points to `curve_len` f32 values — the flat serialization of a
/// `raw_core::view::auto_profile::ProfileCurve` produced by its `to_flat()`
/// (length `raw_core::view::auto_profile::PROFILE_CURVE_FLAT_LEN`). The LUT is
/// JUST the canonical `apply_curve` sampled over a regular `[0, 1]³` grid, so
/// the GPU sampler that uploads these bytes (Apple Metal #812, Web WebGL2
/// #394) cannot drift from the CPU render path.
///
/// **Layout** (matches `raw_core::view::auto_profile::bake_profile_lut`):
/// `n³` RGB triplets, R varying fastest, then G, then B —
/// `out[((b*n + g)*n + r)*3 + c]`. Grid coordinate `k` maps to display value
/// `k / (n - 1)`.
///
/// This is a **per-image, one-shot** call — the fitted curve is keyed on the
/// embedded JPEG (stable across slider edits), so the host bakes once when the
/// curve is first fit and re-samples the GPU texture every slider tick WITHOUT
/// re-baking. Never call this per tick.
///
/// Returns:
/// - `0` on success — `out` is fully written.
/// - `-1` if `curve` or `out` is null, `curve_len` is not exactly
///   `PROFILE_CURVE_FLAT_LEN`, `n < 2`, `n > MAX_LUT_SIZE`, or `n³ * 3` would
///   overflow `usize`.
///   The error path does not set `maple_last_error` (the caller owns the
///   curve bytes + `n` and a null/short buffer is its own diagnostic).
///
/// # Safety
/// - `curve` must point to at least `curve_len` readable f32 values.
/// - `out` must point to a writable buffer of at least `n * n * n * 3` f32
///   values that lives for the duration of the call. It is overwritten on
///   success and untouched on error.
#[no_mangle]
pub unsafe extern "C" fn maple_compute_profile_lut(
    curve: *const f32,
    curve_len: usize,
    n: u32,
    out: *mut f32,
) -> i32 {
    use raw_core::view::auto_profile::{
        bake_profile_lut, ProfileCurve, MAX_LUT_SIZE, PROFILE_CURVE_FLAT_LEN,
    };
    if curve.is_null() || out.is_null() {
        return -1;
    }
    if curve_len != PROFILE_CURVE_FLAT_LEN {
        return -1;
    }
    let n = n as usize;
    // Reject the degenerate and oversized `n` BEFORE calling `bake_profile_lut`
    // — bake panics on those, and a panic across `extern "C"` aborts the host
    // process. `MAX_LUT_SIZE` is the shared core constant, so FFI / WASM / core
    // agree on the accepted range.
    if n < 2 || n > MAX_LUT_SIZE {
        return -1;
    }
    // Guard the output sizing arithmetic before allocating / writing.
    let out_len = match n
        .checked_mul(n)
        .and_then(|nn| nn.checked_mul(n))
        .and_then(|nnn| nnn.checked_mul(3))
    {
        Some(l) => l,
        None => return -1,
    };
    let flat = std::slice::from_raw_parts(curve, curve_len);
    let parsed = match ProfileCurve::from_flat(flat) {
        Some(c) => c,
        None => return -1,
    };
    let lut = bake_profile_lut(&parsed, n);
    // Runtime length check that survives release builds: `bake_profile_lut`
    // always returns exactly `n³ * 3` for an accepted `n`, so this never fires
    // in practice, but guarding it (rather than `debug_assert_eq!`, which
    // compiles out in release) prevents any OOB read in the unsafe copy below
    // if that invariant were ever broken.
    if lut.len() != out_len {
        return -1;
    }
    std::ptr::copy_nonoverlapping(lut.as_ptr(), out, out_len);
    0
}

/// Fit the per-image Auto Profile curve (#812) for a RAW file + XMP sidecar
/// and write its flat serialization into `out`.
///
/// This is the FITTED-curve sibling of `maple_compute_profile_lut` (which
/// BAKES an already-fitted curve into a 3D LUT). The gap #840 flagged: the
/// bake entry took a serialized curve as INPUT, but nothing surfaced the
/// fit across FFI. This export closes that — the Apple Metal host (#812)
/// calls it once per image to obtain the curve, then feeds the result
/// straight into `maple_compute_profile_lut` to bake the GPU LUT.
///
/// It delegates to `raw_core::pipeline::fit_profile_curve_from_raw`, which
/// develops the RAW through the SAME view-transform prefix the CPU render
/// uses (AgX → rec2020→sRGB → sRGB gamma encode) and fits the curve in
/// f32 sRGB-encoded display space — so the GPU Auto Profile render cannot
/// drift from `maple_render_file`'s CPU Auto Profile output.
///
/// `quality_preview` mirrors `maple_render_file`: `0` = `RenderQuality::Full`
/// (matches the parity harness / `maple-cli render`), `1` = `Preview`
/// (half-res develop). Pass the same value the host's scene-linear decode
/// used so the fitted curve matches the buffer being displayed.
///
/// `out` must point to at least `PROFILE_CURVE_FLAT_LEN` writable f32. On
/// success the full flat curve is written and `0` is returned.
///
/// This is a **per-image, one-shot** call — the fit runs a full JPEG
/// extraction + develop chain (orders of magnitude over the slider tick
/// budget). The fit is cached in the shared `auto_profile` LRU keyed on
/// `(raw_identity, mtime)`, so the host should ALSO cache the returned
/// curve on its side and never call this per slider tick.
///
/// Returns:
/// - `0` on success — `out` holds `PROFILE_CURVE_FLAT_LEN` f32.
/// - `1` when no curve applies — the model is not `Profile::Auto`, the
///   embedded JPEG can't be extracted, or the fit is degenerate. `out` is
///   left untouched; the host renders plain AgX (= `Profile::Neutral`).
/// - `2`/`3` when `raw_path` / `xmp_path` is non-UTF-8.
/// - `6`/`7` when the RAW read / decode fails (`maple_last_error` is set).
/// - `9` on an internal invariant failure — the fitted curve did not serialize
///   to `PROFILE_CURVE_FLAT_LEN` (a layout bug, never a caller error;
///   `maple_last_error` is set). Distinct from `-1` so a host can tell this
///   apart from a null-pointer argument.
/// - `-1` when `raw_path` or `out` is null.
///
/// # Safety
/// - `raw_path` must be a valid UTF-8 C string; `xmp_path` may be null.
/// - `out` must point to at least `PROFILE_CURVE_FLAT_LEN` writable f32 that
///   live for the duration of the call. It is overwritten only on success.
#[no_mangle]
pub unsafe extern "C" fn maple_compute_profile_curve(
    raw_path: *const c_char,
    xmp_path: *const c_char,
    quality_preview: i32,
    out: *mut f32,
) -> i32 {
    use raw_core::view::auto_profile::PROFILE_CURVE_FLAT_LEN;
    if raw_path.is_null() || out.is_null() {
        return -1;
    }
    let raw_path_str = match CStr::from_ptr(raw_path).to_str() {
        Ok(s) => s.to_owned(),
        Err(e) => { set_last_error(format!("raw_path not UTF-8: {}", e)); return 2; }
    };
    let xmp_path_str: Option<String> = if xmp_path.is_null() {
        None
    } else {
        match CStr::from_ptr(xmp_path).to_str() {
            Ok(s) => Some(s.to_owned()),
            Err(e) => { set_last_error(format!("xmp_path not UTF-8: {}", e)); return 3; }
        }
    };
    let out_ptr = out as usize;
    with_large_stack(move || {
        let raw_path = std::path::Path::new(&raw_path_str);
        let model = match load_xmp_model_owned(xmp_path_str.as_deref()) {
            LoadModel::Ok(m) => m,
            LoadModel::Err(rc) => return rc,
        };
        let raw_bytes = match raw_core::pipeline::stage("ffi_profile_raw_read", || std::fs::read(raw_path)) {
            Ok(b) => b,
            Err(e) => { set_last_error(format!("raw read: {}", e)); return 6; }
        };
        let ext = raw_path.extension().and_then(|e| e.to_str()).unwrap_or("");
        let raw_img = match raw_core::pipeline::stage("ffi_profile_decode", || decode_bytes(&raw_bytes, ext)) {
            Ok(r) => r,
            Err(e) => { set_last_error(format!("decode: {}", e)); return 7; }
        };
        let quality = if quality_preview != 0 {
            RenderQuality::Preview
        } else {
            RenderQuality::Full
        };
        match fit_profile_curve_from_raw(
            &raw_img, &model, quality, RawInput::Path(raw_path),
        ) {
            Some(curve) => {
                let flat = curve.to_flat();
                // `to_flat` always returns exactly PROFILE_CURVE_FLAT_LEN —
                // guard the unsafe copy so a future layout change can't OOB.
                // This is an internal invariant failure, NOT a caller error, so
                // return a distinct `9` (not the `-1` reserved for null args)
                // and set `maple_last_error` so it is diagnosable (#844).
                if flat.len() != PROFILE_CURVE_FLAT_LEN {
                    set_last_error(format!(
                        "internal: ProfileCurve serialized to {} f32, expected {}",
                        flat.len(),
                        PROFILE_CURVE_FLAT_LEN
                    ));
                    return 9;
                }
                unsafe {
                    std::ptr::copy_nonoverlapping(
                        flat.as_ptr(),
                        out_ptr as *mut f32,
                        PROFILE_CURVE_FLAT_LEN,
                    );
                }
                0
            }
            // Not Auto, no JPEG, or degenerate fit — host falls back to AgX.
            None => 1,
        }
    })
}

