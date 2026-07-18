//! Auto Profile FFI — fit + bake the per-image tone tail (#812 / #817 / #924)
//! into a display-space 3D LUT for the GPU hosts. Split out of `render.rs` to
//! keep both under the file-size budget; the `#[no_mangle]` symbols are
//! unchanged (cbindgen scans every module, so the C ABI is identical).

use crate::error::{set_last_error, with_large_stack};
use crate::model::{load_xmp_model_owned, LoadModel};
use raw_core::decode::decode_bytes;
use raw_core::decode_cache::{decode_bytes_cached, CacheKey};
use raw_core::pipeline::{
    cached_auto_profile_fit, fit_auto_profile_from_raw, fit_profile_curve_from_raw, RawInput,
    RenderQuality,
};
use raw_core::view::auto_profile::cache::CacheKey as AutoCacheKey;
use std::ffi::{c_char, CStr};

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
    // `out` is written as `*mut f32` via `copy_nonoverlapping`, which is UB if
    // `out` is not f32-aligned. Public C ABI — validate alignment rather than
    // trust the caller (mirrors the histogram guard in render.rs).
    if (out as usize) % std::mem::align_of::<f32>() != 0 {
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
/// `(raw_identity, mtime, quality)`, so the host should ALSO cache the
/// returned curve on its side and never call this per slider tick.
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
    // `out` is written as `*mut f32` via `copy_nonoverlapping`; reject a
    // non-f32-aligned `out` up front (UB otherwise — see the render.rs guard).
    if (out as usize) % std::mem::align_of::<f32>() != 0 {
        return -1;
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
    let out_ptr = out as usize;
    with_large_stack(move || {
        let raw_path = std::path::Path::new(&raw_path_str);
        let model = match load_xmp_model_owned(xmp_path_str.as_deref()) {
            LoadModel::Ok(m) => m,
            LoadModel::Err(rc) => return rc,
        };
        let raw_bytes =
            match raw_core::pipeline::stage("ffi_profile_raw_read", || std::fs::read(raw_path)) {
                Ok(b) => b,
                Err(e) => {
                    set_last_error(format!("raw read: {}", e));
                    return 6;
                }
            };
        let ext = raw_path.extension().and_then(|e| e.to_str()).unwrap_or("");
        let raw_img =
            match raw_core::pipeline::stage("ffi_profile_decode", || decode_bytes(&raw_bytes, ext))
            {
                Ok(r) => r,
                Err(e) => {
                    set_last_error(format!("decode: {}", e));
                    return 7;
                }
            };
        let quality = if quality_preview != 0 {
            RenderQuality::Preview
        } else {
            RenderQuality::Full
        };
        match fit_profile_curve_from_raw(&raw_img, &model, quality, RawInput::Path(raw_path)) {
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

/// Fit AND bake the FULL per-image Auto Profile tail (#550 curve **plus** the
/// per-image residual 3D LUT, #924) for a RAW file + XMP sidecar into one
/// composed display-space 3D LUT written to `out`.
///
/// This is the one-shot fusion of `maple_compute_profile_curve` (fit) and
/// `maple_compute_profile_lut` (bake), extended with the residual stage that
/// only the CPU/Web/CLI paths carried until now. It delegates to
/// `raw_core::pipeline::fit_auto_profile_from_raw`, which develops the RAW
/// through the SAME view-transform prefix as the CPU render (AE-off develop →
/// AgX → rec2020→sRGB → sRGB gamma encode), fits the curve, applies it, then
/// fits the residual on the curved buffer — so the composed cube cannot drift
/// from `maple_render_file`'s CPU Auto Profile output. The compose is exactly
/// `residual.sample(curve(node))` over the grid (see
/// `raw_core::view::auto_profile::bake_auto_profile_lut`), so a host samples ONE
/// cube to apply the whole tail in one GPU pass.
///
/// Layout (matches `maple_compute_profile_lut` / `bake_profile_lut`): `n³` RGB
/// triplets, R fastest — `out[((b*n + g)*n + r)*3 + c]`, grid coord `k` →
/// `k / (n - 1)`. Degrades gracefully: a missing residual bakes the curve only
/// (byte-identical to `maple_compute_profile_lut` on that curve); a missing
/// curve bakes the residual over identity (the AE-off brightness anchor — it
/// must NOT fall back to plain AgX, which would render darker than Neutral).
///
/// `quality_preview`: `0` = `Full` (matches the parity harness / `maple-cli`),
/// `1` = `Preview` (half-res develop). Pass the value the host's decode used.
///
/// This is a **per-image, one-shot** call (JPEG extract + full develop + fit +
/// bake, orders of magnitude over the slider-tick budget). Both fits are cached
/// in the shared `auto_profile` LRUs keyed `(path, mtime, quality)`; a call
/// whose artifacts are fully cached bakes straight from the cache WITHOUT
/// reading or decoding the RAW at all (#2035). The host should ALSO cache the
/// composed cube and never call this per slider tick.
///
/// Returns:
/// - `0` on success — `out` holds `n * n * n * 3` f32.
/// - `1` when no tail applies (not `Profile::Auto`, or no embedded JPEG so both
///   stages fail). `out` is untouched; the host renders plain AgX.
/// - `2`/`3` when `raw_path` / `xmp_path` is non-UTF-8.
/// - `6`/`7` when the RAW read / decode fails (`maple_last_error` is set).
/// - `9` on an internal invariant failure — the baked LUT length did not equal
///   `n³ * 3` (a layout bug, never a caller error; `maple_last_error` is set).
/// - `-1` when `raw_path` or `out` is null, `n < 2`, `n > MAX_LUT_SIZE`, or
///   `n³ * 3` would overflow `usize`. The error path does not set
///   `maple_last_error` (the caller owns `n` + `out`).
///
/// # Safety
/// - `raw_path` must be a valid UTF-8 C string; `xmp_path` may be null.
/// - `out` must point to at least `n * n * n * 3` writable f32 that live for the
///   duration of the call. It is overwritten only on success.
#[no_mangle]
pub unsafe extern "C" fn maple_compute_auto_profile_lut(
    raw_path: *const c_char,
    xmp_path: *const c_char,
    quality_preview: i32,
    n: u32,
    out: *mut f32,
) -> i32 {
    use raw_core::view::auto_profile::{
        bake_auto_profile_lut, bake_profile_lut, ProfileCurve, MAX_LUT_SIZE,
    };
    if raw_path.is_null() || out.is_null() {
        return -1;
    }
    // `out` is written as `*mut f32` via `copy_nonoverlapping`; a non-f32-aligned
    // `out` from a C caller would be UB. Public C ABI — validate up front and
    // reject with -1 (mirrors the histogram guard in render.rs).
    if (out as usize) % std::mem::align_of::<f32>() != 0 {
        return -1;
    }
    // Validate `n` and the output sizing BEFORE the multi-second develop so a
    // bad request fails fast. `bake_*` panic outside `[2, MAX_LUT_SIZE]`, and a
    // panic across `extern "C"` aborts the host — reject here instead.
    let n = n as usize;
    if n < 2 || n > MAX_LUT_SIZE {
        return -1;
    }
    let out_len = match n
        .checked_mul(n)
        .and_then(|nn| nn.checked_mul(n))
        .and_then(|nnn| nnn.checked_mul(3))
    {
        Some(l) => l,
        None => return -1,
    };
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
    let out_ptr = out as usize;
    with_large_stack(move || {
        let raw_path = std::path::Path::new(&raw_path_str);
        let model = match load_xmp_model_owned(xmp_path_str.as_deref()) {
            LoadModel::Ok(m) => m,
            LoadModel::Err(rc) => return rc,
        };
        // Not `Profile::Auto` → no tail can ever fit: `fit_auto_profile_from_raw`'s
        // own top guard returns `None` (→ this entry's rc 1) without using the
        // decoded RAW, so exit with the identical rc 1 BEFORE the cache-key
        // stat, the probe, and any read/decode work (Copilot review on #2053).
        // The default (null-xmp) model's profile IS Auto, so sidecar-less calls
        // are unaffected. Note this also means a non-Auto call on an unreadable
        // RAW reports 1 (no tail) rather than 6/7 — the host treats both as
        // "render plain AgX".
        if model.profile != raw_core::xmp::Profile::Auto {
            return 1;
        }
        let quality = if quality_preview != 0 {
            RenderQuality::Preview
        } else {
            RenderQuality::Full
        };
        // #2035: cache-only probe BEFORE any file I/O — when the shared fit
        // LRUs already hold BOTH artifacts for `(path, mtime, quality)`, the
        // bake below needs nothing from the file, so the full-file read and
        // the decode are skipped entirely. The quality in the key keeps a
        // Preview-fit from ever being baked for a Full-quality caller (and
        // vice versa).
        let fit_result = {
            let auto_key = AutoCacheKey::from_path(raw_path, quality);
            match cached_auto_profile_fit(&model, auto_key.as_ref()) {
                Some(pair) => Some(pair),
                None => {
                    // Miss (or no tail) — the pre-#2035 read + decode + fit
                    // path. Compute the decode-cache key BEFORE reading — if
                    // the file changes between here and fs::read we cache the
                    // new bytes under the new mtime, not the old one.
                    let cache_key = CacheKey::from_path(raw_path);
                    let ext = raw_path.extension().and_then(|e| e.to_str()).unwrap_or("");
                    // #2035: probe the decoded-RawImage cache (#949) first —
                    // on a hit the full-file read below is skipped too.
                    let raw_img = match cache_key.as_ref().and_then(raw_core::decode_cache::get) {
                        Some(img) => img,
                        None => {
                            let raw_bytes =
                                match raw_core::pipeline::stage("ffi_auto_lut_raw_read", || {
                                    std::fs::read(raw_path)
                                }) {
                                    Ok(b) => b,
                                    Err(e) => {
                                        set_last_error(format!("raw read: {}", e));
                                        return 6;
                                    }
                                };
                            // #949: route through the decoded-RawImage cache
                            // keyed on (path, mtime). The scene-linear render
                            // FFI decoded the SAME file moments earlier under
                            // the same path key, so this is a hit and the
                            // ~1.8s decode is skipped. The `ffi_auto_lut_decode`
                            // stage wrapper stays so a hit reads as ~0ms.
                            match raw_core::pipeline::stage("ffi_auto_lut_decode", || {
                                decode_auto_lut_cached(cache_key.as_ref(), &raw_bytes, ext)
                            }) {
                                Ok(r) => r,
                                Err(e) => {
                                    set_last_error(format!("decode: {}", e));
                                    return 7;
                                }
                            }
                        }
                    };
                    fit_auto_profile_from_raw(&raw_img, &model, quality, RawInput::Path(raw_path))
                }
            }
        };
        let (curve_opt, residual_opt) = match fit_result {
            Some(pair) => pair,
            // Not Auto, or no embedded JPEG (both stages None) — host AgX.
            None => return 1,
        };
        // Compose curve ∘ residual into one cube. A missing curve degrades to
        // identity (residual-only, the AE-off brightness anchor); a missing
        // residual bakes the curve only — BYTE-identical to the #812 cube.
        let curve = curve_opt.unwrap_or_else(ProfileCurve::identity);
        let lut = match residual_opt {
            Some(residual) => bake_auto_profile_lut(&curve, &residual, n),
            None => bake_profile_lut(&curve, n),
        };
        // `bake_*` always return exactly `n³ * 3` for an accepted `n`; guard the
        // unsafe copy anyway so a future layout change can't OOB. Distinct `9`
        // (vs `-1` for null args) + `maple_last_error` so it's diagnosable.
        if lut.len() != out_len {
            set_last_error(format!(
                "internal: baked Auto Profile LUT len {} != expected {}",
                lut.len(),
                out_len
            ));
            return 9;
        }
        unsafe {
            std::ptr::copy_nonoverlapping(lut.as_ptr(), out_ptr as *mut f32, out_len);
        }
        0
    })
}

/// Decode a RAW file for the Auto-Profile LUT path through the decoded-`RawImage`
/// cache (#949), keyed on `(canonical path, mtime)`. This uses the SAME path
/// key the scene-linear render FFI computed moments earlier on a cold open, so
/// it hits and the ~1.8s decode is skipped.
///
/// `key` is a pre-computed [`CacheKey`] obtained by calling
/// `CacheKey::from_path` BEFORE `std::fs::read` at the call site — computing
/// it after the read would risk caching `T0`-content under a `T1`-mtime key if
/// the file is replaced between read and stat (TOCTOU stale-hit). Falls back to
/// a plain uncached `decode_bytes` on `None` (un-stattable path), so behaviour
/// is never worse than before the cache. Mirrors
/// `scene_linear_f32::decode_file_cached`.
fn decode_auto_lut_cached(
    key: Option<&CacheKey>,
    raw_bytes: &[u8],
    ext: &str,
) -> raw_core::Result<std::sync::Arc<raw_core::RawImage>> {
    match key {
        Some(k) => decode_bytes_cached(k, raw_bytes, ext),
        None => Ok(std::sync::Arc::new(decode_bytes(raw_bytes, ext)?)),
    }
}

#[cfg(test)]
#[path = "auto_profile_tests.rs"]
mod auto_profile_tests;
