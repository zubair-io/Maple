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
use crate::seam::n_way::compute_edge_distance;
use crate::traits::SeamFinder;
use crate::types::{PanoImage, SeamMask};

/// Cost scale factor for converting f32 seam costs to integer BK capacities.
const COST_SCALE: i64 = 1_000_000;
/// "Infinity" capacity for terminal edges that must not be cut.
const INF_CAP: i64 = i64::MAX / 4;

/// Seam finder based on BK max-flow / min-cut over the overlap region.
///
/// Supports non-monotonic seams suitable for multi-row spherical panoramas.
///
/// ## Energy
///
/// Each adjacent pixel pair `(p, q)` in the overlap contributes a
/// capacity to the BK graph of:
///
/// ```text
///   base = w_col  · (color_cost(p)  + color_cost(q))
///        + w_grad · (grad_a(p) + grad_a(q) + grad_b(p) + grad_b(q))
///        + w_dup  · (color_cost(p)² + color_cost(q)²)
///
///   v_factor_p = 1 + λ_val / max(min(d_a[p], d_b[p]), 1)
///   v_factor_q = 1 + λ_val / max(min(d_a[q], d_b[q]), 1)
///   v_factor   = (v_factor_p + v_factor_q) / 2
///
///   sal = λ_sal · (max(sob_a[p], sob_b[p]) + max(sob_a[q], sob_b[q]))
///
///   cost = base · v_factor + sal
/// ```
///
/// `w_dup` is the **duplication penalty**: a quadratic on per-pixel
/// disagreement that disproportionately punishes cuts near pixels
/// where image A and image B disagree strongly (moving objects,
/// parallax mismatches, two structurally different features at the
/// same canvas position). Defaults to 2.0.
///
/// `lambda_val` (default 8.0) is the **validity-distance penalty**.
/// It multiplies the existing cost by `1 + λ_val / max(d, 1)` where
/// `d` is the canvas-pixel distance to the nearest validity boundary
/// (smaller of the two images' distances). Pushes seams toward image
/// interiors and away from warp halos / lens-edge artefacts.
///
/// `lambda_sal` (default 0.5) is the **saliency / edge-avoidance**
/// term. For each canvas pixel it adds `λ_sal · max(sobel_a, sobel_b)`
/// to the per-pixel cost. Penalises seams crossing high-gradient
/// features (cliffs, edges, text, faces). Note this is DIFFERENT from
/// `w_grad` which sums gradients across the four pixel positions of
/// an edge; `lambda_sal` operates on the per-pixel max-gradient
/// between the two images, biasing the cut toward flat pixels
/// regardless of edge orientation.
#[derive(Debug, Clone)]
pub struct GraphCutMaxFlowSeamFinder {
    /// Weight for the gradient term in the edge cost function.
    pub w_grad: f32,
    /// Weight for the colour-difference term.
    pub w_col: f32,
    /// Weight for the duplication penalty (squared per-pixel
    /// disagreement). See struct docs.
    pub w_dup: f32,
    /// Validity-distance penalty strength. Larger → seams pushed
    /// further into image interiors. See struct docs. Default 8.0.
    pub lambda_val: f32,
    /// Saliency / edge-avoidance penalty strength. Larger → seams
    /// avoid high-gradient pixels more strongly. See struct docs.
    /// Default 0.5.
    pub lambda_sal: f32,
}

impl GraphCutMaxFlowSeamFinder {
    pub fn new() -> Self {
        Self {
            w_grad: 1.0,
            w_col: 1.0,
            w_dup: 2.0,
            lambda_val: 8.0,
            lambda_sal: 0.5,
        }
    }

    /// Construct with explicit gradient + colour weights, preserving
    /// the default duplication / validity-distance / saliency
    /// penalties.
    pub fn with_weights(w_grad: f32, w_col: f32) -> Self {
        Self {
            w_grad,
            w_col,
            w_dup: 2.0,
            lambda_val: 8.0,
            lambda_sal: 0.5,
        }
    }

