//! Minimum-cost seam finder using shortest-path search across the overlap
//! region.
//!
//! ## Algorithm choice
//!
//! We use **Dijkstra on a grid graph** because:
//!
//! - The seam problem on a horizontal panorama is naturally a
//!   single-source single-sink shortest-path problem (top row → bottom
//!   row of the overlap region); for that topology Dijkstra and
//!   max-flow / min-cut yield the same seam.
//! - `pathfinding::directed::dijkstra` is O((V + E) log V) — for a
//!   typical 1000×1000 overlap region, milliseconds-class.
//! - `pathfinding::edmonds_karp_sparse` (the only max-flow primitive
//!   in `pathfinding`) is O(V · E²); on a 100 MP panorama overlap
//!   that is orders of magnitude too slow. The Boykov–Kolmogorov
//!   max-flow that vision papers use ("Graphcut Textures", Kwatra
//!   et al. 2003) doesn't have a Rust port; vendoring one is the
//!   right move when we hit the topology where it matters.
//!
//! ## When max-flow would matter
//!
//! Dijkstra finds a single monotonic-in-y shortest path. That's
//! exactly the right shape for horizontal panoramas where the seam
//! runs vertically through the overlap. Max-flow / min-cut handles
//! topologies Dijkstra can't:
//! - vertical panoramas (camera held in portrait, panned vertically),
//! - panoramas where the optimal seam wraps around an object that
//!   crosses the overlap (e.g. a tree branch, a streetlight),
//! - T-junction multi-image overlaps.
//!
//! For the MVP corpus and typical handheld horizontal panoramas the
//! difference is invisible. Switching to a vendored Boykov–Kolmogorov
//! max-flow is tracked as a P2 follow-up — the trait surface here
//! (`SeamFinder`) is stable and would not change.
//!
//! ## Cost function
//!
//! At each pixel in the overlap region:
//! ```text
//!   cost(x, y) = w_grad * (|∇L_A| + |∇L_B|) + w_col * ||A(x,y) - B(x,y)||
//! ```
//! where `L = 0.2126R + 0.7152G + 0.0722B` is Rec.709 luma (used for
//! gradient detection regardless of working space, per the spec note), and
//! `||·||` is the Euclidean RGB distance between the two images at the same
//! pixel.  The seam is encouraged to follow edges (high gradient) in both
//! images and to pass through regions where the two images agree.
//!
//! ## 2-image restriction
//!
//! For the MVP only 2-image seam finding is supported.  A call with N ≠ 2
//! returns `PanoError::Seam` immediately.  N > 2 panoramas can be handled
//! by chaining pairwise seams; that is P2 work per the spec.

use bitvec::vec::BitVec;
use pathfinding::directed::dijkstra::dijkstra;

use crate::error::PanoError;
use crate::traits::SeamFinder;
use crate::types::{PanoImage, SeamMask};

/// Seam finder based on Dijkstra shortest-path in the overlap region.
#[derive(Debug, Clone, Default)]
pub struct GraphCutSeamFinder {
    /// Weight for the gradient term in the cost function.
    pub w_grad: f32,
    /// Weight for the colour-difference term.
    pub w_col: f32,
}

impl GraphCutSeamFinder {
    pub fn new() -> Self {
        Self {
            w_grad: 1.0,
            w_col: 1.0,
        }
    }

