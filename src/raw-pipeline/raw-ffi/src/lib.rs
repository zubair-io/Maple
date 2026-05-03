//! C ABI surface for raw-core. Intended for consumption by Apple's
//! `MapleCore` Swift package via `RawPipeline.xcframework` (per spec § 00).
//!
//! Minimal v1 surface:
//!
//!   int maple_render_file(
//!       const char* raw_path,
//!       const char* xmp_path,            // may be null — uses AdjustmentModel::default()
//!       MapleImageBuffer* out            // receives width, height, rgb pointer
//!   );
//!
//!   void maple_free_buffer(MapleImageBuffer* buffer);
//!
//!   const char* maple_last_error(void);  // thread-local; cleared on next call
//!
//! Output is u8 sRGB RGB (length = 3 × width × height).

#![allow(clippy::missing_safety_doc)]

use raw_core::{
    decode::decode_bytes,
    pipeline::{render_from_raw_with_quality, RenderQuality},
    xmp,
};
use std::ffi::{CStr, c_char};
use std::cell::RefCell;

thread_local! {
    static LAST_ERROR: RefCell<Option<std::ffi::CString>> = const { RefCell::new(None) };
}

/// Strip stages from an `AdjustmentModel` that the Apple editor's
/// scene-linear chain re-applies, so the FFI decode does NOT bake them
/// into the cached buffer.
///
/// Architecture: `apply_scene_linear_chain` (Apple's hot path on every
/// slider tick) applies the FULL model — `scene_tone_controls`,
/// `vibrance`, `saturation`, `clarity`, `texture`, `dehaze`,
/// `nr_luminance`, AgX (contrast). If the decode **also** bakes those
/// fields with the live sidecar values, every chain-handled stage runs
/// twice and slider values double — exposure +3.68 EV becomes +7.36 EV,
/// AgX's highlight rolloff produces non-linear chroma distortion, and
/// the result on real images is a visible magenta cast.
///
/// Apple's Metal kernels also re-apply `sharpen` and `nr_color`
/// **after** the chain, so those two are stripped for the same reason
/// (and have been since the first iteration of this helper).
///
/// Stripped fields (set to `AdjustmentModel::default()` values so the
/// stages early-exit during decode):
///   * `temperature`, `tint`        — `white_balance::apply` early-exits
///     at temp=6500/tint=0 (its identity short-circuit). The post-DCP
///     buffer is at D65 (= 6500K) by construction; the chain re-applies
///     the user's full WB shift from this consistent reference.
///   * `exposure`, `contrast`, `highlights`, `shadows`, `whites`,
///     `blacks`  — scene_tone_controls + AgX contrast slope
///   * `vibrance`, `saturation`, `clarity`, `texture`, `dehaze`
///   * `nr_luminance`              — chain applies it
///   * `sharpen_amount`, `nr_color` — Apple Metal re-applies post-chain
///
/// **Kept** (Apple-irreplaceable, baked at decode only):
///   * `highlight_recovery`         — pre-DCP, no chain equivalent.
///   * `sharpen_radius`, `sharpen_detail`, `sharpen_masking` — read by
///     Apple Metal; not used during decode anyway.
///
/// **WB contract** (the previously load-bearing source of magenta-cast
/// bugs): the strip forces the FFI decode to a fixed reference state
/// (D65) regardless of what the sidecar contains, eliminating the
/// "first-open at D65, post-sidecar at user-temp" inconsistency.
///
/// Apple's `processSceneLinear` then passes
/// `decodedTemp = asShot.temperature` so the chain's
/// `white_balance::apply_delta(live, decoded)` computes
/// `wb_gains(live) / wb_gains(asShot)` — identity at `live == asShot`
/// (the ACR "As Shot" default), with shift relative to asShot when the
/// user moves the slider. **NB**: the chain's math assumes the buffer
/// is at `decoded_temp` whereas the strip puts it at D65; the
/// arithmetic is still well-defined and produces a consistent UX,
/// but the chain output at `live != asShot` is a relative shift on
/// a D65 buffer rather than an absolute WB transform.
///
/// `maple_render_file` (the legacy 8-bit sRGB output used by the parity
/// test harness) does NOT go through this helper — ACR-comparable
/// output requires the full chain run during decode.
/// Tile-path dehaze guard. Dehaze relies on a full-image dark-channel
/// computation; running it on a crop tile would produce a wrong dark
/// channel (radius 67 px on the reference scenes). The non-tile FFI
/// paths catch this via raw-core's stage error (and bubble up as rc=10);
/// since `strip_apple_gpu_stages` zeros `model.dehaze` before the call,
/// the tile path needs an explicit pre-strip check or the rejection is
/// silently bypassed and tiles render with no dehaze (silent
/// degradation rather than the contracted hard error).
///
/// Returns `true` when `model.dehaze` is meaningfully non-zero (matches
/// `dehaze::apply`'s own early-exit threshold of `1e-3`).
fn dehaze_active(model: &xmp::AdjustmentModel) -> bool {
    model.dehaze.abs() > 1e-3
}

fn strip_apple_gpu_stages(mut model: xmp::AdjustmentModel) -> xmp::AdjustmentModel {
    let defaults = xmp::AdjustmentModel::default();
    // White balance — chain applies it from a D65 reference (see above).
    model.temperature = defaults.temperature;
    model.tint = defaults.tint;
    // scene_tone_controls + AgX contrast
    model.exposure = defaults.exposure;
    model.contrast = defaults.contrast;
    model.highlights = defaults.highlights;
    model.shadows = defaults.shadows;
    model.whites = defaults.whites;
    model.blacks = defaults.blacks;
    // Hue/sat/local-contrast/dehaze
    model.vibrance = defaults.vibrance;
    model.saturation = defaults.saturation;
    model.clarity = defaults.clarity;
    model.texture = defaults.texture;
    model.dehaze = defaults.dehaze;
    // Noise reduction (chain handles luminance; Metal handles color)
    model.nr_luminance = defaults.nr_luminance;
    model.nr_color = defaults.nr_color;
    // Sharpen (Apple Metal handles)
    model.sharpen_amount = defaults.sharpen_amount;
    model
}

fn set_last_error(msg: String) {
    if let Ok(cstr) = std::ffi::CString::new(msg) {
        LAST_ERROR.with(|e| *e.borrow_mut() = Some(cstr));
    }
}

/// Stack size for the worker thread that runs RAW decode + develop. Rawler's
/// per-format decoders (CR3 in particular) allocate several MB of Huffman /
/// JPEG-LS scratch on the stack, and Swift's cooperative-pool threads start
/// with ~512 KB — which trips an EXC_BAD_ACCESS / stack overflow on real RAWs.
/// 16 MB is plenty; physical memory is only committed on demand.
const WORKER_STACK_BYTES: usize = 16 * 1024 * 1024;

/// Run a render closure on a dedicated thread with a large stack, then
/// propagate both its return value and any `LAST_ERROR` it set back to the
/// caller. Each FFI entrypoint uses this wrapper so callers don't need to
/// think about stack sizes.
fn with_large_stack<F>(work: F) -> i32
where
    F: FnOnce() -> i32 + Send + 'static,
{
    let handle = std::thread::Builder::new()
        .stack_size(WORKER_STACK_BYTES)
        .name("maple-ffi-decode".to_string())
        .spawn(move || {
            let rc = work();
            // Ferry the worker's thread-local last error out to the caller
            // thread so `maple_last_error` still reports useful messages.
            let err = LAST_ERROR.with(|e| e.borrow().clone());
            (rc, err)
        });
    match handle {
        Ok(h) => match h.join() {
            Ok((rc, err)) => {
                if let Some(cstr) = err {
                    LAST_ERROR.with(|e| *e.borrow_mut() = Some(cstr));
                }
                rc
            }
            Err(_) => {
                set_last_error("render worker panicked".into());
                99
            }
        },
        Err(e) => {
            set_last_error(format!("spawn worker failed: {}", e));
            98
        }
    }
}

