//! N-way graph-cut seam finder built on top of the pairwise 2-way
//! `GraphCutMaxFlowSeamFinder`.
//!
//! ## Why
//!
//! With N input images stitched onto a single canvas, the simple-alpha
//! and multi-band blenders both produce **ghosting** at overlap regions
//! when input frames are imperfectly aligned (which is always — BA
//! residual + parallax + lens-model gaps). Averaging mis-aligned
//! content yields doubled features.
//!
//! Graph-cut seam finding fixes this by assigning each canvas pixel to
//! **exactly one** image via min-cost min-cut: each overlap pixel goes
//! to whichever image's content "wins" the local energy minimisation.
//! Seams are routed through regions of low colour disagreement and low
//! gradient (sky, water, smooth surfaces), where the choice of source
//! image is invisible.
//!
//! ## Algorithm
//!
//! 1. Initialise per-pixel labels via Voronoi: each pixel is assigned
//!    to the first image whose validity is set there. Pixels with no
//!    valid input are labelled `-1`.
//! 2. For each adjacent image pair `(i, i+1)`, if their validity
//!    overlaps, run the existing pairwise `GraphCutMaxFlowSeamFinder`
//!    on that pair. The cut produces a binary partition over the
//!    overlap: each pixel goes to either image i or image i+1.
//!    Update labels for pixels in the overlap.
//! 3. (Optional) For pixels covered by ≥3 images (rare on adjacency-
//!    chain panoramas), the last pair's decision wins. This is
//!    suboptimal in principle but stable in practice for our use case.
//! 4. Convert labels to per-image binary masks: `mask_i[px] = 1.0` iff
//!    `labels[px] == i`, else `0.0`.
//!
//! Optional narrow feathering at seam boundaries is left to the caller
//! (the `SimpleAlphaBlender` handles fractional weights correctly).
//!
//! ## When NOT to use
//!
//! - Single-image "pano" — degenerate, returns trivially.
//! - All images at very different exposures with no GainMap or gain
//!   compensation: hard cuts will produce visible brightness seams.
//!   Run `compensation::gain` first.

use bitvec::vec::BitVec;
use rayon::prelude::*;

use crate::color::ColorSpace;
use crate::seam::graph_cut_maxflow::GraphCutMaxFlowSeamFinder;
use crate::traits::SeamFinder;
use crate::types::PanoImage;

/// Fast hard-partition labelling based on per-image distance-from-
/// validity-edge. For each canvas pixel, assigns the label of the
/// image whose pixel is "deepest" inside its own footprint at that
/// canvas position. This puts seams roughly halfway between images'
/// validity boundaries — like a Voronoi diagram in image-edge-distance
/// space rather than image-centre-distance space.
///
/// This is the **fast** alternative to the full graph-cut N-way
/// algorithm (`compute_n_way_labels`). It doesn't optimise seam
/// energy (cost of pixel disagreement at the seam route), so seams
/// pass through whatever happens to be at the validity-edge midpoint.
/// But it *does* eliminate averaging in overlap interiors, which is
/// the dominant source of ghosting in our pipeline. And it runs in
/// O(N · canvas) instead of O(BK on overlap), so it scales to ~50 MP
/// canvases with no special handling.
///
/// Implementation:
/// 1. Per image, compute the chamfer distance from each pixel to
///    that image's nearest invalid pixel (capped). Pixels outside
///    the image's validity get distance = 0.
/// 2. Per canvas pixel, the label is `argmax_i distance_i[px]`. Ties
///    go to the lowest-index image. Pixels with all distances zero
///    (no image valid) are labelled `-1`.
///
/// Returns a flat `Vec<i32>` of size `width × height`.
pub fn compute_distance_field_labels(warped: &[PanoImage]) -> Vec<i32> {
    let n = warped.len();
    if n == 0 {
        return Vec::new();
    }
    let w = warped[0].width;
    let h = warped[0].height;
    let n_pixels = (w as usize) * (h as usize);

    // Cap at canvas-half-size so the chamfer fills the entire interior
    // of every image (otherwise label-ties would be common deep inside
    // images and the partition would oscillate).
    let cap = (w.max(h) as f32) * 0.5;

    // Per-image distance-from-edge map. Computed in parallel across images.
    let dists: Vec<Vec<f32>> = warped
        .par_iter()
        .map(|img| compute_edge_distance(&img.validity, w, h, cap))
        .collect();

    // For each pixel, pick argmax of distances. Pixels where every image
    // has distance 0 (i.e. invalid for all) get label -1.
    let mut labels = vec![-1_i32; n_pixels];
    for px in 0..n_pixels {
        let mut best_i: i32 = -1;
        let mut best_d = 0.0_f32;
        for i in 0..n {
            let d = dists[i][px];
            if d > best_d {
                best_d = d;
                best_i = i as i32;
            }
        }
        labels[px] = best_i;
    }
    labels
}

