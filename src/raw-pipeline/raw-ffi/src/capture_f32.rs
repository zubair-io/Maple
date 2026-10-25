//! Capture-first decode entries (#5377): the capture result in the fixed
//! as-shot basis plus the [`MapleCaptureCreative`] that renders it, so a host
//! runs the creative stage per tick (`MapleGpuLiveParams::creative_ptr`,
//! `MapleAdjustmentParams::creative_ptr`). Same arguments and return codes as
//! the scene-linear f32 entries they sit beside: 1 null argument, 2/3 a
//! non-UTF-8 path or extension, 4 cancelled, 6/7 read/decode failure, 8
//! render failure, 9 a zero `max_long_edge`.

use crate::buffers::MapleSceneLinearBufferF32;
use crate::cancel::{token_from_ptr, MapleCancelFlag, SendCancelPtr};
use crate::capture_base::MapleCaptureBase;
use crate::capture_creative::{MapleCaptureBufferF32, MapleCaptureCreative};
use crate::error::{set_last_error, with_large_stack};
use crate::model::{
    force_ae_off_if_auto_will_fit_bytes, force_ae_off_if_auto_will_fit_path, load_xmp_model_owned,
    LoadModel,
};
use crate::scene_linear_f32::{file_decode, wb_exports, WbExports, RC_CANCELLED};
use raw_core::decode_cache::{decode_bytes_cached, CacheKey};
use raw_core::error::Error as CoreError;
use raw_core::pipeline::{CaptureRender, RenderQuality};
use raw_core::CancelToken;
use std::ffi::{c_char, CStr};

pub(crate) enum Source {
    Path(String),
    Bytes { bytes: Vec<u8>, extension: String },
}

pub(crate) unsafe fn utf8(ptr: *const c_char, what: &str, rc: i32) -> Result<Option<String>, i32> {
    if ptr.is_null() {
        return Ok(None);
    }
    CStr::from_ptr(ptr)
        .to_str()
        .map(|s| Some(s.to_owned()))
        .map_err(|e| {
            set_last_error(format!("{what} not UTF-8: {e}"));
            rc
        })
}

/// The demosaic quality code and the optional sized-decode edge.
#[derive(Clone, Copy)]
pub(crate) struct Develop {
    pub(crate) quality_preview: i32,
    pub(crate) max_long_edge: Option<u32>,
}

fn quality(quality_preview: i32) -> RenderQuality {
    match quality_preview {
        1 => RenderQuality::Preview,
        2 => RenderQuality::Amaze,
        3 => RenderQuality::Auto,
        _ => RenderQuality::Full,
    }
}

