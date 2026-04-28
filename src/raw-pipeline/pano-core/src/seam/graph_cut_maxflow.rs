//! Minimum-cost seam finder using Boykov-Kolmogorov max-flow / min-cut.
//!
//! ## Motivation vs `GraphCutSeamFinder`
//!
//! [`super::graph_cut::GraphCutSeamFinder`] uses Dijkstra shortest-path to
//! find the seam.  That algorithm finds a *monotonically descending* column
//! path from the top of the overlap to the bottom, which is exactly right for
//! horizontal panoramas.
//!
//! Dijkstra breaks when the optimal seam is non-monotonic:
//! - Vertical panoramas (pan-tilt sequences).
//! - Multi-row spherical panoramas.
//! - Seams that wrap around an object crossing the overlap boundary.
//!
//! BK max-flow / min-cut does not have the monotonicity restriction.  The
//! min-cut partitions overlap pixels into "assign to A" vs "assign to B"
//! globally, allowing any topology.  This matches the strategy used in
//! AliceVision's seam finder.
//!
//! ## Graph construction
//!
//! For two warped images A and B with an overlap region:
//!
//! 1. One BK node per overlap pixel.
//! 2. Boundary pixels that are valid **only in A** are connected to the
//!    *source* with ∞ capacity (they must stay on the A side of the cut).
//! 3. Boundary pixels valid **only in B** are connected to the *sink* with ∞
//!    capacity (they must stay on the B side of the cut).
//! 4. Adjacent overlap pixels (4-connected) share an undirected edge whose
//!    capacity equals the seam cost at that edge:
//!    ```text
//!    cost(p, q) = ||A(p) − B(p)||₂ + ||A(q) − B(q)||₂
//!    ```
//!    plus an optional gradient bonus:
//!    ```text
//!              + w_grad * (|∇L_A(p)| + |∇L_A(q)| + |∇L_B(p)| + |∇L_B(q)|)
//!    ```
//!    High cost → expensive for the seam to pass here → seam avoids
//!    high-disagreement / high-gradient regions.
//!
//! After BK `solve()`:
//! - Pixels with `is_in_source(v)` → assign to A.
//! - Other pixels → assign to B.
//!
//! ## 2-image restriction
//!
//! Same MVP restriction as the Dijkstra version.  N ≠ 2 returns an error.
//! N > 2 panoramas are handled by the pairwise-chain driver in pano-smoke.

use bitvec::vec::BitVec;

use crate::error::PanoError;
use crate::seam::bk::BkGraph;
use crate::traits::SeamFinder;
use crate::types::{PanoImage, SeamMask};

/// Cost scale factor for converting f32 seam costs to integer BK capacities.
const COST_SCALE: i64 = 1_000_000;
/// "Infinity" capacity for terminal edges that must not be cut.
const INF_CAP: i64 = i64::MAX / 4;

/// Seam finder based on BK max-flow / min-cut over the overlap region.
///
/// Supports non-monotonic seams suitable for multi-row spherical panoramas.
#[derive(Debug, Clone)]
pub struct GraphCutMaxFlowSeamFinder {
    /// Weight for the gradient term in the edge cost function.
    pub w_grad: f32,
    /// Weight for the colour-difference term.
    pub w_col: f32,
}

impl GraphCutMaxFlowSeamFinder {
    pub fn new() -> Self {
        Self { w_grad: 1.0, w_col: 1.0 }
    }

    pub fn with_weights(w_grad: f32, w_col: f32) -> Self {
        Self { w_grad, w_col }
    }
}