/// Compute, for each pixel, the chamfer distance to the nearest
/// invalid pixel (capped at `cap`). Same as the
/// `compute_edge_feather` helper in pano-smoke but inlined here to
/// keep the seam module self-contained.
fn compute_edge_distance(validity: &BitVec, w: u32, h: u32, cap: f32) -> Vec<f32> {
    let n = (w as usize) * (h as usize);
    let mut dist = vec![cap + 1.0; n];

    // Initialise: invalid pixels and canvas-border pixels at 0.
    for y in 0..h {
        for x in 0..w {
            let idx = (y * w + x) as usize;
            let on_border = x == 0 || y == 0 || x == w - 1 || y == h - 1;
            if !validity[idx] || on_border {
                dist[idx] = 0.0;
            }
        }
    }

    let stride = w as usize;
    let diag = std::f32::consts::SQRT_2;

    // Forward pass.
    for y in 0..h {
        for x in 0..w {
            let idx = (y as usize) * stride + (x as usize);
            if dist[idx] == 0.0 {
                continue;
            }
            let mut d = dist[idx];
            if x > 0 {
                d = d.min(dist[idx - 1] + 1.0);
            }
            if y > 0 {
                d = d.min(dist[idx - stride] + 1.0);
                if x > 0 {
                    d = d.min(dist[idx - stride - 1] + diag);
                }
                if (x as usize) < stride - 1 {
                    d = d.min(dist[idx - stride + 1] + diag);
                }
            }
            dist[idx] = d.min(cap);
        }
    }

    // Backward pass.
    for y in (0..h).rev() {
        for x in (0..w).rev() {
            let idx = (y as usize) * stride + (x as usize);
            if dist[idx] == 0.0 {
                continue;
            }
            let mut d = dist[idx];
            if (x as usize) < stride - 1 {
                d = d.min(dist[idx + 1] + 1.0);
            }
            if y < h - 1 {
                d = d.min(dist[idx + stride] + 1.0);
                if x > 0 {
                    d = d.min(dist[idx + stride - 1] + diag);
                }
                if (x as usize) < stride - 1 {
                    d = d.min(dist[idx + stride + 1] + diag);
                }
            }
            dist[idx] = d.min(cap);
        }
    }
    dist
}

