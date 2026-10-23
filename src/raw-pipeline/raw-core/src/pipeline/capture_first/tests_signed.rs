//! The capture basis has no soft floor (#5213 amendment 2), so retouch, the
//! chroma prefilter, BM3D and capture sharpening now see signed and
//! out-of-gamut Rec.2020. These pin that each stays finite there and keeps
//! the properties it already promised on non-negative input.

use crate::cancel::CancelToken;
use crate::image::{ColorSpace, Image};
use crate::stages::{bm3d, capture_sharpening, chroma_prefilter, retouch};
use crate::types::local_adjustment::Point2;
use crate::types::{RetouchKind, RetouchSpot};

const SIDE: u32 = 48;

/// Signed, out-of-gamut content: negative channels, negative-luma pixels and
/// values well past 1.0, on a deterministic pseudo-random texture.
fn signed_field() -> Image {
    let mut img = Image::new(SIDE, SIDE, ColorSpace::SceneLinearRec2020);
    let mut state = 0x2545_f491_u32;
    for p in &mut img.pixels {
        for c in p.iter_mut() {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            *c = (state as f32 / u32::MAX as f32) * 3.4 - 0.4;
        }
    }
    img.pixels[0] = [-0.3, -0.02, 0.1];
    img.pixels[1] = [0.05, -0.08, -0.2];
    img
}

fn uniform(color: [f32; 3]) -> Image {
    let mut img = Image::new(SIDE, SIDE, ColorSpace::SceneLinearRec2020);
    img.pixels.fill(color);
    img
}

fn spots() -> Vec<RetouchSpot> {
    [RetouchKind::Heal, RetouchKind::Clone]
        .into_iter()
        .enumerate()
        .map(|(i, kind)| RetouchSpot {
            kind,
            center: Point2::new(0.3 + 0.4 * i as f32, 0.35),
            source: Point2::new(0.3 + 0.4 * i as f32, 0.7),
            radius: 0.12,
            feather: 0.3,
            opacity: 1.0,
        })
        .collect()
}

fn sharpening() -> capture_sharpening::CaptureSharpeningParams {
    capture_sharpening::CaptureSharpeningParams {
        sigma: 1.2,
        strength: 1.0,
        ..capture_sharpening::CaptureSharpeningParams::default()
    }
}

fn run_each_stage(img: &Image) -> [(&'static str, Image); 4] {
    let mut retouched = img.clone();
    retouch::apply_cancellable(&mut retouched, &spots(), CancelToken::never()).unwrap();
    let mut prefiltered = img.clone();
    chroma_prefilter::apply(&mut prefiltered, 100.0);
    let mut denoised = img.clone();
    bm3d::apply_cancellable(&mut denoised, 100.0, CancelToken::never(), None);
    let mut sharpened = img.clone();
    capture_sharpening::apply_capture_sharpening(&mut sharpened, &sharpening());
    [
        ("retouch", retouched),
        ("chroma_prefilter", prefiltered),
        ("bm3d", denoised),
        ("capture_sharpening", sharpened),
    ]
}

#[test]
fn every_capture_stage_stays_finite_on_signed_out_of_gamut_input() {
    let input = signed_field();
    for (name, out) in run_each_stage(&input) {
        assert!(
            out.pixels.iter().flatten().all(|v| v.is_finite()),
            "{name} produced a non-finite value"
        );
        let peak = out
            .pixels
            .iter()
            .flatten()
            .fold(0.0f32, |m, v| m.max(v.abs()));
        assert!(peak < 20.0, "{name} blew a signed input up to {peak}");
    }
}

#[test]
fn a_uniform_out_of_gamut_field_is_a_fixed_point_of_every_capture_stage() {
    let color = [-0.05, 0.3, 1.8];
    let input = uniform(color);
    for (name, out) in run_each_stage(&input) {
        for p in &out.pixels {
            for c in 0..3 {
                assert!(
                    (p[c] - color[c]).abs() <= 1e-5 * color[c].abs().max(1.0),
                    "{name} moved a uniform signed field: {p:?}"
                );
            }
        }
    }
}

#[test]
fn chroma_prefilter_range_weight_survives_a_zero_luma_level() {
    // Two neighbours at luma exactly -PEDESTAL put the old range scale
    // `0.5 * (yc + yt) + PEDESTAL` at 0, and the weight at 0 / 0.
    let mut img = uniform([0.0, 0.0, 0.0]);
    let y = -0.01_f32;
    for p in &mut img.pixels {
        *p = [y, y, y];
    }
    img.pixels[5] = [0.2, -0.04, 0.1];
    chroma_prefilter::apply(&mut img, 100.0);
    assert!(img.pixels.iter().flatten().all(|v| v.is_finite()));
}

#[test]
fn chroma_prefilter_keeps_luma_and_only_desaturates_signed_chroma() {
    let input = signed_field();
    let mut out = input.clone();
    chroma_prefilter::apply(&mut out, 100.0);
    let luma = |p: [f32; 3]| 0.2627 * p[0] + 0.6780 * p[1] + 0.0593 * p[2];
    for (p, q) in input.pixels.iter().zip(&out.pixels) {
        assert!((luma(*p) - luma(*q)).abs() < 1e-4, "{p:?} -> {q:?}");
        let chroma = |v: [f32; 3]| (v[0] - luma(v)).hypot(v[2] - luma(v));
        assert!(
            chroma(*q) <= chroma(*p) * (1.0 + 1e-4) + 1e-6,
            "{p:?} -> {q:?}"
        );
    }
}

#[test]
fn a_clone_spot_carries_signed_source_values_unchanged() {
    let input = signed_field();
    let clone = RetouchSpot {
        kind: RetouchKind::Clone,
        center: Point2::new(0.25, 0.25),
        source: Point2::new(0.75, 0.75),
        radius: 0.1,
        feather: 0.0,
        opacity: 1.0,
    };
    let mut out = input.clone();
    retouch::apply_cancellable(&mut out, &[clone], CancelToken::never()).unwrap();
    // Spots address pixel `round(v * (side - 1))`.
    let pixel = |v: f32| (v * (SIDE - 1) as f32).round() as u32;
    let at = |v: f32| (pixel(v) * SIDE + pixel(v)) as usize;
    assert_eq!(out.pixels[at(0.25)], input.pixels[at(0.75)]);
}

#[test]
fn capture_sharpening_leaves_negative_luma_pixels_alone() {
    let input = signed_field();
    let mut out = input.clone();
    capture_sharpening::apply_capture_sharpening(&mut out, &sharpening());
    assert_eq!(out.pixels[0], input.pixels[0]);
    assert_eq!(out.pixels[1], input.pixels[1]);
}

#[test]
fn bm3d_noise_level_ignores_a_negative_median() {
    let mut dark = signed_field();
    for p in &mut dark.pixels {
        *p = p.map(|v| v * 0.02 - 0.03);
    }
    let mut out = dark.clone();
    bm3d::apply_cancellable(&mut out, 100.0, CancelToken::never(), None);
    assert!(out.pixels.iter().flatten().all(|v| v.is_finite()));
    let moved = out.pixels.iter().zip(&dark.pixels).any(|(p, q)| p != q);
    assert!(moved, "a negative median switched BM3D off");
}
