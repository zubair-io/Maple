//! Opaque handle for cached rawler-decoded `RawImage` + parsed XMP.
//!
//! Plan 3 (Ticket 06 M4) — see
//! .archived-plans/plans/2026-04-25-deep-zoom-tile-rendering.md Task 3.
//!
//! The handle keeps the decoded `RawImage` plus the parsed
//! `AdjustmentModel` alive across multiple tile renders so a 100 MP
//! rawler decode (~3-5 s cold) runs once per asset open instead of once
//! per tile. Apple side wraps the opaque pointer in a `MapleRawHandleBox`
//! final class whose `deinit` calls `maple_close_raw_handle`. Rust side
//! owns a `Box<MapleRawHandleInner>`.
//!
//! Deliberate design choices:
//!
//!   - The xmp file is parsed once at `maple_open_raw_handle` time and
//!     stored alongside the RawImage. Tile renders therefore don't
//!     need a per-call model serialization (no serde / json dep on
//!     raw-ffi). To re-render with a different model the caller closes
//!     the handle and reopens with a new xmp path.
//!
//!   - The struct exposed in the C ABI is `#[repr(C)]` with a single
//!     `*mut c_void` field, identical in shape to a forward-declared
//!     opaque struct. cbindgen emits a typedef for callers.
//!
//!   - Same error code semantics as the file/bytes tile entries: 10 for
//!     dehaze-active, 11 for upscale-attempt, 9 for bad geometry.
//!
//! Strip contract (see scene_linear.rs module doc): handles store
//! whatever model the XMP they were opened with contains; the Apple
//! Swift binding pre-strips the GPU-replayed fields into a temp XMP and
//! passes that temp path to `maple_open_raw_handle`. Rust does not
//! mutate the model.

use crate::buffers::MapleSceneLinearBuffer;
use crate::error::{set_last_error, with_large_stack};
use crate::model::{dehaze_active, load_xmp_model_owned, LoadModel};
use crate::scene_linear::write_scene_linear_buf;
use raw_core::decode::decode_bytes;
use raw_core::xmp;
use std::ffi::{c_char, CStr};

/// Internal state behind the opaque pointer. Not exposed in the C ABI.
pub(crate) struct MapleRawHandleInner {
    pub(crate) raw: raw_core::image::RawImage,
    pub(crate) model: xmp::AdjustmentModel,
}

/// Opaque handle to a decoded RawImage + parsed AdjustmentModel.
/// Allocate via `maple_open_raw_handle` (or
/// `maple_open_raw_handle_bytes`); free via `maple_close_raw_handle`.
/// The pointee layout is intentionally undocumented; callers must treat
/// `*mut MapleRawHandle` as opaque.
#[repr(C)]
pub struct MapleRawHandle {
    /// Opaque pointer to a heap-allocated `MapleRawHandleInner`. Not
    /// introspected by callers.
    inner: *mut std::ffi::c_void,
}

/// Open a RAW + optional XMP sidecar into an opaque handle suitable for
/// repeated tile rendering. The handle owns the rawler-decoded mosaic
/// and the parsed AdjustmentModel; subsequent calls to
/// `maple_render_handle_scene_linear_tile` skip both.
///
/// `xmp_path` may be null — in that case `AdjustmentModel::default()`
/// is stored in the handle.
///
/// Returns 0 on success and writes the handle pointer into
/// `*handle_out`. Non-zero on error (call `maple_last_error` for the
/// message). The output handle pointer is always written: it is null
/// on error and non-null on success.
///
/// The caller must eventually free the handle via
/// `maple_close_raw_handle`. Failing to do so leaks the underlying
/// `RawImage` (~30-300 MB depending on sensor resolution).
#[no_mangle]
pub unsafe extern "C" fn maple_open_raw_handle(
    raw_path: *const c_char,
    xmp_path: *const c_char,
    handle_out: *mut *mut MapleRawHandle,
) -> i32 {
    if raw_path.is_null() || handle_out.is_null() {
        set_last_error("null pointer argument".into());
        return 1;
    }
    // Initialize the out pointer to null defensively so callers that
    // ignore the rc and read the slot still see a sentinel value.
    *handle_out = std::ptr::null_mut();
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
    let handle_out_addr = handle_out as usize;
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
        let inner = Box::new(MapleRawHandleInner {
            raw: raw_img,
            model,
        });
        let inner_ptr = Box::into_raw(inner) as *mut std::ffi::c_void;
        let handle = Box::new(MapleRawHandle { inner: inner_ptr });
        unsafe {
            *(handle_out_addr as *mut *mut MapleRawHandle) = Box::into_raw(handle);
        }
        0
    })
}