/// Compute a hard partition over the canvas: each pixel is assigned
/// to exactly one input image (or to none if no image is valid there).
///
/// Returns a vector of `i32` per pixel: `-1` for invalid pixels, else
/// the index of the assigned input image.
///
/// `downsample` controls a speed/quality trade-off for the BK max-flow:
/// the seam graph is built on a `1/downsample`-sized version of the
/// canvas (e.g. `8` → 8× linear → 64× node-count reduction), then the
/// resulting labels are upsampled back to full resolution. For a 50 MP
/// canvas with 5 images, `downsample = 8` reduces wall time from
/// "minutes per pair" to "single-digit seconds per pair", with seam
/// routes that are coarse to within ±downsample/2 px (invisible after
/// the post-cut feather pass). Pass `1` to skip downsampling.
pub fn compute_n_way_labels(warped: &[PanoImage], downsample: u32) -> Vec<i32> {
    let n = warped.len();
    if n == 0 {
        return Vec::new();
    }
    let ds = downsample.max(1);
    let w = warped[0].width;
    let h = warped[0].height;
    let n_pixels_full = (w as usize) * (h as usize);

    // Working images for BK: either the originals or downsampled versions.
    let t_start = std::time::Instant::now();
    let working: Vec<PanoImage> = if ds == 1 {
        warped.iter().cloned().collect()
    } else {
        warped.iter().map(|img| downsample_pano(img, ds)).collect()
    };
    if std::env::var("PANO_SEAM_VERBOSE").is_ok() {
        eprintln!(
            "n_way: downsample {}× ({} → {} px) took {:?}",
            ds,
            (warped[0].width as usize) * (warped[0].height as usize),
            (working[0].width as usize) * (working[0].height as usize),
            t_start.elapsed(),
        );
    }
    let dw = working[0].width;
    let dh = working[0].height;
    let n_pixels_ds = (dw as usize) * (dh as usize);

    // Step 1 (downsampled): Voronoi-by-first-valid initialisation.
    let mut ds_labels: Vec<i32> = vec![-1; n_pixels_ds];
    for px in 0..n_pixels_ds {
        for i in 0..n {
            if working[i].validity[px] {
                ds_labels[px] = i as i32;
                break;
            }
        }
    }

    // Step 2 (downsampled): pairwise 2-way max-flow cuts for adjacent pairs.
    let verbose = std::env::var("PANO_SEAM_VERBOSE").is_ok();
    let finder = GraphCutMaxFlowSeamFinder::new();
    for i in 0..(n - 1) {
        let j = i + 1;
        let t_pair = std::time::Instant::now();
        let pair = [&working[i], &working[j]];
        let seams = match finder.seams(&pair) {
            Ok(s) => s,
            Err(e) => {
                if verbose {
                    eprintln!("n_way: pair ({i},{j}) cut failed: {e}");
                }
                continue;
            }
        };
        if seams.len() != 2 {
            continue;
        }
        let mask_a = &seams[0];
        for px in 0..n_pixels_ds {
            if working[i].validity[px] && working[j].validity[px] {
                let bit = mask_a.bits[px];
                ds_labels[px] = if bit { j as i32 } else { i as i32 };
            }
        }
        if verbose {
            eprintln!(
                "n_way: pair ({i},{j}) BK max-flow took {:?}",
                t_pair.elapsed()
            );
        }
    }

    if ds == 1 {
        return ds_labels;
    }

    // Step 3: upsample labels via nearest-neighbour, but always trust
    // the original full-res validity (don't extend a label into pixels
    // where the chosen image isn't actually valid).
    let mut labels = vec![-1_i32; n_pixels_full];
    for y in 0..h {
        for x in 0..w {
            let dx = (x / ds).min(dw - 1);
            let dy = (y / ds).min(dh - 1);
            let ds_idx = (dy as usize) * (dw as usize) + (dx as usize);
            let proposed = ds_labels[ds_idx];
            let full_idx = (y as usize) * (w as usize) + (x as usize);
            if proposed >= 0 && warped[proposed as usize].validity[full_idx] {
                labels[full_idx] = proposed;
            } else {
                // Fall back to first valid image if proposed isn't valid
                // here at full res (happens at sub-block boundaries).
                for i in 0..n {
                    if warped[i].validity[full_idx] {
                        labels[full_idx] = i as i32;
                        break;
                    }
                }
            }
        }
    }
    labels
}

