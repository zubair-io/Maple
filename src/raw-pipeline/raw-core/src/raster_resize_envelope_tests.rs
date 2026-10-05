//! Sharp-parity envelope for `resize_raster` (#3573).
//!
//! Every downscale expectation in this file was measured against the
//! installed sharp 0.34.5 / libvips 8.17.3 on the same synthetic source,
//! not derived from reading libvips' C++. (The upscale test instead pins
//! Maple's own convolution bytes as change detection — sharp's upscale is
//! affine bicubic regardless of the requested kernel, #4178, so there is
//! no sharp target to pin there.) The headline finding is upside-down: Maple
//! convolves with the requested kernel everywhere, while libvips
//! (`vips_resize`) routes around its own kernel — integer downscales stage
//! through `vips_reduce`'s truncated-int masks, and every upscale detours
//! through `vips_affine` bicubic regardless of the requested kernel. Measured
//! envelope on lanczos3:
//!
//! * integer downscale of smooth content: byte-exact match to sharp/libvips
//!   across both nearest and convolution kernels (lanczos3, bilinear, etc.)
//!   via ported `vips_reduce` staging (#4177);
//! * fractional downscale: within 1 code (8-wide ramp 8->6);
//! * 2x upscale: up to 63 codes on photos — different algorithm
//!   (affine bicubic), tracked by #4178;
//! * nearest: byte-exact on every downscale swept (2..16px, steps and
//!   ramps included — the #4179 step-edge repro does not reproduce) and on
//!   integer upscales; fractional upscales diverge by whole texels (affine
//!   routing, #4178) and heavy downscales by the first texel (subsample
//!   staging, #4213).
//!
//! A nested module of `raster_resize_tests` so it reuses that module's
//! `opts()` fixture while both files stay inside the repo's file-size
//! budget.

use super::*;

/// 4x4 RGB gradient: R steps across, G steps down, B flat 128.
fn smooth4() -> RasterImage {
    let mut data = Vec::with_capacity(4 * 4 * 3);
    for y in 0..4u8 {
        for x in 0..4u8 {
            data.extend_from_slice(&[x * 85, y * 85, 128]);
        }
    }
    RasterImage::new_rgb(4, 4, data)
}

/// 16x16 RGB gradient: R steps across, G steps down, B flat 128.
fn smooth16() -> RasterImage {
    let mut data = Vec::with_capacity(16 * 16 * 3);
    for y in 0..16u8 {
        for x in 0..16u8 {
            data.extend_from_slice(&[x * 17, y * 17, 128]);
        }
    }
    RasterImage::new_rgb(16, 16, data)
}

/// 16x16 RGBA gradient: R steps across, G steps down, B flat 128, A ramp.
fn smooth16_rgba() -> RasterImage {
    let mut data = Vec::with_capacity(16 * 16 * 4);
    for y in 0..16u8 {
        for x in 0..16u8 {
            let a = ((x as u16 + y as u16) * 8 + 30).min(255) as u8;
            data.extend_from_slice(&[x * 17, y * 17, 128, a]);
        }
    }
    RasterImage::new_rgba(16, 16, data)
}

fn max_diff(a: &[u8], b: &[u8]) -> u8 {
    assert_eq!(
        a.len(),
        b.len(),
        "length mismatch hides dropped bytes behind zip truncation"
    );
    a.iter()
        .zip(b.iter())
        .map(|(&x, &y)| x.abs_diff(y))
        .max()
        .unwrap()
}

/// `nearest` 4x4 -> 2x2 answers sharp's bytes exactly. Smooth content has no
/// half-pixel tie-break, so the sampling phase both agree on shows here;
/// the step-edge phase gap is #4179's scope, not this test's.
#[test]
fn nearest_integer_downscale_matches_sharp_byte_for_byte() {
    let out = resize_raster(&smooth4(), &opts(2, 2, ResizeFit::Fill)).unwrap();
    assert_eq!(
        out.data,
        vec![85, 85, 128, 255, 85, 128, 85, 255, 128, 255, 255, 128]
    );
}