/// Bytes-variant of `maple_open_raw_handle`. Decodes from an in-memory
/// RAW byte slice (PhotoKit / network-source codepaths). `hint_ext` is
/// the extension without the leading dot (e.g. `"dng"`); pass null or
/// empty for content-sniff fallback.
#[no_mangle]
pub unsafe extern "C" fn maple_open_raw_handle_bytes(
    raw_bytes: *const u8,
    raw_len: usize,
    hint_ext: *const c_char,
    xmp_path: *const c_char,
    handle_out: *mut *mut MapleRawHandle,
) -> i32 {
    if raw_bytes.is_null() || handle_out.is_null() {
        set_last_error("null pointer argument".into());
        return 1;
    }
    *handle_out = std::ptr::null_mut();
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
    let handle_out_addr = handle_out as usize;
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
        let inner = Box::new(MapleRawHandleInner {
            raw: raw_img,
            model,
        });
        let inner_ptr = Box::into_raw(inner) as *mut std::ffi::c_void;
        let handle = Box::new(MapleRawHandle { inner: inner_ptr });
        unsafe {
            *(handle_out_addr as *mut *mut MapleRawHandle) = Box::into_raw(handle);
        }
        0
    })
}

/// Render a tile from a previously opened raw handle. Same arguments
/// and error codes as `maple_render_file_scene_linear_tile` minus the
/// path / xmp handling — the handle already carries the decoded
/// `RawImage` and parsed `AdjustmentModel`.
///
/// `decoded_temperature` / `decoded_tint` (#1725 band fix, append-only —
/// same precedent as `noise_profile_ptr`): when `decoded_temperature > 0`,
/// the tile's WB stage applies `model.temperature`/`model.tint` as a DELTA
/// relative to `(decoded_temperature, decoded_tint)`, matching
/// `maple_apply_scene_linear_chain`'s (the GPU-live per-tick FFI entry's)
/// delta contract — a tile rendered with `model.temperature ==
/// decoded_temperature` is IDENTITY, so it agrees with an unedited-open
/// live frame instead of shifting away from it (the horizontal-band
/// symptom). Pass `decoded_temperature <= 0.0` (e.g. `0.0`) to preserve the
/// pre-#1725 ABSOLUTE `resolve_wb` + `apply` behavior — the correct
/// semantics when the handle's stored model came from an XMP sidecar with
/// an authored absolute `crs:Temperature` and there is no "decoded anchor"
/// concept (e.g. `maple-cli`-style one-shot renders).
///
/// Error codes:
///   - 1: null pointer argument
///   - 9: bad tile geometry (src_w/src_h/out_w/out_h == 0)
///   - 10: model not tile-compatible (dehaze, vignette, deep denoise, a
///         non-identity local adjustment, or active capture sharpening —
///         #1084 / #1105 / #1109) — caller should fall back to fit-zoom
///         rendering
///   - 11: upscale attempt (out > src) — tile path is downscale-only
///   - 12: mismatched aspect — tile path requires `out_w/out_h` aspect
///         to match `src_w/src_h` aspect (within integer rounding)
///   - 8: any other error from the core tile renderer
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn maple_render_handle_scene_linear_tile(
    handle: *const MapleRawHandle,
    src_x: u32,
    src_y: u32,
    src_w: u32,
    src_h: u32,
    out_w: u32,
    out_h: u32,
    quality_preview: i32,
    decoded_temperature: f32,
    decoded_tint: f32,
    out: *mut MapleSceneLinearBuffer,
) -> i32 {
    if handle.is_null() || out.is_null() {
        set_last_error("null pointer argument".into());
        return 1;
    }
    if src_w == 0 || src_h == 0 || out_w == 0 || out_h == 0 {
        set_last_error("src_w/src_h/out_w/out_h must be > 0".into());
        return 9;
    }
    let inner_ptr = (*handle).inner as *const MapleRawHandleInner;
    if inner_ptr.is_null() {
        set_last_error("handle has been freed".into());
        return 1;
    }
    let inner: &MapleRawHandleInner = &*inner_ptr;
    let raw_addr = (&inner.raw) as *const _ as usize;
    let model_addr = (&inner.model) as *const _ as usize;
    let out_ptr = out as usize;
    let quality = if quality_preview != 0 {
        raw_core::pipeline::RenderQuality::Preview
    } else {
        raw_core::pipeline::RenderQuality::Full
    };
    // Sentinel convention matches `raw-ffi/src/gpu_live/params.rs`'s
    // `use_delta = p.decoded_temperature > 0.0` (0/0 means "no decoded WB").
    let wb_anchor = if decoded_temperature > 0.0 {
        Some((decoded_temperature, decoded_tint))
    } else {
        None
    };
    with_large_stack(move || {
        // SAFETY: caller guarantees the handle is alive for the
        // duration of this call (caller is the actor-isolated
        // RawImageCache; see Task 5). The references read here live in
        // the heap-boxed `MapleRawHandleInner` whose lifetime is tied
        // to the matching `maple_close_raw_handle` call.
        let raw_img: &raw_core::image::RawImage =
            unsafe { &*(raw_addr as *const raw_core::image::RawImage) };
        let model: &xmp::AdjustmentModel = unsafe { &*(model_addr as *const xmp::AdjustmentModel) };
        if dehaze_active(model) {
            set_last_error("dehaze unsupported on tile path".into());
            return 10;
        }
        let (w, h, fp16) =
            match raw_core::pipeline::render_scene_linear_tile_from_raw_with_quality_and_wb_anchor(
                raw_img,
                model,
                raw_core::pipeline::TileRect {
                    src_x,
                    src_y,
                    src_w,
                    src_h,
                    out_w,
                    out_h,
                },
                quality,
                wb_anchor,
            ) {
                Ok(t) => t,
                Err(e) => {
                    let msg = format!("{}", e);
                    set_last_error(msg.clone());
                    // rc=10 — model not tile-compatible; caller should fall
                    // back to the full-image render. Covers the core entry's
                    // dehaze / vignette / deep-denoise / local-adjustments /
                    // capture-sharpening rejections (#1084, #1105, #1109).
                    if msg.contains("dehaze")
                        || msg.contains("vignette")
                        || msg.contains("deep denoise")
                        || msg.contains("local adjustments")
                        || msg.contains("capture sharpening")
                        || msg.contains("OpcodeList3")
                    {
                        return 10;
                    }
                    if msg.contains("upscale") || msg.contains("downscale-only") {
                        return 11;
                    }
                    if msg.contains("matching aspect") {
                        return 12;
                    }
                    return 8;
                }
            };
        write_scene_linear_buf(out_ptr, w, h, fp16);
        0
    })
}