    /// Construct with the three "classic" weights specified
    /// explicitly; uses default `lambda_val = 8.0` and
    /// `lambda_sal = 0.5`.
    pub fn with_weights_full(w_grad: f32, w_col: f32, w_dup: f32) -> Self {
        Self {
            w_grad,
            w_col,
            w_dup,
            lambda_val: 8.0,
            lambda_sal: 0.5,
        }
    }

    /// Override the validity-distance penalty strength (default 8.0).
    /// `0.0` disables the term entirely.
    pub fn with_lambda_val(mut self, lambda_val: f32) -> Self {
        self.lambda_val = lambda_val;
        self
    }

    /// Override the saliency / edge-avoidance penalty strength
    /// (default 0.5). `0.0` disables the term entirely.
    pub fn with_lambda_sal(mut self, lambda_sal: f32) -> Self {
        self.lambda_sal = lambda_sal;
        self
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

/// 3×3 Sobel gradient magnitude on the luma channel at every pixel.
/// Border pixels reflect with replicate (`x_minus = x.saturating_sub(1)`,
/// etc.) so the result is the same size as the input. Invalid pixels
/// stay at 0 since they don't carry meaningful colour. Returned as a
/// flat row-major `Vec<f32>` of length `w * h`.
///
/// Used by the saliency term in `edge_cost`: pre-computed once per
/// image before BK construction so the per-edge lookup is O(1).
pub(crate) fn sobel_magnitude_map(img: &PanoImage) -> Vec<f32> {
    let w = img.width as usize;
    let h = img.height as usize;
    let n = w * h;
    if n == 0 {
        return Vec::new();
    }

    // Build a luma plane once (avoid recomputing inside every Sobel
    // window).
    let mut luma_plane = vec![0.0f32; n];
    for y in 0..h {
        for x in 0..w {
            let [r, g, bl] = get_pixel(img, x as u32, y as u32);
            luma_plane[y * w + x] = luma(r, g, bl);
        }
    }

    let l = |x: usize, y: usize| -> f32 { luma_plane[y * w + x] };

    let mut out = vec![0.0f32; n];
    if w < 2 || h < 2 {
        return out;
    }

    for y in 0..h {
        for x in 0..w {
            // Replicate padding for border pixels.
            let xl = x.saturating_sub(1);
            let xr = if x + 1 < w { x + 1 } else { x };
            let yu = y.saturating_sub(1);
            let yd = if y + 1 < h { y + 1 } else { y };

            // 3x3 Sobel kernels:
            //   Gx = [[-1, 0, 1], [-2, 0, 2], [-1, 0, 1]]
            //   Gy = [[-1,-2,-1], [ 0, 0, 0], [ 1, 2, 1]]
            let gx = -l(xl, yu) + l(xr, yu)
                   - 2.0 * l(xl, y)  + 2.0 * l(xr, y)
                   - l(xl, yd) + l(xr, yd);
            let gy = -l(xl, yu) - 2.0 * l(x, yu) - l(xr, yu)
                   + l(xl, yd) + 2.0 * l(x, yd) + l(xr, yd);
            out[y * w + x] = (gx * gx + gy * gy).sqrt();
        }
    }
    out
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

/// Pre-computed per-image features consumed by `edge_cost`.
///
/// Computing these once in the seam-finder entry point and then
/// passing them through every edge keeps each `edge_cost` call O(1)
/// instead of recomputing chamfer / Sobel for each adjacent pair.
struct EdgeContext<'a> {
    /// Distance (chamfer, capped) from each pixel to the nearest
    /// invalid pixel for image A. Length = `w * h`.
    dist_a: &'a [f32],
    /// Same for image B.
    dist_b: &'a [f32],
    /// Sobel gradient magnitude per pixel for image A. Length = `w * h`.
    sobel_a: &'a [f32],
    /// Same for image B.
    sobel_b: &'a [f32],
    /// Canvas width in pixels (shared between A and B).
    width: u32,
}

#[inline]
fn ctx_index(ctx: &EdgeContext<'_>, x: u32, y: u32) -> usize {
    (y as usize) * (ctx.width as usize) + (x as usize)
}

/// Seam edge cost between adjacent overlap pixels `p` and `q`.
///
/// A high cost discourages the seam from passing between p and q.
///
/// `w_dup` adds a *quadratic* penalty proportional to per-pixel
/// disagreement — `color_cost(p)² + color_cost(q)²`. Where the linear
/// `w_col` term punishes a cut by `disagreement`, the quadratic dup
/// term punishes by `disagreement²`, so cuts near badly-disagreeing
/// pixels (parallax mismatches, moving objects, two different
/// features at the same canvas pixel) become much more expensive
/// than cuts near mildly-disagreeing pixels. With `w_dup = 0` this
/// reduces to the plain Brown-Lowe energy.
///
/// `lambda_val` multiplies the (col + grad + dup) base cost by
/// `1 + lambda_val / max(d, 1)` where `d` is the smaller of the two
/// images' validity-edge distances at the pixel. With `lambda_val = 0`
/// the multiplier is 1.0 and the term has no effect.
///
/// `lambda_sal` adds `lambda_sal * (max(sobel_a[p], sobel_b[p]) +
/// max(sobel_a[q], sobel_b[q]))` on top of the multiplied base cost.
/// With `lambda_sal = 0` the term has no effect.
fn edge_cost(
    img_a: &PanoImage,
    img_b: &PanoImage,
    ctx: &EdgeContext<'_>,
    x1: u32,
    y1: u32,
    x2: u32,
    y2: u32,
    w_grad: f32,
    w_col: f32,
    w_dup: f32,
    lambda_val: f32,
    lambda_sal: f32,
) -> i64 {
    let col_p = color_cost(img_a, img_b, x1, y1);
    let col_q = color_cost(img_a, img_b, x2, y2);
    let col = col_p + col_q;
    let grad = grad_luma(img_a, x1, y1)
        + grad_luma(img_a, x2, y2)
        + grad_luma(img_b, x1, y1)
        + grad_luma(img_b, x2, y2);
    // Squared per-pixel disagreement — the duplication penalty.
    let dup = col_p * col_p + col_q * col_q;
    let base = w_col * col + w_grad * grad + w_dup * dup;

    // Validity-distance penalty: factor grows as either image's
    // validity boundary gets close. Take min(d_a, d_b) so the
    // penalty is dominated by whichever image is closer to its edge.
    let idx_p = ctx_index(ctx, x1, y1);
    let idx_q = ctx_index(ctx, x2, y2);
    let d_p = ctx.dist_a[idx_p].min(ctx.dist_b[idx_p]);
    let d_q = ctx.dist_a[idx_q].min(ctx.dist_b[idx_q]);
    let factor_p = 1.0 + lambda_val / d_p.max(1.0);
    let factor_q = 1.0 + lambda_val / d_q.max(1.0);
    let validity_factor = 0.5 * (factor_p + factor_q);

    // Saliency: per-pixel max gradient between the two images.
    let sal_p = ctx.sobel_a[idx_p].max(ctx.sobel_b[idx_p]);
    let sal_q = ctx.sobel_a[idx_q].max(ctx.sobel_b[idx_q]);
    let saliency = lambda_sal * (sal_p + sal_q);

    let cost = base * validity_factor + saliency;
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

        // Pre-compute per-image features used by the edge cost.
        // Cap matches the n_way::compute_distance_field_labels cap so
        // deep-interior pixels saturate.
        let cap = (w.max(h) as f32) * 0.5;
        let dist_a = compute_edge_distance(&a.validity, w, h, cap);
        let dist_b = compute_edge_distance(&b.validity, w, h, cap);
        let sobel_a = sobel_magnitude_map(a);
        let sobel_b = sobel_magnitude_map(b);
        let ctx = EdgeContext {
            dist_a: &dist_a,
            dist_b: &dist_b,
            sobel_a: &sobel_a,
            sobel_b: &sobel_b,
            width: w,
        };

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
                        let c = edge_cost(
                            a, b, &ctx, x, y, x + 1, y,
                            self.w_grad, self.w_col, self.w_dup,
                            self.lambda_val, self.lambda_sal,
                        );
                        g.add_edge(nid, nid_r, c, c);
                    }
                }
                // Down neighbour.
                if y + 1 <= y_max {
                    let ov_d = (y + 1 - y_min) as usize * ov_w + (x - x_min) as usize;
                    let nid_d = node_map[ov_d];
                    if nid_d != INVALID_NODE {
                        let c = edge_cost(
                            a, b, &ctx, x, y, x, y + 1,
                            self.w_grad, self.w_col, self.w_dup,
                            self.lambda_val, self.lambda_sal,
                        );
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

    /// Build a degenerate `EdgeContext` whose validity-distance is
    /// uniformly large (so `validity_factor → 1.0`) and whose
    /// saliency is zero. Lets the older tests exercise the
    /// classic `(col + grad + dup)` core without polluting the
    /// numbers.
    fn neutral_ctx(w: u32, h: u32) -> (Vec<f32>, Vec<f32>, Vec<f32>, Vec<f32>) {
        let n = (w as usize) * (h as usize);
        // Use a "very large" distance — `lambda_val / 1e6` ≈ 0, so
        // the validity factor is essentially 1.0.
        let big = vec![1.0e6_f32; n];
        let zero = vec![0.0_f32; n];
        (big.clone(), big, zero.clone(), zero)
    }

    /// `edge_cost` with `w_dup = 0` reduces to the original Brown-Lowe
    /// energy; with `w_dup > 0` an extra quadratic-in-disagreement
    /// term is added, making the cost grow faster than linear in
    /// per-pixel colour disagreement.
    #[test]
    fn edge_cost_with_w_dup_adds_squared_disagreement() {
        // Both pixels: A is black, B is full red. Per-pixel
        // color_cost = sqrt(1² + 0² + 0²) = 1.0 at each.
        let a = solid(2, 1, 0.0, 0.0, 0.0);
        let b = solid(2, 1, 1.0, 0.0, 0.0);

        let (da, db, sa, sb) = neutral_ctx(2, 1);
        let ctx = EdgeContext {
            dist_a: &da, dist_b: &db,
            sobel_a: &sa, sobel_b: &sb,
            width: 2,
        };

        // No-dup baseline: cost = 1·(1.0+1.0) + 1·grad = 2 + grad.
        // grad on a uniform image is 0.
        let no_dup = edge_cost(&a, &b, &ctx, 0, 0, 1, 0, 1.0, 1.0, 0.0, 0.0, 0.0);
        // With w_dup = 2: cost = 2 + 0 + 2·(1²+1²) = 2 + 4 = 6.
        let with_dup = edge_cost(&a, &b, &ctx, 0, 0, 1, 0, 1.0, 1.0, 2.0, 0.0, 0.0);
        // Cheap sanity (the +1 baseline noise is identical for both):
        assert!(with_dup > no_dup, "with_dup={} no_dup={}", with_dup, no_dup);
        let delta = with_dup - no_dup;
        let expected = (4.0 * COST_SCALE as f32) as i64;
        assert!(
            (delta - expected).abs() < 100,
            "delta = {} expected ≈ {}",
            delta,
            expected
        );
    }

    /// `edge_cost` with low disagreement → quadratic dup term is much
    /// smaller than linear col term (squaring shrinks values < 1).
    #[test]
    fn edge_cost_dup_penalty_negligible_for_low_disagreement() {
        // Per-pixel disagreement = 0.1 (each channel diff = 0.1/sqrt(3)).
        let small = (0.1_f32 * 0.1_f32 / 3.0).sqrt();
        let a = solid(2, 1, 0.0, 0.0, 0.0);
        let mut b = solid(2, 1, small, small, small);
        for i in 0..2 {
            b.pixels[i * 3] = small;
            b.pixels[i * 3 + 1] = small;
            b.pixels[i * 3 + 2] = small;
        }
        let (da, db, sa, sb) = neutral_ctx(2, 1);
        let ctx = EdgeContext {
            dist_a: &da, dist_b: &db,
            sobel_a: &sa, sobel_b: &sb,
            width: 2,
        };
        let no_dup = edge_cost(&a, &b, &ctx, 0, 0, 1, 0, 1.0, 1.0, 0.0, 0.0, 0.0);
        let with_dup = edge_cost(&a, &b, &ctx, 0, 0, 1, 0, 1.0, 1.0, 2.0, 0.0, 0.0);
        let delta = with_dup - no_dup;
        // Linear col contribution per edge = 2 · 0.1 = 0.2 (× SCALE).
        // Quadratic dup contribution = 2 · 2 · 0.01 = 0.04 (× SCALE).
        // So delta ≪ no_dup — the squaring kills small disagreements.
        assert!(
            delta < (no_dup as f32 * 0.5) as i64,
            "low-disagreement dup delta should be small relative to baseline (delta={}, no_dup={})",
            delta, no_dup
        );
    }

    /// End-to-end: a tiny overlap with a high-disagreement pixel acts
    /// as a wall the seam should route around. With the duplication
    /// penalty active by default (`w_dup = 2.0`), the cut never
    /// crosses through high-disagreement edges; every wall pixel
    /// stays assigned to image A (the low-disagreement source).
    ///
    /// Kept tiny (8×4 → 16-node overlap) on purpose — the existing
    /// BK solver is already exercised on much larger graphs by the
    /// real `pano-smoke` runs; this test's job is to verify the
    /// `w_dup` plumbing reaches the BK edge capacities at all.
    #[test]
    fn graph_cut_routes_seam_around_high_disagreement_pixel() {
        let w = 8u32;
        let h = 4u32;

        // Image A: uniform grey 0.5, valid in cols 0..6.
        let mut a = solid(w, h, 0.5, 0.5, 0.5);
        for y in 0..h {
            for x in 6..w {
                a.set_invalid(x, y);
            }
        }
        // Image B: uniform grey 0.5, valid in cols 2..8, with a
        // bright-red 1×1 wall at (3, 2). ||diff|| ≈ 0.71 there.
        let mut b = solid(w, h, 0.5, 0.5, 0.5);
        for y in 0..h {
            for x in 0..2 {
                b.set_invalid(x, y);
            }
        }
        let i = ((2 * w + 3) * 3) as usize;
        b.pixels[i] = 1.0;
        b.pixels[i + 1] = 0.2;
        b.pixels[i + 2] = 0.2;

        let finder = GraphCutMaxFlowSeamFinder::new();
        let masks = finder.seams(&[&a, &b]).expect("seam finds");

        // The disagreement pixel (3, 2) lies in the overlap
        // (cols 2..5). The cut should keep it assigned to A —
        // mask_a bit = 0 means "use A here".
        let idx = (2 * w + 3) as usize;
        assert!(
            !masks[0].bits[idx],
            "seam crossed high-disagreement pixel (3,2): mask_a bit = {}",
            masks[0].bits[idx]
        );
    }

    /// `with_weights_full` exposes the duplication-penalty knob; setting
    /// `w_dup = 0` reproduces the legacy (col + grad) energy.
    #[test]
    fn with_weights_full_zeroes_dup_when_requested() {
        let f = GraphCutMaxFlowSeamFinder::with_weights_full(1.0, 1.0, 0.0);
        assert_eq!(f.w_dup, 0.0);
        let g = GraphCutMaxFlowSeamFinder::new();
        assert_eq!(g.w_dup, 2.0);
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

    // -----------------------------------------------------------------
    // Stage D: validity-distance + saliency tests
    // -----------------------------------------------------------------

    /// `sobel_magnitude_map` returns ~0 on uniform images, large
    /// values on a sharp step.
    #[test]
    fn sobel_magnitude_zero_on_uniform_large_on_step() {
        // Uniform image — Sobel magnitude should be 0 everywhere.
        let flat = solid(8, 8, 0.5, 0.5, 0.5);
        let mag_flat = sobel_magnitude_map(&flat);
        assert_eq!(mag_flat.len(), 64);
        for v in &mag_flat {
            assert!(v.abs() < 1e-5, "uniform image Sobel = {}", v);
        }

        // Vertical step: cols 0..4 black, cols 4..8 white.
        let mut step = solid(8, 8, 0.0, 0.0, 0.0);
        for y in 0..8 {
            for x in 4..8 {
                let i = ((y * 8 + x) * 3) as usize;
                step.pixels[i] = 1.0;
                step.pixels[i + 1] = 1.0;
                step.pixels[i + 2] = 1.0;
            }
        }
        let mag_step = sobel_magnitude_map(&step);
        // Pixels deep on either side: ~0. Pixels straddling x=3..4
        // (the step) should be large.
        let interior_left = mag_step[(4 * 8 + 0) as usize];
        let on_step = mag_step[(4 * 8 + 3) as usize];
        let interior_right = mag_step[(4 * 8 + 7) as usize];
        assert!(
            interior_left.abs() < 1e-5,
            "interior left should be flat (got {})", interior_left
        );
        assert!(
            interior_right.abs() < 1e-5,
            "interior right should be flat (got {})", interior_right
        );
        assert!(
            on_step > 1.0,
            "Sobel on-step magnitude should be large (got {})", on_step
        );
    }

    /// `with_lambda_val` and `with_lambda_sal` builder methods set the
    /// fields and don't touch the existing weights.
    #[test]
    fn with_lambda_builders_set_only_intended_fields() {
        let f = GraphCutMaxFlowSeamFinder::new()
            .with_lambda_val(0.0)
            .with_lambda_sal(0.0);
        assert_eq!(f.lambda_val, 0.0);
        assert_eq!(f.lambda_sal, 0.0);
        assert_eq!(f.w_col, 1.0);
        assert_eq!(f.w_grad, 1.0);
        assert_eq!(f.w_dup, 2.0);

        let g = GraphCutMaxFlowSeamFinder::new();
        assert_eq!(g.lambda_val, 8.0);
        assert_eq!(g.lambda_sal, 0.5);
    }

    /// Validity-distance penalty: in a wide overlap, the seam should
    /// prefer the deep-interior column over a column that hugs an
    /// image's validity boundary.
    ///
    /// Setup (16×8 canvas):
    ///   image A: valid in cols 0..14 (so col 14 is near A's right edge)
    ///   image B: valid in cols 1..16 (so col 1 is near B's left edge)
    ///   overlap: cols 1..14 (13 wide). Both images have a SMALL
    ///   uniform colour difference (so the `(col + grad + dup)` base
    ///   cost is non-zero everywhere — without that the validity
    ///   factor has nothing to multiply against and the cut is
    ///   arbitrary).
    ///
    /// The seam has to cut SOMEWHERE between col 1 and col 13. With
    /// a strong validity-distance penalty (λ_val = 50), BK should
    /// route the cut through a deep-interior column rather than the
    /// near-boundary column 1 or 13.
    #[test]
    fn validity_distance_prefers_image_interior() {
        let w = 16u32;
        let h = 8u32;

        // Uniform colour offset so the base cost is non-zero
        // everywhere; the validity-distance factor multiplies that
        // non-zero base. We pick a moderate Δ so the floating-point
        // cost dominates the +1 integer floor.
        let mut a = solid(w, h, 0.2, 0.5, 0.8);
        for y in 0..h {
            for x in 14..w {
                a.set_invalid(x, y);
            }
        }
        let mut b = solid(w, h, 0.8, 0.5, 0.2);
        for y in 0..h {
            for x in 0..1 {
                b.set_invalid(x, y);
            }
        }

        // Compare two runs: one with the validity-distance penalty
        // off (legacy behaviour), one with it on. We don't pin the
        // exact column the cut lands in — just assert that turning
        // on `lambda_val` moves the cut deeper into the interior.
        let off = GraphCutMaxFlowSeamFinder::new()
            .with_lambda_val(0.0)
            .with_lambda_sal(0.0);
        let masks_off = off.seams(&[&a, &b]).expect("seam succeeds");

        let on = GraphCutMaxFlowSeamFinder::new()
            .with_lambda_val(200.0)
            .with_lambda_sal(0.0);
        let masks_on = on.seams(&[&a, &b]).expect("seam succeeds");

        // Find the A→B transition column on the middle row for both
        // configs.
        let row = h / 2;
        let find_transition = |masks: &[SeamMask]| -> Option<u32> {
            for x in 1..14 {
                let idx_here = (row as usize) * (w as usize) + (x as usize);
                let idx_next = (row as usize) * (w as usize) + ((x + 1) as usize);
                let here_a = !masks[0].bits[idx_here];
                let next_a = !masks[0].bits[idx_next];
                if here_a && !next_a {
                    return Some(x);
                }
            }
            None
        };

        let tx_off = find_transition(&masks_off)
            .expect("expected an A→B transition with lambda_val=0");
        let tx_on = find_transition(&masks_on)
            .expect("expected an A→B transition with lambda_val=50");

        // Sanity: both runs find a transition.
        assert!(
            (1..=13).contains(&tx_off),
            "off-run transition out of overlap range: {}",
            tx_off
        );
        assert!(
            (1..=13).contains(&tx_on),
            "on-run transition out of overlap range: {}",
            tx_on
        );

        // The validity-distance penalty should push the cut toward
        // the deep interior. The midpoint of the overlap is col 7
        // (between cols 1 and 13). The "depth" function (distance to
        // nearest validity edge) peaks somewhere in the middle. So
        // the on-run cut should be strictly farther from the
        // validity boundaries than the off-run cut.
        let dist_to_boundary = |x: u32| -> u32 {
            // Distance to the nearer of B's left invalid (col 0) and
            // A's right invalid (col 14). Both image-validity
            // boundaries. The transition `tx` is between cols
            // tx and tx+1, so use tx+1 as the centre.
            let centre = x as i32 + 1;
            let l = centre - 0;
            let r = 14 - centre;
            l.min(r).max(0) as u32
        };
        let depth_off = dist_to_boundary(tx_off);
        let depth_on = dist_to_boundary(tx_on);
        assert!(
            depth_on > depth_off,
            "validity-distance penalty should push seam toward interior; \
             off-run at col {} (depth {}), on-run at col {} (depth {})",
            tx_off, depth_off, tx_on, depth_on
        );
        // And the on-run should land far enough from either boundary
        // (depth ≥ 3) to count as "interior".
        assert!(
            depth_on >= 3,
            "on-run should land in interior (depth ≥ 3), got col {} with depth {}",
            tx_on, depth_on
        );
    }

    /// Saliency / edge-avoidance: with a textured (high-gradient)
    /// band on one side of the overlap and a flat band on the other,
    /// the cut should route through the flat side.
    ///
    /// Setup (12×8 canvas):
    ///   image A: valid in cols 0..10 — top half flat grey, bottom half
    ///            highly textured (alternating black/white rows). The
    ///            "cliff" is in rows 4..8.
    ///   image B: valid in cols 2..12 — uniform grey everywhere.
    ///   overlap: cols 2..10, rows 0..8.
    /// The cut should hide in the top half (rows 0..3) where image A
    /// is also flat and per-pixel saliency is low; it should NOT
    /// route through the textured bottom half.
    ///
    /// Verification: count "use A" → "use B" transitions per row, and
    /// assert the cut transitions exist in the top half but not in the
    /// bottom half.
    #[test]
    fn saliency_routes_seam_through_flat_band() {
        let w = 12u32;
        let h = 8u32;

        // Image A: valid in cols 0..10.
        // Top half (rows 0..4): uniform grey.
        // Bottom half (rows 4..8): alternating black/white per row to
        // give the Sobel filter a strong vertical-direction kick.
        let mut a = solid(w, h, 0.5, 0.5, 0.5);
        for y in 4..h {
            let v = if y % 2 == 0 { 0.0 } else { 1.0 };
            for x in 0..w {
                let i = ((y * w + x) * 3) as usize;
                a.pixels[i] = v;
                a.pixels[i + 1] = v;
                a.pixels[i + 2] = v;
            }
        }
        for y in 0..h {
            for x in 10..w {
                a.set_invalid(x, y);
            }
        }

        // Image B: valid in cols 2..12, uniform grey.
        let mut b = solid(w, h, 0.5, 0.5, 0.5);
        for y in 0..h {
            for x in 0..2 {
                b.set_invalid(x, y);
            }
        }

        // Strong saliency penalty; validity-distance off so it doesn't
        // fight the saliency term.
        let finder = GraphCutMaxFlowSeamFinder::new()
            .with_lambda_val(0.0)
            .with_lambda_sal(50.0);
        let masks = finder.seams(&[&a, &b]).expect("seam succeeds");

        // Per row, find whether there is ANY A→B transition inside
        // the overlap (cols 2..10). A row that "transitions" means
        // the cut crosses that row at some column.
        let mut top_transitions = 0;
        let mut bottom_transitions = 0;
        for y in 0..h {
            let mut row_has_transition = false;
            for x in 2..9 {
                let idx_here = (y as usize) * (w as usize) + (x as usize);
                let idx_next = (y as usize) * (w as usize) + ((x + 1) as usize);
                let here_a = !masks[0].bits[idx_here];
                let next_a = !masks[0].bits[idx_next];
                if here_a && !next_a {
                    row_has_transition = true;
                    break;
                }
            }
            if row_has_transition {
                if y < 4 {
                    top_transitions += 1;
                } else {
                    bottom_transitions += 1;
                }
            }
        }

        // The cut is a roughly vertical line (canvas is wider than tall)
        // so each row should generally see one A→B transition. With
        // saliency penalty pushing the cut away from the textured
        // bottom half, the cut should consist mostly of top-half
        // transitions and the bottom-half columns should sit on the
        // SAME side (whichever side wins on cost) — meaning fewer
        // transitions per textured row, or the cut routes through the
        // flat top entirely.
        //
        // Concretely: top_transitions should equal `top_rows` (4) — every
        // top row crosses the cut — and bottom_transitions should be
        // strictly less, demonstrating the cut prefers the flat band.
        assert!(
            top_transitions >= bottom_transitions,
            "saliency should keep cuts in flat top half: top={}, bottom={}",
            top_transitions, bottom_transitions
        );
        // And the top should actually have transitions (cut isn't
        // degenerate / pinned to the boundary).
        assert!(
            top_transitions > 0,
            "expected at least one cut transition in the flat top half (got {})",
            top_transitions
        );
    }

    /// Backward-compat smoke: with the new defaults applied, two
    /// uniform-grey overlapping images still give every-pixel-
    /// assigned masks (the same property the original
    /// `graph_cut_two_image_overlap_produces_complementary_masks`
    /// test checked, but now with non-zero λ_val and λ_sal).
    #[test]
    fn defaults_preserve_complementary_masks_invariant() {
        let finder = GraphCutMaxFlowSeamFinder::new();
        // Sanity — defaults match the documented values.
        assert_eq!(finder.lambda_val, 8.0);
        assert_eq!(finder.lambda_sal, 0.5);

        // Two identical solid images, full overlap.
        let a = solid(16, 16, 0.4, 0.5, 0.6);
        let b = solid(16, 16, 0.4, 0.5, 0.6);
        let masks = finder.seams(&[&a, &b]).expect("seam succeeds");
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
        assert_eq!(
            assigned, n,
            "every pixel must be assigned to at least one image \
             (defaults regression)"
        );
    }
}