/// `lanczos3` fractional downscale 8 -> 6 on a grey ramp: within 1 code of
/// sharp. The fractional path runs the general interpolator on both sides,
/// so no reduce-staging gap applies.
#[test]
fn lanczos3_fractional_downscale_stays_within_one_code() {
    let ramp = [0u8, 36, 73, 109, 146, 182, 219, 255]
        .iter()
        .flat_map(|&v| [v, v, v])
        .collect();
    let src = RasterImage::new_rgb(8, 1, ramp);
    let mut o = opts(6, 1, ResizeFit::Fill);
    o.filter = FilterAlg::Lanczos3;
    let out = resize_raster(&src, &o).unwrap();
    let sharp = [6u8, 55, 103, 152, 200, 249]
        .iter()
        .flat_map(|&v| [v, v, v])
        .collect::<Vec<_>>();
    assert!(
        max_diff(&out.data, &sharp) <= 1,
        "drifted past 1 code: {:?} vs sharp {:?}",
        out.data,
        sharp
    );
}

/// `lanczos3` integer downscale 4x4 -> 2x2: matches sharp byte-for-byte.
/// The reduce staging (#4177) reproduces libvips' `vips_reduce` integer
/// shrink, truncated 12-bit masks and 8-bit intermediate clamping.
#[test]
fn lanczos3_integer_downscale_matches_sharp_byte_for_byte() {
    let mut o = opts(2, 2, ResizeFit::Fill);
    o.filter = FilterAlg::Lanczos3;
    let out = resize_raster(&smooth4(), &o).unwrap();
    let sharp = vec![40, 40, 128, 215, 40, 128, 40, 215, 128, 215, 215, 128];
    assert_eq!(
        out.data, sharp,
        "lanczos3 integer downscale matches sharp byte-for-byte"
    );
}

/// `lanczos3` 16x16 -> 4x4 integer downscale: exercises `box_stage` (`int_shrink = 2`)
/// followed by residual kernel reduction, matching sharp byte-for-byte.
#[test]
fn lanczos3_integer_box_stage_downscale_matches_sharp_byte_for_byte() {
    let mut o = opts(4, 4, ResizeFit::Fill);
    o.filter = FilterAlg::Lanczos3;
    let out = resize_raster(&smooth16(), &o).unwrap();
    let sharp = vec![
        25, 25, 128, 94, 25, 128, 162, 25, 128, 231, 25, 128, 25, 94, 128, 94, 94, 128, 162, 94,
        128, 231, 94, 128, 25, 162, 128, 94, 162, 128, 162, 162, 128, 231, 162, 128, 25, 231, 128,
        94, 231, 128, 162, 231, 128, 231, 231, 128,
    ];
    assert_eq!(
        out.data, sharp,
        "lanczos3 box-stage downscale matches sharp byte-for-byte"
    );
}

/// `bilinear` 16x16 -> 4x4 integer downscale: verifies non-lanczos3 kernels
/// route through `vips_reduce` and match sharp byte-for-byte.
#[test]
fn bilinear_integer_downscale_matches_sharp_byte_for_byte() {
    let mut o = opts(4, 4, ResizeFit::Fill);
    o.filter = FilterAlg::Bilinear;
    let out = resize_raster(&smooth16(), &o).unwrap();
    let sharp = vec![
        30, 30, 128, 94, 30, 128, 162, 30, 128, 226, 30, 128, 30, 94, 128, 94, 94, 128, 162, 94,
        128, 226, 94, 128, 30, 162, 128, 94, 162, 128, 162, 162, 128, 226, 162, 128, 30, 226, 128,
        94, 226, 128, 162, 226, 128, 226, 226, 128,
    ];
    assert_eq!(
        out.data, sharp,
        "bilinear integer downscale matches sharp byte-for-byte"
    );
}

/// `lanczos3` 2x2 -> 4x4 pins Maple's own convolution bytes. Sharp answers
/// something up to 63 codes away on photos because its upscale path is
/// affine bicubic, not the requested kernel (#4178) — so this test pins
/// current behaviour as change detection, not parity. A deliberate
/// upscale re-route will intentionally change these bytes.
#[test]
fn lanczos3_upscale_pins_convolution_bytes() {
    let src = RasterImage::new_rgb(2, 2, vec![0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255]);
    let mut o = opts(4, 4, ResizeFit::Fill);
    o.filter = FilterAlg::Lanczos3;
    let out = resize_raster(&src, &o).unwrap();
    assert_eq!(
        out.data,
        vec![
            0, 0, 0, 59, 0, 0, 196, 0, 0, 255, 0, 0, 0, 69, 0, 46, 45, 14, 150, 14, 45, 230, 0, 69,
            0, 230, 0, 14, 150, 46, 45, 46, 150, 69, 0, 230, 0, 255, 0, 0, 196, 59, 0, 59, 196, 0,
            0, 255,
        ]
    );
}