/// f32 (16 B/px) counterpart to [`maple_render_handle_scene_linear_tile`].
///
/// Identical arguments, geometry, WB-anchor contract, and error codes; the
/// only difference is the output buffer is **f32** RGBA (`bytes_per_pixel =
/// 16`) instead of fp16 (`8`). The Apple native-detail tile-refinement path
/// (`NativeDetailRenderer`) uses this so its working precision matches the
/// whole-image scene-linear path's f32 (#487) rather than the fp16 the tile
/// path shipped — a precision-tier divergence that could bias shadows / band
/// the AgX shoulder in the zoomed-in tile vs the full image (#1945).
///
/// Auto-exposure (#1167): this entry never threads an AE gain — it is
/// exactly the pre-#1167 tile chain, i.e. bit-identical to `ae_gain = 1.0`.
/// See [`maple_render_handle_scene_linear_tile_ae_f32`] for the AE-gain-aware
/// sibling; kept as a separate symbol (rather than widening this one's
/// arity) so existing Apple bindings compiled against this signature keep
/// working unchanged.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn maple_render_handle_scene_linear_tile_f32(
    handle: *const MapleRawHandle,
    src_x: u32,
    src_y: u32,
    src_w: u32,
    src_h: u32,
    out_w: u32,
    out_h: u32,
    quality_preview: i32,
    decoded_temperature: f32,
    decoded_tint: f32,
    out: *mut crate::buffers::MapleSceneLinearBufferF32,
) -> i32 {
    render_handle_scene_linear_tile_f32_impl(
        handle,
        src_x,
        src_y,
        src_w,
        src_h,
        out_w,
        out_h,
        quality_preview,
        decoded_temperature,
        decoded_tint,
        1.0,
        out,
    )
}

/// AE-gain-aware sibling of [`maple_render_handle_scene_linear_tile_f32`]
/// (#1167). Identical in every other respect; `ae_gain` is the auto-exposure
/// anchor gain to thread into the tile develop chain — pass the
/// `MapleSceneLinearBufferF32::ae_gain` a full-image (or sized) f32 render of
/// the SAME model already exported, so a deep-zoom tile matches the
/// full-image AE brightness instead of omitting the stage (`ae_gain = 1.0`
/// reproduces the pre-#1167 / [`maple_render_handle_scene_linear_tile_f32`]
/// output bit-for-bit).
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn maple_render_handle_scene_linear_tile_ae_f32(
    handle: *const MapleRawHandle,
    src_x: u32,
    src_y: u32,
    src_w: u32,
    src_h: u32,
    out_w: u32,
    out_h: u32,
    quality_preview: i32,
    decoded_temperature: f32,
    decoded_tint: f32,
    ae_gain: f32,
    out: *mut crate::buffers::MapleSceneLinearBufferF32,
) -> i32 {
    render_handle_scene_linear_tile_f32_impl(
        handle,
        src_x,
        src_y,
        src_w,
        src_h,
        out_w,
        out_h,
        quality_preview,
        decoded_temperature,
        decoded_tint,
        ae_gain,
        out,
    )
}