#[repr(C)]
pub struct MapleImageBuffer {
    /// Pointer to heap-allocated RGB u8 buffer. Free via `maple_free_buffer`.
    pub rgb: *mut u8,
    /// Bytes in the buffer (= 3 * width * height).
    pub len: usize,
    pub width: u32,
    pub height: u32,
}

impl MapleImageBuffer {
    fn empty() -> Self {
        Self { rgb: std::ptr::null_mut(), len: 0, width: 0, height: 0 }
    }
}

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
        let model = match &xmp_path_str {
            None => xmp::AdjustmentModel::default(),
            Some(p) => match std::fs::read_to_string(p) {
                Ok(xml) => match xmp::parse(&xml) {
                    Ok(m) => m,
                    Err(e) => { set_last_error(format!("xmp parse: {}", e)); return 4; }
                },
                Err(e) => { set_last_error(format!("xmp read: {}", e)); return 5; }
            },
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
        let (w, h, bytes) = match render_from_raw_with_quality(&raw_img, &model, quality) {
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
        let model = match &xmp_path_str {
            None => xmp::AdjustmentModel::default(),
            Some(p) => match std::fs::read_to_string(p) {
                Ok(xml) => match xmp::parse(&xml) {
                    Ok(m) => m,
                    Err(e) => { set_last_error(format!("xmp parse: {}", e)); return 4; }
                },
                Err(e) => { set_last_error(format!("xmp read: {}", e)); return 5; }
            },
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

/// Free a buffer populated by `maple_render_file` or `maple_render_bytes`.
#[no_mangle]
pub unsafe extern "C" fn maple_free_buffer(buffer: *mut MapleImageBuffer) {
    if buffer.is_null() { return; }
    let b = &mut *buffer;
    if !b.rgb.is_null() {
        let slice = std::slice::from_raw_parts_mut(b.rgb, b.len);
        drop(Box::from_raw(slice as *mut [u8]));
    }
    *b = MapleImageBuffer::empty();
}

/// Scene-linear FFI buffer — Rec.2020 fp16 RGBA, straight alpha, row-major.
///
/// `bytes_per_pixel` is always 8 (4 channels × 2 bytes per fp16 lane). It
/// is exposed in the struct so the Apple consumer can read the layout
/// without hard-coding the constant; future plans (e.g. higher bit depth
/// for HDR) can change it without breaking the ABI.
#[repr(C)]
pub struct MapleSceneLinearBuffer {
    /// Pointer to heap-allocated fp16 RGBA buffer. Free via
    /// `maple_free_scene_linear_buffer`.
    pub fp16_rgba: *mut u16,
    /// Bytes in the buffer (= 4 * 2 * width * height = 8 * width * height).
    pub len_bytes: usize,
    /// Channels per pixel (always 4: R, G, B, A).
    pub channels: u32,
    /// Bytes per pixel (always 8 for fp16 RGBA).
    pub bytes_per_pixel: u32,
    pub width: u32,
    pub height: u32,
}

impl MapleSceneLinearBuffer {
    fn empty() -> Self {
        Self {
            fp16_rgba: std::ptr::null_mut(),
            len_bytes: 0,
            channels: 0,
            bytes_per_pixel: 0,
            width: 0,
            height: 0,
        }
    }
}

/// Render a RAW+XMP to a scene-linear Rec.2020 fp16 RGBA buffer. Returns
/// 0 on success, non-zero on error (call `maple_last_error`). The output
/// pre-AgX, pre-Rec.2020->sRGB — the caller is expected to apply a view
/// transform and gamut convert before display.
///
/// `quality_preview` mirrors `maple_render_file` — 1 = half-res preview,
/// 0 = full export.
#[no_mangle]
pub unsafe extern "C" fn maple_render_file_scene_linear(
    raw_path: *const c_char,
    xmp_path: *const c_char,
    quality_preview: i32,
    out: *mut MapleSceneLinearBuffer,
) -> i32 {
    if raw_path.is_null() || out.is_null() {
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
    let out_ptr = out as usize;
    with_large_stack(move || {
        let raw_path = std::path::Path::new(&raw_path_str);
        let model = match &xmp_path_str {
            None => xmp::AdjustmentModel::default(),
            Some(p) => match std::fs::read_to_string(p) {
                Ok(xml) => match xmp::parse(&xml) {
                    Ok(m) => m,
                    Err(e) => { set_last_error(format!("xmp parse: {}", e)); return 4; }
                },
                Err(e) => { set_last_error(format!("xmp read: {}", e)); return 5; }
            },
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
            raw_core::pipeline::RenderQuality::Preview
        } else {
            raw_core::pipeline::RenderQuality::Full
        };
        let model = strip_apple_gpu_stages(model);
        let (w, h, fp16) = match raw_core::pipeline::render_scene_linear_from_raw_with_quality(
            &raw_img, &model, quality,
        ) {
            Ok(t) => t,
            Err(e) => { set_last_error(format!("render: {}", e)); return 8; }
        };
        // Box the Vec<u16> so we can hand the raw pointer + len to the caller.
        let (fp16_ptr, _len_lanes, len_bytes) = raw_core::pipeline::stage("ffi_pack", || {
            let mut boxed = fp16.into_boxed_slice();
            let p = boxed.as_mut_ptr();
            let n = boxed.len();
            std::mem::forget(boxed);
            (p, n, n * std::mem::size_of::<u16>())
        });
        unsafe {
            *(out_ptr as *mut MapleSceneLinearBuffer) =
                MapleSceneLinearBuffer {
                    fp16_rgba: fp16_ptr,
                    len_bytes,
                    channels: 4,
                    bytes_per_pixel: 8,
                    width: w,
                    height: h,
                };
        }
        0
    })
}

/// Render a RAW from a byte slice to a scene-linear Rec.2020 fp16 RGBA
/// buffer. Mirrors `maple_render_bytes` for the new path.
#[no_mangle]
pub unsafe extern "C" fn maple_render_bytes_scene_linear(
    raw_bytes: *const u8,
    raw_len: usize,
    hint_ext: *const c_char,
    xmp_path: *const c_char,
    quality_preview: i32,
    out: *mut MapleSceneLinearBuffer,
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
    let input: Vec<u8> = std::slice::from_raw_parts(raw_bytes, raw_len).to_vec();
    let out_ptr = out as usize;
    with_large_stack(move || {
        let model = match &xmp_path_str {
            None => xmp::AdjustmentModel::default(),
            Some(p) => match std::fs::read_to_string(p) {
                Ok(xml) => match xmp::parse(&xml) {
                    Ok(m) => m,
                    Err(e) => { set_last_error(format!("xmp parse: {}", e)); return 4; }
                },
                Err(e) => { set_last_error(format!("xmp read: {}", e)); return 5; }
            },
        };
        let raw_img = match raw_core::pipeline::stage("ffi_rawler_decode", || decode_bytes(&input, &ext_owned)) {
            Ok(r) => r,
            Err(e) => { set_last_error(format!("decode: {}", e)); return 7; }
        };
        let quality = if quality_preview != 0 {
            raw_core::pipeline::RenderQuality::Preview
        } else {
            raw_core::pipeline::RenderQuality::Full
        };
        let model = strip_apple_gpu_stages(model);
        let (w, h, fp16) = match raw_core::pipeline::render_scene_linear_from_raw_with_quality(
            &raw_img, &model, quality,
        ) {
            Ok(t) => t,
            Err(e) => { set_last_error(format!("render: {}", e)); return 8; }
        };
        let (fp16_ptr, _len_lanes, len_bytes) = raw_core::pipeline::stage("ffi_pack", || {
            let mut boxed = fp16.into_boxed_slice();
            let p = boxed.as_mut_ptr();
            let n = boxed.len();
            std::mem::forget(boxed);
            (p, n, n * std::mem::size_of::<u16>())
        });
        unsafe {
            *(out_ptr as *mut MapleSceneLinearBuffer) =
                MapleSceneLinearBuffer {
                    fp16_rgba: fp16_ptr,
                    len_bytes,
                    channels: 4,
                    bytes_per_pixel: 8,
                    width: w,
                    height: h,
                };
        }
        0
    })
}

/// Sized scene-linear render — same as `maple_render_file_scene_linear`
/// but downsamples to fit within `max_long_edge` on its long edge,
/// preserving aspect ratio, never upscaling. Same return / error
/// conventions and the same `MapleSceneLinearBuffer` output struct.
///
/// API choice: a single `max_long_edge` u32 instead of `max_width/
/// max_height` simplifies WASM/Web parity (Plan 3 will mirror this on
/// the Web FFI; one scalar keeps the JS binding signature shorter).
/// Aspect math is local to the Rust renderer because it knows the
/// source dimensions.
///
/// Plan 1 v2 — see docs/superpowers/plans/2026-04-24-ffi-split-plan-1.md
/// Task 8 and docs/tickets/06-viewport-sized-rust-ffi-preview.md
/// Milestone 2.
#[no_mangle]
pub unsafe extern "C" fn maple_render_file_scene_linear_sized(
    raw_path: *const c_char,
    xmp_path: *const c_char,
    max_long_edge: u32,
    quality_preview: i32,
    out: *mut MapleSceneLinearBuffer,
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
        let model = match &xmp_path_str {
            None => xmp::AdjustmentModel::default(),
            Some(p) => match std::fs::read_to_string(p) {
                Ok(xml) => match xmp::parse(&xml) {
                    Ok(m) => m,
                    Err(e) => { set_last_error(format!("xmp parse: {}", e)); return 4; }
                },
                Err(e) => { set_last_error(format!("xmp read: {}", e)); return 5; }
            },
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
            raw_core::pipeline::RenderQuality::Preview
        } else {
            raw_core::pipeline::RenderQuality::Full
        };
        let model = strip_apple_gpu_stages(model);
        let (w, h, fp16) = match raw_core::pipeline::render_scene_linear_sized_from_raw_with_quality(
            &raw_img, &model, quality, max_long_edge,
        ) {
            Ok(t) => t,
            Err(e) => { set_last_error(format!("render: {}", e)); return 8; }
        };
        let (fp16_ptr, _len_lanes, len_bytes) = raw_core::pipeline::stage("ffi_pack", || {
            let mut boxed = fp16.into_boxed_slice();
            let p = boxed.as_mut_ptr();
            let n = boxed.len();
            std::mem::forget(boxed);
            (p, n, n * std::mem::size_of::<u16>())
        });
        unsafe {
            *(out_ptr as *mut MapleSceneLinearBuffer) =
                MapleSceneLinearBuffer {
                    fp16_rgba: fp16_ptr,
                    len_bytes,
                    channels: 4,
                    bytes_per_pixel: 8,
                    width: w,
                    height: h,
                };
        }
        0
    })
}

/// Sized scene-linear render from a byte slice — bytes equivalent of
/// `maple_render_file_scene_linear_sized`. Same args + `raw_bytes` /
/// `raw_len` / `hint_ext`.
#[no_mangle]
pub unsafe extern "C" fn maple_render_bytes_scene_linear_sized(
    raw_bytes: *const u8,
    raw_len: usize,
    hint_ext: *const c_char,
    xmp_path: *const c_char,
    max_long_edge: u32,
    quality_preview: i32,
    out: *mut MapleSceneLinearBuffer,
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
    let input: Vec<u8> = std::slice::from_raw_parts(raw_bytes, raw_len).to_vec();
    let out_ptr = out as usize;
    with_large_stack(move || {
        let model = match &xmp_path_str {
            None => xmp::AdjustmentModel::default(),
            Some(p) => match std::fs::read_to_string(p) {
                Ok(xml) => match xmp::parse(&xml) {
                    Ok(m) => m,
                    Err(e) => { set_last_error(format!("xmp parse: {}", e)); return 4; }
                },
                Err(e) => { set_last_error(format!("xmp read: {}", e)); return 5; }
            },
        };
        let raw_img = match raw_core::pipeline::stage("ffi_rawler_decode", || decode_bytes(&input, &ext_owned)) {
            Ok(r) => r,
            Err(e) => { set_last_error(format!("decode: {}", e)); return 7; }
        };
        let quality = if quality_preview != 0 {
            raw_core::pipeline::RenderQuality::Preview
        } else {
            raw_core::pipeline::RenderQuality::Full
        };
        let model = strip_apple_gpu_stages(model);
        let (w, h, fp16) = match raw_core::pipeline::render_scene_linear_sized_from_raw_with_quality(
            &raw_img, &model, quality, max_long_edge,
        ) {
            Ok(t) => t,
            Err(e) => { set_last_error(format!("render: {}", e)); return 8; }
        };
        let (fp16_ptr, _len_lanes, len_bytes) = raw_core::pipeline::stage("ffi_pack", || {
            let mut boxed = fp16.into_boxed_slice();
            let p = boxed.as_mut_ptr();
            let n = boxed.len();
            std::mem::forget(boxed);
            (p, n, n * std::mem::size_of::<u16>())
        });
        unsafe {
            *(out_ptr as *mut MapleSceneLinearBuffer) =
                MapleSceneLinearBuffer {
                    fp16_rgba: fp16_ptr,
                    len_bytes,
                    channels: 4,
                    bytes_per_pixel: 8,
                    width: w,
                    height: h,
                };
        }
        0
    })
}

/// Tile scene-linear render — same fp16 RGBA output struct as the sized
/// variant, but renders only the source-pixel rectangle
/// `(src_x, src_y, src_w, src_h)`. Pads internally by 35 px to satisfy
/// the development chain's stencil radii (clarity is the binding
/// constraint), then trims to the inner rect, downsamples to
/// `(out_w, out_h)`, orients, and packs to fp16 RGBA.
///
/// Returns 0 on success. Error codes mirror `maple_render_file_scene_linear`
/// plus:
///   - 9:  `src_w/src_h/out_w/out_h == 0` — bad tile geometry.
///   - 10: `model.dehaze != 0` — tile path is not supported (radius 67
///          exceeds the 35 px overlap pad). Caller should fall back to
///          fit-zoom rendering.
///   - 11: `out_w > src_w || out_h > src_h` — tile path is downscale-only.
///
/// Plan 3 — see docs/superpowers/plans/2026-04-25-deep-zoom-tile-rendering.md
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
        let model = match &xmp_path_str {
            None => xmp::AdjustmentModel::default(),
            Some(p) => match std::fs::read_to_string(p) {
                Ok(xml) => match xmp::parse(&xml) {
                    Ok(m) => m,
                    Err(e) => { set_last_error(format!("xmp parse: {}", e)); return 4; }
                },
                Err(e) => { set_last_error(format!("xmp read: {}", e)); return 5; }
            },
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
            raw_core::pipeline::RenderQuality::Preview
        } else {
            raw_core::pipeline::RenderQuality::Full
        };
        if dehaze_active(&model) {
            set_last_error("dehaze unsupported on tile path".into());
            return 10;
        }
        let model = strip_apple_gpu_stages(model);
        let (w, h, fp16) = match raw_core::pipeline::render_scene_linear_tile_from_raw_with_quality(
            &raw_img, &model, src_x, src_y, src_w, src_h, out_w, out_h, quality,
        ) {
            Ok(t) => t,
            Err(e) => {
                let msg = format!("{}", e);
                set_last_error(msg.clone());
                if msg.contains("dehaze") { return 10; }
                if msg.contains("upscale") || msg.contains("downscale-only") { return 11; }
                return 8;
            }
        };
        let (fp16_ptr, _len_lanes, len_bytes) = raw_core::pipeline::stage("ffi_pack", || {
            let mut boxed = fp16.into_boxed_slice();
            let p = boxed.as_mut_ptr();
            let n = boxed.len();
            std::mem::forget(boxed);
            (p, n, n * std::mem::size_of::<u16>())
        });
        unsafe {
            *(out_ptr as *mut MapleSceneLinearBuffer) =
                MapleSceneLinearBuffer {
                    fp16_rgba: fp16_ptr,
                    len_bytes,
                    channels: 4,
                    bytes_per_pixel: 8,
                    width: w,
                    height: h,
                };
        }
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
    let input: Vec<u8> = std::slice::from_raw_parts(raw_bytes, raw_len).to_vec();
    let out_ptr = out as usize;
    with_large_stack(move || {
        let model = match &xmp_path_str {
            None => xmp::AdjustmentModel::default(),
            Some(p) => match std::fs::read_to_string(p) {
                Ok(xml) => match xmp::parse(&xml) {
                    Ok(m) => m,
                    Err(e) => { set_last_error(format!("xmp parse: {}", e)); return 4; }
                },
                Err(e) => { set_last_error(format!("xmp read: {}", e)); return 5; }
            },
        };
        let raw_img = match raw_core::pipeline::stage("ffi_rawler_decode", || decode_bytes(&input, &ext_owned)) {
            Ok(r) => r,
            Err(e) => { set_last_error(format!("decode: {}", e)); return 7; }
        };
        let quality = if quality_preview != 0 {
            raw_core::pipeline::RenderQuality::Preview
        } else {
            raw_core::pipeline::RenderQuality::Full
        };
        if dehaze_active(&model) {
            set_last_error("dehaze unsupported on tile path".into());
            return 10;
        }
        let model = strip_apple_gpu_stages(model);
        let (w, h, fp16) = match raw_core::pipeline::render_scene_linear_tile_from_raw_with_quality(
            &raw_img, &model, src_x, src_y, src_w, src_h, out_w, out_h, quality,
        ) {
            Ok(t) => t,
            Err(e) => {
                let msg = format!("{}", e);
                set_last_error(msg.clone());
                if msg.contains("dehaze") { return 10; }
                if msg.contains("upscale") || msg.contains("downscale-only") { return 11; }
                return 8;
            }
        };
        let (fp16_ptr, _len_lanes, len_bytes) = raw_core::pipeline::stage("ffi_pack", || {
            let mut boxed = fp16.into_boxed_slice();
            let p = boxed.as_mut_ptr();
            let n = boxed.len();
            std::mem::forget(boxed);
            (p, n, n * std::mem::size_of::<u16>())
        });
        unsafe {
            *(out_ptr as *mut MapleSceneLinearBuffer) =
                MapleSceneLinearBuffer {
                    fp16_rgba: fp16_ptr,
                    len_bytes,
                    channels: 4,
                    bytes_per_pixel: 8,
                    width: w,
                    height: h,
                };
        }
        0
    })
}

/// Free a buffer populated by `maple_render_*_scene_linear`.
#[no_mangle]
pub unsafe extern "C" fn maple_free_scene_linear_buffer(buffer: *mut MapleSceneLinearBuffer) {
    if buffer.is_null() { return; }
    let b = &mut *buffer;
    if !b.fp16_rgba.is_null() {
        let len_lanes = b.len_bytes / std::mem::size_of::<u16>();
        let slice = std::slice::from_raw_parts_mut(b.fp16_rgba, len_lanes);
        drop(Box::from_raw(slice as *mut [u16]));
    }
    *b = MapleSceneLinearBuffer::empty();
}

// =====================================================================
// Opaque handle for cached rawler-decoded RawImage + parsed XMP.
// =====================================================================
//
// Plan 3 (Ticket 06 M4) — see
// docs/superpowers/plans/2026-04-25-deep-zoom-tile-rendering.md Task 3.
//
// The handle keeps the decoded `RawImage` plus the parsed
// `AdjustmentModel` alive across multiple tile renders so a 100 MP
// rawler decode (~3-5 s cold) runs once per asset open instead of once
// per tile. Apple side wraps the opaque pointer in a `MapleRawHandleBox`
// final class whose `deinit` calls `maple_close_raw_handle`. Rust side
// owns a `Box<MapleRawHandleInner>`.
//
// Deliberate design choices:
//
//   - The xmp file is parsed once at `maple_open_raw_handle` time and
//     stored alongside the RawImage. Tile renders therefore don't
//     need a per-call model serialization (no serde / json dep on
//     raw-ffi). To re-render with a different model the caller closes
//     the handle and reopens with a new xmp path.
//
//   - The struct exposed in the C ABI is `#[repr(C)]` with a single
//     `*mut c_void` field, identical in shape to a forward-declared
//     opaque struct. cbindgen emits a typedef for callers.
//
//   - Same error code semantics as the file/bytes tile entries: 10 for
//     dehaze-active, 11 for upscale-attempt, 9 for bad geometry.

/// Internal state behind the opaque pointer. Not exposed in the C ABI.
struct MapleRawHandleInner {
    raw: raw_core::image::RawImage,
    model: xmp::AdjustmentModel,
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
    let handle_out_addr = handle_out as usize;
    with_large_stack(move || {
        let raw_path = std::path::Path::new(&raw_path_str);
        let model = match &xmp_path_str {
            None => xmp::AdjustmentModel::default(),
            Some(p) => match std::fs::read_to_string(p) {
                Ok(xml) => match xmp::parse(&xml) {
                    Ok(m) => m,
                    Err(e) => { set_last_error(format!("xmp parse: {}", e)); return 4; }
                },
                Err(e) => { set_last_error(format!("xmp read: {}", e)); return 5; }
            },
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
        let inner = Box::new(MapleRawHandleInner { raw: raw_img, model });
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
    let input: Vec<u8> = std::slice::from_raw_parts(raw_bytes, raw_len).to_vec();
    let handle_out_addr = handle_out as usize;
    with_large_stack(move || {
        let model = match &xmp_path_str {
            None => xmp::AdjustmentModel::default(),
            Some(p) => match std::fs::read_to_string(p) {
                Ok(xml) => match xmp::parse(&xml) {
                    Ok(m) => m,
                    Err(e) => { set_last_error(format!("xmp parse: {}", e)); return 4; }
                },
                Err(e) => { set_last_error(format!("xmp read: {}", e)); return 5; }
            },
        };
        let raw_img = match raw_core::pipeline::stage("ffi_rawler_decode", || decode_bytes(&input, &ext_owned)) {
            Ok(r) => r,
            Err(e) => { set_last_error(format!("decode: {}", e)); return 7; }
        };
        let inner = Box::new(MapleRawHandleInner { raw: raw_img, model });
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
/// Error codes:
///   - 1: null pointer argument
///   - 9: bad tile geometry (src_w/src_h/out_w/out_h == 0)
///   - 10: dehaze active in the handle's model — tile path unsafe
///   - 11: upscale attempt (out > src) — tile path is downscale-only
///   - 8: any other error from the core tile renderer
#[no_mangle]
pub unsafe extern "C" fn maple_render_handle_scene_linear_tile(
    handle: *const MapleRawHandle,
    src_x: u32,
    src_y: u32,
    src_w: u32,
    src_h: u32,
    out_w: u32,
    out_h: u32,
    quality_preview: i32,
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
    with_large_stack(move || {
        // SAFETY: caller guarantees the handle is alive for the
        // duration of this call (caller is the actor-isolated
        // RawImageCache; see Task 5). The references read here live in
        // the heap-boxed `MapleRawHandleInner` whose lifetime is tied
        // to the matching `maple_close_raw_handle` call.
        let raw_img: &raw_core::image::RawImage = unsafe { &*(raw_addr as *const raw_core::image::RawImage) };
        let model: &xmp::AdjustmentModel = unsafe { &*(model_addr as *const xmp::AdjustmentModel) };
        if dehaze_active(model) {
            set_last_error("dehaze unsupported on tile path".into());
            return 10;
        }
        let model = strip_apple_gpu_stages(model.clone());
        let (w, h, fp16) = match raw_core::pipeline::render_scene_linear_tile_from_raw_with_quality(
            raw_img, &model, src_x, src_y, src_w, src_h, out_w, out_h, quality,
        ) {
            Ok(t) => t,
            Err(e) => {
                let msg = format!("{}", e);
                set_last_error(msg.clone());
                if msg.contains("dehaze") { return 10; }
                if msg.contains("upscale") || msg.contains("downscale-only") { return 11; }
                return 8;
            }
        };
        let (fp16_ptr, _len_lanes, len_bytes) = raw_core::pipeline::stage("ffi_pack", || {
            let mut boxed = fp16.into_boxed_slice();
            let p = boxed.as_mut_ptr();
            let n = boxed.len();
            std::mem::forget(boxed);
            (p, n, n * std::mem::size_of::<u16>())
        });
        unsafe {
            *(out_ptr as *mut MapleSceneLinearBuffer) =
                MapleSceneLinearBuffer {
                    fp16_rgba: fp16_ptr,
                    len_bytes,
                    channels: 4,
                    bytes_per_pixel: 8,
                    width: w,
                    height: h,
                };
        }
        0
    })
}

/// Free a `MapleRawHandle` and its inner `RawImage` + `AdjustmentModel`.
/// No-op when `handle` is null. Apple's `MapleRawHandleBox.deinit` calls
/// this on cache eviction or asset switch.
#[no_mangle]
pub unsafe extern "C" fn maple_close_raw_handle(handle: *mut MapleRawHandle) {
    if handle.is_null() { return; }
    let h = Box::from_raw(handle);
    if !h.inner.is_null() {
        let inner = h.inner as *mut MapleRawHandleInner;
        drop(Box::from_raw(inner));
    }
}

/// Returns the most recent error message for the current thread, or null.
/// The returned pointer remains valid until the next FFI call on this thread.
#[no_mangle]
pub unsafe extern "C" fn maple_last_error() -> *const c_char {
    LAST_ERROR.with(|e| match &*e.borrow() {
        Some(cstr) => cstr.as_ptr(),
        None => std::ptr::null(),
    })
}

// ─── Per-tick scene-linear chain (Option C) ─────────────────────────────────
//
// Architectural intent: collapse the duplicate Apple-Metal kernel chain
// (WB → tone → vibrance → saturation → clarity → texture → dehaze →
// nr_luminance → AgX) into a single FFI call into the canonical Rust
// implementation. Sharpen + nr_color stay on the GPU (Metal compute) —
// they're too expensive on CPU to hit the per-tick budget. Everything
// else has CPU cost <2ms at viewport size and runs here so Rust is the
// single source of truth for those algorithms.
//
// Caller-provided buffers; this entry doesn't allocate. Input and output
// are both packed fp16 RGBA (8 bytes/pixel), `extendedLinearITUR_2020`
// scene-linear, straight alpha. Output is post-AgX (display-linear
// Rec.2020) when `skip_agx == 0`, scene-linear when non-zero. The
// `skip_agx` flag exists for the non-RAW path: HEIF / JPEG / PNG /
// screenshot input is already display-encoded, so AgX would
// double-tone-map (white compresses to ~0.82). See
// `processSceneLinearNonRaw` in `ImageEditPipeline.swift` for the
// matching commit `4a8c655`.

/// C-ABI mirror of the slider subset that the per-tick chain consumes.
/// Kept flat (all f32) so cbindgen / Swift's `@_silgen_name` import
/// produce a layout-compatible struct on both sides.
///
/// Field order matches the Swift `MapleAdjustmentParams` initialiser at
/// `PipelineRenderer.swift::makeAdjustmentParams` byte-for-byte —
/// changing the order here means changing it there.
#[repr(C)]
pub struct MapleAdjustmentParams {
    pub temperature: f32,
    pub tint: f32,
    pub exposure: f32,
    pub contrast: f32,
    pub highlights: f32,
    pub shadows: f32,
    pub whites: f32,
    pub blacks: f32,
    pub vibrance: f32,
    pub saturation: f32,
    pub clarity: f32,
    pub texture: f32,
    pub nr_luminance: f32,
    pub dehaze: f32,
    pub decoded_temperature: f32,
    pub decoded_tint: f32,
    /// 1 = skip the AgX view transform (non-RAW path: input is already
    /// display-encoded). 0 = apply AgX (RAW path).
    pub skip_agx: u32,
}

/// Run the cheap-stage scene-linear chain over a caller-provided fp16 RGBA
/// buffer. Returns 0 on success, non-zero on error (call `maple_last_error`).
///
/// `in_ptr` and `out_ptr` MUST point to buffers of size
/// `8 * width * height` bytes (= `4 * width * height` fp16 lanes). The
/// caller owns both buffers; this entry doesn't allocate or free.
/// `out_ptr` may alias `in_ptr` only if the caller is willing to lose the
/// input on error — current implementation copies the result at the end
/// so partial in-place is safe but partial-write semantics are undefined
/// on error. Recommend distinct buffers.
///
/// `params` must be a valid pointer to a `MapleAdjustmentParams` struct
/// the caller owns for the duration of this call.
#[no_mangle]
pub unsafe extern "C" fn maple_apply_scene_linear_chain(
    in_ptr: *const u16,
    width: u32,
    height: u32,
    params: *const MapleAdjustmentParams,
    out_ptr: *mut u16,
) -> i32 {
    if in_ptr.is_null() || params.is_null() || out_ptr.is_null() {
        set_last_error("apply_scene_linear_chain: null pointer".into());
        return 1;
    }
    if width == 0 || height == 0 {
        set_last_error(format!(
            "apply_scene_linear_chain: zero dimension width={} height={}",
            width, height
        ));
        return 2;
    }
    let lanes = (width as usize)
        .saturating_mul(height as usize)
        .saturating_mul(4);
    if lanes == 0 {
        set_last_error("apply_scene_linear_chain: pixel-count overflow".into());
        return 3;
    }
    let p = &*params;

    // Build an AdjustmentModel from the C-ABI params. Fields the chain
    // uses get copied across; sharpen + nr_color stay default (they're
    // applied on the GPU after this call returns) and other fields keep
    // the AdjustmentModel::default() values so this matches the Rust
    // pipeline's behavior on the cheap-stage subset.
    let mut model = raw_core::xmp::AdjustmentModel::default();
    model.temperature = p.temperature;
    model.tint = p.tint;
    model.exposure = p.exposure;
    model.contrast = p.contrast;
    model.highlights = p.highlights;
    model.shadows = p.shadows;
    model.whites = p.whites;
    model.blacks = p.blacks;
    model.vibrance = p.vibrance;
    model.saturation = p.saturation;
    model.clarity = p.clarity;
    model.texture = p.texture;
    model.nr_luminance = p.nr_luminance;
    model.dehaze = p.dehaze;

    let in_slice = std::slice::from_raw_parts(in_ptr, lanes);

    let out_vec = match raw_core::pipeline::apply_scene_linear_chain(
        in_slice,
        width,
        height,
        &model,
        p.decoded_temperature,
        p.decoded_tint,
        p.skip_agx != 0,
    ) {
        Ok(v) => v,
        Err(e) => {
            set_last_error(format!("apply_scene_linear_chain: {}", e));
            return 8;
        }
    };
    if out_vec.len() != lanes {
        set_last_error(format!(
            "apply_scene_linear_chain: chain returned {} lanes, expected {}",
            out_vec.len(),
            lanes
        ));
        return 9;
    }

    let out_slice = std::slice::from_raw_parts_mut(out_ptr, lanes);
    out_slice.copy_from_slice(&out_vec);
    0
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::CString;

    #[test]
    fn render_default_model_via_ffi() {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test-fixtures/raws/test_0002.dng");
        if !path.exists() { return; }
        let raw_cstr = CString::new(path.to_str().unwrap()).unwrap();
        let mut buf = MapleImageBuffer::empty();
        let rc = unsafe { maple_render_file(raw_cstr.as_ptr(), std::ptr::null(), 0, &mut buf) };
        assert_eq!(rc, 0, "render rc = {}", rc);
        assert!(buf.width > 0 && buf.height > 0);
        assert_eq!(buf.len as u32, buf.width * buf.height * 3);
        unsafe { maple_free_buffer(&mut buf) };
        assert!(buf.rgb.is_null());
    }

    #[test]
    fn render_bytes_via_ffi() {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test-fixtures/raws/test_0002.dng");
        if !path.exists() { return; }
        let bytes = std::fs::read(&path).unwrap();
        let ext = CString::new("dng").unwrap();
        let mut buf = MapleImageBuffer::empty();
        let rc = unsafe {
            maple_render_bytes(bytes.as_ptr(), bytes.len(), ext.as_ptr(),
                               std::ptr::null(), 0, &mut buf)
        };
        assert_eq!(rc, 0, "render_bytes rc = {}", rc);
        assert!(buf.width > 0 && buf.height > 0);
        assert_eq!(buf.len as u32, buf.width * buf.height * 3);
        unsafe { maple_free_buffer(&mut buf) };
        assert!(buf.rgb.is_null());
    }

    #[test]
    fn null_arg_sets_error() {
        let mut buf = MapleImageBuffer::empty();
        let rc = unsafe { maple_render_file(std::ptr::null(), std::ptr::null(), 0, &mut buf) };
        assert_eq!(rc, 1);
        let err = unsafe { maple_last_error() };
        assert!(!err.is_null());
        let msg = unsafe { CStr::from_ptr(err).to_str().unwrap() };
        assert!(msg.contains("null"));
    }

    #[test]
    fn render_scene_linear_default_model_via_ffi() {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test-fixtures/raws/test_0002.dng");
        if !path.exists() { return; }
        let raw_cstr = CString::new(path.to_str().unwrap()).unwrap();
        let mut buf = MapleSceneLinearBuffer::empty();
        let rc = unsafe {
            maple_render_file_scene_linear(raw_cstr.as_ptr(), std::ptr::null(), 1, &mut buf)
        };
        assert_eq!(rc, 0, "render rc = {}", rc);
        assert!(buf.width > 0 && buf.height > 0);
        assert_eq!(buf.channels, 4);
        assert_eq!(buf.bytes_per_pixel, 8);
        assert_eq!(buf.len_bytes as u32, buf.width * buf.height * 8);
        unsafe { maple_free_scene_linear_buffer(&mut buf) };
        assert!(buf.fp16_rgba.is_null());
    }

    #[test]
    fn scene_linear_null_arg_sets_error() {
        let mut buf = MapleSceneLinearBuffer::empty();
        let rc = unsafe { maple_render_file_scene_linear(std::ptr::null(), std::ptr::null(), 0, &mut buf) };
        assert_eq!(rc, 1);
        let err = unsafe { maple_last_error() };
        assert!(!err.is_null());
        let msg = unsafe { CStr::from_ptr(err).to_str().unwrap() };
        assert!(msg.contains("null"));
    }

    #[test]
    fn render_scene_linear_sized_via_ffi_caps_long_edge() {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test-fixtures/raws/test_0002.dng");
        if !path.exists() { return; }
        let raw_cstr = CString::new(path.to_str().unwrap()).unwrap();
        let mut buf = MapleSceneLinearBuffer::empty();
        let max_long_edge: u32 = 800;
        let rc = unsafe {
            maple_render_file_scene_linear_sized(
                raw_cstr.as_ptr(), std::ptr::null(), max_long_edge, 1, &mut buf,
            )
        };
        assert_eq!(rc, 0, "render rc = {}", rc);
        assert!(buf.width.max(buf.height) <= max_long_edge,
            "size cap not respected: {}x{}", buf.width, buf.height);
        assert_eq!(buf.bytes_per_pixel, 8);
        assert_eq!(buf.len_bytes as u32, buf.width * buf.height * 8);
        unsafe { maple_free_scene_linear_buffer(&mut buf) };
        assert!(buf.fp16_rgba.is_null());
    }

    #[test]
    fn sized_zero_long_edge_sets_error() {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test-fixtures/raws/test_0002.dng");
        if !path.exists() { return; }
        let raw_cstr = CString::new(path.to_str().unwrap()).unwrap();
        let mut buf = MapleSceneLinearBuffer::empty();
        let rc = unsafe {
            maple_render_file_scene_linear_sized(
                raw_cstr.as_ptr(), std::ptr::null(), 0, 1, &mut buf,
            )
        };
        assert_eq!(rc, 9);
    }

    // -----------------------------------------------------------------
    // Tile FFI entry tests (Plan deep-zoom-tile-rendering Task 2).
    // -----------------------------------------------------------------

    /// Null pointer to `maple_render_file_scene_linear_tile` returns 1
    /// (no fixture required — null check fires before any I/O).
    #[test]
    fn tile_null_arg_sets_error() {
        let mut buf = MapleSceneLinearBuffer::empty();
        let rc = unsafe {
            maple_render_file_scene_linear_tile(
                std::ptr::null(), std::ptr::null(),
                0, 0, 512, 512, 256, 256, 0, &mut buf,
            )
        };
        assert_eq!(rc, 1);
        let err = unsafe { maple_last_error() };
        assert!(!err.is_null());
        let msg = unsafe { CStr::from_ptr(err).to_str().unwrap() };
        assert!(msg.contains("null"));
    }

    /// Zero-dimensioned src/out arguments return 9. We need a non-null
    /// pointer for the path so the null check passes; the bad-geometry
    /// check fires before the path is read.
    #[test]
    fn tile_zero_dim_sets_error() {
        let dummy = CString::new("/dev/null").unwrap();
        let mut buf = MapleSceneLinearBuffer::empty();
        // src_w == 0
        let rc = unsafe {
            maple_render_file_scene_linear_tile(
                dummy.as_ptr(), std::ptr::null(),
                0, 0, 0, 512, 256, 256, 0, &mut buf,
            )
        };
        assert_eq!(rc, 9, "src_w=0 should be rc=9, got {}", rc);
        // out_h == 0
        let rc = unsafe {
            maple_render_file_scene_linear_tile(
                dummy.as_ptr(), std::ptr::null(),
                0, 0, 512, 512, 256, 0, 0, &mut buf,
            )
        };
        assert_eq!(rc, 9, "out_h=0 should be rc=9, got {}", rc);
    }

    /// Bytes-variant null pointer returns 1.
    #[test]
    fn tile_bytes_null_arg_sets_error() {
        let mut buf = MapleSceneLinearBuffer::empty();
        let ext = CString::new("dng").unwrap();
        let rc = unsafe {
            maple_render_bytes_scene_linear_tile(
                std::ptr::null(), 0, ext.as_ptr(), std::ptr::null(),
                0, 0, 512, 512, 256, 256, 0, &mut buf,
            )
        };
        assert_eq!(rc, 1);
    }

    /// File-path tile render with default model returns a 256×256 fp16
    /// RGBA buffer with alpha = 1.0 in every pixel and the documented
    /// channel/bytes-per-pixel layout. Fixture-gated.
    #[test]
    fn render_tile_default_model_via_ffi() {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test-fixtures/raws/test_0002.dng");
        if !path.exists() { return; }
        let raw_cstr = CString::new(path.to_str().unwrap()).unwrap();
        let mut buf = MapleSceneLinearBuffer::empty();
        let rc = unsafe {
            maple_render_file_scene_linear_tile(
                raw_cstr.as_ptr(), std::ptr::null(),
                1024, 1024, 512, 512, 256, 256,
                /* quality_preview = */ 0, &mut buf,
            )
        };
        assert_eq!(rc, 0, "tile render rc = {}", rc);
        assert_eq!(buf.width, 256);
        assert_eq!(buf.height, 256);
        assert_eq!(buf.channels, 4);
        assert_eq!(buf.bytes_per_pixel, 8);
        assert_eq!(buf.len_bytes as u32, buf.width * buf.height * 8);
        // Verify alpha lane is fp16 1.0 (= 0x3c00) for every pixel.
        let n_lanes = buf.len_bytes / std::mem::size_of::<u16>();
        let lanes = unsafe { std::slice::from_raw_parts(buf.fp16_rgba, n_lanes) };
        let alpha_ok = lanes.chunks_exact(4).filter(|c| c[3] == 0x3c00).count();
        assert_eq!(alpha_ok, (buf.width * buf.height) as usize,
            "all alpha lanes must be fp16 1.0");
        unsafe { maple_free_scene_linear_buffer(&mut buf) };
        assert!(buf.fp16_rgba.is_null());
    }

    /// Bytes-variant tile render with default model — same shape checks
    /// as the file-path test. Fixture-gated.
    #[test]
    fn render_tile_default_model_via_bytes_ffi() {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test-fixtures/raws/test_0002.dng");
        if !path.exists() { return; }
        let bytes = std::fs::read(&path).unwrap();
        let ext = CString::new("dng").unwrap();
        let mut buf = MapleSceneLinearBuffer::empty();
        let rc = unsafe {
            maple_render_bytes_scene_linear_tile(
                bytes.as_ptr(), bytes.len(), ext.as_ptr(), std::ptr::null(),
                1024, 1024, 512, 512, 256, 256,
                0, &mut buf,
            )
        };
        assert_eq!(rc, 0, "tile bytes render rc = {}", rc);
        assert_eq!(buf.width, 256);
        assert_eq!(buf.height, 256);
        assert_eq!(buf.channels, 4);
        assert_eq!(buf.bytes_per_pixel, 8);
        assert_eq!(buf.len_bytes as u32, buf.width * buf.height * 8);
        unsafe { maple_free_scene_linear_buffer(&mut buf) };
        assert!(buf.fp16_rgba.is_null());
    }

    /// Tile FFI rejects active dehaze with rc=10. Fixture-gated because
    /// the rejection happens after rawler decodes the RAW (the dehaze
    /// gate lives in `render_scene_linear_tile_from_raw_with_quality`).
    #[test]
    fn render_tile_dehaze_active_returns_error_code_10() {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test-fixtures/raws/test_0002.dng");
        if !path.exists() { return; }
        // Synthesize an XMP file with dehaze=50.
        let xmp_path = std::env::temp_dir().join("tile-dehaze-ffi.xmp");
        std::fs::write(
            &xmp_path,
            r#"<?xml version="1.0"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:Dehaze="50"/></rdf:RDF></x:xmpmeta>"#,
        ).unwrap();
        let raw_cstr = CString::new(path.to_str().unwrap()).unwrap();
        let xmp_cstr = CString::new(xmp_path.to_str().unwrap()).unwrap();
        let mut buf = MapleSceneLinearBuffer::empty();
        let rc = unsafe {
            maple_render_file_scene_linear_tile(
                raw_cstr.as_ptr(), xmp_cstr.as_ptr(),
                1024, 1024, 512, 512, 256, 256, 0, &mut buf,
            )
        };
        assert_eq!(rc, 10, "expected dehaze-unsupported rc=10, got {}", rc);
        unsafe { maple_free_scene_linear_buffer(&mut buf) };
        let _ = std::fs::remove_file(&xmp_path);
    }

    /// Tile FFI rejects out > src (upscale) with rc=11. Fixture-gated
    /// because the upscale gate runs inside the post-decode core call.
    #[test]
    fn render_tile_upscale_returns_error_code_11() {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test-fixtures/raws/test_0002.dng");
        if !path.exists() { return; }
        let raw_cstr = CString::new(path.to_str().unwrap()).unwrap();
        let mut buf = MapleSceneLinearBuffer::empty();
        // out_w > src_w
        let rc = unsafe {
            maple_render_file_scene_linear_tile(
                raw_cstr.as_ptr(), std::ptr::null(),
                1024, 1024, 256, 256, 512, 256, 0, &mut buf,
            )
        };
        assert_eq!(rc, 11, "out_w>src_w must rc=11, got {}", rc);
        // out_h > src_h
        let rc = unsafe {
            maple_render_file_scene_linear_tile(
                raw_cstr.as_ptr(), std::ptr::null(),
                1024, 1024, 256, 256, 256, 512, 0, &mut buf,
            )
        };
        assert_eq!(rc, 11, "out_h>src_h must rc=11, got {}", rc);
    }

    // -----------------------------------------------------------------
    // MapleRawHandle FFI tests (Plan deep-zoom-tile-rendering Task 3).
    // -----------------------------------------------------------------

    /// Null pointer to `maple_open_raw_handle` returns 1; the out
    /// pointer is initialized to null on error.
    #[test]
    fn open_raw_handle_null_arg_sets_error() {
        let mut handle: *mut MapleRawHandle = std::ptr::null_mut();
        let rc = unsafe {
            maple_open_raw_handle(std::ptr::null(), std::ptr::null(), &mut handle)
        };
        assert_eq!(rc, 1);
        assert!(handle.is_null());
        let err = unsafe { maple_last_error() };
        assert!(!err.is_null());
        let msg = unsafe { CStr::from_ptr(err).to_str().unwrap() };
        assert!(msg.contains("null"));
    }

    /// Null handle to `maple_render_handle_scene_linear_tile` returns 1.
    #[test]
    fn render_handle_null_arg_sets_error() {
        let mut buf = MapleSceneLinearBuffer::empty();
        let rc = unsafe {
            maple_render_handle_scene_linear_tile(
                std::ptr::null(), 0, 0, 512, 512, 256, 256, 0, &mut buf,
            )
        };
        assert_eq!(rc, 1);
    }

    /// `maple_close_raw_handle(null)` is a no-op (no crash).
    #[test]
    fn close_raw_handle_null_is_noop() {
        unsafe { maple_close_raw_handle(std::ptr::null_mut()) };
    }

    /// Open a handle, render a tile, close. Verifies the round-trip
    /// works end-to-end. Fixture-gated.
    #[test]
    fn raw_handle_round_trip_renders_tile() {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test-fixtures/raws/test_0002.dng");
        if !path.exists() { return; }
        let raw_cstr = CString::new(path.to_str().unwrap()).unwrap();
        let mut handle: *mut MapleRawHandle = std::ptr::null_mut();
        let rc = unsafe {
            maple_open_raw_handle(raw_cstr.as_ptr(), std::ptr::null(), &mut handle)
        };
        assert_eq!(rc, 0, "open rc = {}", rc);
        assert!(!handle.is_null());
        let mut buf = MapleSceneLinearBuffer::empty();
        let rc = unsafe {
            maple_render_handle_scene_linear_tile(
                handle, 1024, 1024, 512, 512, 256, 256, 0, &mut buf,
            )
        };
        assert_eq!(rc, 0, "render rc = {}", rc);
        assert_eq!(buf.width, 256);
        assert_eq!(buf.height, 256);
        assert_eq!(buf.channels, 4);
        assert_eq!(buf.bytes_per_pixel, 8);
        assert_eq!(buf.len_bytes as u32, buf.width * buf.height * 8);
        // Verify alpha lane is fp16 1.0 in every pixel.
        let n_lanes = buf.len_bytes / std::mem::size_of::<u16>();
        let lanes = unsafe { std::slice::from_raw_parts(buf.fp16_rgba, n_lanes) };
        let alpha_ok = lanes.chunks_exact(4).filter(|c| c[3] == 0x3c00).count();
        assert_eq!(alpha_ok, (buf.width * buf.height) as usize);
        unsafe {
            maple_free_scene_linear_buffer(&mut buf);
            maple_close_raw_handle(handle);
        }
    }

    /// Multiple tile renders against the same handle reuse the cached
    /// decoded mosaic. Sanity check on the lifecycle: open once, render
    /// 3 different tiles, close once.
    #[test]
    fn raw_handle_renders_multiple_tiles() {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test-fixtures/raws/test_0002.dng");
        if !path.exists() { return; }
        let raw_cstr = CString::new(path.to_str().unwrap()).unwrap();
        let mut handle: *mut MapleRawHandle = std::ptr::null_mut();
        let rc = unsafe {
            maple_open_raw_handle(raw_cstr.as_ptr(), std::ptr::null(), &mut handle)
        };
        assert_eq!(rc, 0);
        // Render three non-overlapping tiles.
        let coords: [(u32, u32); 3] = [(0, 0), (1024, 0), (0, 1024)];
        for (sx, sy) in coords.iter() {
            let mut buf = MapleSceneLinearBuffer::empty();
            let rc = unsafe {
                maple_render_handle_scene_linear_tile(
                    handle, *sx, *sy, 512, 512, 256, 256, 0, &mut buf,
                )
            };
            assert_eq!(rc, 0, "tile ({},{}) rc = {}", sx, sy, rc);
            assert_eq!(buf.width, 256);
            assert_eq!(buf.height, 256);
            unsafe { maple_free_scene_linear_buffer(&mut buf) };
        }
        unsafe { maple_close_raw_handle(handle) };
    }

    /// Handle opened with an XMP that sets dehaze != 0 propagates the
    /// dehaze rejection (rc=10) on tile render — the model is locked
    /// at handle-open time. Fixture-gated.
    #[test]
    fn raw_handle_with_dehaze_xmp_returns_rc10() {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test-fixtures/raws/test_0002.dng");
        if !path.exists() { return; }
        let xmp_path = std::env::temp_dir().join("handle-dehaze.xmp");
        std::fs::write(
            &xmp_path,
            r#"<?xml version="1.0"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:Dehaze="50"/></rdf:RDF></x:xmpmeta>"#,
        ).unwrap();
        let raw_cstr = CString::new(path.to_str().unwrap()).unwrap();
        let xmp_cstr = CString::new(xmp_path.to_str().unwrap()).unwrap();
        let mut handle: *mut MapleRawHandle = std::ptr::null_mut();
        let rc = unsafe {
            maple_open_raw_handle(raw_cstr.as_ptr(), xmp_cstr.as_ptr(), &mut handle)
        };
        assert_eq!(rc, 0, "open rc = {}", rc);
        let mut buf = MapleSceneLinearBuffer::empty();
        let rc = unsafe {
            maple_render_handle_scene_linear_tile(
                handle, 1024, 1024, 512, 512, 256, 256, 0, &mut buf,
            )
        };
        assert_eq!(rc, 10, "expected dehaze rc=10, got {}", rc);
        unsafe {
            maple_free_scene_linear_buffer(&mut buf);
            maple_close_raw_handle(handle);
        }
        let _ = std::fs::remove_file(&xmp_path);
    }

    /// Render handle rejects upscale (out > src) with rc=11.
    #[test]
    fn raw_handle_upscale_returns_rc11() {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test-fixtures/raws/test_0002.dng");
        if !path.exists() { return; }
        let raw_cstr = CString::new(path.to_str().unwrap()).unwrap();
        let mut handle: *mut MapleRawHandle = std::ptr::null_mut();
        let rc = unsafe {
            maple_open_raw_handle(raw_cstr.as_ptr(), std::ptr::null(), &mut handle)
        };
        assert_eq!(rc, 0);
        let mut buf = MapleSceneLinearBuffer::empty();
        let rc = unsafe {
            maple_render_handle_scene_linear_tile(
                handle, 1024, 1024, 256, 256, 512, 256, 0, &mut buf,
            )
        };
        assert_eq!(rc, 11, "out_w>src_w must rc=11, got {}", rc);
        unsafe { maple_close_raw_handle(handle) };
    }

    /// Bytes-variant open + render + close round-trip. Fixture-gated.
    #[test]
    fn raw_handle_bytes_round_trip() {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test-fixtures/raws/test_0002.dng");
        if !path.exists() { return; }
        let bytes = std::fs::read(&path).unwrap();
        let ext = CString::new("dng").unwrap();
        let mut handle: *mut MapleRawHandle = std::ptr::null_mut();
        let rc = unsafe {
            maple_open_raw_handle_bytes(
                bytes.as_ptr(), bytes.len(), ext.as_ptr(), std::ptr::null(), &mut handle,
            )
        };
        assert_eq!(rc, 0, "open_bytes rc = {}", rc);
        assert!(!handle.is_null());
        let mut buf = MapleSceneLinearBuffer::empty();
        let rc = unsafe {
            maple_render_handle_scene_linear_tile(
                handle, 1024, 1024, 512, 512, 256, 256, 0, &mut buf,
            )
        };
        assert_eq!(rc, 0);
        assert_eq!(buf.width, 256);
        assert_eq!(buf.height, 256);
        unsafe {
            maple_free_scene_linear_buffer(&mut buf);
            maple_close_raw_handle(handle);
        }
    }
}