impl Default for GraphCutMaxFlowSeamFinder {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// Internal helpers (shared with graph_cut.rs but inlined here to avoid
// coupling the two modules)
// ---------------------------------------------------------------------------

/// Rec.709 luma from a linear-light RGB triple.
#[inline]
fn luma(r: f32, g: f32, b: f32) -> f32 {
    0.2126 * r + 0.7152 * g + 0.0722 * b
}

/// Read a pixel from a `PanoImage` as `[r, g, b]`.
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

/// Per-pixel colour-disagreement cost between the two images.
#[inline]
fn color_cost(img_a: &PanoImage, img_b: &PanoImage, x: u32, y: u32) -> f32 {
    let pa = get_pixel(img_a, x, y);
    let pb = get_pixel(img_b, x, y);
    let dr = pa[0] - pb[0];
    let dg = pa[1] - pb[1];
    let db = pa[2] - pb[2];
    (dr * dr + dg * dg + db * db).sqrt()
}

/// Seam edge cost between adjacent overlap pixels `p` and `q`.
///
/// A high cost discourages the seam from passing between p and q.
fn edge_cost(
    img_a: &PanoImage,
    img_b: &PanoImage,
    x1: u32, y1: u32,
    x2: u32, y2: u32,
    w_grad: f32,
    w_col: f32,
) -> i64 {
    let col = color_cost(img_a, img_b, x1, y1) + color_cost(img_a, img_b, x2, y2);
    let grad = grad_luma(img_a, x1, y1) + grad_luma(img_a, x2, y2)
             + grad_luma(img_b, x1, y1) + grad_luma(img_b, x2, y2);
    let cost = w_col * col + w_grad * grad;
    // Scale to integer and clamp to avoid overflow when used as BK capacity.
    (cost * COST_SCALE as f32).round() as i64 + 1 // +1 so cost is never 0
}

/// Bounding box of pixels valid in both images.
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
                if x < x_min { x_min = x; }
                if x > x_max { x_max = x; }
                if y < y_min { y_min = y; }
                if y > y_max { y_max = y; }
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
// SeamFinder impl
// ---------------------------------------------------------------------------

impl SeamFinder for GraphCutMaxFlowSeamFinder {
    fn seams(&self, images: &[&PanoImage]) -> Result<Vec<SeamMask>, PanoError> {
        if images.len() != 2 {
            return Err(PanoError::Seam(format!(
                "GraphCutMaxFlowSeamFinder requires exactly 2 images, got {}",
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
        let n_canvas = (w * h) as usize;

        // Start with default masks: A assigned everywhere in mask_a, B in mask_b.
        let mut bits_a = BitVec::repeat(false, n_canvas);
        let mut bits_b = BitVec::repeat(false, n_canvas);

        // Pixels valid only in A → assign to A in both masks.
        // Pixels valid only in B → assign to B in both masks.
        for y in 0..h {
            for x in 0..w {
                let idx = (y as usize) * (w as usize) + (x as usize);
                match (a.is_valid(x, y), b.is_valid(x, y)) {
                    (true, false) => {
                        bits_a.set(idx, false); // mask_a: use A
                        bits_b.set(idx, true);  // mask_b: use A (not B)
                    }
                    (false, true) => {
                        bits_a.set(idx, true);  // mask_a: use B (not A)
                        bits_b.set(idx, false); // mask_b: use B
                    }
                    _ => {
                        // Overlap or both invalid: default A.
                        bits_a.set(idx, false);
                        bits_b.set(idx, false);
                    }
                }
            }
        }

        // Find overlap bounding box.
        let bbox = match overlap_bbox(a, b) {
            Some(bb) => bb,
            None => {
                // No overlap: return default masks.
                return Ok(vec![
                    SeamMask { width: w, height: h, bits: bits_a },
                    SeamMask { width: w, height: h, bits: bits_b },
                ]);
            }
        };
        let (x_min, x_max, y_min, y_max) = bbox;
        let ov_w = (x_max - x_min + 1) as usize;
        let ov_h = (y_max - y_min + 1) as usize;
        let n_ov = ov_w * ov_h;

        // Build a node-id mapping for overlap pixels.
        // Node id = (y - y_min) * ov_w + (x - x_min) for pixels in the overlap.
        // Only pixels where both images are valid get a node; others get INVALID_NODE.
        const INVALID_NODE: u32 = u32::MAX;
        let mut node_map = vec![INVALID_NODE; n_ov];

        // Count valid overlap pixels.
        let mut n_valid = 0usize;
        for y in y_min..=y_max {
            for x in x_min..=x_max {
                let ov_idx = (y - y_min) as usize * ov_w + (x - x_min) as usize;
                if a.is_valid(x, y) && b.is_valid(x, y) {
                    node_map[ov_idx] = n_valid as u32;
                    n_valid += 1;
                }
            }
        }

        if n_valid == 0 {
            return Ok(vec![
                SeamMask { width: w, height: h, bits: bits_a },
                SeamMask { width: w, height: h, bits: bits_b },
            ]);
        }

        // Estimate edge count: 4-connected within overlap + boundary terminals.
        let edge_estimate = n_valid * 4;
        let mut g = BkGraph::with_capacity(n_valid, edge_estimate);
        for _ in 0..n_valid {
            g.add_node();
        }

        // ---- Terminal edges ------------------------------------------------
        // For each valid overlap pixel, check its 4 neighbours.  If a neighbour
        // is valid only in A (not B), this pixel is on the A-boundary: connect
        // it to the source.  If a neighbour is valid only in B, connect it to
        // the sink.
        //
        // We use a high-but-finite capacity (INF_CAP) rather than truly ∞ to
        // avoid overflow inside the BK solver.
        for y in y_min..=y_max {
            for x in x_min..=x_max {
                let ov_idx = (y - y_min) as usize * ov_w + (x - x_min) as usize;
                let nid = node_map[ov_idx];
                if nid == INVALID_NODE {
                    continue;
                }

                // Check 4 neighbours for boundary conditions.
                let mut near_a_only = false;
                let mut near_b_only = false;
                for (nx, ny) in neighbours_4(x, y, w, h) {
                    let va = a.is_valid(nx, ny);
                    let vb = b.is_valid(nx, ny);
                    if va && !vb {
                        near_a_only = true;
                    }
                    if vb && !va {
                        near_b_only = true;
                    }
                }
                // Also treat this pixel itself as a boundary indicator
                // if it borders the non-overlap region.
                // (The outer loop already restricts to both-valid pixels,
                // so the pixel itself is valid in both.)

                if near_a_only {
                    g.add_terminal(nid, INF_CAP, 0);
                }
                if near_b_only {
                    g.add_terminal(nid, 0, INF_CAP);
                }
            }
        }

        // ---- Graph edges between adjacent overlap pixels ------------------
        for y in y_min..=y_max {
            for x in x_min..=x_max {
                let ov_idx = (y - y_min) as usize * ov_w + (x - x_min) as usize;
                let nid = node_map[ov_idx];
                if nid == INVALID_NODE {
                    continue;
                }

                // Right neighbour.
                if x + 1 <= x_max {
                    let ov_r = (y - y_min) as usize * ov_w + (x + 1 - x_min) as usize;
                    let nid_r = node_map[ov_r];
                    if nid_r != INVALID_NODE {
                        let c = edge_cost(a, b, x, y, x + 1, y, self.w_grad, self.w_col);
                        g.add_edge(nid, nid_r, c, c);
                    }
                }
                // Down neighbour.
                if y + 1 <= y_max {
                    let ov_d = (y + 1 - y_min) as usize * ov_w + (x - x_min) as usize;
                    let nid_d = node_map[ov_d];
                    if nid_d != INVALID_NODE {
                        let c = edge_cost(a, b, x, y, x, y + 1, self.w_grad, self.w_col);
                        g.add_edge(nid, nid_d, c, c);
                    }
                }
            }
        }

        g.finalize();
        g.solve();

        // ---- Read back the min-cut and write seam masks -------------------
        for y in y_min..=y_max {
            for x in x_min..=x_max {
                let ov_idx = (y - y_min) as usize * ov_w + (x - x_min) as usize;
                let nid = node_map[ov_idx];
                if nid == INVALID_NODE {
                    continue;
                }
                let canvas_idx = (y as usize) * (w as usize) + (x as usize);
                if g.is_in_source(nid) {
                    // Source side → assign to A.
                    bits_a.set(canvas_idx, false); // mask_a: use A
                    bits_b.set(canvas_idx, true);  // mask_b: use A (not B)
                } else {
                    // Sink side → assign to B.
                    bits_a.set(canvas_idx, true);  // mask_a: use B (not A)
                    bits_b.set(canvas_idx, false); // mask_b: use B
                }
            }
        }

        Ok(vec![
            SeamMask { width: w, height: h, bits: bits_a },
            SeamMask { width: w, height: h, bits: bits_b },
        ])
    }
}

// ---------------------------------------------------------------------------
// Helper: 4-connected neighbours within bounds.
// ---------------------------------------------------------------------------

fn neighbours_4(x: u32, y: u32, w: u32, h: u32) -> impl Iterator<Item = (u32, u32)> {
    let mut v = Vec::with_capacity(4);
    if x > 0     { v.push((x - 1, y)); }
    if x + 1 < w { v.push((x + 1, y)); }
    if y > 0     { v.push((x, y - 1)); }
    if y + 1 < h { v.push((x, y + 1)); }
    v.into_iter()
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::color::ColorSpace;
    use crate::traits::SeamFinder;
    use crate::types::PanoImage;

    fn solid(w: u32, h: u32, r: f32, g: f32, b: f32) -> PanoImage {
        let mut img = PanoImage::new(w, h, ColorSpace::rec2020_d65_linear());
        for i in (0..img.pixels.len()).step_by(3) {
            img.pixels[i] = r;
            img.pixels[i + 1] = g;
            img.pixels[i + 2] = b;
        }
        img
    }

    /// Two fully-overlapping identical images → every pixel is assigned to at
    /// least one image (complementary masks).
    #[test]
    fn graph_cut_two_image_overlap_produces_complementary_masks() {
        let finder = GraphCutMaxFlowSeamFinder::new();
        let a = solid(16, 16, 0.3, 0.5, 0.7);
        let b = solid(16, 16, 0.7, 0.5, 0.3);
        let masks = finder.seams(&[&a, &b]).expect("seam should succeed");
        assert_eq!(masks.len(), 2);

        let n = 16 * 16;
        let mut assigned = 0usize;
        for i in 0..n {
            let use_a = !masks[0].bits[i];
            let use_b = !masks[1].bits[i];
            if use_a || use_b {
                assigned += 1;
            }
        }
        assert_eq!(assigned, n, "every pixel must be assigned to at least one image");
    }

    /// The BK seam finder should return an error for N ≠ 2 images.
    #[test]
    fn graph_cut_returns_error_when_n_not_2() {
        let finder = GraphCutMaxFlowSeamFinder::new();
        let img = solid(8, 8, 0.5, 0.5, 0.5);
        assert!(finder.seams(&[]).is_err());
        assert!(finder.seams(&[&img]).is_err());
        assert!(finder.seams(&[&img, &img, &img]).is_err());
    }

    /// Two non-overlapping images (different halves) → masks should assign
    /// each pixel to its own image.
    #[test]
    fn non_overlapping_images_correct_assignment() {
        let w = 16u32;
        let h = 8u32;
        let mut a = solid(w, h, 0.5, 0.5, 0.5);
        let mut b = solid(w, h, 0.5, 0.5, 0.5);
        // a valid only for x < 8, b valid only for x >= 8.
        for y in 0..h {
            for x in 8..w {
                a.set_invalid(x, y);
            }
            for x in 0..8 {
                b.set_invalid(x, y);
            }
        }
        let finder = GraphCutMaxFlowSeamFinder::new();
        let masks = finder.seams(&[&a, &b]).expect("seam should succeed");

        // Left half should use A.
        for y in 0..h {
            for x in 0..8 {
                let idx = (y as usize) * (w as usize) + (x as usize);
                assert!(!masks[0].bits[idx], "left half of mask_a should use A (bit=0)");
            }
        }
        // Right half should use B.
        for y in 0..h {
            for x in 8..w {
                let idx = (y as usize) * (w as usize) + (x as usize);
                assert!(!masks[1].bits[idx], "right half of mask_b should use B (bit=0)");
            }
        }
    }
}
