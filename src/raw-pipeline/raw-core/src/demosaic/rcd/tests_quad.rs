//! `rcd_quad_half_cancellable` (#4373) against its definition: full-frame
//! [`rcd`] followed by a 2×2 quad average, bit for bit.

use super::{rcd, rcd_quad_half_cancellable, BAND, MIN_DIM};
use crate::cancel::CancelToken;
use crate::demosaic::bilinear::bilinear;
use crate::image::{CfaPattern, ColorSpace, Image};
use std::sync::atomic::AtomicBool;

const PATTERNS: [CfaPattern; 4] = [
    CfaPattern::Rggb,
    CfaPattern::Bggr,
    CfaPattern::Grbg,
    CfaPattern::Gbrg,
];

/// Textured scene: hash noise over a diagonal edge, so every RCD step
/// (directional weights, chroma differences) sees a non-trivial input and
/// the per-channel values differ.
fn textured(w: u32, h: u32, cfa: CfaPattern) -> Image {
    let mut img = Image::new(w, h, ColorSpace::CameraNativeMosaic);
    for y in 0..h {
        for x in 0..w {
            let c = cfa.color_at(x, y) as usize;
            let hash = (x.wrapping_mul(73_856_093) ^ y.wrapping_mul(19_349_663)) % 1000;
            let edge = if x + y < (w + h) / 2 { 0.1 } else { 0.7 };
            img.pixels[(y * w + x) as usize][c] = edge + hash as f32 * 2e-4 + c as f32 * 0.03;
        }
    }
    img
}

/// The reference: the full-resolution image averaged per 2×2 quad, the odd
/// trailing row/column dropped, summed in the kernel's order.
fn quad_reference(full: &Image) -> Vec<[f32; 3]> {
    let (w, ow, oh) = (
        full.width as usize,
        full.width as usize / 2,
        full.height as usize / 2,
    );
    let mut out = Vec::with_capacity(ow * oh);
    for y in 0..oh {
        for x in 0..ow {
            let at = |dx: usize, dy: usize| full.pixels[(2 * y + dy) * w + 2 * x + dx];
            let (a, b, c, d) = (at(0, 0), at(1, 0), at(0, 1), at(1, 1));
            out.push(std::array::from_fn(|ch| {
                (a[ch] + b[ch] + c[ch] + d[ch]) * 0.25
            }));
        }
    }
    out
}

#[test]
fn quad_half_equals_full_rcd_then_quad_average_for_every_phase_and_size() {
    // Even/odd sizes, exactly one band, one band plus a row, several bands
    // with a ragged tail, and odd heights straddling a band seam.
    let band = BAND as u32;
    let sizes = [
        (64, 64),
        (65, 63),
        (97, band + 1),
        (130, 2 * band + 2),
        (51, 3 * band + 7),
        (200, 2 * band - 1),
    ];
    for cfa in PATTERNS {
        for (w, h) in sizes {
            let mosaic = textured(w, h, cfa);
            let out = rcd_quad_half_cancellable(&mosaic, cfa, CancelToken::never());
            assert_eq!((out.width, out.height), (w / 2, h / 2), "{cfa:?} {w}x{h}");
            assert_eq!(out.space, ColorSpace::CameraNativeLinearRgb);
            let expected = quad_reference(&rcd(&mosaic, cfa));
            assert!(
                out.pixels == expected,
                "{cfa:?} {w}x{h}: differs from rcd + quad average"
            );
        }
    }
}

#[test]
fn quad_half_below_the_rcd_stencil_averages_the_bilinear_reconstruction() {
    let small = MIN_DIM as u32 - 1;
    for (w, h) in [(small, 40), (40, small), (2, 2), (3, 5)] {
        let mosaic = textured(w, h, CfaPattern::Grbg);
        let out = rcd_quad_half_cancellable(&mosaic, CfaPattern::Grbg, CancelToken::never());
        assert_eq!(
            out.pixels,
            quad_reference(&bilinear(&mosaic, CfaPattern::Grbg))
        );
    }
}

#[test]
fn quad_half_of_a_degenerate_mosaic_is_empty_without_panicking() {
    for (w, h) in [(0, 0), (1, 40), (40, 1)] {
        let mosaic = Image::new(w, h, ColorSpace::CameraNativeMosaic);
        let out = rcd_quad_half_cancellable(&mosaic, CfaPattern::Rggb, CancelToken::never());
        assert_eq!((out.width, out.height), (w / 2, h / 2));
        assert!(out.pixels.is_empty());
    }
}

#[test]
fn quad_half_cancelled_before_start_leaves_every_output_row_zeroed() {
    let flag = AtomicBool::new(true);
    let mosaic = textured(320, 300, CfaPattern::Rggb);
    let out = rcd_quad_half_cancellable(&mosaic, CfaPattern::Rggb, CancelToken::new(&flag));
    assert_eq!(out.pixels.len(), 160 * 150);
    assert!(out.pixels.iter().all(|p| *p == [0.0; 3]));
}
