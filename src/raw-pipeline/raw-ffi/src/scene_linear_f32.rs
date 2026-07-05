//! Scene-linear Rec.2020 f32 RGBA render entries (#482).
//!
//! f32 sibling of `scene_linear.rs`. Mirrors the four fp16 entries
//! (file/bytes × full/sized) returning `MapleSceneLinearBufferF32` so
//! consumers can hold the scene-linear buffer at full f32 precision
//! end-to-end (#416). The fp16 entries are kept intact — Apple still
//! consumes them today; the per-tick FFI chain is fp16 in/out, so
//! migrating Apple's render path alone would silently round-trip back
//! to fp16 every slider tick. Apple migration is tracked as a separate
//! ticket once `maple_apply_scene_linear_chain` grows an f32 sibling.
//! Web consumes f32 directly (RGBA32F FBOs).
//!
//! Split out of `scene_linear.rs` so each file stays under the 600-LOC
//! budget. The strip / dehaze-guard / Auto-Profile-AE contracts documented
//! in `scene_linear.rs` apply here too — in particular, post-#927 these
//! buffers are AE-off for every preview-bearing RAW under `Profile::Auto`,
//! and are only display-faithful with the fitted tail applied (#1174).

use crate::buffers::MapleSceneLinearBufferF32;
use crate::cancel::{token_from_ptr, MapleCancelFlag, SendCancelPtr};
use crate::error::{set_last_error, with_large_stack};
use crate::model::{
    force_ae_off_if_auto_will_fit_bytes, force_ae_off_if_auto_will_fit_path, load_xmp_model_owned,
    LoadModel,
};
use raw_core::decode::decode_bytes;
use raw_core::decode_cache::{decode_bytes_cached, CacheKey};
use raw_core::error::Error as CoreError;
use raw_core::CancelToken;
use std::ffi::{c_char, CStr};

/// Return code for a render the host cancelled mid-flight (#951). Distinct
/// from every other rc in this module (1/2/3 = arg errors, 6/7/8 = read /
/// decode / render failures, 9 = bad size) so the Swift caller can map it onto
/// the silent "dropped" path instead of surfacing a render error. Only ever
/// returned when a non-null cancel flag was passed AND the host set it.
const RC_CANCELLED: i32 = 4;

// The module-level doc-comment above captures the rationale; the
// detailed prose that lived here in the pre-split file has been folded
// into it to avoid duplication.

