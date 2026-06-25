//! Tile scene-linear render entries — `maple_render_file_scene_linear_tile`
//! and `maple_render_bytes_scene_linear_tile`.
//!
//! Split from `scene_linear` to stay within the 600-line file budget (#1247).
//! `write_scene_linear_buf` lives in the parent module and is re-used here.

use crate::buffers::MapleSceneLinearBuffer;
use crate::error::{set_last_error, with_large_stack};
use crate::model::{deep_denoise_active, dehaze_active, load_xmp_model_owned, LoadModel};
use raw_core::decode::decode_bytes;
use std::ffi::{c_char, CStr};

/// Tile scene-linear render — same fp16 RGBA output struct as the sized
/// variant, but renders only the source-pixel rectangle
/// `(src_x, src_y, src_w, src_h)`. Pads internally by
/// `raw_core::pipeline::TILE_OVERLAP_PX` to satisfy the
/// development chain's stencil radii (clarity is the binding
/// constraint), then trims to the inner rect, downsamples to
/// `(out_w, out_h)`, orients, and packs to fp16 RGBA.
///
/// Returns 0 on success. Error codes mirror `maple_render_file_scene_linear`
/// plus:
///   - 9:  `src_w/src_h/out_w/out_h == 0` — bad tile geometry.
///   - 10: model not tile-compatible — dehaze (radius 67 exceeds the
///          overlap pad), vignette (full-frame anchor not threaded, #1109
///          / #11), BM3D deep denoise (frame-anchored patch grid, #1105),
///          a non-identity local adjustment (full-image-normalized mask
///          coords, #1084), or active capture sharpening (RL stencil
///          exceeds the overlap pad, #1084). Caller should fall back to
///          fit-zoom rendering.
///   - 11: `out_w > src_w || out_h > src_h` — tile path is downscale-only.
///   - 12: `(out_w, out_h)` aspect does not match `(src_w, src_h)` —
///          tile path requires matching aspect.
///
/// Plan 3 — see .archived-plans/plans/2026-04-25-deep-zoom-tile-rendering.md
/// Task 2 and docs/tickets/06-viewport-sized-rust-ffi-preview.md M4.
#[no_mangle]
pub unsafe extern "C" fn maple_render_file_scene_linear_tile(
    raw_path: *const c_char,
    xmp_path: *const c_char,
    src_x: u32,
    src_y: u32,
    src_w: u32,
    src_h: u32,
    out_w: u32,
    out_h: u32,
    quality_preview: i32,
    out: *mut MapleSceneLinearBuffer,
) -> i32 {
    if raw_path.is_null() || out.is_null() {
        set_last_error("null pointer argument".into());
        return 1;
    }
    if src_w == 0 || src_h == 0 || out_w == 0 || out_h == 0 {
        set_last_error("src_w/src_h/out_w/out_h must be > 0".into());
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
            1 => raw_core::pipeline::RenderQuality::Preview,
            2 => raw_core::pipeline::RenderQuality::Amaze,
            _ => raw_core::pipeline::RenderQuality::Full,
        };
        if dehaze_active(&model) {
            set_last_error("dehaze unsupported on tile path".into());
            return 10;
        }
        if deep_denoise_active(&model) {
            // #1105: BM3D's reference grid is frame-anchored — per-tile
            // grids would seam. Same fallback contract as dehaze.
            set_last_error("deepDenoise unsupported on tile path".into());
            return 10;
        }
        let (w, h, fp16) = match raw_core::pipeline::render_scene_linear_tile_from_raw_with_quality(
            &raw_img, &model, src_x, src_y, src_w, src_h, out_w, out_h, quality,
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
        super::write_scene_linear_buf(out_ptr, w, h, fp16);
        0
    })
}

/// Tile scene-linear render from a byte slice — bytes equivalent of
/// `maple_render_file_scene_linear_tile`. Same arguments + `raw_bytes` /
/// `raw_len` / `hint_ext` (mirroring the bytes-variant convention from
/// `maple_render_bytes_scene_linear_sized`).
#[no_mangle]
pub unsafe extern "C" fn maple_render_bytes_scene_linear_tile(
    raw_bytes: *const u8,
    raw_len: usize,
    hint_ext: *const c_char,
    xmp_path: *const c_char,
    src_x: u32,
    src_y: u32,
    src_w: u32,
    src_h: u32,
    out_w: u32,
    out_h: u32,
    quality_preview: i32,
    out: *mut MapleSceneLinearBuffer,
) -> i32 {
    if raw_bytes.is_null() || out.is_null() {
        set_last_error("null pointer argument".into());
        return 1;
    }
    if src_w == 0 || src_h == 0 || out_w == 0 || out_h == 0 {
        set_last_error("src_w/src_h/out_w/out_h must be > 0".into());
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
            1 => raw_core::pipeline::RenderQuality::Preview,
            2 => raw_core::pipeline::RenderQuality::Amaze,
            _ => raw_core::pipeline::RenderQuality::Full,
        };
        if dehaze_active(&model) {
            set_last_error("dehaze unsupported on tile path".into());
            return 10;
        }
        if deep_denoise_active(&model) {
            // #1105: BM3D's reference grid is frame-anchored — per-tile
            // grids would seam. Same fallback contract as dehaze.
            set_last_error("deepDenoise unsupported on tile path".into());
            return 10;
        }
        let (w, h, fp16) = match raw_core::pipeline::render_scene_linear_tile_from_raw_with_quality(
            &raw_img, &model, src_x, src_y, src_w, src_h, out_w, out_h, quality,
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
        super::write_scene_linear_buf(out_ptr, w, h, fp16);
        0
    })
}