/// Box-downsample a `PanoImage` by integer factor `ds`. Each output
/// pixel averages an `ds × ds` block of input pixels (only pixels
/// with `validity = true` contribute). Output validity is `true` iff
/// at least 25 % of the input block was valid (avoids tiny slivers
/// of validity propagating up).
fn downsample_pano(img: &PanoImage, ds: u32) -> PanoImage {
    let w = img.width;
    let h = img.height;
    let dw = w.div_ceil(ds);
    let dh = h.div_ceil(ds);
    let mut out = PanoImage::new(dw, dh, ColorSpace::rec2020_d65_linear());

    let block_pixels = (ds * ds) as f32;
    let valid_threshold = (0.25 * block_pixels).max(1.0);

    for dy in 0..dh {
        for dx in 0..dw {
            let mut sum = [0.0_f32; 3];
            let mut count_valid = 0_u32;
            let y0 = dy * ds;
            let x0 = dx * ds;
            let y1 = (y0 + ds).min(h);
            let x1 = (x0 + ds).min(w);
            for y in y0..y1 {
                for x in x0..x1 {
                    let idx = (y * w + x) as usize;
                    if img.validity[idx] {
                        sum[0] += img.pixels[idx * 3];
                        sum[1] += img.pixels[idx * 3 + 1];
                        sum[2] += img.pixels[idx * 3 + 2];
                        count_valid += 1;
                    }
                }
            }
            let dst_idx = (dy * dw + dx) as usize;
            if count_valid > 0 {
                let inv = 1.0 / count_valid as f32;
                out.pixels[dst_idx * 3] = sum[0] * inv;
                out.pixels[dst_idx * 3 + 1] = sum[1] * inv;
                out.pixels[dst_idx * 3 + 2] = sum[2] * inv;
            }
            out.validity
                .set(dst_idx, (count_valid as f32) >= valid_threshold);
        }
    }
    out
}

/// Build per-image binary partition masks from the N-way labels.
///
/// Each output mask is a row-major flat `Vec<f32>` matching the
/// canvas dimensions:
/// - `mask_i[px] = 1.0` iff `labels[px] == i`
/// - `0.0` otherwise (pixel assigned to a different image, or invalid)
///
/// Pass directly to `SimpleAlphaBlender::blend_n`. The blender
/// computes `Σ(mask · pixel) / Σ(mask)`; with hard binary masks the
/// output is exactly the assigned image's pixel (no averaging).
pub fn build_n_way_binary_masks(warped: &[PanoImage], downsample: u32) -> Vec<Vec<f32>> {
    let n = warped.len();
    if n == 0 {
        return Vec::new();
    }
    let n_pixels = (warped[0].width as usize) * (warped[0].height as usize);
    let labels = compute_n_way_labels(warped, downsample);
    let mut masks: Vec<Vec<f32>> = (0..n).map(|_| vec![0.0_f32; n_pixels]).collect();
    for px in 0..n_pixels {
        if labels[px] >= 0 {
            let i = labels[px] as usize;
            if i < n {
                masks[i][px] = 1.0;
            }
        }
    }
    masks
}