/// Shared body of [`maple_render_handle_scene_linear_tile_f32`] and
/// [`maple_render_handle_scene_linear_tile_ae_f32`] — every argument the two
/// public symbols have in common, plus `ae_gain` (1.0 from the former, a
/// caller-supplied value from the latter). Factored out so the two `#[repr(C)]`
/// entries (which must keep distinct, stable arities — see each fn's doc)
/// don't duplicate the guard/decode/pack body (#1167).
#[allow(clippy::too_many_arguments)]
unsafe fn render_handle_scene_linear_tile_f32_impl(
    handle: *const MapleRawHandle,
    src_x: u32,
    src_y: u32,
    src_w: u32,
    src_h: u32,
    out_w: u32,
    out_h: u32,
    quality_preview: i32,
    decoded_temperature: f32,
    decoded_tint: f32,
    ae_gain: f32,
    out: *mut crate::buffers::MapleSceneLinearBufferF32,
) -> i32 {
    if handle.is_null() || out.is_null() {
        set_last_error("null pointer argument".into());
        return 1;
    }
    if src_w == 0 || src_h == 0 || out_w == 0 || out_h == 0 {
        set_last_error("src_w/src_h/out_w/out_h must be > 0".into());
        return 9;
    }
    let inner_ptr = (*handle).inner as *const MapleRawHandleInner;
    if inner_ptr.is_null() {
        set_last_error("handle has been freed".into());
        return 1;
    }
    let inner: &MapleRawHandleInner = &*inner_ptr;
    let raw_addr = (&inner.raw) as *const _ as usize;
    let model_addr = (&inner.model) as *const _ as usize;
    let out_ptr = out as usize;
    let quality = if quality_preview != 0 {
        raw_core::pipeline::RenderQuality::Preview
    } else {
        raw_core::pipeline::RenderQuality::Full
    };
    let wb_anchor = if decoded_temperature > 0.0 {
        Some((decoded_temperature, decoded_tint))
    } else {
        None
    };
    with_large_stack(move || {
        // SAFETY: identical to `maple_render_handle_scene_linear_tile` — the
        // caller (actor-isolated RawImageCache) keeps the handle alive for the
        // call; the references live in the heap-boxed `MapleRawHandleInner`.
        let raw_img: &raw_core::image::RawImage =
            unsafe { &*(raw_addr as *const raw_core::image::RawImage) };
        let model: &xmp::AdjustmentModel = unsafe { &*(model_addr as *const xmp::AdjustmentModel) };
        if dehaze_active(model) {
            set_last_error("dehaze unsupported on tile path".into());
            return 10;
        }
        let (w, h, f32_rgba) = match raw_core::pipeline::render_scene_linear_tile_from_raw_with_quality_and_wb_anchor_and_ae_gain_f32(
            raw_img,
            model,
            raw_core::pipeline::TileRect {
                src_x,
                src_y,
                src_w,
                src_h,
                out_w,
                out_h,
            },
            quality,
            wb_anchor,
            ae_gain,
        ) {
            Ok(t) => t,
            Err(e) => {
                let msg = format!("{}", e);
                set_last_error(msg.clone());
                if msg.contains("dehaze")
                    || msg.contains("vignette")
                    || msg.contains("deep denoise")
                    || msg.contains("local adjustments")
                    || msg.contains("capture sharpening")
                    || msg.contains("OpcodeList3")
                {
                    return 10;
                }
                if msg.contains("upscale") || msg.contains("downscale-only") {
                    return 11;
                }
                if msg.contains("matching aspect") {
                    return 12;
                }
                return 8;
            }
        };
        crate::scene_linear_f32::write_scene_linear_buf_f32(
            out_ptr,
            w,
            h,
            f32_rgba,
            raw_img.noise_profile.as_deref(),
            raw_img.iso,
            &crate::scene_linear_f32::wb_frame_export(raw_img),
            ae_gain,
        );
        0
    })
}

/// Free a `MapleRawHandle` and its inner `RawImage` + `AdjustmentModel`.
/// No-op when `handle` is null. Apple's `MapleRawHandleBox.deinit` calls
/// this on cache eviction or asset switch.
#[no_mangle]
pub unsafe extern "C" fn maple_close_raw_handle(handle: *mut MapleRawHandle) {
    if handle.is_null() {
        return;
    }
    let h = Box::from_raw(handle);
    if !h.inner.is_null() {
        let inner = h.inner as *mut MapleRawHandleInner;
        drop(Box::from_raw(inner));
    }
}