    pub fn with_weights(w_grad: f32, w_col: f32) -> Self {
        Self { w_grad, w_col }
    }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/// Rec.709 luma from a linear-light RGB triple.
#[inline]
fn luma(r: f32, g: f32, b: f32) -> f32 {
    0.2126 * r + 0.7152 * g + 0.0722 * b
}

/// Read the three channels for pixel (x, y) from a PanoImage.
#[inline]
fn get_pixel(img: &PanoImage, x: u32, y: u32) -> [f32; 3] {
    let base = ((y as usize) * (img.width as usize) + (x as usize)) * 3;
    [img.pixels[base], img.pixels[base + 1], img.pixels[base + 2]]
}

/// Finite-difference gradient magnitude of luma at (x, y).
#[inline]
fn grad_luma(img: &PanoImage, x: u32, y: u32) -> f32 {
    let w = img.width;
    let h = img.height;
    let luma_at = |px: u32, py: u32| -> f32 {
        let [r, g, b] = get_pixel(img, px, py);
        luma(r, g, b)
    };
    let x1 = if x + 1 < w { x + 1 } else { x };
    let y1 = if y + 1 < h { y + 1 } else { y };
    let gx = luma_at(x1, y) - luma_at(x, y);
    let gy = luma_at(x, y1) - luma_at(x, y);
    (gx * gx + gy * gy).sqrt()
}

/// Per-pixel seam cost in the overlap region.
fn pixel_cost(
    img_a: &PanoImage,
    img_b: &PanoImage,
    x: u32,
    y: u32,
    w_grad: f32,
    w_col: f32,
) -> f32 {
    let pa = get_pixel(img_a, x, y);
    let pb = get_pixel(img_b, x, y);

    let grad = grad_luma(img_a, x, y) + grad_luma(img_b, x, y);
    let col_diff = (pa[0] - pb[0]).powi(2) + (pa[1] - pb[1]).powi(2) + (pa[2] - pb[2]).powi(2);

    w_grad * grad + w_col * col_diff.sqrt()
}

/// Find the overlap region: bounding box of pixels valid in *both* images.
/// Returns (x_min, x_max, y_min, y_max) or None if overlap is empty.
fn overlap_bbox(a: &PanoImage, b: &PanoImage) -> Option<(u32, u32, u32, u32)> {
    assert_eq!(a.width, b.width);
    assert_eq!(a.height, b.height);
    let w = a.width;
    let h = a.height;

    let mut x_min = w;
    let mut x_max = 0u32;
    let mut y_min = h;
    let mut y_max = 0u32;

    for y in 0..h {
        for x in 0..w {
            if a.is_valid(x, y) && b.is_valid(x, y) {
                x_min = x_min.min(x);
                x_max = x_max.max(x);
                y_min = y_min.min(y);
                y_max = y_max.max(y);
            }
        }
    }

    if x_min > x_max || y_min > y_max {
        None
    } else {
        Some((x_min, x_max, y_min, y_max))
    }
}

// ---------------------------------------------------------------------------
// Seam finding: Dijkstra top-to-bottom shortest path.
//
// We model the overlap region as a grid where each node is (x, y) in the
// overlap rectangle.  Edges connect each node to its three downward
// neighbours (lower-left, below, lower-right).  The source is a virtual
// node that connects for free to every node in the top row, and the sink is
// a virtual node connected from every node in the bottom row.
//
// The resulting seam is a monotonically descending column path from the
// top to the bottom of the overlap, which divides the overlap into a
// left-of-seam region (assigned to image A) and a right-of-seam region
// (assigned to image B).
//
// Node indices: 0..=w_ov*h_ov are (col, row) in the overlap; the source is
// w_ov * h_ov and the sink is w_ov * h_ov + 1.
// ---------------------------------------------------------------------------

struct SeamPathArgs<'a> {
    img_a: &'a PanoImage,
    img_b: &'a PanoImage,
    x_min: u32,
    x_max: u32,
    y_min: u32,
    y_max: u32,
    w_grad: f32,
    w_col: f32,
}