/// Decode, develop to the capture result and write `out`. With `base_out`,
/// also hand the host the decode's refine base (#5381).
pub(crate) unsafe fn capture_entry(
    source: Source,
    xmp_path: Option<String>,
    develop: Develop,
    cancel: *const MapleCancelFlag,
    (out, base_out): (
        *mut MapleCaptureBufferF32,
        Option<*mut *mut MapleCaptureBase>,
    ),
) -> i32 {
    let (out_ptr, base_out) = (out as usize, base_out.map(|p| p as usize));
    let cancel = SendCancelPtr(cancel);
    with_large_stack(move || {
        let cancel = cancel;
        // SAFETY: the worker is joined before the FFI call returns and the
        // host keeps the flag alive across the call (see cancel.rs).
        let token = match token_from_ptr(cancel.0) {
            Some(p) => CancelToken::new(p.as_ref()),
            None => CancelToken::never(),
        };
        let loaded = match load_xmp_model_owned(xmp_path.as_deref()) {
            LoadModel::Ok(m) => m,
            LoadModel::Err(rc) => return rc,
        };
        let (raw, model) = match &source {
            Source::Path(path) => {
                let path = std::path::Path::new(path);
                match file_decode::decode_file_cached(path, token) {
                    Ok(raw) => (raw, force_ae_off_if_auto_will_fit_path(&loaded, path)),
                    Err(rc) => return rc,
                }
            }
            Source::Bytes { bytes, extension } => {
                match raw_core::pipeline::stage("ffi_rawler_decode", || {
                    decode_bytes_cached(&CacheKey::from_bytes(bytes), bytes, extension)
                }) {
                    Ok(raw) => (
                        raw,
                        force_ae_off_if_auto_will_fit_bytes(&loaded, bytes, extension),
                    ),
                    Err(e) => {
                        set_last_error(format!("decode: {e}"));
                        return 7;
                    }
                }
            }
        };
        let quality = quality(develop.quality_preview);
        let rendered = match (base_out, develop.max_long_edge) {
            (Some(_), edge) => raw_core::pipeline::render_capture_with_base_from_raw_f32(
                &raw,
                (&loaded, &model),
                quality,
                edge,
                token,
            )
            .map(|(capture, base)| (capture, Some(base))),
            (None, Some(edge)) => raw_core::pipeline::render_capture_sized_from_raw_f32(
                &raw, &model, quality, edge, token,
            )
            .map(|capture| (capture, None)),
            (None, None) => {
                raw_core::pipeline::render_capture_from_raw_f32(&raw, &model, quality, token)
                    .map(|capture| (capture, None))
            }
        };
        let (capture, base) = match rendered {
            Ok(rendered) => rendered,
            Err(CoreError::Cancelled) => return RC_CANCELLED,
            Err(e) => {
                set_last_error(format!("render: {e}"));
                return 8;
            }
        };
        let exports = DecodeExports::of(&raw);
        write_capture(out_ptr, &exports, capture);
        if let (Some(base_out), Some(base)) = (base_out, base) {
            // SAFETY: the entry checked `base_out` non-null; the host owns it.
            unsafe {
                *(base_out as *mut *mut MapleCaptureBase) = MapleCaptureBase::boxed(base, exports)
            };
        }
        0
    })
}

/// What a capture buffer reports about its RAW besides the pixels, kept with
/// a refine base so a refine reports exactly what its decode did.
pub(crate) struct DecodeExports {
    noise_profile: Option<Vec<f32>>,
    iso: u32,
    frame: raw_core::stages::wb_camera::SliderFrameExport,
    lens: (bool, bool, bool),
    support_json: Option<std::ffi::CString>,
}

impl DecodeExports {
    fn of(raw: &raw_core::RawImage) -> Self {
        Self {
            noise_profile: raw.noise_profile.clone(),
            iso: raw.iso,
            frame: wb_exports(raw).frame,
            lens: (
                raw.has_lens_corrections(),
                raw.lens_correction_ca_inert(),
                raw.lens_correction_distortion_inert(),
            ),
            support_json: raw_core::support_tiers::RenderSupport::resolve(raw)
                .ok()
                .map(|support| {
                    std::ffi::CString::new(support.to_json()).expect("JSON escapes NUL")
                }),
        }
    }
}

pub(crate) fn write_capture(out_ptr: usize, exports: &DecodeExports, capture: CaptureRender) {
    let CaptureRender {
        width,
        height,
        rgba,
        creative,
        tables,
        whites_anchor_ev,
        nr_sampling_scale,
    } = capture;
    let out = out_ptr as *mut MapleCaptureBufferF32;
    // SAFETY: the entry checked `out` non-null; the host owns it for the call.
    let scene = unsafe { std::ptr::addr_of_mut!((*out).scene) } as usize;
    crate::scene_linear_f32::write_scene_linear_buf_f32(
        scene,
        width,
        height,
        rgba,
        exports.noise_profile.as_deref(),
        exports.iso,
        &WbExports {
            frame: exports.frame,
            hsm: None,
        },
        creative.ae_gain,
        whites_anchor_ev,
        nr_sampling_scale,
        exports.lens.0,
        exports.lens.1,
        exports.lens.2,
        None,
    );
    let tables = crate::wb_frame_flat::intern_table_wire(tables.floats());
    // SAFETY: as above; the buffer's free releases the support JSON.
    unsafe {
        (*out).scene.camera_support_json = exports
            .support_json
            .clone()
            .map_or(std::ptr::null_mut(), std::ffi::CString::into_raw);
        (*out).creative = MapleCaptureCreative::new(&creative, tables);
    }
}