/// `nearest` 8x8 half-black/half-white step -> 4x4 answers sharp's bytes
/// exactly. This is the #4179 repro, and it does not reproduce: both sides
/// sample source texels {1, 3, 5, 7} (floor of the center-mapped
/// coordinate), so the boundary column agrees. Pinned so a future
/// subsample-staging port (#4213) keeps this case green.
#[test]
fn nearest_step_edge_matches_sharp_byte_for_byte() {
    let dark = [0u8, 0, 0];
    let lite = [255u8, 255, 255];
    let row: Vec<u8> = (0..8)
        .flat_map(|x| if x < 4 { dark } else { lite })
        .collect();
    let src = RasterImage::new_rgb(8, 8, row.repeat(8));
    let out = resize_raster(&src, &opts(4, 4, ResizeFit::Fill)).unwrap();
    let out_row = vec![0, 0, 0, 0, 0, 0, 255, 255, 255, 255, 255, 255];
    assert_eq!(out.data, out_row.repeat(4));
}

/// `nearest` 4x4 -> 6x6 pins Maple's own sampling bytes. Sharp answers up
/// to a full texel away (85 codes here) because fractional upscales run
/// through `vips_affine`'s corner-based mapping, not center sampling
/// (#4178) — so this test pins current behaviour as change detection, not
/// parity. An affine-routing port will intentionally change these bytes.
#[test]
fn nearest_fractional_upscale_pins_maple_bytes() {
    let out = resize_raster(&smooth4(), &opts(6, 6, ResizeFit::Fill)).unwrap();
    assert_eq!(
        out.data,
        vec![
            0, 0, 128, 85, 0, 128, 85, 0, 128, 170, 0, 128, 255, 0, 128, 255, 0, 128, 0, 85, 128,
            85, 85, 128, 85, 85, 128, 170, 85, 128, 255, 85, 128, 255, 85, 128, 0, 85, 128, 85, 85,
            128, 85, 85, 128, 170, 85, 128, 255, 85, 128, 255, 85, 128, 0, 170, 128, 85, 170, 128,
            85, 170, 128, 170, 170, 128, 255, 170, 128, 255, 170, 128, 0, 170, 128, 85, 170, 128,
            85, 170, 128, 170, 170, 128, 255, 170, 128, 255, 170, 128, 0, 255, 128, 85, 255, 128,
            85, 255, 128, 170, 255, 128, 255, 255, 128, 255, 255, 128,
        ]
    );
}

/// `nearest` 13 -> 2 on a grey index row matches sharp byte-for-byte.
/// Heavy downscales stage through `vips_subsample` plus a residual reduce,
/// sampling source texels {0, 9} (#4213).
#[test]
fn nearest_heavy_downscale_matches_sharp_byte_for_byte() {
    let row: Vec<u8> = (0..13u16)
        .flat_map(|x| [(x * 21).min(255) as u8; 3])
        .collect();
    let src = RasterImage::new_rgb(13, 1, row);
    let out = resize_raster(&src, &opts(2, 1, ResizeFit::Fill)).unwrap();
    assert_eq!(out.data, vec![0, 0, 0, 189, 189, 189]);

    // 9 -> 2 stages through subsample factor 2, sampling texels {0, 6}.
    let row9: Vec<u8> = (0..9u16)
        .flat_map(|x| [(x * 21).min(255) as u8; 3])
        .collect();
    let src9 = RasterImage::new_rgb(9, 1, row9);
    let out9 = resize_raster(&src9, &opts(2, 1, ResizeFit::Fill)).unwrap();
    assert_eq!(out9.data, vec![0, 0, 0, 126, 126, 126]);

    // 14 -> 2 stages through subsample factor 3, sampling texels {0, 9}.
    let row14: Vec<u8> = (0..14u16)
        .flat_map(|x| [(x * 21).min(255) as u8; 3])
        .collect();
    let src14 = RasterImage::new_rgb(14, 1, row14);
    let out14 = resize_raster(&src14, &opts(2, 1, ResizeFit::Fill)).unwrap();
    assert_eq!(out14.data, vec![0, 0, 0, 189, 189, 189]);

    // 10 -> 2 stages through subsample factor 2, sampling texels {2, 6}.
    let row10: Vec<u8> = (0..10u16)
        .flat_map(|x| [(x * 21).min(255) as u8; 3])
        .collect();
    let src10 = RasterImage::new_rgb(10, 1, row10);
    let out10 = resize_raster(&src10, &opts(2, 1, ResizeFit::Fill)).unwrap();
    assert_eq!(out10.data, vec![42, 42, 42, 126, 126, 126]);
}