fn find_seam_path(args: SeamPathArgs<'_>) -> Vec<u32> {
    let SeamPathArgs {
        img_a,
        img_b,
        x_min,
        x_max,
        y_min,
        y_max,
        w_grad,
        w_col,
    } = args;
    // Overlap dimensions.
    let ov_w = (x_max - x_min + 1) as usize;
    let ov_h = (y_max - y_min + 1) as usize;

    // Node encoding: row * ov_w + col (inside overlap), or special virtual
    // source/sink nodes.
    let n_grid = ov_w * ov_h;
    let source: usize = n_grid;
    let sink: usize = n_grid + 1;

    // Cost quantised to u32 (scale factor so small cost differences matter).
    let cost_scale = 1_000_000.0_f32;

    let successors = |node: &usize| -> Vec<(usize, u32)> {
        let node = *node;
        if node == source {
            // Source → top row (zero-cost edges).
            return (0..ov_w)
                .map(|col| (col, 0u32)) // row 0
                .collect();
        }
        if node == sink {
            return Vec::new(); // sink has no outgoing edges
        }

        let row = node / ov_w;
        let col = node % ov_w;

        if row + 1 == ov_h {
            // Bottom row → connect to sink.
            return vec![(sink, 0u32)];
        }

        // Down-left, down, down-right (staying in bounds).
        let next_row = row + 1;
        let mut edges = Vec::with_capacity(3);
        for dc in [-1i32, 0, 1] {
            let nc = col as i32 + dc;
            if nc < 0 || nc >= ov_w as i32 {
                continue;
            }
            let nc = nc as usize;
            let gx = x_min + nc as u32;
            let gy = y_min + next_row as u32;
            let c = if img_a.is_valid(gx, gy) && img_b.is_valid(gx, gy) {
                (pixel_cost(img_a, img_b, gx, gy, w_grad, w_col) * cost_scale) as u32
            } else {
                // Penalise leaving the valid overlap.
                10 * cost_scale as u32
            };
            edges.push((next_row * ov_w + nc, c));
        }
        edges
    };

    let result = dijkstra(&source, successors, |n| *n == sink);

    if let Some((path, _)) = result {
        // Extract the x column index in the overlap for each row.
        // path[0] = source, path[last] = sink; the interior nodes are the seam.
        let mut seam = Vec::with_capacity(ov_h);
        for &node in path.iter() {
            if node == source || node == sink {
                continue;
            }
            let col = node % ov_w;
            seam.push(col as u32);
        }
        seam
    } else {
        // Fallback: vertical seam through the centre.
        vec![(ov_w / 2) as u32; ov_h]
    }
}

// ---------------------------------------------------------------------------
// SeamFinder impl
// ---------------------------------------------------------------------------

