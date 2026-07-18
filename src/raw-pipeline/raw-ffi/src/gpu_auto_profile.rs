//! `gpu`-gated Auto Profile artifact FFI (epic #925, P4b-apple / #1028) — fit the
//! per-image Auto Profile tail and return the **raw curve + residual LUT as
//! SEPARATE artifacts**, instead of the pre-composed 33³ cube the default FFI
//! (`maple_compute_auto_profile_lut`) bakes.
//!
//! ## Why separate artifacts (not the cube)
//!
//! The default Apple path composes `curve ∘ residual` into one `CIColorCube`
//! (`AutoProfileLUT.swift`) and lets CoreImage apply it. The wgpu live chain
//! (#925 P4b) instead runs the curve and the residual as TWO distinct GPU passes
//! (`AutoProfileCurvePass` + `ResidualLutPass` — they consume
//! `FullChainInputs.{profile_curve_flat, residual_lut_size, residual_lut_data}`).
//! So the host needs the fitted `ProfileCurve::to_flat()` and the residual
//! `ColorLut.{size, data}` UN-composed, to feed [`crate::MapleGpuLiveParams`].
//!
//! This delegates to the SAME `raw_core::pipeline::fit_auto_profile_from_raw` the
//! cube FFI uses (and shares its `auto_profile::cache` LRUs), so the two-pass GPU
//! tail and the cube cannot drift on the fit — they differ ONLY in compose-then-
//! sample (cube) vs sample-curve-then-sample-residual (passes), a within-tolerance
//! numerical difference the host parity test bounds.
//!
//! Gated behind the `gpu` feature with the rest of the gpu FFI, so it (and the
//! `MapleGpuLiveParams` it feeds) is absent from the default xcframework.

use crate::error::{set_last_error, with_large_stack};
use crate::model::{load_xmp_model_owned, LoadModel};
use raw_core::decode::decode_bytes;
use raw_core::decode_cache::{decode_bytes_cached, CacheKey};
use raw_core::pipeline::{
    cached_auto_profile_fit, fit_auto_profile_from_raw, RawInput, RenderQuality,
};
use raw_core::view::auto_profile::cache::CacheKey as AutoCacheKey;
use std::ffi::{c_char, CStr};

/// The flat-`f32` length of a serialized `ProfileCurve` — the size the host must
/// allocate for `maple_gpu_fit_auto_profile`'s `curve_out` (and the
/// `profile_curve_len` it sets on `MapleGpuLiveParams`). The Swift host has no
/// other source for it (raw-core's `PROFILE_CURVE_FLAT_LEN` is a cross-crate const
/// cbindgen can't evaluate), so this literal is emitted into the header as a
/// `#define`. The `const _` assertion below PINS it to raw-core's value — a drift
/// fails the build, not just the FFI's runtime `to_flat().len()` check.
pub const MAPLE_PROFILE_CURVE_FLAT_LEN: usize = 220;

/// Compile-time pin: the header constant MUST equal raw-core's authoritative
/// `PROFILE_CURVE_FLAT_LEN` (a curve-layout change there breaks the host ABI here).
const _: () = assert!(
    MAPLE_PROFILE_CURVE_FLAT_LEN == raw_core::view::auto_profile::PROFILE_CURVE_FLAT_LEN,
    "MAPLE_PROFILE_CURVE_FLAT_LEN drifted from raw-core's PROFILE_CURVE_FLAT_LEN"
);

