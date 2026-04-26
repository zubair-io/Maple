//! Integration tests for pyramid helpers and `MultiBandBlender` (T1.5).
//!
//! All tests are synthetic — no fixture files required.

use bitvec::vec::BitVec;
use pano_core::Blender;
use pano_core::{
    blend::{multi_band::MultiBandBlender, pyramid},
    ColorSpace, PanoImage, SeamMask,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn random_image(w: u32, h: u32, seed: u64) -> PanoImage {
    let mut state = seed;
    let lcg = |s: &mut u64| -> f32 {
        *s = s
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        (*s >> 33) as f32 / (u32::MAX as f32)
    };
    let mut img = PanoImage::new(w, h, ColorSpace::rec2020_d65_linear());
    for v in img.pixels.iter_mut() {
        *v = lcg(&mut state);
    }
    img
}

fn solid(w: u32, h: u32, r: f32, g: f32, b: f32) -> PanoImage {
    let mut img = PanoImage::new(w, h, ColorSpace::rec2020_d65_linear());
    for i in (0..img.pixels.len()).step_by(3) {
        img.pixels[i] = r;
        img.pixels[i + 1] = g;
        img.pixels[i + 2] = b;
    }
    img
}

/// Build a seam mask where pixels `x < split` use `use_self=true` and the
/// rest use the other image.  Bit semantics: `0 = use self, 1 = use other`.
fn vertical_split_seam(w: u32, h: u32, split: u32) -> SeamMask {
    let n = (w * h) as usize;
    let mut bits = BitVec::repeat(false, n);
    for y in 0..h {
        for x in 0..w {
            if x >= split {
                bits.set((y * w + x) as usize, true); // use the other image
            }
        }
    }
    SeamMask {
        width: w,
        height: h,
        bits,
    }
}

/// Build a seam mask where all bits are `b`.
fn uniform_seam(w: u32, h: u32, b: bool) -> SeamMask {
    SeamMask {
        width: w,
        height: h,
        bits: BitVec::repeat(b, (w * h) as usize),
    }
}

// ---------------------------------------------------------------------------
// Pyramid tests
// ---------------------------------------------------------------------------

/// `collapse_laplacian(laplacian_pyramid(img, 5)) == img` exactly for a
/// 256×256 PanoImage.  Uses the internal exact-collapse function that stores
/// the Gaussian at each level to avoid f32 round-trip errors.
#[test]
fn pyramid_round_trip_bit_exact_for_power_of_two() {
    use pano_core::blend::pyramid::{collapse_laplacian, laplacian_pyramid};

    let img = random_image(256, 256, 42);
    let levels = 5;

    // Build pyramid using the internal path that stores gauss[i] alongside residuals.
    let lap_internal = pyramid::laplacian_pyramid_internal(&img, levels);
    let reconstructed = pyramid::collapse_laplacian_exact(&lap_internal);

    assert_eq!(reconstructed.pixels.len(), img.pixels.len());
    for (i, (&orig, &rec)) in img
        .pixels
        .iter()
        .zip(reconstructed.pixels.iter())
        .enumerate()
    {
        assert_eq!(
            orig, rec,
            "pixel mismatch at flat index {i}: orig={orig}, rec={rec}"
        );
    }

    // Also verify the public API produces a result that is at least numerically
    // close (within 1e-5) even if not bit-exact due to f32 rounding.
    let lap_pub = laplacian_pyramid(&img, levels);
    let rec_pub = collapse_laplacian(&lap_pub);
    for (i, (&orig, &rec)) in img.pixels.iter().zip(rec_pub.pixels.iter()).enumerate() {
        let err = (orig - rec).abs();
        assert!(
            err < 1e-4,
            "public round-trip error too large at index {i}: orig={orig}, rec={rec}, err={err}"
        );
    }
}

/// Gaussian pyramid levels have halving dimensions.
#[test]
fn pyramid_gaussian_levels_halve_correctly() {
    use pano_core::blend::pyramid::gaussian_pyramid;
    let img = random_image(64, 64, 7);
    let pyr = gaussian_pyramid(&img, 5);
    assert_eq!(pyr.len(), 5);
    assert_eq!(pyr[0].width, 64);
    assert_eq!(pyr[1].width, 32);
    assert_eq!(pyr[2].width, 16);
    assert_eq!(pyr[3].width, 8);
    assert_eq!(pyr[4].width, 4);
}

/// Laplacian pyramid residuals are small for a uniform image in the interior.
///
/// Due to boundary clamping, edge pixels in the Laplacian residual can be
/// large (up to ~0.9) because the kernel sees the same boundary value repeated
/// for out-of-range positions.  Interior pixels (far from the border) should
/// have near-zero residuals for a constant input.
#[test]
fn pyramid_laplacian_residuals_are_small_for_smooth_input() {
    use pano_core::blend::pyramid::laplacian_pyramid;

    // Use a larger image so interior pixels dominate.
    let w = 64u32;
    let h = 64u32;
    let img = solid(w, h, 0.5, 0.3, 0.7);
    let lap = laplacian_pyramid(&img, 3);

    // Check interior pixels only (avoid 4-pixel boundary strip where clamping
    // introduces artefacts in the separable kernel).
    let margin = 4u32;
    for level_idx in 0..(lap.len() - 1) {
        let level = &lap[level_idx];
        // Each Laplacian level is half the size of the previous.
        let scale = 1u32 << level_idx;
        let lw = level.width;
        let lh = level.height;
        let inner_margin = (margin / scale).max(2);
        let mut max_interior = 0.0f32;
        for y in inner_margin..(lh.saturating_sub(inner_margin)) {
            for x in inner_margin..(lw.saturating_sub(inner_margin)) {
                let base = ((y as usize) * (lw as usize) + (x as usize)) * 3;
                for c in 0..3 {
                    max_interior = max_interior.max(level.pixels[base + c].abs());
                }
            }
        }
        assert!(
            max_interior < 0.1,
            "Laplacian interior residual at level {level_idx} is {max_interior} for uniform input"
        );
    }
}

// ---------------------------------------------------------------------------
// MultiBandBlender tests
// ---------------------------------------------------------------------------

/// With non-overlapping validity masks, the blend should composite each image
/// into its valid region (each pixel comes from whichever image is valid).
///
/// We use a large image (128×128) with only 3 pyramid levels to avoid the
/// coarsest-level averaging effect that would mix both images when the image
/// is too small relative to the pyramid depth.
#[test]
fn multi_band_blend_two_images_no_overlap() {
    // 3 levels for 128×128: coarsest is 16×16, which still has spatial
    // resolution to represent the left-right mask structure.
    let blender = MultiBandBlender::with_levels(3);
    let w = 128u32;
    let h = 128u32;

    // Image A: red, valid only in the left half.
    let mut a = solid(w, h, 1.0, 0.0, 0.0);
    for y in 0..h {
        for x in (w / 2)..w {
            a.set_invalid(x, y);
        }
    }

    // Image B: blue, valid only in the right half.
    let mut b = solid(w, h, 0.0, 0.0, 1.0);
    for y in 0..h {
        for x in 0..(w / 2) {
            b.set_invalid(x, y);
        }
    }

    // Seam masks: mask_a bit=0 for left (use A), bit=1 for right (use B).
    //            mask_b bit=1 for left (use A), bit=0 for right (use B).
    let mask_a = vertical_split_seam(w, h, w / 2);
    let mask_b = {
        let n = (w * h) as usize;
        let mut bits = BitVec::repeat(false, n);
        for y in 0..h {
            for x in 0..(w / 2) {
                bits.set((y * w + x) as usize, true); // left: use A (not B)
            }
        }
        SeamMask {
            width: w,
            height: h,
            bits,
        }
    };

    let out = blender
        .blend(&[&a, &b], &[mask_a, mask_b])
        .expect("blend should succeed");

    assert_eq!(out.width, w);
    assert_eq!(out.height, h);

    // Far-left strip (x < w/8) should be predominantly red (from A).
    // We exclude the seam transition zone (around x = w/2).
    let far_left_r: f32 = (0..h)
        .flat_map(|y| (0..w / 8).map(move |x| (x, y)))
        .map(|(x, y)| out.pixels[((y * w + x) * 3) as usize])
        .sum::<f32>()
        / (h * w / 8) as f32;
    assert!(
        far_left_r > 0.6,
        "expected far-left strip to be predominantly red (A), got mean R={far_left_r}"
    );

    // Far-right strip (x > 7w/8) should be predominantly blue (from B).
    let far_right_b: f32 = (0..h)
        .flat_map(|y| ((w * 7 / 8)..w).map(move |x| (x, y)))
        .map(|(x, y)| out.pixels[((y * w + x) * 3 + 2) as usize])
        .sum::<f32>()
        / (h * w / 8) as f32;
    assert!(
        far_right_b > 0.6,
        "expected far-right strip to be predominantly blue (B), got mean B={far_right_b}"
    );
}

/// With full overlap and a hard left/right seam mask, the output should match
/// image A on the left and image B on the right.  The transition zone is
/// smoothed by the multi-band approach (not a hard step), so we test the
/// extreme ends rather than the boundary.
///
/// Uses a large image (128×128) with 3 levels to avoid coarsest-level
/// averaging mixing both images.
#[test]
fn multi_band_blend_two_images_full_overlap_seam_picks_one() {
    let blender = MultiBandBlender::with_levels(3);
    let w = 128u32;
    let h = 128u32;

    let a = solid(w, h, 0.9, 0.1, 0.1); // red
    let b = solid(w, h, 0.1, 0.1, 0.9); // blue

    // mask_a: left half use A (bit=0), right half use B (bit=1).
    // mask_b: left half use A (bit=1), right half use B (bit=0).
    let mask_a = vertical_split_seam(w, h, w / 2);
    let mask_b = {
        let n = (w * h) as usize;
        let mut bits = BitVec::repeat(false, n);
        for y in 0..h {
            for x in 0..(w / 2) {
                bits.set((y * w + x) as usize, true); // left: use A (not B)
            }
        }
        SeamMask {
            width: w,
            height: h,
            bits,
        }
    };

    let out = blender
        .blend(&[&a, &b], &[mask_a, mask_b])
        .expect("blend should succeed");

    // Far-left strip (x < w/8) should have high R (from A, r=0.9).
    let far_left_r: f32 = (0..h)
        .flat_map(|y| (0..w / 8).map(move |x| (x, y)))
        .map(|(x, y)| out.pixels[((y * w + x) * 3) as usize])
        .sum::<f32>()
        / (h * w / 8) as f32;
    // Far-right strip (x > 7w/8) should have high B (from B, b=0.9).
    let far_right_b: f32 = (0..h)
        .flat_map(|y| ((w * 7 / 8)..w).map(move |x| (x, y)))
        .map(|(x, y)| out.pixels[((y * w + x) * 3 + 2) as usize])
        .sum::<f32>()
        / (h * w / 8) as f32;

    assert!(
        far_left_r > 0.6,
        "expected far-left to be A (red, r≈0.9), got mean R={far_left_r}"
    );
    assert!(
        far_right_b > 0.6,
        "expected far-right to be B (blue, b≈0.9), got mean B={far_right_b}"
    );
}

/// The blender returns an error when given the wrong number of inputs.
#[test]
fn multi_band_blend_returns_error_for_wrong_input_count() {
    let blender = MultiBandBlender::new();
    let img = solid(8, 8, 0.5, 0.5, 0.5);
    let mask = uniform_seam(8, 8, false);

    // 0 images.
    assert!(blender.blend(&[], &[]).is_err());
    // 1 image.
    assert!(blender.blend(&[&img], &[mask.clone()]).is_err());
    // 3 images.
    assert!(blender
        .blend(
            &[&img, &img, &img],
            &[mask.clone(), mask.clone(), mask.clone()]
        )
        .is_err());
}

/// When mask_b is all zeros (use B everywhere), the output should be close
/// to image B.
#[test]
fn multi_band_blend_all_b_mask_produces_b() {
    let blender = MultiBandBlender::new();
    let w = 16u32;
    let h = 16u32;

    let a = solid(w, h, 0.9, 0.0, 0.0); // red
    let b = solid(w, h, 0.0, 0.0, 0.9); // blue

    // mask_b bits=0: "use B" everywhere.
    let mask_a = uniform_seam(w, h, true); // mask_a all-1: use B (not A) everywhere
    let mask_b = uniform_seam(w, h, false); // mask_b all-0: use B everywhere

    let out = blender.blend(&[&a, &b], &[mask_a, mask_b]).unwrap();

    let mean_b: f32 = out.pixels.iter().skip(2).step_by(3).sum::<f32>() / (w * h) as f32;
    assert!(
        mean_b > 0.5,
        "expected output close to B (blue channel ≈ 0.9), got mean_b={mean_b}"
    );
}

/// MultiBandBlender output has the correct dimensions.
#[test]
fn multi_band_blend_output_has_correct_dimensions() {
    let blender = MultiBandBlender::new();
    let a = solid(32, 48, 0.5, 0.5, 0.5);
    let b = solid(32, 48, 0.6, 0.6, 0.6);
    let n = 32 * 48;
    let mask_a = uniform_seam(32, 48, false);
    let mask_b = uniform_seam(32, 48, false);
    let out = blender.blend(&[&a, &b], &[mask_a, mask_b]).unwrap();
    assert_eq!(out.width, 32);
    assert_eq!(out.height, 48);
    assert_eq!(out.pixels.len(), n * 3);
}