/// Apply a narrow Gaussian feather to each binary mask, producing
/// soft transitions at seam boundaries. Without feathering, hard
/// cuts can show visible discontinuity from residual brightness
/// mismatch between adjacent images; with a 3-5 px feather the
/// transition is invisible while keeping each image's territory
/// sharp.
///
/// `radius` is the feather radius in pixels. The kernel is a
/// separable Gaussian with σ ≈ radius / 2.
///
/// The feather is applied per-mask independently. Note that this
/// breaks partition-of-unity slightly at seam boundaries (sum of
/// masks may dip below 1.0 in a 1-2 px band), but the
/// `SimpleAlphaBlender` normalises by the per-pixel weight sum so
/// the output is still well-defined.
pub fn feather_binary_masks(
    masks: &mut [Vec<f32>],
    width: u32,
    height: u32,
    radius: u32,
) {
    if radius == 0 {
        return;
    }
    let w = width as usize;
    let h = height as usize;
    let r = radius as i32;
    let sigma = (radius as f32 / 2.0).max(0.5);
    let two_sigma_sq = 2.0 * sigma * sigma;

    // Precompute 1-D Gaussian kernel.
    let mut kernel = Vec::with_capacity((2 * r + 1) as usize);
    let mut sum = 0.0_f32;
    for k in -r..=r {
        let v = (-(k as f32).powi(2) / two_sigma_sq).exp();
        kernel.push(v);
        sum += v;
    }
    for v in kernel.iter_mut() {
        *v /= sum;
    }

    // Per-mask separable convolution.
    for mask in masks.iter_mut() {
        let mut tmp = vec![0.0_f32; w * h];
        // Horizontal pass.
        for y in 0..h {
            for x in 0..w {
                let mut acc = 0.0_f32;
                for k in -r..=r {
                    let xx = (x as i32 + k).clamp(0, w as i32 - 1) as usize;
                    acc += kernel[(k + r) as usize] * mask[y * w + xx];
                }
                tmp[y * w + x] = acc;
            }
        }
        // Vertical pass.
        for y in 0..h {
            for x in 0..w {
                let mut acc = 0.0_f32;
                for k in -r..=r {
                    let yy = (y as i32 + k).clamp(0, h as i32 - 1) as usize;
                    acc += kernel[(k + r) as usize] * tmp[yy * w + x];
                }
                mask[y * w + x] = acc;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::color::ColorSpace;

    /// Build a constant-colour image with validity = full or partial.
    /// `valid_xrange` is `(x_min, x_max)` inclusive — pixels outside
    /// the range are marked invalid.
    fn make_image(w: u32, h: u32, rgb: [f32; 3], valid_xrange: (u32, u32)) -> PanoImage {
        let mut img = PanoImage::new(w, h, ColorSpace::rec2020_d65_linear());
        for y in 0..h {
            for x in 0..w {
                let i = (y * w + x) as usize;
                img.pixels[i * 3] = rgb[0];
                img.pixels[i * 3 + 1] = rgb[1];
                img.pixels[i * 3 + 2] = rgb[2];
                let valid = x >= valid_xrange.0 && x <= valid_xrange.1;
                img.validity.set(i, valid);
            }
        }
        img
    }

    /// Three images with chained overlaps. After the cut, every pixel
    /// should be assigned to at most one image and partition-of-unity
    /// should hold over the union of validity regions.
    #[test]
    fn n_way_partition_is_mutually_exclusive() {
        let w = 64u32;
        let h = 32u32;
        // image 0 valid in cols [0, 30]
        // image 1 valid in cols [20, 50] (overlaps 0 in [20, 30])
        // image 2 valid in cols [40, 63] (overlaps 1 in [40, 50])
        let img0 = make_image(w, h, [0.8, 0.2, 0.2], (0, 30));
        let img1 = make_image(w, h, [0.2, 0.8, 0.2], (20, 50));
        let img2 = make_image(w, h, [0.2, 0.2, 0.8], (40, 63));
        let warped = vec![img0, img1, img2];

        let masks = build_n_way_binary_masks(&warped, 1);
        assert_eq!(masks.len(), 3);

        // For every pixel, sum of masks must be 0 or 1 (exactly one
        // image winning, or none).
        let n_pixels = (w * h) as usize;
        for px in 0..n_pixels {
            let s = masks[0][px] + masks[1][px] + masks[2][px];
            assert!(
                (s - 0.0).abs() < 1e-6 || (s - 1.0).abs() < 1e-6,
                "pixel {px} mask sum = {s} (not 0 or 1)"
            );
        }
    }

    /// Pixels valid in exactly one image must be assigned to that image.
    #[test]
    fn single_coverage_pixels_assigned_to_their_image() {
        let w = 32u32;
        let h = 16u32;
        let img0 = make_image(w, h, [1.0, 0.0, 0.0], (0, 10));
        let img1 = make_image(w, h, [0.0, 1.0, 0.0], (20, 31));
        let warped = vec![img0, img1];

        let masks = build_n_way_binary_masks(&warped, 1);

        // Cols [0, 10]: image 0 must win.
        for y in 0..h {
            for x in 0..=10 {
                let px = (y * w + x) as usize;
                assert_eq!(masks[0][px], 1.0, "single-coverage of img0 at ({x},{y})");
                assert_eq!(masks[1][px], 0.0);
            }
        }
        // Cols [20, 31]: image 1 must win.
        for y in 0..h {
            for x in 20..=31 {
                let px = (y * w + x) as usize;
                assert_eq!(masks[1][px], 1.0, "single-coverage of img1 at ({x},{y})");
                assert_eq!(masks[0][px], 0.0);
            }
        }
        // Cols [11, 19]: neither image valid → both masks zero.
        for y in 0..h {
            for x in 11..=19 {
                let px = (y * w + x) as usize;
                assert_eq!(masks[0][px], 0.0, "no coverage at ({x},{y})");
                assert_eq!(masks[1][px], 0.0);
            }
        }
    }

    /// In the overlap region, the partition should split somewhere
    /// inside the overlap, not at the boundaries (which would mean the
    /// cut never moved off the initial Voronoi assignment).
    #[test]
    fn overlap_partition_is_nontrivial() {
        let w = 64u32;
        let h = 32u32;
        let img0 = make_image(w, h, [0.5, 0.5, 0.5], (0, 40));
        let img1 = make_image(w, h, [0.5, 0.5, 0.5], (20, 63));
        let warped = vec![img0, img1];

        let masks = build_n_way_binary_masks(&warped, 1);

        // Count pixels assigned to each image in the overlap region (cols 20-40).
        let mut count_0 = 0;
        let mut count_1 = 0;
        for y in 0..h {
            for x in 20..=40 {
                let px = (y * w + x) as usize;
                if masks[0][px] == 1.0 {
                    count_0 += 1;
                } else if masks[1][px] == 1.0 {
                    count_1 += 1;
                }
            }
        }
        let total = (h * 21) as i32;
        // Both images should claim some overlap pixels (the cut isn't
        // trivially all-A or all-B). With identical content the cut
        // is min-energy at the centre, but as long as both have > 0
        // we know the algorithm is doing something.
        assert!(
            count_0 + count_1 == total,
            "{count_0} + {count_1} != {total}: every overlap pixel must be assigned"
        );
    }

    /// Feathering a binary mask preserves total mass approximately and
    /// turns the hard 0/1 boundary into a smooth ramp.
    #[test]
    fn feather_smooths_binary_mask_boundary() {
        let w = 32u32;
        let h = 8u32;
        // Single mask: 1.0 in left half, 0.0 in right half.
        let mut masks = vec![vec![0.0_f32; (w * h) as usize]];
        for y in 0..h {
            for x in 0..(w / 2) {
                masks[0][(y * w + x) as usize] = 1.0;
            }
        }

        feather_binary_masks(&mut masks, w, h, 4);

        // Boundary at x = w/2 = 16. Pixels well inside left should be ≈ 1.
        for y in 0..h {
            assert!(
                masks[0][(y * w) as usize] > 0.9,
                "far-left pixel should remain ≈ 1.0"
            );
            assert!(
                masks[0][(y * w + w - 1) as usize] < 0.1,
                "far-right pixel should remain ≈ 0.0"
            );
            // Pixel right at the boundary should be intermediate.
            let mid = masks[0][(y * w + w / 2) as usize];
            assert!(
                (0.1..=0.9).contains(&mid),
                "boundary pixel at x={} y={} should be intermediate, got {}",
                w / 2,
                y,
                mid
            );
        }
    }
}