/// The capture decode of a RAW file (the full-resolution sibling of
/// `maple_render_file_scene_linear_f32`). Free with
/// [`crate::capture_creative::maple_free_capture_buffer_f32`].
///
/// # Safety
/// `raw_path` a NUL-terminated path; `xmp_path` null or one; `cancel` null or
/// a live flag; `out` writable.
#[no_mangle]
pub unsafe extern "C" fn maple_render_file_capture_f32(
    raw_path: *const c_char,
    xmp_path: *const c_char,
    quality_preview: i32,
    cancel: *const MapleCancelFlag,
    out: *mut MapleCaptureBufferF32,
) -> i32 {
    crate::error::catch_panic_rc("maple_render_file_capture_f32", || {
        let develop = Develop {
            quality_preview,
            max_long_edge: None,
        };
        file_entry(raw_path, xmp_path, develop, cancel, (out, None))
    })
}

/// [`maple_render_file_capture_f32`] downsampled to `max_long_edge` before
/// the capture stages, as `maple_render_file_scene_linear_sized_f32` does.
///
/// # Safety
/// As for [`maple_render_file_capture_f32`].
#[no_mangle]
pub unsafe extern "C" fn maple_render_file_capture_sized_f32(
    raw_path: *const c_char,
    xmp_path: *const c_char,
    max_long_edge: u32,
    quality_preview: i32,
    cancel: *const MapleCancelFlag,
    out: *mut MapleCaptureBufferF32,
) -> i32 {
    crate::error::catch_panic_rc("maple_render_file_capture_sized_f32", || {
        let develop = Develop {
            quality_preview,
            max_long_edge: Some(max_long_edge),
        };
        file_entry(raw_path, xmp_path, develop, cancel, (out, None))
    })
}

/// The capture decode of RAW bytes; `hint_ext` names the container.
///
/// # Safety
/// `raw_bytes` valid for `raw_len` bytes; otherwise as for
/// [`maple_render_file_capture_f32`].
#[no_mangle]
pub unsafe extern "C" fn maple_render_bytes_capture_f32(
    raw_bytes: *const u8,
    raw_len: usize,
    hint_ext: *const c_char,
    xmp_path: *const c_char,
    quality_preview: i32,
    cancel: *const MapleCancelFlag,
    out: *mut MapleCaptureBufferF32,
) -> i32 {
    crate::error::catch_panic_rc("maple_render_bytes_capture_f32", || {
        bytes_entry(
            (raw_bytes, raw_len, hint_ext),
            xmp_path,
            Develop {
                quality_preview,
                max_long_edge: None,
            },
            cancel,
            (out, None),
        )
    })
}

/// [`maple_render_bytes_capture_f32`] downsampled to `max_long_edge`.
///
/// # Safety
/// As for [`maple_render_bytes_capture_f32`].
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn maple_render_bytes_capture_sized_f32(
    raw_bytes: *const u8,
    raw_len: usize,
    hint_ext: *const c_char,
    xmp_path: *const c_char,
    max_long_edge: u32,
    quality_preview: i32,
    cancel: *const MapleCancelFlag,
    out: *mut MapleCaptureBufferF32,
) -> i32 {
    crate::error::catch_panic_rc("maple_render_bytes_capture_sized_f32", || {
        bytes_entry(
            (raw_bytes, raw_len, hint_ext),
            xmp_path,
            Develop {
                quality_preview,
                max_long_edge: Some(max_long_edge),
            },
            cancel,
            (out, None),
        )
    })
}

/// The capture buffer, and the slot for the refine base when one is wanted.
pub(crate) type Outs = (
    *mut MapleCaptureBufferF32,
    Option<*mut *mut MapleCaptureBase>,
);

fn outs_null((out, base_out): Outs) -> bool {
    out.is_null() || base_out.is_some_and(<*mut _>::is_null)
}