impl SeamFinder for GraphCutSeamFinder {
    /// Find seams for exactly two warped images.
    ///
    /// Both images must have the same dimensions (they sit on a shared canvas).
    /// The returned pair of masks assigns each pixel to exactly one image.
    ///
    /// Outside the overlap region each mask mirrors the corresponding image's
    /// validity: pixels only valid in image A go to mask A (mask_a bit = 0,
    /// i.e. "use A"), and similarly for B.
    fn seams(&self, images: &[&PanoImage]) -> Result<Vec<SeamMask>, PanoError> {
        if images.len() != 2 {
            return Err(PanoError::Seam(format!(
                "MVP seam finder requires exactly 2 images, got {}",
                images.len()
            )));
        }
        let a = images[0];
        let b = images[1];
        if a.width != b.width || a.height != b.height {
            return Err(PanoError::Seam(
                "images must share the same canvas dimensions".into(),
            ));
        }

        let w = a.width;
        let h = a.height;
        let n = (w * h) as usize;

        // mask_a: bit=0 means "use image A", bit=1 means "use image B"
        // mask_b: bit=0 means "use image B", bit=1 means "use image A"
        // They are complementary in the overlap and default outside.
        let mut bits_a = BitVec::repeat(false, n); // default: everything uses A
        let mut bits_b = BitVec::repeat(false, n); // default: everything uses B

        // Outside the overlap: assign to the valid image.
        for y in 0..h {
            for x in 0..w {
                let idx = (y as usize) * (w as usize) + (x as usize);
                let va = a.is_valid(x, y);
                let vb = b.is_valid(x, y);
                match (va, vb) {
                    (true, false) => {
                        // Only A valid → mask_a uses A (bit=0), mask_b uses A (bit=1).
                        bits_a.set(idx, false);
                        bits_b.set(idx, true);
                    }
                    (false, true) => {
                        // Only B valid → mask_a uses B (bit=1), mask_b uses B (bit=0).
                        bits_a.set(idx, true);
                        bits_b.set(idx, false);
                    }
                    _ => {
                        // Both valid or both invalid — will be resolved by the seam
                        // path.  Default: A in mask_a, B in mask_b.
                        bits_a.set(idx, false);
                        bits_b.set(idx, false);
                    }
                }
            }
        }

        // Find overlap bounding box.
        if let Some((x_min, x_max, y_min, y_max)) = overlap_bbox(a, b) {
            let ov_w = (x_max - x_min + 1) as usize;
            let seam = find_seam_path(SeamPathArgs {
                img_a: a,
                img_b: b,
                x_min,
                x_max,
                y_min,
                y_max,
                w_grad: self.w_grad,
                w_col: self.w_col,
            });

            // Assign overlap pixels: left-of-seam → A, right-of-seam → B.
            for (row_i, &seam_col) in seam.iter().enumerate() {
                let gy = y_min + row_i as u32;
                for col_i in 0..ov_w {
                    let gx = x_min + col_i as u32;
                    if !a.is_valid(gx, gy) || !b.is_valid(gx, gy) {
                        continue;
                    }
                    let idx = (gy as usize) * (w as usize) + (gx as usize);
                    if col_i as u32 <= seam_col {
                        // Left of seam: use A.
                        bits_a.set(idx, false); // mask_a: use A
                        bits_b.set(idx, true); // mask_b: use A (not B)
                    } else {
                        // Right of seam: use B.
                        bits_a.set(idx, true); // mask_a: use B (not A)
                        bits_b.set(idx, false); // mask_b: use B
                    }
                }
            }
        }

        Ok(vec![
            SeamMask {
                width: w,
                height: h,
                bits: bits_a,
            },
            SeamMask {
                width: w,
                height: h,
                bits: bits_b,
            },
        ])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::color::ColorSpace;
    use crate::traits::SeamFinder;
    use crate::types::PanoImage;

    fn solid_image(w: u32, h: u32, r: f32, g: f32, b: f32) -> PanoImage {
        let mut img = PanoImage::new(w, h, ColorSpace::rec2020_d65_linear());
        for i in (0..img.pixels.len()).step_by(3) {
            img.pixels[i] = r;
            img.pixels[i + 1] = g;
            img.pixels[i + 2] = b;
        }
        img
    }

    #[test]
    fn seam_returns_error_for_n_ne_2() {
        let finder = GraphCutSeamFinder::new();
        let img = solid_image(4, 4, 0.5, 0.5, 0.5);
        let imgs = vec![&img, &img, &img];
        let result = finder.seams(&imgs);
        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), PanoError::Seam(_)));
    }

    #[test]
    fn seam_two_identical_solid_images_produces_two_masks() {
        let finder = GraphCutSeamFinder::new();
        let img = solid_image(8, 8, 0.3, 0.5, 0.7);
        let masks = finder.seams(&[&img, &img]).unwrap();
        assert_eq!(masks.len(), 2);
        assert_eq!(masks[0].width, 8);
        assert_eq!(masks[0].height, 8);
        assert_eq!(masks[1].width, 8);
        assert_eq!(masks[1].height, 8);
    }

    #[test]
    fn luma_pure_red_is_correct() {
        assert!((luma(1.0, 0.0, 0.0) - 0.2126).abs() < 1e-4);
    }

    #[test]
    fn luma_pure_green_is_correct() {
        assert!((luma(0.0, 1.0, 0.0) - 0.7152).abs() < 1e-4);
    }
}