/// f32 sibling of [`maple_render_file_scene_linear`]. Identical inputs
/// and error codes; the output buffer is [`MapleSceneLinearBufferF32`]
/// (16 bytes per pixel) instead of the fp16 surface.
///
/// `cancel` (#951) is an optional host-owned [`MapleCancelFlag`] (from
/// [`crate::cancel::maple_cancel_flag_new`]). Pass null for the legacy
/// never-cancel behaviour (bit-identical to before). When non-null and the
/// host sets it mid-render, the develop chain unwinds and this returns
/// [`RC_CANCELLED`].
#[no_mangle]
pub unsafe extern "C" fn maple_render_file_scene_linear_f32(
    raw_path: *const c_char,
    xmp_path: *const c_char,
    quality_preview: i32,
    cancel: *const MapleCancelFlag,
    out: *mut MapleSceneLinearBufferF32,
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
    let out_ptr = out as usize;
    // Move the raw cancel pointer across the worker-thread boundary. The
    // worker is join-ed before this call returns (see `with_large_stack`), so
    // the host-owned flag outlives the borrow we reconstruct inside.
    let cancel = SendCancelPtr(cancel);
    with_large_stack(move || {
        let cancel = cancel; // capture the Send shim
                             // SAFETY: worker is join-ed before the FFI call returns; the host keeps
                             // the flag allocation alive across the call (see module doc in cancel.rs).
        let token = match token_from_ptr(cancel.0) {
            Some(p) => CancelToken::new(p.as_ref()),
            None => CancelToken::never(),
        };
        let raw_path = std::path::Path::new(&raw_path_str);
        let model = match load_xmp_model_owned(xmp_path_str.as_deref()) {
            LoadModel::Ok(m) => m,
            LoadModel::Err(rc) => return rc,
        };
        // Compute the key BEFORE reading — if the file changes between here and
        // fs::read we cache the new bytes under the new mtime, not the old one.
        let cache_key = CacheKey::from_path(raw_path);
        let raw_bytes = match raw_core::pipeline::stage("ffi_raw_read", || std::fs::read(raw_path))
        {
            Ok(b) => b,
            Err(e) => {
                set_last_error(format!("raw read: {}", e));
                return 6;
            }
        };
        let ext = raw_path.extension().and_then(|e| e.to_str()).unwrap_or("");
        // #949: route through the decoded-RawImage cache keyed on (path, mtime)
        // so the back-to-back Auto-Profile fit (same key) hits instead of
        // re-decoding. The `stage` wrapper stays so a hit reads as ~0ms.
        let raw_img = match raw_core::pipeline::stage("ffi_rawler_decode", || {
            decode_file_cached(cache_key.as_ref(), &raw_bytes, ext)
        }) {
            Ok(r) => r,
            Err(e) => {
                set_last_error(format!("decode: {}", e));
                return 7;
            }
        };
        let quality = match quality_preview {
            1 => raw_core::pipeline::RenderQuality::Preview,
            2 => raw_core::pipeline::RenderQuality::Amaze,
            _ => raw_core::pipeline::RenderQuality::Full,
        };
        // #871: force auto_exposure Off when an Auto Profile curve will fit.
        let model = force_ae_off_if_auto_will_fit_path(&model, raw_path);
        let (w, h, f32_rgba) =
            match raw_core::pipeline::render_scene_linear_from_raw_with_quality_f32_cancellable(
                &raw_img, &model, quality, token,
            ) {
                Ok(t) => t,
                Err(CoreError::Cancelled) => return RC_CANCELLED,
                Err(e) => {
                    set_last_error(format!("render: {}", e));
                    return 8;
                }
            };
        write_scene_linear_buf_f32(
            out_ptr,
            w,
            h,
            f32_rgba,
            raw_img.noise_profile.as_deref(),
            raw_img.iso,
            &wb_frame_export(&raw_img),
        );
        0
    })
}

/// f32 sibling of [`maple_render_bytes_scene_linear`]. `cancel` is the
/// optional #951 cancel flag — see [`maple_render_file_scene_linear_f32`].
#[no_mangle]
pub unsafe extern "C" fn maple_render_bytes_scene_linear_f32(
    raw_bytes: *const u8,
    raw_len: usize,
    hint_ext: *const c_char,
    xmp_path: *const c_char,
    quality_preview: i32,
    cancel: *const MapleCancelFlag,
    out: *mut MapleSceneLinearBufferF32,
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
    let input: Vec<u8> = std::slice::from_raw_parts(raw_bytes, raw_len).to_vec();
    let out_ptr = out as usize;
    let cancel = SendCancelPtr(cancel);
    with_large_stack(move || {
        let cancel = cancel;
        // SAFETY: worker is join-ed before the FFI call returns; the host keeps
        // the flag allocation alive across the call (see module doc in cancel.rs).
        let token = match token_from_ptr(cancel.0) {
            Some(p) => CancelToken::new(p.as_ref()),
            None => CancelToken::never(),
        };
        let model = match load_xmp_model_owned(xmp_path_str.as_deref()) {
            LoadModel::Ok(m) => m,
            LoadModel::Err(rc) => return rc,
        };
        // #949: cache keyed on the bytes hash (no path in the in-memory path).
        let raw_img = match raw_core::pipeline::stage("ffi_rawler_decode", || {
            decode_bytes_cached(&CacheKey::from_bytes(&input), &input, &ext_owned)
        }) {
            Ok(r) => r,
            Err(e) => {
                set_last_error(format!("decode: {}", e));
                return 7;
            }
        };
        let quality = match quality_preview {
            1 => raw_core::pipeline::RenderQuality::Preview,
            2 => raw_core::pipeline::RenderQuality::Amaze,
            _ => raw_core::pipeline::RenderQuality::Full,
        };
        // #871: force auto_exposure Off when an Auto Profile curve will fit.
        let model = force_ae_off_if_auto_will_fit_bytes(&model, &input, &ext_owned);
        let (w, h, f32_rgba) =
            match raw_core::pipeline::render_scene_linear_from_raw_with_quality_f32_cancellable(
                &raw_img, &model, quality, token,
            ) {
                Ok(t) => t,
                Err(CoreError::Cancelled) => return RC_CANCELLED,
                Err(e) => {
                    set_last_error(format!("render: {}", e));
                    return 8;
                }
            };
        write_scene_linear_buf_f32(
            out_ptr,
            w,
            h,
            f32_rgba,
            raw_img.noise_profile.as_deref(),
            raw_img.iso,
            &wb_frame_export(&raw_img),
        );
        0
    })
}

