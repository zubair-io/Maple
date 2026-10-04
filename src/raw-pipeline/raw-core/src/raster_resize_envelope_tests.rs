//! Sharp-parity envelope for `resize_raster` (#3573).
//!
//! Every expected number in this file was measured against the installed
//! sharp 0.34.5 / libvips 8.17.3 on the same synthetic source, not derived
//! from reading libvips' C++. The headline finding is upside-down: Maple
//! convolves with the requested kernel everywhere, while libvips
//! (`vips_resize`) routes around its own kernel — integer downscales stage
//! through `vips_reduce`'s truncated-int masks, and every upscale detours
//! through `vips_affine` bicubic regardless of the requested kernel. Measured
//! envelope on lanczos3:
//!
//! * integer downscale of smooth content: sharp-exact (nearest) or within
//!   a few codes (lanczos3: max 8 on a 1600px photo, max 6 on a 4x4
//!   gradient) — reduce-staging gap, tracked by #4177;
//! * fractional downscale: within 1 code (8-wide ramp 8->6);
//! * 2x upscale: up to 63 codes on photos — different algorithm
//!   (affine bicubic), tracked by #4178;
//! * nearest on a step edge: opposite side of the half-pixel boundary,
//!   tracked by #4179.
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

fn max_diff(a: &[u8], b: &[u8]) -> u8 {
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
    assert_eq!(out.data.len(), sharp.len());
    assert!(
        max_diff(&out.data, &sharp) <= 1,
        "drifted past 1 code: {:?} vs sharp {:?}",
        out.data,
        sharp
    );
}

/// `lanczos3` integer downscale 4x4 -> 2x2: within 8 codes of sharp's bytes.
/// The gap is `vips_reduce`'s truncated-int masks and 8-bit intermediate
/// clamp between the H and V passes (#4177) — Maple evaluates the kernel
/// once in f32 at the final position instead. The bound is a ratchet: a
/// reduce port should drive it toward 0, and anything past 8 is a
/// regression.
#[test]
fn lanczos3_integer_downscale_stays_within_known_envelope() {
    let mut o = opts(2, 2, ResizeFit::Fill);
    o.filter = FilterAlg::Lanczos3;
    let out = resize_raster(&smooth4(), &o).unwrap();
    let sharp = vec![40, 40, 128, 215, 40, 128, 40, 215, 128, 215, 215, 128];
    assert!(
        max_diff(&out.data, &sharp) <= 8,
        "drifted past the 8-code reduce envelope: {:?} vs sharp {:?}",
        out.data,
        sharp
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
