//! Integration tests for `CpuWarper` (T1.5).
//!
//! All tests are synthetic — no fixture files required.

use nalgebra::Matrix3;
use pano_core::{Camera, ColorSpace, CpuWarper, Distortion, PanoImage, Projection, Warper};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn identity_camera(focal: f32) -> Camera {
    Camera {
        focal,
        rotation: Matrix3::identity(),
        distortion: Distortion::default(),
    }
}

/// Fill a PanoImage with a repeatable gradient pattern.
fn gradient_image(w: u32, h: u32) -> PanoImage {
    let mut img = PanoImage::new(w, h, ColorSpace::rec2020_d65_linear());
    for y in 0..h {
        for x in 0..w {
            let base = ((y as usize) * (w as usize) + (x as usize)) * 3;
            img.pixels[base] = x as f32 / w as f32;
            img.pixels[base + 1] = y as f32 / h as f32;
            img.pixels[base + 2] = 0.5;
        }
    }
    img
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/// An identity-rotation camera with Rectilinear projection should reproduce
/// the input in the central region (pixels that project within the image
/// bounds) with only small interpolation error.
#[test]
fn cpu_warper_identity_camera_returns_input() {
    let w = 32u32;
    let h = 32u32;
    // Use a focal length equal to the image width so the full FOV maps back in.
    let cam = identity_camera(w as f32);
    let img = gradient_image(w, h);
    let warper = CpuWarper::new();

    let out = warper
        .warp(&img, &cam, Projection::Rectilinear)
        .expect("warp should not fail");

    assert_eq!(out.width, w);
    assert_eq!(out.height, h);

    // Central region should be pixel-identical to the input (within bilinear
    // interpolation tolerance).
    let margin = 8u32;
    let mut max_err = 0.0_f32;
    let mut valid_count = 0u32;
    for y in margin..(h - margin) {
        for x in margin..(w - margin) {
            if !out.is_valid(x, y) {
                continue;
            }
            valid_count += 1;
            let base = ((y as usize) * (w as usize) + (x as usize)) * 3;
            let expected_r = x as f32 / w as f32;
            let expected_g = y as f32 / h as f32;
            let err = (out.pixels[base] - expected_r)
                .abs()
                .max((out.pixels[base + 1] - expected_g).abs());
            max_err = max_err.max(err);
        }
    }

    // At least some central pixels must be valid.
    assert!(valid_count > 0, "expected some valid central pixels, got 0");
    // Bilinear interpolation error should be small (< 5% of pixel range).
    assert!(
        max_err < 0.05,
        "max interpolation error {max_err} exceeded threshold in central region"
    );
}

/// A camera rotation should produce a valid output with some pixels mapping
/// outside the source image (marked invalid).  Pixels that do map into the
/// source should have plausible pixel values.
#[test]
fn cpu_warper_pure_translation_homography() {
    let w = 32u32;
    let h = 32u32;
    let img = gradient_image(w, h);

    // 30° horizontal rotation: a significant fraction of the output pixels
    // will map outside the source image.
    let angle = std::f32::consts::FRAC_PI_6; // 30°
    let cos_a = angle.cos();
    let sin_a = angle.sin();
    // Rotation around Y axis (horizontal pan).
    let r = Matrix3::new(cos_a, 0.0, sin_a, 0.0, 1.0, 0.0, -sin_a, 0.0, cos_a);
    let cam = Camera {
        focal: w as f32,
        rotation: r,
        distortion: Distortion::default(),
    };

    let warper = CpuWarper::new();
    let out = warper
        .warp(&img, &cam, Projection::Rectilinear)
        .expect("warp should not fail");

    assert_eq!(out.width, w);
    assert_eq!(out.height, h);

    // With a 30° rotation and focal = w, many output pixels map outside the
    // source image and should be invalid.
    let invalid_count = (0..h)
        .flat_map(|y| (0..w).map(move |x| (x, y)))
        .filter(|&(x, y)| !out.is_valid(x, y))
        .count();
    assert!(
        invalid_count > 0,
        "expected some invalid pixels after 30° horizontal rotation"
    );

    // Valid pixels should have plausible values (no NaN/inf, values in [0, 1]).
    for y in 0..h {
        for x in 0..w {
            if out.is_valid(x, y) {
                let base = ((y as usize) * (w as usize) + (x as usize)) * 3;
                for c in 0..3 {
                    let v = out.pixels[base + c];
                    assert!(v.is_finite(), "NaN/inf at ({x},{y}) channel {c}");
                    assert!(
                        v >= -0.1 && v <= 1.1,
                        "value {v} out of range at ({x},{y}) channel {c}"
                    );
                }
            }
        }
    }
}

/// Cylindrical warping should produce a valid output with the same dimensions
/// for a straight-ahead camera.  The output must have at least some valid
/// pixels and no NaN/inf values.
#[test]
fn cpu_warper_cylindrical_round_trip() {
    let w = 32u32;
    let h = 32u32;
    let img = gradient_image(w, h);
    let cam = identity_camera(w as f32);
    let warper = CpuWarper::new();

    let out = warper
        .warp(&img, &cam, Projection::Cylindrical)
        .expect("cylindrical warp should not fail");

    assert_eq!(out.width, w);
    assert_eq!(out.height, h);

    // Count valid pixels.
    let valid = (0..h)
        .flat_map(|y| (0..w).map(move |x| (x, y)))
        .filter(|&(x, y)| out.is_valid(x, y))
        .count();
    assert!(valid > 0, "expected some valid pixels in cylindrical warp");

    // No NaN / inf in the valid pixel data.
    for y in 0..h {
        for x in 0..w {
            if out.is_valid(x, y) {
                let base = ((y as usize) * (w as usize) + (x as usize)) * 3;
                for c in 0..3 {
                    let v = out.pixels[base + c];
                    assert!(v.is_finite(), "NaN/inf at ({x},{y}) channel {c}: {v}");
                }
            }
        }
    }
}

/// Spherical (equirectangular) warping should produce a valid output image.
#[test]
fn cpu_warper_spherical_produces_valid_output() {
    let w = 32u32;
    let h = 32u32;
    let img = gradient_image(w, h);
    let cam = identity_camera(w as f32);
    let warper = CpuWarper::new();

    let out = warper
        .warp(&img, &cam, Projection::Spherical)
        .expect("spherical warp should not fail");

    assert_eq!(out.width, w);
    assert_eq!(out.height, h);

    let valid = (0..h)
        .flat_map(|y| (0..w).map(move |x| (x, y)))
        .filter(|&(x, y)| out.is_valid(x, y))
        .count();
    assert!(valid > 0, "expected some valid pixels in spherical warp");
}

/// Pixels outside the source image boundary should be marked invalid.
#[test]
fn cpu_warper_out_of_bounds_pixels_are_invalid() {
    let w = 16u32;
    let h = 16u32;
    let img = gradient_image(w, h);

    // Rotate 45°: many pixels will map outside the source.
    let angle = std::f32::consts::FRAC_PI_4;
    let cos_a = angle.cos();
    let sin_a = angle.sin();
    let r = Matrix3::new(cos_a, -sin_a, 0.0, sin_a, cos_a, 0.0, 0.0, 0.0, 1.0);
    let cam = Camera {
        focal: w as f32 * 0.5,
        rotation: r,
        distortion: Distortion::default(),
    };

    let warper = CpuWarper::new();
    let out = warper
        .warp(&img, &cam, Projection::Rectilinear)
        .expect("warp should not fail");

    // With a 45° rotation and a small focal length, many corner pixels should
    // be invalid.
    let invalid_count = (0..h)
        .flat_map(|y| (0..w).map(move |x| (x, y)))
        .filter(|&(x, y)| !out.is_valid(x, y))
        .count();
    assert!(
        invalid_count > 0,
        "expected some invalid pixels after large rotation"
    );
}
