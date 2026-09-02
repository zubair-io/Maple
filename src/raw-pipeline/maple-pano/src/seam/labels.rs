//! N-way content-aware seam labelling, built on top of the pairwise
//! [`super::pairwise::cut`] (spec §5.7, #1179).
//!
//! With `k` frames warped onto one canvas, adjacent-pair overlaps need a
//! single consistent partition: every covered canvas pixel picks
//! **exactly one** owning frame. [`compute_labels`] gets there by
//! **pairwise alpha-expansion** (the same strategy AliceVision's
//! `panoramaSeams` uses):
//!
//! 1. Initialise every covered pixel to the lowest-indexed frame valid
//!    there (a cheap, deterministic starting partition).
//! 2. Build the list of frame pairs that actually overlap.
//! 3. For each pair `(i, j)`, run the pairwise min-cut on the full
//!    canvas and apply its decision **only** to pixels currently
//!    labelled `i` or `j` — a pixel labelled by some other frame `k` is
//!    left for the `(i, k)` / `(j, k)` pass to resolve. Every such
//!    pair-cut is a valid alpha-expansion move, so the total seam energy
//!    is monotone non-increasing across passes.
//! 4. Repeat until fewer than [`CONVERGE_THRESHOLD`] of pixels change
//!    label in a full pass, or [`MAX_ITER`] passes have run.
//!
//! [`labels_to_masks`] converts the final label field into hard
//! per-frame binary masks, and [`feather_masks`] softens the boundaries
//! by one blend-band width so the seam isn't a visible one-pixel knife
//! edge in the final composite.

use rayon::prelude::*;

use crate::ingest::PlanarImage;

use super::pairwise;

/// Cap on alpha-expansion passes over the full overlap-pair list.
const MAX_ITER: u32 = 3;
/// Stop early once fewer than this fraction of canvas pixels change
/// label in a full pass (0.1%).
const CONVERGE_THRESHOLD: f64 = 0.001;

/// `-1` = uncovered by any frame.
pub const UNLABELLED: i32 = -1;

/// Every `(i, j)` with `i < j` whose frames share at least one valid
/// canvas pixel, sorted by descending overlap pixel count (largest
/// overlaps — the pairs alpha-expansion has the most to gain from —
/// resolved first).
fn overlapping_pairs(layers: &[PlanarImage]) -> Vec<(usize, usize)> {
    let n = layers.len();
    let mut pairs: Vec<(usize, usize, usize)> = Vec::new();
    for i in 0..n {
        for j in (i + 1)..n {
            let count = (0..layers[i].pixel_count())
                .filter(|&px| {
                    let (x, y) = (
                        (px % layers[i].width() as usize) as u32,
                        (px / layers[i].width() as usize) as u32,
                    );
                    layers[i].validity.get(x, y) && layers[j].validity.get(x, y)
                })
                .count();
            if count > 0 {
                pairs.push((i, j, count));
            }
        }
    }
    pairs.sort_by(|a, b| b.2.cmp(&a.2));
    pairs.into_iter().map(|(i, j, _)| (i, j)).collect()
}

/// Compute the N-way label field: one owning frame index per canvas
/// pixel (or [`UNLABELLED`]). `layers[i]` must all share the same canvas
/// dimensions — the caller (`seam::masks`) guarantees this since every
/// layer here is a warp onto the same [`crate::canvas::CanvasSpec`].
pub fn compute_labels(layers: &[PlanarImage]) -> Vec<i32> {
    let n = layers.len();
    if n == 0 {
        return Vec::new();
    }
    let (w, h) = (layers[0].width(), layers[0].height());
    let n_px = (w as usize) * (h as usize);

    // Step 1: Voronoi-by-first-valid initialisation.
    let mut labels = vec![UNLABELLED; n_px];
    for (px, label) in labels.iter_mut().enumerate() {
        let (x, y) = ((px % w as usize) as u32, (px / w as usize) as u32);
        for (i, layer) in layers.iter().enumerate() {
            if layer.validity.get(x, y) {
                *label = i as i32;
                break;
            }
        }
    }
    if n == 1 {
        return labels;
    }

    let pairs = overlapping_pairs(layers);

    for _ in 0..MAX_ITER {
        let mut changes: u64 = 0;
        for &(i, j) in &pairs {
            let use_b = pairwise::cut(&layers[i], &layers[j]);
            let (li, lj) = (i as i32, j as i32);
            for (px, label) in labels.iter_mut().enumerate() {
                if *label != li && *label != lj {
                    continue;
                }
                let proposed = if use_b[px] { lj } else { li };
                if proposed != *label {
                    let (x, y) = ((px % w as usize) as u32, (px / w as usize) as u32);
                    // Defensive: only move to a label whose frame is
                    // actually valid at this pixel.
                    if layers[proposed as usize].validity.get(x, y) {
                        *label = proposed;
                        changes += 1;
                    }
                }
            }
        }
        let frac = changes as f64 / n_px.max(1) as f64;
        if frac < CONVERGE_THRESHOLD {
            break;
        }
    }
    labels
}

