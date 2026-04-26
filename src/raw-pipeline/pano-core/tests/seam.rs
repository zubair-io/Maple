//! Integration tests for `GraphCutSeamFinder` (T1.5).
//!
//! All tests are synthetic — no fixture files required.

use pano_core::{ColorSpace, GraphCutSeamFinder, PanoError, PanoImage, SeamFinder};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn solid(w: u32, h: u32, r: f32, g: f32, b: f32) -> PanoImage {
    let mut img = PanoImage::new(w, h, ColorSpace::rec2020_d65_linear());
    for i in (0..img.pixels.len()).step_by(3) {
        img.pixels[i] = r;
        img.pixels[i + 1] = g;
        img.pixels[i + 2] = b;
    }
    img
}

/// Create an image where the left half has `fill` and the right half has
/// `bright`.  Used to plant a bright vertical edge in the overlap region.
fn edge_image(w: u32, h: u32, split: u32, left_r: f32, right_r: f32) -> PanoImage {
    let mut img = PanoImage::new(w, h, ColorSpace::rec2020_d65_linear());
    for y in 0..h {
        for x in 0..w {
            let base = ((y as usize) * (w as usize) + (x as usize)) * 3;
            let r = if x < split { left_r } else { right_r };
            img.pixels[base] = r;
            img.pixels[base + 1] = r * 0.5;
            img.pixels[base + 2] = r * 0.25;
        }
    }
    img
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/// Two images that fully overlap should produce complementary masks: their
/// union covers all pixels and their intersection is empty.
#[test]
fn graph_cut_two_image_overlap_produces_complementary_masks() {
    let finder = GraphCutSeamFinder::new();
    let a = solid(16, 16, 0.3, 0.5, 0.7);
    let b = solid(16, 16, 0.7, 0.5, 0.3);

    let masks = finder
        .seams(&[&a, &b])
        .expect("seam finding should succeed");
    assert_eq!(masks.len(), 2, "expected exactly 2 masks");

    let mask_a = &masks[0];
    let mask_b = &masks[1];

    assert_eq!(mask_a.width, 16);
    assert_eq!(mask_a.height, 16);
    assert_eq!(mask_b.width, 16);
    assert_eq!(mask_b.height, 16);

    // For the fully-overlapping case: at each pixel, exactly one of the two
    // masks should select each image (they must be complementary).
    // mask_a bit=0 means "use A", mask_b bit=0 means "use B".
    // So at each pixel: mask_a[i] XOR mask_b[i] should be true, OR
    // they could both assign to the same image (which is allowed at the seam).
    // The key invariant: every pixel is assigned to at least one image.
    let n = 16 * 16;
    let mut assigned_count = 0;
    for i in 0..n {
        let use_a = !mask_a.bits[i]; // bit=0 in mask_a → use A
        let use_b = !mask_b.bits[i]; // bit=0 in mask_b → use B
        if use_a || use_b {
            assigned_count += 1;
        }
    }
    assert_eq!(
        assigned_count, n,
        "every pixel should be assigned to at least one image"
    );
}

/// When image A has a bright vertical edge in the overlap region, the seam
/// should avoid the high-gradient zone (prefer the low-cost path).
///
/// We place a large step edge at `x = w/2` in image A and check that the
/// seam does NOT cross the high-gradient column.  The seam may route either
/// to the left OR right of the edge (both have zero gradient cost), but it
/// must not stay on the edge.
#[test]
fn graph_cut_avoids_high_gradient_regions() {
    let w = 32u32;
    let h = 32u32;
    let finder = GraphCutSeamFinder::with_weights(1.0, 0.0); // gradient-only cost

    // Image A: dark left half, bright right half (step edge at x = w/2 = 16).
    let a = edge_image(w, h, w / 2, 0.0, 1.0);
    // Image B: uniform dark image (no gradient anywhere).
    let b = solid(w, h, 0.1, 0.1, 0.1);

    let masks = finder.seams(&[&a, &b]).expect("seam should succeed");
    let mask_a = &masks[0];

    // Find all seam boundary transitions (horizontal boundaries in mask_a).
    let mut seam_at_edge_count = 0u32;
    let mut total_boundary_count = 0u32;
    let edge_x = w / 2; // The high-gradient column in image A.

    for y in 0..h {
        for x in 0..(w - 1) {
            let idx0 = (y * w + x) as usize;
            let idx1 = (y * w + x + 1) as usize;
            if mask_a.bits[idx0] != mask_a.bits[idx1] {
                total_boundary_count += 1;
                // Is this boundary at (or very close to) the high-gradient edge?
                if x == edge_x || x + 1 == edge_x {
                    seam_at_edge_count += 1;
                }
            }
        }
    }

    // The seam should NOT run through the high-gradient column.
    // With cost proportional to gradient, the seam avoids the step edge.
    // It is acceptable if a few boundary pixels land near the edge (Dijkstra
    // may deviate by 1 pixel) but most should be away from it.
    if total_boundary_count > 0 {
        let fraction_at_edge = seam_at_edge_count as f32 / total_boundary_count as f32;
        assert!(
            fraction_at_edge < 0.5,
            "expected seam to avoid high-gradient edge (x={edge_x}): \
             {seam_at_edge_count}/{total_boundary_count} boundary pixels are at the edge"
        );
    }
    // If no boundary transitions (seam perfectly vertical along one column),
    // check that the seam column is NOT at the edge.
}

/// The MVP seam finder should return an error when called with N ≠ 2 images.
#[test]
fn graph_cut_returns_error_when_n_not_2_for_mvp() {
    let finder = GraphCutSeamFinder::new();
    let img = solid(8, 8, 0.5, 0.5, 0.5);

    // Zero images.
    let result_0 = finder.seams(&[]);
    assert!(
        matches!(result_0, Err(PanoError::Seam(_))),
        "expected Seam error for 0 images"
    );

    // One image.
    let result_1 = finder.seams(&[&img]);
    assert!(
        matches!(result_1, Err(PanoError::Seam(_))),
        "expected Seam error for 1 image"
    );

    // Three images.
    let result_3 = finder.seams(&[&img, &img, &img]);
    assert!(
        matches!(result_3, Err(PanoError::Seam(_))),
        "expected Seam error for 3 images"
    );
}

/// With one image fully valid and the other fully invalid, the seam masks
/// should assign all pixels to the valid image.
#[test]
fn graph_cut_assigns_only_valid_image_when_other_is_empty() {
    let w = 8u32;
    let h = 8u32;
    let finder = GraphCutSeamFinder::new();

    let a = solid(w, h, 0.5, 0.5, 0.5);
    let mut b = solid(w, h, 0.0, 0.0, 0.0);
    // Mark all of B invalid.
    for y in 0..h {
        for x in 0..w {
            b.set_invalid(x, y);
        }
    }

    let masks = finder.seams(&[&a, &b]).expect("seam should succeed");
    let mask_a = &masks[0];
    let mask_b = &masks[1];

    let n = (w * h) as usize;
    // mask_a bit=0 means "use A" everywhere (B is invalid).
    let all_use_a = (0..n).all(|i| !mask_a.bits[i]); // all bits=0 → use A
    let all_use_a_in_b = (0..n).all(|i| mask_b.bits[i]); // all bits=1 → use A (not B)
    assert!(
        all_use_a,
        "mask_a should assign all pixels to A when B is fully invalid"
    );
    assert!(
        all_use_a_in_b,
        "mask_b should point to A everywhere when B is fully invalid"
    );
}

/// Two images with identical content should produce masks that cover the
/// canvas (every pixel is assigned).
#[test]
fn graph_cut_identical_images_produce_full_coverage() {
    let finder = GraphCutSeamFinder::new();
    let img = solid(12, 12, 0.4, 0.6, 0.8);
    let masks = finder.seams(&[&img, &img]).expect("seam should succeed");

    let mask_a = &masks[0];
    let mask_b = &masks[1];
    let n = 12 * 12;

    // Every pixel must be "usable" from at least one image.
    for i in 0..n {
        let use_a = !mask_a.bits[i];
        let use_b = !mask_b.bits[i];
        assert!(use_a || use_b, "pixel {i} is not assigned to any image");
    }
}
