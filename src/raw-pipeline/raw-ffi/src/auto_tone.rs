//! Auto Tone FFI — one-shot slider recommendation for a post-WB scene-linear buffer.
//!
//! Mirrors `raw_core::stages::auto_tone::compute_auto_tone_from_rgba` across
//! the C ABI for the Apple side. The Swift wrapper lives in
//! `MapleCore/Sources/MapleCore/AutoTone.swift` (added under #A4 — Task A2
//! only ships the C surface).
//!
//! Phase 1a: only `exposure` is populated; the other five fields are
//! returned as `0.0`. The flat-struct ABI is forward-compatible with Phase
//! 1b/1c which will fill the remaining sliders in-place.

use raw_core::stages::auto_tone;

/// Maple Auto Tone result. Field order matches
/// `raw_core::stages::auto_tone::AutoTone` and the `#[wasm_bindgen]`
/// `AutoTone` struct in `raw-wasm`, so Swift and TypeScript see the same
/// schema across both FFI bridges. `#[repr(C)]` is load-bearing — cbindgen
/// emits this as a flat C struct, and Swift reads `MapleAutoTone` field
/// offsets via that layout.
#[repr(C)]
pub struct MapleAutoTone {
    pub exposure: f32,
    pub contrast: f32,
    pub whites: f32,
    pub blacks: f32,
    pub highlights: f32,
    pub shadows: f32,
}

/// Compute Auto Tone values from a post-WB scene-linear RGBA f32 buffer.
///
/// `scene_post_wb_rgba` must be tightly packed RGBA f32 — `4 * width *
/// height` floats, scene-linear Rec.2020 D65 (the working space the post-WB
/// stage emits). Alpha is ignored; the underlying core analyses only the
/// RGB triple.
///
/// Phase 1a: only `out->exposure` is meaningful. The other five fields are
/// returned as `0.0` until Phase 1b/1c expand the mapping. The flat-struct
/// ABI is forward-compatible — adding fills in-place needs no recompile on
/// the Swift side.
///
/// Returns 0 on success, -1 on null pointer or shape mismatch.
///
/// # Safety
/// - `scene_post_wb_rgba` must point to at least `4 * width * height`
///   readable `f32` values.
/// - `out` must point to a writable `MapleAutoTone`.
#[no_mangle]
pub unsafe extern "C" fn maple_compute_auto_tone(
    scene_post_wb_rgba: *const f32,
    width: u32,
    height: u32,
    out: *mut MapleAutoTone,
) -> i32 {
    if scene_post_wb_rgba.is_null() || out.is_null() {
        return -1;
    }
    let Some(pixels) = (width as usize).checked_mul(height as usize) else {
        return -1;
    };
    let Some(len) = pixels.checked_mul(4) else {
        return -1;
    };
    if pixels == 0 {
        return -1;
    }
    let slice = std::slice::from_raw_parts(scene_post_wb_rgba, len);
    let result =
        auto_tone::compute_auto_tone_from_rgba(slice, width as usize, height as usize, 0.005);
    *out = MapleAutoTone {
        exposure: result.exposure,
        contrast: result.contrast,
        whites: result.whites,
        blacks: result.blacks,
        highlights: result.highlights,
        shadows: result.shadows,
    };
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn zero_tone() -> MapleAutoTone {
        MapleAutoTone {
            exposure: -999.0,
            contrast: 0.0,
            whites: 0.0,
            blacks: 0.0,
            highlights: 0.0,
            shadows: 0.0,
        }
    }

    #[test]
    fn midgray_returns_zero_exposure() {
        let w = 64usize;
        let h = 64usize;
        let mut rgba = vec![0.18f32; w * h * 4];
        // Stamp alpha = 1.0 so the buffer looks like a real post-view RGBA.
        for i in 0..(w * h) {
            rgba[i * 4 + 3] = 1.0;
        }
        let mut out = zero_tone();
        let rc = unsafe { maple_compute_auto_tone(rgba.as_ptr(), w as u32, h as u32, &mut out) };
        assert_eq!(rc, 0);
        assert!(out.exposure.abs() < 0.05, "got {}", out.exposure);
    }

    #[test]
    fn dark_image_returns_positive_exposure() {
        let w = 32usize;
        let h = 32usize;
        let mut rgba = vec![0.045f32; w * h * 4];
        for i in 0..(w * h) {
            rgba[i * 4 + 3] = 1.0;
        }
        let mut out = zero_tone();
        let rc = unsafe { maple_compute_auto_tone(rgba.as_ptr(), w as u32, h as u32, &mut out) };
        assert_eq!(rc, 0);
        assert!((out.exposure - 2.0).abs() < 0.15, "got {}", out.exposure);
    }

    #[test]
    fn null_buffer_returns_error() {
        let mut out = zero_tone();
        let rc = unsafe { maple_compute_auto_tone(std::ptr::null(), 1, 1, &mut out) };
        assert_eq!(rc, -1);
    }

    #[test]
    fn null_out_returns_error() {
        let rgba = vec![0.18f32; 4];
        let rc =
            unsafe { maple_compute_auto_tone(rgba.as_ptr(), 1, 1, std::ptr::null_mut()) };
        assert_eq!(rc, -1);
    }

    #[test]
    fn zero_dimension_returns_error() {
        let rgba = vec![0.18f32; 4];
        let mut out = zero_tone();
        let rc = unsafe { maple_compute_auto_tone(rgba.as_ptr(), 0, 0, &mut out) };
        assert_eq!(rc, -1);
    }

    #[test]
    fn overflow_dimension_returns_error() {
        let rgba = vec![0.18f32; 4];
        let mut out = zero_tone();
        // (u32::MAX as usize) * (u32::MAX as usize) overflows pixel count
        // on 32-bit `usize` targets and pixel*4 overflows on 64-bit; either
        // way the checked-arithmetic guard returns -1.
        let rc = unsafe {
            maple_compute_auto_tone(rgba.as_ptr(), u32::MAX, u32::MAX, &mut out)
        };
        assert_eq!(rc, -1);
    }
}
