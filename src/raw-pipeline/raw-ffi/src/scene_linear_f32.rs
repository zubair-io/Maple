//! Scene-linear Rec.2020 f32 RGBA render entries (#482).
//!
//! f32 sibling of `scene_linear.rs`. Mirrors the four fp16 entries (file/bytes × full/sized)
//! returning `MapleSceneLinearBufferF32` so consumers can hold the scene-linear buffer at full
//! f32 precision end-to-end (#416). The fp16 entries stay intact for Apple's still-fp16 per-tick
//! chain; Apple's own f32 migration is a separate ticket once `maple_apply_scene_linear_chain`
//! grows an f32 sibling. Web consumes f32 directly (RGBA32F FBOs).
//!
//! Split out of `scene_linear.rs` to stay under the 600-LOC budget; the strip / dehaze-guard /
//! Auto-Profile-AE contracts there apply here too — post-#927 these buffers are AE-off for every
//! preview-bearing RAW under `Profile::Auto`, display-faithful only with the fitted tail (#1174).

use crate::buffers::MapleSceneLinearBufferF32;
use crate::cancel::{token_from_ptr, MapleCancelFlag, SendCancelPtr};
use crate::error::{set_last_error, with_large_stack};
use crate::model::{
    force_ae_off_if_auto_will_fit_bytes, force_ae_off_if_auto_will_fit_path, load_xmp_model_owned,
    LoadModel,
};
use raw_core::decode_cache::{decode_bytes_cached, CacheKey};

#[path = "scene_linear_f32/file_decode.rs"]
mod file_decode;
use raw_core::error::Error as CoreError;
use raw_core::CancelToken;
use std::ffi::{c_char, CStr};

/// Return code for a render the host cancelled mid-flight (#951). Distinct from
/// every other rc here (1/2/3 = arg errors, 6/7/8 = read/decode/render
/// failures, 9 = bad size) so Swift maps it to the silent "dropped" path
/// instead of a render error — only when a non-null cancel flag was set.
const RC_CANCELLED: i32 = 4;

/// f32 sibling of [`maple_render_file_scene_linear`]. Identical inputs and
/// error codes; the output buffer is [`MapleSceneLinearBufferF32`] (16
/// bytes/pixel) instead of the fp16 surface. `cancel` (#951) is an optional
/// host-owned [`MapleCancelFlag`]; null means the legacy never-cancel
/// behaviour (bit-identical to before). Non-null + host-set mid-render
/// unwinds the develop chain and returns [`RC_CANCELLED`].
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
        let raw_img = match file_decode::decode_file_cached(raw_path, token) {
            Ok(raw) => raw,
            Err(rc) => return rc,
        };
        let quality = match quality_preview {
            1 => raw_core::pipeline::RenderQuality::Preview,
            2 => raw_core::pipeline::RenderQuality::Amaze,
            _ => raw_core::pipeline::RenderQuality::Full,
        };
        // #871: force auto_exposure Off when an Auto Profile curve will fit.
        let model = force_ae_off_if_auto_will_fit_path(&model, raw_path);
        let (w, h, f32_rgba, ae_gain) =
            match raw_core::pipeline::render_scene_linear_from_raw_with_quality_f32_cancellable_with_gain(
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
            ae_gain,
            raw_img.has_lens_corrections(),
            raw_img.lens_correction_ca_inert(),
            raw_img.lens_correction_distortion_inert(),
            Some(&raw_img),
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
        let (w, h, f32_rgba, ae_gain) =
            match raw_core::pipeline::render_scene_linear_from_raw_with_quality_f32_cancellable_with_gain(
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
            ae_gain,
            raw_img.has_lens_corrections(),
            raw_img.lens_correction_ca_inert(),
            raw_img.lens_correction_distortion_inert(),
            Some(&raw_img),
        );
        0
    })
}

/// f32 sibling of [`maple_render_file_scene_linear_sized`] — the fast-phase
/// RAW-open entry the editor interrupts on a slider tick during a cold open.
/// `cancel` is the optional #951 cancel flag, see [`maple_render_file_scene_linear_f32`].
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
        let raw_img = match file_decode::decode_file_cached(raw_path, token) {
            Ok(raw) => raw,
            Err(rc) => return rc,
        };
        let quality = match quality_preview {
            1 => raw_core::pipeline::RenderQuality::Preview,
            2 => raw_core::pipeline::RenderQuality::Amaze,
            _ => raw_core::pipeline::RenderQuality::Full,
        };
        // #871: force auto_exposure Off when an Auto Profile curve will fit.
        let model = force_ae_off_if_auto_will_fit_path(&model, raw_path);
        let (w, h, f32_rgba, ae_gain) = match raw_core::pipeline::render_scene_linear_sized_from_raw_with_quality_f32_cancellable_with_gain(
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
            ae_gain,
            raw_img.has_lens_corrections(),
            raw_img.lens_correction_ca_inert(),
            raw_img.lens_correction_distortion_inert(),
            Some(&raw_img),
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
        let (w, h, f32_rgba, ae_gain) = match raw_core::pipeline::render_scene_linear_sized_from_raw_with_quality_f32_cancellable_with_gain(
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
            ae_gain,
            raw_img.has_lens_corrections(),
            raw_img.lens_correction_ca_inert(),
            raw_img.lens_correction_distortion_inert(),
            Some(&raw_img),
        );
        0
    })
}

/// Resolve the WB slider-frame export for a decoded RAW (#1781): the
/// `wb_camera::SliderFrame` data + in-frame as-shot `(scene_cct, tint)`, so
/// the host can derive per-tick WB deltas in the develop chain's own
/// calibration frame. Gated on EXACTLY the tiers `pipeline::develop` gates
/// `wb_camera` on (real calibration, pre-gained Bayer/full-LinearRaw source);
/// everything else exports `SliderFrameExport::ABSENT`, matching the develop
/// chain's own post-DCP CAT16 fallback.
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

pub(crate) use crate::scene_linear_f32_buffer::write_scene_linear_buf_f32;