/// Hard per-frame binary masks from the label field: `mask[i][px] = 1.0`
/// iff `labels[px] == i`, else `0.0`. Length `layers.len()`, each of
/// length `width * height`.
pub fn labels_to_masks(labels: &[i32], n_frames: usize) -> Vec<Vec<f32>> {
    let mut masks: Vec<Vec<f32>> = (0..n_frames).map(|_| vec![0.0_f32; labels.len()]).collect();
    for (px, &label) in labels.iter().enumerate() {
        if label >= 0 && (label as usize) < n_frames {
            masks[label as usize][px] = 1.0;
        }
    }
    masks
}

/// Soften each binary mask's boundary with a separable Gaussian feather
/// (radius in pixels, sigma = radius / 2) — the "one blend-band feather"
/// the ticket calls for. Without it a hard label boundary is a visible
/// one-pixel knife edge in the final composite; the feather gives the
/// blend a few pixels to hide any residual brightness mismatch across
/// the seam.
///
/// Feathering each mask independently can dip the per-pixel weight sum
/// slightly below 1 right at a boundary; callers that normalize by that
/// sum (as [`crate::blend::blend_multiband`]'s weighted-average contract
/// does) render it correctly regardless.
pub fn feather_masks(masks: &mut [Vec<f32>], width: u32, height: u32, radius: u32) {
    if radius == 0 {
        return;
    }
    let (w, h) = (width as usize, height as usize);
    let r = radius as i32;
    let sigma = (radius as f32 / 2.0).max(0.5);
    let two_sigma_sq = 2.0 * sigma * sigma;

    let mut kernel = Vec::with_capacity((2 * r + 1) as usize);
    let mut sum = 0.0_f32;
    for k in -r..=r {
        let v = (-(k as f32).powi(2) / two_sigma_sq).exp();
        kernel.push(v);
        sum += v;
    }
    for v in &mut kernel {
        *v /= sum;
    }

    masks.par_iter_mut().for_each(|mask| {
        let mut tmp = vec![0.0_f32; w * h];
        tmp.par_chunks_exact_mut(w)
            .enumerate()
            .for_each(|(y, row)| {
                for x in 0..w {
                    let mut acc = 0.0_f32;
                    for k in -r..=r {
                        let xx = (x as i32 + k).clamp(0, w as i32 - 1) as usize;
                        acc += kernel[(k + r) as usize] * mask[y * w + xx];
                    }
                    row[x] = acc;
                }
            });
        mask.par_chunks_exact_mut(w)
            .enumerate()
            .for_each(|(y, row)| {
                for x in 0..w {
                    let mut acc = 0.0_f32;
                    for k in -r..=r {
                        let yy = (y as i32 + k).clamp(0, h as i32 - 1) as usize;
                        acc += kernel[(k + r) as usize] * tmp[yy * w + x];
                    }
                    row[x] = acc;
                }
            });
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ingest::ValidityMask;

    fn frame(w: u32, h: u32, valid: impl Fn(u32, u32) -> bool, fill: [f32; 3]) -> PlanarImage {
        let n = (w as usize) * (h as usize);
        let mut mask = ValidityMask::new_filled(w, h, false);
        for y in 0..h {
            for x in 0..w {
                mask.set(x, y, valid(x, y));
            }
        }
        PlanarImage::from_planes(
            w,
            h,
            vec![fill[0]; n],
            vec![fill[1]; n],
            vec![fill[2]; n],
            mask,
        )
    }

    /// Three frames tiling a 30-wide canvas left/middle/right with 4px
    /// overlaps: every pixel must end up labelled by exactly one frame,
    /// and no pixel is ever assigned to a frame that isn't valid there.
    #[test]
    fn every_covered_pixel_gets_exactly_one_valid_label() {
        let h = 10;
        let left = frame(30, h, |x, _| x < 12, [0.2, 0.3, 0.4]);
        let mid = frame(30, h, |x, _| (8..22).contains(&x), [0.25, 0.32, 0.38]);
        let right = frame(30, h, |x, _| x >= 18, [0.3, 0.35, 0.42]);
        let layers = vec![left, mid, right];

        let labels = compute_labels(&layers);
        for y in 0..h {
            for x in 0..30u32 {
                let idx = (y * 30 + x) as usize;
                let l = labels[idx];
                assert!(l >= 0, "pixel ({x},{y}) uncovered");
                assert!(
                    layers[l as usize].validity.get(x, y),
                    "pixel ({x},{y}) labelled {l} but frame {l} isn't valid there"
                );
            }
        }
    }

    #[test]
    fn single_frame_is_labelled_everywhere_it_is_valid() {
        let layers = vec![frame(6, 6, |_, _| true, [0.5, 0.5, 0.5])];
        let labels = compute_labels(&layers);
        assert!(labels.iter().all(|&l| l == 0));
    }

    #[test]
    fn feather_preserves_mask_length_and_stays_in_unit_range() {
        let w = 10;
        let h = 8;
        let mut masks = vec![
            vec![0.0f32; (w * h) as usize],
            vec![1.0f32; (w * h) as usize],
        ];
        feather_masks(&mut masks, w, h, 3);
        for m in &masks {
            assert_eq!(m.len(), (w * h) as usize);
            for &v in m {
                assert!(
                    (-1e-4..=1.0001).contains(&v),
                    "feathered weight {v} out of range"
                );
            }
        }
    }
}