/// `lanczos3` 16x16 RGBA -> 4x4 integer downscale: with flat alpha (255),
/// premultiply and divide passes are exact identities, matching sharp's
/// 4-channel downscale byte-for-byte.
#[test]
fn lanczos3_rgba_flat_alpha_matches_sharp_byte_for_byte() {
    let mut data = Vec::with_capacity(16 * 16 * 4);
    for y in 0..16u8 {
        for x in 0..16u8 {
            data.extend_from_slice(&[x * 17, y * 17, 128, 255]);
        }
    }
    let src = RasterImage::new_rgba(16, 16, data);
    let mut o = opts(4, 4, ResizeFit::Fill);
    o.filter = FilterAlg::Lanczos3;
    let out = resize_raster(&src, &o).unwrap();
    let sharp = vec![
        25, 25, 128, 255, 94, 25, 128, 255, 162, 25, 128, 255, 231, 25, 128, 255, 25, 94, 128, 255,
        94, 94, 128, 255, 162, 94, 128, 255, 231, 94, 128, 255, 25, 162, 128, 255, 94, 162, 128,
        255, 162, 162, 128, 255, 231, 162, 128, 255, 25, 231, 128, 255, 94, 231, 128, 255, 162,
        231, 128, 255, 231, 231, 128, 255,
    ];
    assert_eq!(
        out.data, sharp,
        "lanczos3 flat-alpha RGBA downscale matches sharp byte-for-byte"
    );
}

/// `lanczos3` 16x16 RGBA -> 4x4 integer downscale with varying alpha:
/// pins Maple's integer `fast_image_resize` premultiply/divide passes and
/// stays within 4 codes of sharp's float-based premultiply downscale.
#[test]
fn lanczos3_rgba_varying_alpha_pins_maple_bytes_and_bounds_sharp_diff() {
    let mut o = opts(4, 4, ResizeFit::Fill);
    o.filter = FilterAlg::Lanczos3;
    let out = resize_raster(&smooth16_rgba(), &o).unwrap();
    let sharp = vec![
        28, 28, 127, 54, 91, 26, 127, 86, 159, 25, 127, 118, 231, 25, 127, 150, 26, 94, 127, 86,
        92, 92, 127, 118, 161, 93, 127, 150, 231, 93, 127, 182, 25, 162, 127, 118, 93, 161, 127,
        150, 161, 161, 127, 182, 231, 161, 126, 215, 25, 231, 127, 150, 93, 231, 127, 182, 162,
        232, 127, 214, 231, 231, 128, 245,
    ];
    assert!(
        max_diff(&out.data, &sharp) <= 4,
        "premultiply rounding drifted past 4 codes vs sharp"
    );
    assert_eq!(
        out.data,
        vec![
            28, 28, 128, 54, 95, 27, 127, 86, 162, 28, 127, 118, 231, 25, 127, 150, 27, 95, 127,
            86, 93, 95, 127, 118, 161, 93, 127, 150, 233, 94, 128, 182, 26, 162, 127, 118, 93, 163,
            127, 150, 161, 163, 128, 182, 232, 162, 127, 215, 25, 233, 127, 150, 94, 231, 128, 182,
            162, 232, 127, 214, 231, 231, 128, 245,
        ]
    );
}

/// A short data buffer returns `Error::Decode` instead of panicking on index.
#[test]
fn malformed_buffer_length_returns_decode_error() {
    let bad = RasterImage::new_rgb(16, 16, vec![0u8; 10]); // expected 16 * 16 * 3 = 768
    let err = resize_raster(&bad, &opts(4, 4, ResizeFit::Fill)).unwrap_err();
    assert!(
        matches!(err, Error::Decode { .. }),
        "expected Error::Decode, got {err:?}"
    );
}