/// Fit the per-image Auto Profile tail (#550 curve + #924 residual LUT) for a RAW
/// file + XMP sidecar and write the curve + residual as SEPARATE artifacts (the
/// un-composed inputs the wgpu live chain's curve + residual-LUT passes consume —
/// see this module's docs on why not the cube).
///
/// Writes, on success:
/// - `*curve_present` = 1 and `curve_out[0..PROFILE_CURVE_FLAT_LEN]` = the fitted
///   `ProfileCurve::to_flat()`, OR `*curve_present` = 0 (the fit produced no curve
///   — too few pairs; the host uses the identity curve, i.e. the residual alone).
/// - `*lut_size` = the residual LUT edge `n` (0 if no residual), and
///   `lut_out[0..n³·3]` = `ColorLut.data` (R fastest — `data[((b*n+g)*n+r)*3+c]`,
///   the same layout the residual-LUT pass / the cube bake use).
///
/// `*lut_size` is ALWAYS written first (even on the buffer-too-small path), so a
/// caller that under-sized `lut_out` can read the needed edge, reallocate
/// `lut_size³·3` floats, and re-call (the fit is cached — the second call is
/// cheap). The residual is fit at a fixed edge today, but surfacing the size keeps
/// the host robust to a core change.
///
/// `quality_preview`: `0` = `Full` (matches the parity harness / `maple-cli`),
/// `1` = `Preview` (half-res develop). Pass the value the host's decode used so
/// the fit matches the displayed buffer.
///
/// This is a **per-image, one-shot** call (JPEG extract + full develop + fit,
/// orders of magnitude over the slider-tick budget). Both fits are cached in the
/// shared `auto_profile` LRUs keyed `(path, mtime, quality)`; a call whose
/// artifacts are fully cached returns WITHOUT reading or decoding the RAW at
/// all (#2035 — the Apple host re-issues this call on every GPU session
/// re-open, so the hit path is just an artifact copy). The host should ALSO
/// cache the returned artifacts and never call this per slider tick.
///
/// Returns:
/// - `0` on success — at least one of curve / residual was fit and written.
/// - `1` when no tail applies (not `Profile::Auto`, or no embedded JPEG so both
///   stages fail). Out-params: `*curve_present = 0`, `*lut_size = 0`. The host
///   renders plain AgX (= `Profile::Neutral`).
/// - `2`/`3` when `raw_path` / `xmp_path` is non-UTF-8.
/// - `6`/`7` when the RAW read / decode fails (`maple_last_error` is set).
/// - `9` on an internal invariant failure — the fitted curve did not serialize to
///   `PROFILE_CURVE_FLAT_LEN` (a layout bug; `maple_last_error` is set).
/// - `-1` when `raw_path`, `curve_out`, `curve_present`, `lut_out`, or `lut_size`
///   is null, or a buffer is mis-aligned. The error path does not set
///   `maple_last_error` (the caller owns the buffers).
/// - `-2` when `lut_out` is too small for the fitted residual — `*lut_size` holds
///   the required edge `n` (reallocate `n³·3` floats and re-call; the fit is cached).
///
/// # Safety
/// - `raw_path` must be a valid UTF-8 C string; `xmp_path` may be null.
/// - `curve_out` must point to ≥ `PROFILE_CURVE_FLAT_LEN` writable, f32-aligned f32.
/// - `lut_out` must point to ≥ `lut_capacity_floats` writable, f32-aligned f32.
/// - `curve_present` (i32) and `lut_size` (u32) must be valid writable pointers.
/// - All buffers must live for the duration of the call. Written only as documented.
#[no_mangle]
pub unsafe extern "C" fn maple_gpu_fit_auto_profile(
    raw_path: *const c_char,
    xmp_path: *const c_char,
    quality_preview: i32,
    curve_out: *mut f32,
    curve_present: *mut i32,
    lut_out: *mut f32,
    lut_capacity_floats: usize,
    lut_size: *mut u32,
) -> i32 {
    use raw_core::view::auto_profile::PROFILE_CURVE_FLAT_LEN;

    if raw_path.is_null()
        || curve_out.is_null()
        || curve_present.is_null()
        || lut_out.is_null()
        || lut_size.is_null()
    {
        return -1;
    }
    // `curve_out` / `lut_out` are written as `*mut f32` via `copy_nonoverlapping`;
    // reject mis-aligned buffers up front (UB otherwise — mirrors the render.rs /
    // auto_profile.rs alignment guards).
    if (curve_out as usize) % std::mem::align_of::<f32>() != 0
        || (lut_out as usize) % std::mem::align_of::<f32>() != 0
    {
        return -1;
    }
    // Always write the out-params first so the caller can rely on them on every
    // path (a None fit ⇒ no curve, no residual).
    *curve_present = 0;
    *lut_size = 0;

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

    let curve_out_addr = curve_out as usize;
    let curve_present_addr = curve_present as usize;
    let lut_out_addr = lut_out as usize;
    let lut_size_addr = lut_size as usize;

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
        // The default (null-xmp) model's profile IS Auto, so the Apple host's
        // sidecar-less calls are unaffected. Note this also means a non-Auto
        // call on an unreadable RAW reports 1 (no tail) rather than 6/7 — the
        // host treats both as "render plain AgX".
        if model.profile != raw_core::xmp::Profile::Auto {
            return 1;
        }
        let quality = if quality_preview != 0 {
            RenderQuality::Preview
        } else {
            RenderQuality::Full
        };

        // #2035: cache-only probe BEFORE any file I/O. The Apple GPU-live host
        // re-issues this call on every session re-open (a window resize, a
        // zoom past fit), and the fit LRUs usually still hold the artifacts —
        // under a hit the whole call is an artifact copy, skipping the
        // full-file read and the decode entirely. The probe key carries the
        // develop quality, so a Preview host can never be served Full-fit
        // artifacts (or vice versa).
        let auto_key = AutoCacheKey::from_path(raw_path, quality);
        let fit_result = match cached_auto_profile_fit(&model, auto_key.as_ref()) {
            Some(pair) => Some(pair),
            None => {
                // Miss (or no tail) — the pre-#2035 read + decode + fit path.
                // Compute the decode-cache key BEFORE the read so a file
                // replaced between read and stat can't cache T0-content under
                // a T1-mtime key (TOCTOU stale-hit).
                let cache_key = CacheKey::from_path(raw_path);
                let ext = raw_path.extension().and_then(|e| e.to_str()).unwrap_or("");
                // #2035: probe the decoded-RawImage cache (#949) first — on a
                // hit the full-file read below is skipped too.
                let raw_img = match cache_key.as_ref().and_then(raw_core::decode_cache::get) {
                    Some(img) => img,
                    None => {
                        let raw_bytes =
                            match raw_core::pipeline::stage("ffi_gpu_auto_raw_read", || {
                                std::fs::read(raw_path)
                            }) {
                                Ok(b) => b,
                                Err(e) => {
                                    set_last_error(format!("raw read: {}", e));
                                    return 6;
                                }
                            };
                        // #1662: route through the SAME decoded-RawImage cache
                        // (#949) the scene-linear render FFI populated moments
                        // earlier under this path key, so the GPU-live
                        // Auto-Profile fit HITS instead of re-decoding the RAW
                        // a second time. Falls back to an uncached decode on an
                        // un-stattable path (key None), mirroring
                        // `decode_file_cached`.
                        match raw_core::pipeline::stage("ffi_gpu_auto_decode", || {
                            match cache_key.as_ref() {
                                Some(k) => decode_bytes_cached(k, &raw_bytes, ext),
                                None => Ok(std::sync::Arc::new(decode_bytes(&raw_bytes, ext)?)),
                            }
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
        };
        let (curve_opt, residual_opt) = match fit_result {
            Some(pair) => pair,
            // Not Auto, or no embedded JPEG (both stages None) — host AgX.
            None => return 1,
        };

        // --- Curve: write the flat serialization iff a curve was fit. ---
        if let Some(curve) = curve_opt {
            let flat = curve.to_flat();
            if flat.len() != PROFILE_CURVE_FLAT_LEN {
                set_last_error(format!(
                    "internal: ProfileCurve serialized to {} f32, expected {}",
                    flat.len(),
                    PROFILE_CURVE_FLAT_LEN
                ));
                return 9;
            }
            // SAFETY: caller guarantees `curve_out` holds ≥ PROFILE_CURVE_FLAT_LEN
            // writable, f32-aligned floats (validated above for null/alignment).
            unsafe {
                std::ptr::copy_nonoverlapping(
                    flat.as_ptr(),
                    curve_out_addr as *mut f32,
                    PROFILE_CURVE_FLAT_LEN,
                );
                *(curve_present_addr as *mut i32) = 1;
            }
        }

        // --- Residual: report the edge, write the grid iff it fits. ---
        if let Some(residual) = residual_opt {
            let n = residual.size;
            // SAFETY: `lut_size` validated non-null above.
            unsafe {
                *(lut_size_addr as *mut u32) = n as u32;
            }
            let needed = match n
                .checked_mul(n)
                .and_then(|nn| nn.checked_mul(n))
                .and_then(|nnn| nnn.checked_mul(3))
            {
                Some(v) => v,
                // A residual this large can't exist (LUT_SIZE is tiny), but guard
                // the arithmetic rather than overflow into the copy.
                None => return -1,
            };
            debug_assert_eq!(residual.data.len(), needed, "ColorLut data/size mismatch");
            if needed > lut_capacity_floats {
                // Buffer too small — `*lut_size` already tells the caller the edge.
                // Re-call with `n³·3` floats (the fit is cached → cheap).
                return -2;
            }
            // SAFETY: `lut_out` holds ≥ lut_capacity_floats ≥ needed writable,
            // f32-aligned floats (validated above).
            unsafe {
                std::ptr::copy_nonoverlapping(
                    residual.data.as_ptr(),
                    lut_out_addr as *mut f32,
                    needed,
                );
            }
        }

        0
    })
}

#[cfg(test)]
#[path = "gpu_auto_profile_tests.rs"]
mod gpu_auto_profile_tests;