/// f32 sibling of [`maple_render_file_scene_linear_sized`]. `cancel` is the
/// optional #951 cancel flag — see [`maple_render_file_scene_linear_f32`].
/// This is the fast-phase RAW-open entry, so it's the one the editor actually
/// interrupts on a slider tick during a cold open.
#[no_mangle]
pub unsafe extern "C" fn maple_render_file_scene_linear_sized_f32(
    raw_path: *const c_char,
    xmp_path: *const c_char,
    max_long_edge: u32,
    quality_preview: i32,
    cancel: *const MapleCancelFlag,
    out: *mut MapleSceneLinearBufferF32,
) -> i32 {
    if raw_path.is_null() || out.is_null() {
        set_last_error("null pointer argument".into());
        return 1;
    }
    if max_long_edge == 0 {
        set_last_error("max_long_edge must be > 0".into());
        return 9;
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
    let cancel = SendCancelPtr(cancel);
    with_large_stack(move || {
        let cancel = cancel;
        // SAFETY: worker is join-ed before the FFI call returns; the host keeps
        // the flag allocation alive across the call (see module doc in cancel.rs).
        let token = match token_from_ptr(cancel.0) {
            Some(p) => CancelToken::new(p.as_ref()),
            None => CancelToken::never(),
        };
        let raw_path = std::path::Path::new(&raw_path_str);
        let model = match load_xmp_model_owned(xmp_path_str.as_deref()) {
            LoadModel::Ok(m) => m,
            LoadModel::Err(rc) => return rc,
        };
        // Compute the key BEFORE reading — if the file changes between here and
        // fs::read we cache the new bytes under the new mtime, not the old one.
        let cache_key = CacheKey::from_path(raw_path);
        let raw_bytes = match raw_core::pipeline::stage("ffi_raw_read", || std::fs::read(raw_path))
        {
            Ok(b) => b,
            Err(e) => {
                set_last_error(format!("raw read: {}", e));
                return 6;
            }
        };
        let ext = raw_path.extension().and_then(|e| e.to_str()).unwrap_or("");
        // #949: cache keyed on (path, mtime) — see the full-res variant above.
        let raw_img = match raw_core::pipeline::stage("ffi_rawler_decode", || {
            decode_file_cached(cache_key.as_ref(), &raw_bytes, ext)
        }) {
            Ok(r) => r,
            Err(e) => {
                set_last_error(format!("decode: {}", e));
                return 7;
            }
        };
        let quality = match quality_preview {
            1 => raw_core::pipeline::RenderQuality::Preview,
            2 => raw_core::pipeline::RenderQuality::Amaze,
            _ => raw_core::pipeline::RenderQuality::Full,
        };
        // #871: force auto_exposure Off when an Auto Profile curve will fit.
        let model = force_ae_off_if_auto_will_fit_path(&model, raw_path);
        let (w, h, f32_rgba) = match raw_core::pipeline::render_scene_linear_sized_from_raw_with_quality_f32_cancellable(
            &raw_img, &model, quality, max_long_edge, token,
        ) {
            Ok(t) => t,
            Err(CoreError::Cancelled) => return RC_CANCELLED,
            Err(e) => { set_last_error(format!("render: {}", e)); return 8; }
        };
        write_scene_linear_buf_f32(
            out_ptr,
            w,
            h,
            f32_rgba,
            raw_img.noise_profile.as_deref(),
            raw_img.iso,
            &wb_frame_export(&raw_img),
        );
        0
    })
}

/// f32 sibling of [`maple_render_bytes_scene_linear_sized`]. `cancel` is the
/// optional #951 cancel flag — see [`maple_render_file_scene_linear_f32`].
#[no_mangle]
pub unsafe extern "C" fn maple_render_bytes_scene_linear_sized_f32(
    raw_bytes: *const u8,
    raw_len: usize,
    hint_ext: *const c_char,
    xmp_path: *const c_char,
    max_long_edge: u32,
    quality_preview: i32,
    cancel: *const MapleCancelFlag,
    out: *mut MapleSceneLinearBufferF32,
) -> i32 {
    if raw_bytes.is_null() || out.is_null() {
        set_last_error("null pointer argument".into());
        return 1;
    }
    if max_long_edge == 0 {
        set_last_error("max_long_edge must be > 0".into());
        return 9;
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
    let input: Vec<u8> = std::slice::from_raw_parts(raw_bytes, raw_len).to_vec();
    let out_ptr = out as usize;
    let cancel = SendCancelPtr(cancel);
    with_large_stack(move || {
        let cancel = cancel;
        // SAFETY: worker is join-ed before the FFI call returns; the host keeps
        // the flag allocation alive across the call (see module doc in cancel.rs).
        let token = match token_from_ptr(cancel.0) {
            Some(p) => CancelToken::new(p.as_ref()),
            None => CancelToken::never(),
        };
        let model = match load_xmp_model_owned(xmp_path_str.as_deref()) {
            LoadModel::Ok(m) => m,
            LoadModel::Err(rc) => return rc,
        };
        // #949: cache keyed on the bytes hash — see the full-res bytes variant.
        let raw_img = match raw_core::pipeline::stage("ffi_rawler_decode", || {
            decode_bytes_cached(&CacheKey::from_bytes(&input), &input, &ext_owned)
        }) {
            Ok(r) => r,
            Err(e) => {
                set_last_error(format!("decode: {}", e));
                return 7;
            }
        };
        let quality = match quality_preview {
            1 => raw_core::pipeline::RenderQuality::Preview,
            2 => raw_core::pipeline::RenderQuality::Amaze,
            _ => raw_core::pipeline::RenderQuality::Full,
        };
        // #871: force auto_exposure Off when an Auto Profile curve will fit.
        let model = force_ae_off_if_auto_will_fit_bytes(&model, &input, &ext_owned);
        let (w, h, f32_rgba) = match raw_core::pipeline::render_scene_linear_sized_from_raw_with_quality_f32_cancellable(
            &raw_img, &model, quality, max_long_edge, token,
        ) {
            Ok(t) => t,
            Err(CoreError::Cancelled) => return RC_CANCELLED,
            Err(e) => { set_last_error(format!("render: {}", e)); return 8; }
        };
        write_scene_linear_buf_f32(
            out_ptr,
            w,
            h,
            f32_rgba,
            raw_img.noise_profile.as_deref(),
            raw_img.iso,
            &wb_frame_export(&raw_img),
        );
        0
    })
}

/// Decode a RAW file through the decoded-`RawImage` cache (#949), keyed on
/// `(canonical path, mtime)`. On a cache hit this skips the ~1.8s decode; the
/// back-to-back Auto-Profile fit FFI builds the same path key and hits.
///
/// `key` is a pre-computed [`CacheKey`] obtained by calling
/// `CacheKey::from_path` BEFORE `std::fs::read` at the call site — computing
/// it after the read would risk caching `T0`-content under a `T1`-mtime key if
/// the file is replaced between read and stat (TOCTOU stale-hit). Callers pass
/// `None` when `from_path` returned `None` (un-stattable path), and this helper
/// falls back to a plain uncached `decode_bytes` — behaviour is never worse than
/// before the cache.
fn decode_file_cached(
    key: Option<&CacheKey>,
    raw_bytes: &[u8],
    ext: &str,
) -> raw_core::Result<std::sync::Arc<raw_core::RawImage>> {
    match key {
        Some(k) => decode_bytes_cached(k, raw_bytes, ext),
        None => Ok(std::sync::Arc::new(decode_bytes(raw_bytes, ext)?)),
    }
}

/// Resolve the WB slider-frame export for a decoded RAW (#1781): the
/// `wb_camera::SliderFrame` data + the in-frame as-shot `(scene_cct, tint)`
/// estimate, carried on [`MapleSceneLinearBufferF32`] so the host can derive
/// per-tick WB deltas in the SAME calibration frame the develop chain used.
///
/// Gated on EXACTLY the tiers the develop chain gates `wb_camera` on
/// (`pipeline::develop`): a real calibration (`!RawlerFallback`) and a
/// pre-gained Bayer/full-LinearRaw source (not the 8-bit lossy LinearRaw
/// escape hatch). Everything else exports `SliderFrameExport::ABSENT`
/// (all-zero) — the host then keeps its legacy generic-CAT16 behaviour,
/// matching the develop chain's own post-DCP CAT16 fallback for those tiers.
pub(crate) fn wb_frame_export(
    raw: &raw_core::RawImage,
) -> raw_core::stages::wb_camera::SliderFrameExport {
    use raw_core::stages::wb_camera::SliderFrameExport;
    let skip_pre_gain =
        matches!(raw.cfa, raw_core::image::CfaPattern::LinearRgb) && raw.white_level <= 255;
    if skip_pre_gain {
        return SliderFrameExport::ABSENT;
    }
    match raw_core::color::dcp::profile_for_with_source(raw) {
        Ok((profile, source))
            if !matches!(source, raw_core::color::dcp::ProfileSource::RawlerFallback) =>
        {
            SliderFrameExport::resolve(raw, &profile)
        }
        _ => SliderFrameExport::ABSENT,
    }
}

/// Row-major flatten of a raw-core 3x3 matrix for the flat C-ABI fields.
pub(crate) fn flatten_matrix(m: raw_core::math::Matrix3) -> [f32; 9] {
    [
        m.0[0][0], m.0[0][1], m.0[0][2], m.0[1][0], m.0[1][1], m.0[1][2], m.0[2][0], m.0[2][1],
        m.0[2][2],
    ]
}

/// f32 counterpart to [`write_scene_linear_buf`]. Boxes the `Vec<f32>` and
/// hands the raw parts to the caller in a [`MapleSceneLinearBufferF32`].
///
/// `noise_profile` is the optional per-camera noise profile from
/// `RawImage::noise_profile`, and `iso` is `RawImage::iso`. Both are forwarded
/// into the buffer so the per-tick FFI chain (`maple_apply_scene_linear_chain_f32`)
/// can use them for profile-aware NR (PR #1709 review fix).
pub(crate) fn write_scene_linear_buf_f32(
    out_ptr: usize,
    w: u32,
    h: u32,
    f32_rgba: Vec<f32>,
    noise_profile: Option<&[f32]>,
    iso: u32,
    wb_frame: &raw_core::stages::wb_camera::SliderFrameExport,
) {
    let (f32_ptr, _len_lanes, len_bytes) = raw_core::pipeline::stage("ffi_pack_f32", || {
        let mut boxed = f32_rgba.into_boxed_slice();
        let p = boxed.as_mut_ptr();
        let n = boxed.len();
        std::mem::forget(boxed);
        (p, n, n * std::mem::size_of::<f32>())
    });
    // Box the noise profile if present so it's heap-owned and can be freed
    // by `maple_free_scene_linear_buffer_f32`.
    let (np_ptr, np_len) = if let Some(profile) = noise_profile {
        let mut boxed = profile.to_vec().into_boxed_slice();
        let p = boxed.as_mut_ptr();
        let n = boxed.len();
        std::mem::forget(boxed);
        (p, n as u32)
    } else {
        (std::ptr::null_mut(), 0u32)
    };
    unsafe {
        *(out_ptr as *mut MapleSceneLinearBufferF32) = MapleSceneLinearBufferF32 {
            f32_rgba: f32_ptr,
            len_bytes,
            channels: 4,
            bytes_per_pixel: 16,
            width: w,
            height: h,
            noise_profile_data: np_ptr,
            noise_profile_len: np_len,
            iso,
            wb_frame_m_cold: flatten_matrix(wb_frame.m_cold),
            wb_frame_cct_cold: wb_frame.cct_cold,
            wb_frame_m_warm: flatten_matrix(wb_frame.m_warm),
            wb_frame_cct_warm: wb_frame.cct_warm,
            wb_frame_scene_cct: wb_frame.scene_cct,
            wb_frame_as_shot_tint: wb_frame.as_shot_tint,
        };
    }
}
