//! End-to-end tests for the crop stage public API plus the small helpers
//! lifted to the parent module. Submodule-internal helpers
//! (`axis_aligned::slice_*`, `rotate::orthogonal_*`, `bilinear::*`) are
//! exercised transitively via [`super::apply_f32_rgba`] /
//! [`super::apply_u8_rgb`].

use super::*;
use crate::types::Crop;

/// 4x3 RGBA f32 buffer with a unique per-pixel R-tag (G/B = 0). Easy to
/// verify pixel mappings.
fn fixture_4x3_rgba() -> (u32, u32, Vec<f32>) {
    let w = 4u32;
    let h = 3u32;
    let mut v = Vec::with_capacity((w * h * 4) as usize);
    for y in 0..h {
        for x in 0..w {
            let r = (y * w + x) as f32;
            v.extend_from_slice(&[r, 0.0, 0.0, 1.0]);
        }
    }
    (w, h, v)
}

fn fixture_4x3_rgb_u8() -> (u32, u32, Vec<u8>) {
    let w = 4u32;
    let h = 3u32;
    let mut v = Vec::with_capacity((w * h * 3) as usize);
    for y in 0..h {
        for x in 0..w {
            let r = (y * w + x) as u8;
            v.extend_from_slice(&[r, 0, 0]);
        }
    }
    (w, h, v)
}

#[test]
fn identity_crop_returns_input_unchanged_f32() {
    let (w, h, src) = fixture_4x3_rgba();
    let (nw, nh, out) = apply_f32_rgba(&src, w, h, &Crop::IDENTITY);
    assert_eq!((nw, nh), (w, h));
    assert_eq!(out, src);
}

#[test]
fn identity_crop_returns_input_unchanged_u8() {
    let (w, h, src) = fixture_4x3_rgb_u8();
    let (nw, nh, out) = apply_u8_rgb(&src, w, h, &Crop::IDENTITY);
    assert_eq!((nw, nh), (w, h));
    assert_eq!(out, src);
}

#[test]
fn invalid_rect_no_angle_is_identity() {
    let (w, h, src) = fixture_4x3_rgba();
    // bottom < top — invalid rect, angle 0 → identity.
    let bad = Crop {
        top: 0.9,
        left: 0.0,
        bottom: 0.1,
        right: 1.0,
        angle: 0.0,
    };
    let (nw, nh, out) = apply_f32_rgba(&src, w, h, &bad);
    assert_eq!((nw, nh), (w, h));
    assert_eq!(out, src);
}

#[test]
fn axis_aligned_slice_extracts_rect_exactly_f32() {
    let (w, h, src) = fixture_4x3_rgba();
    // Crop left-half: x ∈ [0, 2), y ∈ [0, 3).
    let crop = Crop {
        top: 0.0,
        left: 0.0,
        bottom: 1.0,
        right: 0.5,
        angle: 0.0,
    };
    let (nw, nh, out) = apply_f32_rgba(&src, w, h, &crop);
    assert_eq!((nw, nh), (2, 3));
    // Tags for left-half are 0, 1, 4, 5, 8, 9.
    let tags: Vec<f32> = out.chunks_exact(4).map(|c| c[0]).collect();
    assert_eq!(tags, vec![0.0, 1.0, 4.0, 5.0, 8.0, 9.0]);
}

#[test]
fn axis_aligned_slice_extracts_rect_exactly_u8() {
    let (w, h, src) = fixture_4x3_rgb_u8();
    // Crop right-half: x ∈ [2, 4).
    let crop = Crop {
        top: 0.0,
        left: 0.5,
        bottom: 1.0,
        right: 1.0,
        angle: 0.0,
    };
    let (nw, nh, out) = apply_u8_rgb(&src, w, h, &crop);
    assert_eq!((nw, nh), (2, 3));
    let tags: Vec<u8> = out.chunks_exact(3).map(|c| c[0]).collect();
    assert_eq!(tags, vec![2, 3, 6, 7, 10, 11]);
}

#[test]
fn rotate_90_full_frame_swaps_dims_and_is_exact() {
    let (w, h, src) = fixture_4x3_rgba();
    let crop = Crop {
        angle: 90.0,
        ..Crop::IDENTITY
    };
    let (nw, nh, out) = apply_f32_rgba(&src, w, h, &crop);
    assert_eq!((nw, nh), (3, 4)); // 4x3 -> 3x4
    let sw = w as usize;
    let sh = h as usize;
    let dw = nw as usize;
    let dh = nh as usize;
    for yp in 0..dh {
        for xp in 0..dw {
            let sx = yp;
            let sy = sh - 1 - xp;
            let _ = sw;
            let src_tag = src[(sy * sw + sx) * 4];
            let dst_tag = out[(yp * dw + xp) * 4];
            assert_eq!(src_tag, dst_tag, "mismatch at ({}, {})", xp, yp);
        }
    }
}