pub(crate) unsafe fn file_entry(
    raw_path: *const c_char,
    xmp_path: *const c_char,
    develop: Develop,
    cancel: *const MapleCancelFlag,
    outs: Outs,
) -> i32 {
    if raw_path.is_null() || outs_null(outs) {
        set_last_error("null pointer argument".into());
        return 1;
    }
    if develop.max_long_edge == Some(0) {
        set_last_error("max_long_edge must be > 0".into());
        return 9;
    }
    let raw_path = match utf8(raw_path, "raw_path", 2) {
        Ok(path) => path.expect("checked non-null"),
        Err(rc) => return rc,
    };
    let xmp_path = match utf8(xmp_path, "xmp_path", 3) {
        Ok(path) => path,
        Err(rc) => return rc,
    };
    capture_entry(Source::Path(raw_path), xmp_path, develop, cancel, outs)
}

pub(crate) unsafe fn bytes_entry(
    (raw_bytes, raw_len, hint_ext): (*const u8, usize, *const c_char),
    xmp_path: *const c_char,
    develop: Develop,
    cancel: *const MapleCancelFlag,
    outs: Outs,
) -> i32 {
    if raw_bytes.is_null() || outs_null(outs) {
        set_last_error("null pointer argument".into());
        return 1;
    }
    if develop.max_long_edge == Some(0) {
        set_last_error("max_long_edge must be > 0".into());
        return 9;
    }
    let extension = match utf8(hint_ext, "hint_ext", 2) {
        Ok(ext) => ext.unwrap_or_default(),
        Err(rc) => return rc,
    };
    let xmp_path = match utf8(xmp_path, "xmp_path", 3) {
        Ok(path) => path,
        Err(rc) => return rc,
    };
    let bytes = std::slice::from_raw_parts(raw_bytes, raw_len).to_vec();
    capture_entry(
        Source::Bytes { bytes, extension },
        xmp_path,
        develop,
        cancel,
        outs,
    )
}

/// A tile of the capture result of a handle's RAW, for the native-detail
/// patch: same geometry, quality and return codes as
/// `maple_render_handle_scene_linear_tile_f32`. The pixels are in the fixed
/// as-shot basis and carry no exposure gain; render them with the creative
/// stage of the whole-frame capture decode. `out.ae_gain` is 1 and
/// `out.whites_anchor_ev` NaN, as for the scene tiles.
///
/// # Safety
/// `handle` a live handle; `out` writable.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn maple_render_handle_capture_tile_f32(
    handle: *const crate::handle::MapleRawHandle,
    src_x: u32,
    src_y: u32,
    src_w: u32,
    src_h: u32,
    out_w: u32,
    out_h: u32,
    quality_preview: i32,
    out: *mut MapleSceneLinearBufferF32,
) -> i32 {
    if handle.is_null() || out.is_null() {
        set_last_error("null pointer argument".into());
        return 1;
    }
    if src_w == 0 || src_h == 0 || out_w == 0 || out_h == 0 {
        set_last_error("src_w/src_h/out_w/out_h must be > 0".into());
        return 9;
    }
    let inner = (*handle).inner as *const crate::handle::MapleRawHandleInner;
    if inner.is_null() {
        set_last_error("handle has been freed".into());
        return 1;
    }
    let (inner_addr, out_ptr) = (inner as usize, out as usize);
    let rect = raw_core::pipeline::TileRect {
        src_x,
        src_y,
        src_w,
        src_h,
        out_w,
        out_h,
    };
    let quality = if quality_preview != 0 {
        RenderQuality::Preview
    } else {
        RenderQuality::Full
    };
    with_large_stack(move || {
        // SAFETY: the host keeps the handle alive for the call.
        let inner = unsafe { &*(inner_addr as *const crate::handle::MapleRawHandleInner) };
        let (w, h, rgba) = match inner.render_capture_tile_f32(rect, quality) {
            Ok(tile) => tile,
            Err(e) => return crate::handle::tile_error_rc(e),
        };
        let raw = &inner.raw;
        crate::scene_linear_f32::write_scene_linear_buf_f32(
            out_ptr,
            w,
            h,
            rgba,
            raw.noise_profile.as_deref(),
            raw.iso,
            &WbExports::ABSENT,
            1.0,
            f32::NAN,
            1.0,
            raw.has_lens_corrections(),
            raw.lens_correction_ca_inert(),
            raw.lens_correction_distortion_inert(),
            None,
        );
        0
    })
}
