//! Tests for the `maple_compute_auto_tone` FFI entry. Pure-math tests —
//! no fixtures needed, so they always run in CI.

use crate::auto_tone::{maple_compute_auto_tone, MapleAutoTone};

fn sentinel() -> MapleAutoTone {
    MapleAutoTone {
        exposure: -999.0,
        contrast: -999.0,
        whites: -999.0,
        blacks: -999.0,
        highlights: -999.0,
        shadows: -999.0,
    }
}

#[test]
fn auto_tone_midgray_returns_zero_exposure() {
    let w = 64usize;
    let h = 64usize;
    let mut rgba = vec![0.0f32; w * h * 4];
    for px in rgba.chunks_exact_mut(4) {
        px[0] = 0.18;
        px[1] = 0.18;
        px[2] = 0.18;
        px[3] = 1.0;
    }
    let mut out = sentinel();
    let rc = unsafe { maple_compute_auto_tone(rgba.as_ptr(), w as u32, h as u32, &mut out) };
    assert_eq!(rc, 0);
    assert!(out.exposure.abs() < 0.05, "got {}", out.exposure);
    // Phase 1a contract: all other fields are slider rest position.
    assert_eq!(out.contrast, 0.0);
    assert_eq!(out.whites, 0.0);
    assert_eq!(out.blacks, 0.0);
    assert_eq!(out.highlights, 0.0);
    assert_eq!(out.shadows, 0.0);
}

#[test]
fn auto_tone_dark_image_recommends_positive_exposure() {
    let w = 64usize;
    let h = 64usize;
    let mut rgba = vec![0.0f32; w * h * 4];
    for px in rgba.chunks_exact_mut(4) {
        // 0.045 = 0.18 / 4 → 2 stops under midgray.
        px[0] = 0.045;
        px[1] = 0.045;
        px[2] = 0.045;
        px[3] = 1.0;
    }
    let mut out = sentinel();
    let rc = unsafe { maple_compute_auto_tone(rgba.as_ptr(), w as u32, h as u32, &mut out) };
    assert_eq!(rc, 0);
    assert!(
        (out.exposure - 2.0).abs() < 0.15,
        "expected ~+2 stops, got {}",
        out.exposure,
    );
}

#[test]
fn auto_tone_null_buffer_returns_error() {
    let mut out = sentinel();
    let rc = unsafe { maple_compute_auto_tone(std::ptr::null(), 1, 1, &mut out) };
    assert_eq!(rc, -1);
    // `out` is untouched on the error path.
    assert_eq!(out.exposure, -999.0);
}

#[test]
fn auto_tone_null_out_returns_error() {
    let rgba = vec![0.18f32; 4];
    let rc = unsafe { maple_compute_auto_tone(rgba.as_ptr(), 1, 1, std::ptr::null_mut()) };
    assert_eq!(rc, -1);
}

#[test]
fn auto_tone_overflow_returns_error() {
    // width * height overflows usize on 32-bit (vacuous on 64-bit, but
    // `width * height * 4` still overflows above 2^30 pixels).
    let rgba = vec![0.18f32; 4];
    let rc = unsafe { maple_compute_auto_tone(rgba.as_ptr(), u32::MAX, u32::MAX, &mut sentinel()) };
    assert_eq!(rc, -1);
}