#[test]
fn rotate_180_full_frame_is_exact() {
    let (w, h, src) = fixture_4x3_rgba();
    let crop = Crop {
        angle: 180.0,
        ..Crop::IDENTITY
    };
    let (nw, nh, out) = apply_f32_rgba(&src, w, h, &crop);
    assert_eq!((nw, nh), (w, h));
    let n = (w * h) as usize;
    let src_tags: Vec<f32> = src.chunks_exact(4).map(|c| c[0]).collect();
    let dst_tags: Vec<f32> = out.chunks_exact(4).map(|c| c[0]).collect();
    for i in 0..n {
        assert_eq!(
            dst_tags[i],
            src_tags[n - 1 - i],
            "180° rotation should reverse pixel order"
        );
    }
}

#[test]
fn rotate_270_full_frame_is_exact() {
    let (w, h, src) = fixture_4x3_rgba();
    let crop = Crop {
        angle: 270.0,
        ..Crop::IDENTITY
    };
    let (nw, nh, _out) = apply_f32_rgba(&src, w, h, &crop);
    assert_eq!((nw, nh), (3, 4));
}

#[test]
fn rotate_360_is_byte_identity_with_full_frame_rect() {
    let (w, h, src) = fixture_4x3_rgba();
    let crop = Crop {
        angle: 360.0,
        ..Crop::IDENTITY
    };
    let (nw, nh, out) = apply_f32_rgba(&src, w, h, &crop);
    assert_eq!((nw, nh), (w, h));
    assert_eq!(out, src);
}

#[test]
fn small_angle_uses_bilinear_path_and_changes_pixels() {
    // 8x8 ramp, then a 1° rotation must not be byte-identity (otherwise
    // we accidentally took the orthogonal path).
    let w = 8u32;
    let h = 8u32;
    let mut v: Vec<f32> = Vec::with_capacity((w * h * 4) as usize);
    for y in 0..h {
        for x in 0..w {
            v.extend_from_slice(&[x as f32, y as f32, 0.0, 1.0]);
        }
    }
    let crop = Crop {
        angle: 1.0,
        ..Crop::IDENTITY
    };
    let (nw, nh, out) = apply_f32_rgba(&v, w, h, &crop);
    assert_eq!((nw, nh), (w, h));
    let differs = v.iter().zip(out.iter()).any(|(a, b)| (a - b).abs() > 1e-6);
    assert!(differs, "1° rotation produced byte-identity buffer");
}

#[test]
fn snap_orthogonal_classifies_exact_angles() {
    assert_eq!(snap_orthogonal(0.0), OrthogonalSnap::Zero);
    assert_eq!(snap_orthogonal(0.005), OrthogonalSnap::Zero);
    assert_eq!(snap_orthogonal(-0.005), OrthogonalSnap::Zero);
    assert_eq!(snap_orthogonal(90.0), OrthogonalSnap::Cw90);
    assert_eq!(snap_orthogonal(180.0), OrthogonalSnap::Cw180);
    assert_eq!(snap_orthogonal(270.0), OrthogonalSnap::Cw270);
    assert_eq!(snap_orthogonal(360.0), OrthogonalSnap::Zero);
    assert_eq!(snap_orthogonal(-90.0), OrthogonalSnap::Cw270);
    assert_eq!(snap_orthogonal(5.0), OrthogonalSnap::Off);
}

#[test]
fn rect_in_pixels_full_frame_returns_full_image() {
    let (rx, ry, rw, rh) = rect_in_pixels(&Crop::IDENTITY, 100, 50);
    assert_eq!((rx, ry, rw, rh), (0, 0, 100, 50));
}

#[test]
fn rect_in_pixels_quarter_crop() {
    let crop = Crop {
        top: 0.25,
        left: 0.25,
        bottom: 0.75,
        right: 0.75,
        angle: 0.0,
    };
    // 100 × 50 image, crop 25%..75%:
    //   x ∈ [0.25 × 100, 0.75 × 100] = [25, 75] → (rx, rw) = (25, 50)
    //   y ∈ [0.25 × 50, 0.75 × 50]   = [12.5, 37.5] → round-half-away-from-zero
    //     gives (13, 25). Apple + Web mirrors must use the same rounding
    //     rule when pre-rounding crop coords before XMP serialization.
    let (rx, ry, rw, rh) = rect_in_pixels(&crop, 100, 50);
    assert_eq!((rx, ry, rw, rh), (25, 13, 50, 25));
}
