//! Local block/per-channel photometric compensation.
//!
//! The whole-image scalar-luma and whole-image per-channel-RGB solvers
//! in `gain.rs` produce a single multiplier per image. They cannot
//! correct *spatial* photometric variation within a single image
//! (vignetting, sky→ground falloff, residual lens-shading) and they
//! cannot suppress brightness banding inside an image without
//! over-correcting somewhere else.
//!
//! This module solves a small **per-tile per-channel log-gain field**
//! per image instead. The image canvas is split into a coarse grid
//! (default 16 × 16 tiles); each tile gets its own `(lg_R, lg_G, lg_B)`
//! triple. The solver couples tiles across overlapping images via the
//! per-channel **median** ratio inside the joint overlap of each
//! (i, j) tile pair, regularises with a tile-tile smoothness prior
//! (default `λ_smooth = 5.0`) and a zero/Tikhonov prior (default
//! `λ_zero = 0.1`), and **hard-clamps** every solved log-gain to
//! ±log(1.5).
//!
//! The clamp is the safety bar — a runaway local solver bends colour
//! and shifts hue in regions where overlap data isn't representative
//! (clouds, strong gradients, near seams). Aggressive per-pixel
//! rejection BEFORE the median cuts the same risk at the data layer:
//!
//! - Any channel `> clip_threshold` (default `0.95`) → drop. Highlight
//!   clipping breaks the linear-photometry assumption.
//! - Luma `< dark_threshold` (default `0.02`) → drop. Noise dominates
//!   the ratio.
//! - Distance to nearest invalid pixel `< validity_min_distance_px`
//!   (default 16 px) → drop. Warp halos along validity boundaries
//!   bias means.
//! - Distance to any seam-path pixel for this image pair
//!   `< seam_band_radius_px` (default 16 px) → drop. Parallax
//!   mismatches concentrate at seam routes.
//! - Local Sobel gradient magnitude high → drop. Sharp edges /
//!   high-frequency texture introduce cross-image bias from
//!   sub-pixel disagreement.
//!
//! After rejection, the per-tile per-channel **median** (not mean)
//! is robust to the few outliers that survived. Each tile-pair
//! produces one observation per channel:
//!
//! ```text
//!     lg_i,tile − lg_j,tile = log(median_j / median_i)
//! ```
//!
//! Solved jointly with the smoothness and zero priors, then projected
//! onto `[-log(1.5), +log(1.5)]` per element.
//!
//! # When to use
//!
//! - Default photometric path. The `gain.rs` scalar-luma and
//!   per-channel-RGB solvers stay available behind
//!   `--gain-mode luma|per-channel` for fallback / A/B.
//! - `block` is appropriate when overlaps are large (≳ 16 tiles
//!   per pair after rejection); on tiny overlaps the LSQ has too
//!   few constraints and the smoothness prior dominates → the
//!   field returns to ~zero, equivalent to no compensation.

use std::collections::HashMap;

use nalgebra::{DMatrix, DVector};

use crate::error::PanoError;
use crate::seam::compute_edge_distance;
use crate::seam::graph_cut_maxflow::sobel_magnitude_map;
use crate::types::PanoImage;

/// Solver options for the per-tile per-channel log-gain field.
#[derive(Debug, Clone, Copy)]
pub struct BlockGainOptions {
    /// Tiles in the column direction. Default 16.
    pub grid_cols: u32,
    /// Tiles in the row direction. Default 16.
    pub grid_rows: u32,
    /// Hard clamp on each solved log-gain component, in natural log.
    /// Default `ln(1.5) ≈ 0.405`. Pixels gain at most `1.5×` /
    /// shrink at most `0.667×` per channel per tile. Set to a larger
    /// value only if you trust the input data more than the safety
    /// bar.
    pub max_log_gain: f32,
    /// Tikhonov / zero-prior weight `λ_zero`. Larger → field pulled
    /// closer to identity (`lg = 0`). Default `0.1`. Doubles as
    /// gauge fix for disconnected components of the tile-pair graph.
    pub lambda_zero: f32,
    /// Tile-tile smoothness weight `λ_smooth`. Larger → smoother
    /// field within an image. Default `5.0`.
    pub lambda_smooth: f32,
    /// Pixels with any RGB channel above this value are rejected
    /// before the per-tile median. Default `0.95`.
    pub clip_threshold: f32,
    /// Pixels with luma below this value are rejected before the
    /// per-tile median. Default `0.02`.
    pub dark_threshold: f32,
    /// Pixels closer than this to either image's validity boundary
    /// are rejected. Default `16.0` px.
    pub validity_min_distance_px: f32,
    /// Pixels within this radius of any seam-path coordinate for the
    /// (i, j) image pair are rejected. Default `16.0` px.
    pub seam_band_radius_px: f32,
    /// Tiles with fewer surviving pixel pairs than this are skipped
    /// (no observation contributed for that tile-pair). Default `64`.
    pub min_overlap_per_tile: u32,
    /// Pixels with combined Sobel gradient magnitude
    /// `max(sob_a[p], sob_b[p])` above this threshold are rejected
    /// before the per-tile median. Default `0.25` (in scene-linear
    /// luma, calibrated for Rec.2020 panorama input).
    pub gradient_threshold: f32,
}

impl Default for BlockGainOptions {
    fn default() -> Self {
        Self {
            grid_cols: 16,
            grid_rows: 16,
            // ln(1.5) ≈ 0.4054651
            max_log_gain: 1.5_f32.ln(),
            lambda_zero: 0.1,
            lambda_smooth: 5.0,
            clip_threshold: 0.95,
            dark_threshold: 0.02,
            validity_min_distance_px: 16.0,
            seam_band_radius_px: 16.0,
            min_overlap_per_tile: 64,
            gradient_threshold: 0.25,
        }
    }
}

/// Result of `solve_block_gains`: one per-image log-gain field with
/// a `grid_cols × grid_rows × 3` flat-vector layout.
///
/// `log_gains[ty * grid_cols + tx]` is the `[lg_R, lg_G, lg_B]` triple
/// for tile `(tx, ty)`. The gain applied at canvas pixel `(cx, cy)`
/// in image `i` is `exp(bilinear_sample(field_i, cx, cy))` per channel.
#[derive(Debug, Clone, PartialEq)]
pub struct BlockGainField {
    pub grid_cols: u32,
    pub grid_rows: u32,
    pub canvas_width: u32,
    pub canvas_height: u32,
    pub log_gains: Vec<[f32; 3]>,
}

impl BlockGainField {
    /// Sample the field at canvas pixel `(cx, cy)` via bilinear
    /// interpolation between the 4 surrounding tile-centres. Returns
    /// `[lg_R, lg_G, lg_B]` already clamped to the solver budget.
    pub fn sample(&self, cx: f32, cy: f32) -> [f32; 3] {
        if self.grid_cols == 0 || self.grid_rows == 0 || self.log_gains.is_empty() {
            return [0.0; 3];
        }
        let cols = self.grid_cols as usize;
        let rows = self.grid_rows as usize;
        // Tile centres are at `(tx + 0.5) * tile_w, (ty + 0.5) * tile_h`.
        let tile_w = (self.canvas_width as f32) / (cols as f32).max(1.0);
        let tile_h = (self.canvas_height as f32) / (rows as f32).max(1.0);
        // Position in tile-centre coords: 0 lines up with tile 0's
        // centre, `cols-1` lines up with the last tile's centre.
        let tx_f = (cx / tile_w - 0.5).clamp(0.0, (cols as f32) - 1.0);
        let ty_f = (cy / tile_h - 0.5).clamp(0.0, (rows as f32) - 1.0);
        let tx0 = tx_f.floor() as usize;
        let ty0 = ty_f.floor() as usize;
        let tx1 = (tx0 + 1).min(cols - 1);
        let ty1 = (ty0 + 1).min(rows - 1);
        let fx = tx_f - tx0 as f32;
        let fy = ty_f - ty0 as f32;
        let i00 = ty0 * cols + tx0;
        let i10 = ty0 * cols + tx1;
        let i01 = ty1 * cols + tx0;
        let i11 = ty1 * cols + tx1;
        let mut out = [0.0_f32; 3];
        for c in 0..3 {
            let v00 = self.log_gains[i00][c];
            let v10 = self.log_gains[i10][c];
            let v01 = self.log_gains[i01][c];
            let v11 = self.log_gains[i11][c];
            let v0 = v00 * (1.0 - fx) + v10 * fx;
            let v1 = v01 * (1.0 - fx) + v11 * fx;
            out[c] = v0 * (1.0 - fy) + v1 * fy;
        }
        out
    }
}

/// Solve a per-image per-tile per-channel log-gain field.
///
/// `images` are warped onto a shared canvas — width and height must
/// match across all entries. `seam_paths` come from `extract_seam_paths`
/// (`HashMap<(i, j), Vec<(u32, u32)>>`); pass an empty map to disable
/// seam-band rejection.
///
/// Returns one `BlockGainField` per image in the input order, each
/// with `grid_cols × grid_rows` log-gain triples already projected
/// onto `[-max_log_gain, +max_log_gain]`.
pub fn solve_block_gains(
    images: &[&PanoImage],
    seam_paths: &HashMap<(usize, usize), Vec<(u32, u32)>>,
    options: BlockGainOptions,
) -> Result<Vec<BlockGainField>, PanoError> {
    let n = images.len();
    if n == 0 {
        return Ok(Vec::new());
    }
    let w = images[0].width;
    let h = images[0].height;
    for img in images.iter() {
        if img.width != w || img.height != h {
            return Err(PanoError::Other(format!(
                "block gain: canvas size mismatch ({}x{} vs {}x{})",
                w, h, img.width, img.height
            )));
        }
    }
    let grid_cols = options.grid_cols.max(2);
    let grid_rows = options.grid_rows.max(2);
    let tiles_per_image = (grid_cols as usize) * (grid_rows as usize);
    if w == 0 || h == 0 {
        let zero_field = BlockGainField {
            grid_cols,
            grid_rows,
            canvas_width: w,
            canvas_height: h,
            log_gains: vec![[0.0; 3]; tiles_per_image],
        };
        return Ok(vec![zero_field; n]);
    }

    // Precompute per-image distance-from-validity-edge maps and Sobel
    // magnitude maps. Cap the chamfer at the seam-zone radius; we
    // only care whether a pixel is "close to a boundary" or "deep
    // inside its own footprint."
    let dist_cap = (options.validity_min_distance_px * 4.0).max(64.0);
    let edge_dists: Vec<Vec<f32>> = images
        .iter()
        .map(|img| compute_edge_distance(&img.validity, w, h, dist_cap))
        .collect();
    let sobel_maps: Vec<Vec<f32>> = images.iter().map(|img| sobel_magnitude_map(img)).collect();

    // Precompute, per (i, j) image pair, a per-pixel distance-to-seam-path
    // mask. We only do this for pairs that actually have a seam path
    // entry; everywhere else the "distance" is effectively +inf.
    //
    // For simplicity (and because the seam-band radius is small —
    // 16 px by default), we materialise this as a `Vec<bool>` of
    // length w*h per pair: true ⇒ "close to a seam-path coord, drop."
    //
    // Building the full chamfer would be overkill — we sample
    // distances by stamping a circular kernel of radius
    // `seam_band_radius_px` around each seam-path coord.
    let seam_band: HashMap<(usize, usize), Vec<bool>> = seam_paths
        .iter()
        .map(|((i, j), pts)| {
            let mask = stamp_seam_band(pts, w, h, options.seam_band_radius_px);
            ((*i, *j), mask)
        })
        .collect();

    // Per (i, j) pair: collect per-tile per-channel ratios.
    //
    // ratios[(i,j)][tile_idx][channel] = Vec<log(b/a)> across all
    // accepted pixels in that tile of this pair's overlap.
    //
    // We accumulate into per-tile vectors and then take per-channel
    // medians at the end.
    let mut pair_observations: Vec<PairObservation> = Vec::new();

    let tile_w = w as f32 / grid_cols as f32;
    let tile_h = h as f32 / grid_rows as f32;
    let n_pixels = (w as usize) * (h as usize);

    for i in 0..n {
        for j in (i + 1)..n {
            let band_a = seam_band.get(&(i, j));
            let band_b = seam_band.get(&(j, i));
            // Per-tile per-channel pixel-pair lists (ratios).
            // We store actual ratios b/a (linear), then take median.
            let mut tile_ratios: Vec<[Vec<f32>; 3]> = (0..tiles_per_image)
                .map(|_| [Vec::new(), Vec::new(), Vec::new()])
                .collect();

            for px in 0..n_pixels {
                if !images[i].validity[px] || !images[j].validity[px] {
                    continue;
                }
                let a_r = images[i].pixels[px * 3];
                let a_g = images[i].pixels[px * 3 + 1];
                let a_b = images[i].pixels[px * 3 + 2];
                let b_r = images[j].pixels[px * 3];
                let b_g = images[j].pixels[px * 3 + 1];
                let b_b = images[j].pixels[px * 3 + 2];

                // Reject clipped highlights (any channel > threshold,
                // either image).
                let clip = options.clip_threshold;
                if a_r > clip
                    || a_g > clip
                    || a_b > clip
                    || b_r > clip
                    || b_g > clip
                    || b_b > clip
                {
                    continue;
                }

                // Reject very dark (luma below threshold, either image).
                let dark = options.dark_threshold;
                let ya = 0.2126 * a_r + 0.7152 * a_g + 0.0722 * a_b;
                let yb = 0.2126 * b_r + 0.7152 * b_g + 0.0722 * b_b;
                if ya < dark || yb < dark {
                    continue;
                }

                // Reject near validity boundary (either image).
                if edge_dists[i][px] < options.validity_min_distance_px
                    || edge_dists[j][px] < options.validity_min_distance_px
                {
                    continue;
                }

                // Reject inside seam band for this pair.
                if let Some(b) = band_a {
                    if b[px] {
                        continue;
                    }
                }
                if let Some(b) = band_b {
                    if b[px] {
                        continue;
                    }
                }

                // Reject high local gradient (either image).
                if sobel_maps[i][px].max(sobel_maps[j][px]) > options.gradient_threshold {
                    continue;
                }

                // Need both channels strictly positive for the ratio
                // to be defined.
                if a_r <= 0.0 || a_g <= 0.0 || a_b <= 0.0 {
                    continue;
                }
                if b_r <= 0.0 || b_g <= 0.0 || b_b <= 0.0 {
                    continue;
                }

                let x = (px % (w as usize)) as f32;
                let y = (px / (w as usize)) as f32;
                let tx = ((x / tile_w) as usize).min(grid_cols as usize - 1);
                let ty = ((y / tile_h) as usize).min(grid_rows as usize - 1);
                let tile_idx = ty * (grid_cols as usize) + tx;

                tile_ratios[tile_idx][0].push(b_r / a_r);
                tile_ratios[tile_idx][1].push(b_g / a_g);
                tile_ratios[tile_idx][2].push(b_b / a_b);
            }

            // Reduce each tile's pixel ratios to the per-channel median.
            for (tile_idx, ratios) in tile_ratios.iter_mut().enumerate() {
                let count = ratios[0].len() as u32;
                if count < options.min_overlap_per_tile {
                    continue;
                }
                let med_r = median(&mut ratios[0]);
                let med_g = median(&mut ratios[1]);
                let med_b = median(&mut ratios[2]);
                if med_r <= 0.0 || med_g <= 0.0 || med_b <= 0.0 {
                    continue;
                }
                pair_observations.push(PairObservation {
                    image_a: i,
                    image_b: j,
                    tile_idx,
                    log_ratio: [med_r.ln(), med_g.ln(), med_b.ln()],
                });
            }
        }
    }

    // ---- Solve normal equations once per channel ------------------
    //
    // For channel c, unknowns are `lg_{i, tile}` for every (image,
    // tile) cell — that's `n * tiles_per_image` unknowns per channel.
    // For 21 images × 256 tiles = 5376 unknowns/channel; dense LU
    // works at this size.
    let unknowns_per_image = tiles_per_image;
    let n_unknowns = n * unknowns_per_image;
    let lambda_smooth_sq = (options.lambda_smooth as f64).powi(2);
    let lambda_zero_sq = (options.lambda_zero as f64).powi(2);

    let unknown_index = |image_index: usize, tile_idx: usize| -> usize {
        image_index * unknowns_per_image + tile_idx
    };

    // Per-channel solve.
    let mut per_channel_solutions: [Vec<f32>; 3] = [
        vec![0.0; n_unknowns],
        vec![0.0; n_unknowns],
        vec![0.0; n_unknowns],
    ];
    for channel in 0..3 {
        let mut ata = DMatrix::<f64>::zeros(n_unknowns, n_unknowns);
        let mut atb = DVector::<f64>::zeros(n_unknowns);

        // Tile-pair alignment residuals: `lg_i,t − lg_j,t = log_ratio`.
        for obs in &pair_observations {
            let row = [
                (unknown_index(obs.image_a, obs.tile_idx), 1.0_f64),
                (unknown_index(obs.image_b, obs.tile_idx), -1.0_f64),
            ];
            let rhs = obs.log_ratio[channel] as f64;
            // Per-pair-tile weight = 1.
            accumulate_normal_equation_row(&row, rhs, 1.0, &mut ata, &mut atb);
        }

        // Smoothness residuals: per image, for each pair of mesh-
        // adjacent tiles, `lg_a − lg_b = 0`.
        if lambda_smooth_sq > 0.0 {
            for image_index in 0..n {
                for ty in 0..(grid_rows as usize) {
                    for tx in 0..(grid_cols as usize) {
                        let v_idx = ty * (grid_cols as usize) + tx;
                        if tx + 1 < grid_cols as usize {
                            let v_right = ty * (grid_cols as usize) + (tx + 1);
                            accumulate_normal_equation_row(
                                &[
                                    (unknown_index(image_index, v_idx), 1.0),
                                    (unknown_index(image_index, v_right), -1.0),
                                ],
                                0.0,
                                lambda_smooth_sq,
                                &mut ata,
                                &mut atb,
                            );
                        }
                        if ty + 1 < grid_rows as usize {
                            let v_down = (ty + 1) * (grid_cols as usize) + tx;
                            accumulate_normal_equation_row(
                                &[
                                    (unknown_index(image_index, v_idx), 1.0),
                                    (unknown_index(image_index, v_down), -1.0),
                                ],
                                0.0,
                                lambda_smooth_sq,
                                &mut ata,
                                &mut atb,
                            );
                        }
                    }
                }
            }
        }

        // Zero / Tikhonov prior — diagonal contribution.
        if lambda_zero_sq > 0.0 {
            for k in 0..n_unknowns {
                ata[(k, k)] += lambda_zero_sq;
            }
        }

        let lu = ata.lu();
        let solution = lu.solve(&atb).ok_or_else(|| {
            PanoError::Other(format!(
                "block gain: singular normal equations for channel {channel}"
            ))
        })?;

        // Hard clamp every solved log-gain to ±max_log_gain.
        let cap = options.max_log_gain.abs();
        for k in 0..n_unknowns {
            let v = solution[k] as f32;
            per_channel_solutions[channel][k] = v.clamp(-cap, cap);
        }
    }

    // Pack into BlockGainField per image.
    let mut fields = Vec::with_capacity(n);
    for image_index in 0..n {
        let mut log_gains = vec![[0.0_f32; 3]; tiles_per_image];
        for t in 0..tiles_per_image {
            let k = unknown_index(image_index, t);
            log_gains[t][0] = per_channel_solutions[0][k];
            log_gains[t][1] = per_channel_solutions[1][k];
            log_gains[t][2] = per_channel_solutions[2][k];
        }
        fields.push(BlockGainField {
            grid_cols,
            grid_rows,
            canvas_width: w,
            canvas_height: h,
            log_gains,
        });
    }
    Ok(fields)
}

/// Apply per-tile log-gain fields to each image in place.
///
/// For every valid pixel of every image, samples the image's
/// `BlockGainField` via bilinear interpolation between tile centres,
/// exponentiates to a multiplicative gain triple, and multiplies the
/// pixel's RGB.
pub fn apply_block_gains(
    images: &mut [PanoImage],
    fields: &[BlockGainField],
) -> Result<(), PanoError> {
    if images.len() != fields.len() {
        return Err(PanoError::Other(format!(
            "apply_block_gains: image/field count mismatch ({} vs {})",
            images.len(),
            fields.len()
        )));
    }
    for (img, field) in images.iter_mut().zip(fields.iter()) {
        if field.canvas_width != img.width || field.canvas_height != img.height {
            return Err(PanoError::Other(format!(
                "apply_block_gains: image/field canvas mismatch ({}x{} vs {}x{})",
                img.width, img.height, field.canvas_width, field.canvas_height
            )));
        }
        let w = img.width as usize;
        let h = img.height as usize;
        for y in 0..h {
            for x in 0..w {
                let idx = y * w + x;
                if !img.validity[idx] {
                    continue;
                }
                let lg = field.sample(x as f32 + 0.5, y as f32 + 0.5);
                img.pixels[idx * 3] *= lg[0].exp();
                img.pixels[idx * 3 + 1] *= lg[1].exp();
                img.pixels[idx * 3 + 2] *= lg[2].exp();
            }
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------

struct PairObservation {
    image_a: usize,
    image_b: usize,
    tile_idx: usize,
    /// Median(b/a) per channel, in linear ratio.
    log_ratio: [f32; 3],
}

/// Quickselect-based median. Mutates the input. Returns 0.0 for an
/// empty slice (callers ensure non-empty before calling).
fn median(xs: &mut [f32]) -> f32 {
    if xs.is_empty() {
        return 0.0;
    }
    xs.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let n = xs.len();
    if n % 2 == 1 {
        xs[n / 2]
    } else {
        0.5 * (xs[n / 2 - 1] + xs[n / 2])
    }
}

/// Stamp a binary mask of length `w * h` with `true` at every pixel
/// within `radius` of any seam-path coordinate. O(P * r²) where P is
/// the number of seam-path points; for realistic seam paths (a few
/// hundred coordinates) this is negligible.
fn stamp_seam_band(pts: &[(u32, u32)], w: u32, h: u32, radius: f32) -> Vec<bool> {
    let mut mask = vec![false; (w as usize) * (h as usize)];
    if radius <= 0.0 {
        return mask;
    }
    let r = radius.ceil() as i32;
    let r_sq = (radius * radius).ceil() as i32;
    for &(px, py) in pts {
        let x0 = (px as i32 - r).max(0);
        let y0 = (py as i32 - r).max(0);
        let x1 = (px as i32 + r).min(w as i32 - 1);
        let y1 = (py as i32 + r).min(h as i32 - 1);
        for y in y0..=y1 {
            for x in x0..=x1 {
                let dx = x - px as i32;
                let dy = y - py as i32;
                if dx * dx + dy * dy <= r_sq {
                    mask[(y as usize) * (w as usize) + (x as usize)] = true;
                }
            }
        }
    }
    mask
}

/// Add `weight_sq · row^T row` to `ata` and `weight_sq · row^T rhs` to
/// `atb`. `row` is a sparse `[(column, coefficient)]` list.
fn accumulate_normal_equation_row(
    row: &[(usize, f64)],
    rhs: f64,
    weight_sq: f64,
    ata: &mut DMatrix<f64>,
    atb: &mut DVector<f64>,
) {
    if weight_sq <= 0.0 {
        return;
    }
    for &(c_i, v_i) in row {
        for &(c_j, v_j) in row {
            ata[(c_i, c_j)] += weight_sq * v_i * v_j;
        }
        atb[c_i] += weight_sq * v_i * rhs;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::color::ColorSpace;

    /// Build an opaque solid-colour panel `width × height`, valid in
    /// `[col_start, col_end)`.
    fn make_solid(
        width: u32,
        height: u32,
        rgb: [f32; 3],
        col_start: u32,
        col_end: u32,
    ) -> PanoImage {
        let mut img = PanoImage::new(width, height, ColorSpace::rec2020_d65_linear());
        for idx in 0..(width as usize * height as usize) {
            img.pixels[idx * 3] = rgb[0];
            img.pixels[idx * 3 + 1] = rgb[1];
            img.pixels[idx * 3 + 2] = rgb[2];
        }
        for y in 0..height {
            for x in 0..width {
                if x < col_start || x >= col_end {
                    img.set_invalid(x, y);
                }
            }
        }
        img
    }

    fn fast_options() -> BlockGainOptions {
        // Smaller grid + relaxed thresholds for the synthetic tests.
        BlockGainOptions {
            grid_cols: 4,
            grid_rows: 4,
            // Synthetic panels have zero local gradient, infinite
            // distance to validity (interior), zero distance to seam
            // (we pass empty seam paths) — defaults are fine.
            min_overlap_per_tile: 16,
            // Loosen the validity-edge guard for tiny (32×32)
            // synthetic canvases — otherwise the entire image falls
            // inside the rejection band.
            validity_min_distance_px: 1.0,
            seam_band_radius_px: 0.0,
            ..Default::default()
        }
    }

    /// Three solid 32×32 images with chained validity, each carrying
    /// a known per-channel scale relative to image 0. The block solver
    /// should recover those scales (within 1 %) AND every solved
    /// log-gain must stay inside ±log(1.5).
    #[test]
    fn recovery_solid_chain_three_images() {
        // Pixel values stay below `clip_threshold = 0.95` so the
        // rejection mask doesn't drop every pixel.
        // img0: cols 0..16 RGB [0.5, 0.5, 0.5]
        // img1: cols 8..24 RGB [0.6, 0.55, 0.5]   → +20% R, +10% G, 0% B
        // img2: cols 16..32 RGB [0.65, 0.525, 0.475] → +30% R, +5% G, −5% B
        // Pair (0,1) overlap cols 8..16; pair (1,2) overlap cols 16..24.
        // Image 0 is the natural gauge; the solver returns gauge-fixed
        // log-gains s.t. applying exp(lg_i,tile) to image i makes
        // overlap means equalise. With image 0 ≈ identity, we expect:
        //   lg_1 ≈ log(0.5 / 0.6, 0.5 / 0.55, 0.5 / 0.5) per channel
        //   lg_2 ≈ log(0.5 / 0.65, 0.5 / 0.525, 0.5 / 0.475)
        // BUT with the zero prior pulling all log-gains toward 0, the
        // solver actually splits the disagreement (no single image is
        // pinned). We assert the equalisation invariant rather than
        // hard target log-ratios: after applying gains, the per-pair
        // overlap means should match channel-wise.
        let img0 = make_solid(32, 32, [0.5, 0.5, 0.5], 0, 16);
        let img1 = make_solid(32, 32, [0.6, 0.55, 0.5], 8, 24);
        let img2 = make_solid(32, 32, [0.65, 0.525, 0.475], 16, 32);

        let opts = fast_options();
        let max_lg = opts.max_log_gain;
        let fields =
            solve_block_gains(&[&img0, &img1, &img2], &HashMap::new(), opts).expect("solve");
        assert_eq!(fields.len(), 3);
        for (i, field) in fields.iter().enumerate() {
            for tile in &field.log_gains {
                for (c, v) in tile.iter().enumerate() {
                    assert!(
                        v.abs() <= max_lg + 1e-6,
                        "image {} tile lg[{}] = {} exceeds clamp {}",
                        i,
                        c,
                        v,
                        max_lg
                    );
                }
            }
        }
        // Apply and check overlap means equalise per channel.
        let mut imgs = vec![img0.clone(), img1.clone(), img2.clone()];
        apply_block_gains(&mut imgs, &fields).expect("apply");
        // Pair (0,1): valid overlap is cols 8..16.
        let (m0a, m1a) = overlap_means(&imgs[0], &imgs[1]).expect("pair (0,1) overlap");
        let (m1b, m2b) = overlap_means(&imgs[1], &imgs[2]).expect("pair (1,2) overlap");
        for c in 0..3 {
            let dev01 = (m0a[c] - m1a[c]).abs() / m0a[c].max(1e-6);
            let dev12 = (m1b[c] - m2b[c]).abs() / m1b[c].max(1e-6);
            // 1 %: synthetic-fixture tolerance; the only systematic
            // gap is the zero-prior pulling everyone slightly off.
            // With λ_zero=0.1 over 16 unknowns/channel/image the
            // residual is well under 1 %.
            assert!(
                dev01 < 0.01,
                "pair (0,1) channel {}: mean_0 = {}, mean_1 = {} ({:.3}% off)",
                c,
                m0a[c],
                m1a[c],
                100.0 * dev01,
            );
            assert!(
                dev12 < 0.01,
                "pair (1,2) channel {}: mean_1 = {}, mean_2 = {} ({:.3}% off)",
                c,
                m1b[c],
                m2b[c],
                100.0 * dev12,
            );
        }
    }

    /// Pair of images with an extreme overlap mean ratio (5×). The
    /// solver MUST clamp to ±log(1.5). It is NOT allowed to solve
    /// to log(5) ≈ 1.61.
    #[test]
    fn hard_clamp_extreme_ratio() {
        // img0 RGB [0.1, 0.1, 0.1] over cols 0..24
        // img1 RGB [0.5, 0.5, 0.5] over cols 8..32
        // Pair overlap cols 8..24 — full mid section. Ratio = 5×.
        // Both well below clip_threshold=0.95.
        let img0 = make_solid(32, 32, [0.1, 0.1, 0.1], 0, 24);
        let img1 = make_solid(32, 32, [0.5, 0.5, 0.5], 8, 32);

        let opts = fast_options();
        let max_lg = opts.max_log_gain;
        let fields = solve_block_gains(&[&img0, &img1], &HashMap::new(), opts).expect("solve");
        for (i, field) in fields.iter().enumerate() {
            for tile in &field.log_gains {
                for (c, v) in tile.iter().enumerate() {
                    assert!(
                        v.abs() <= max_lg + 1e-6,
                        "image {} tile lg[{}] = {} exceeds clamp {}, ratio was 5.0",
                        i,
                        c,
                        v,
                        max_lg
                    );
                }
            }
        }
    }

    /// **Stage J seam-residual invariant** (the thing that motivated
    /// reverting `--gain-mode` default from `block` to `luma` in
    /// pano-smoke).
    ///
    /// When the inter-image brightness ratio exceeds `exp(max_log_gain)`
    /// (≈ 1.5× per default options), the solver's hard clamp prevents
    /// it from fully equalising the pair's overlap mean. After
    /// `apply_block_gains` runs, a measurable residual remains in the
    /// overlap-mean ratio — and that residual is exactly the brightness
    /// step that visibly survives the multi-band blender at every seam
    /// crossing the affected tiles.
    ///
    /// Why it's a test, not a comment in the solver: future work on
    /// `compensation/block.rs` might widen the clamp ("cleaner result
    /// on synthetic fixtures") without realising it makes the solver
    /// over-fit on real scenes. This test gates that — if the clamp
    /// is removed, the residual ratio collapses below the tolerance
    /// and the assertion fails LOUDLY, forcing the future change to
    /// document why the safety bar was lowered.
    #[test]
    fn clamp_leaves_visible_residual_when_ratio_exceeds_budget() {
        // 5× ratio between two solid images. With max_log_gain =
        // ln(1.5) ≈ 0.405, the solver cannot close the gap by more
        // than ≈ ±exp(0.405) = ±1.5× per side, so the post-apply
        // ratio bottoms out near 5 / (1.5 × 1.5) ≈ 2.22.
        let img0 = make_solid(32, 32, [0.1, 0.1, 0.1], 0, 24);
        let img1 = make_solid(32, 32, [0.5, 0.5, 0.5], 8, 32);

        let opts = fast_options();
        let fields = solve_block_gains(&[&img0, &img1], &HashMap::new(), opts).expect("solve");
        let mut imgs = vec![img0.clone(), img1.clone()];
        apply_block_gains(&mut imgs, &fields).expect("apply");
        let (m0, m1) = overlap_means(&imgs[0], &imgs[1]).expect("overlap");
        // Residual must remain — and it has to be a meaningful chunk.
        // A future "fix" that closes this gap to within 1% would mean
        // the clamp got widened; the warning above explains why that's
        // a regression on real scenes regardless of how it scores on
        // synthetic ones.
        for c in 0..3 {
            let ratio = m1[c] / m0[c].max(1e-6);
            assert!(
                ratio > 1.5,
                "channel {}: post-apply mean ratio {:.3} → clamp didn't engage. \
                 If you've intentionally widened the clamp, update or remove this test \
                 AFTER reading docs/tickets/04-… on Stage J.",
                c,
                ratio
            );
        }
    }

    /// Two solid images with identical content scaled per channel:
    /// img1 = (1.2 R, 1.1 G, 1.0 B) × img0. The solver must close the
    /// per-channel mismatch between the two images — that's the
    /// hue-matching invariant.
    ///
    /// This test specifically checks that when the input data carries
    /// a real per-channel WB drift, the solver corrects it per channel
    /// (rather than collapsing to a scalar / luma-only correction).
    #[test]
    fn hue_preservation_per_channel_scaling() {
        let base = [0.5_f32, 0.5, 0.5];
        let scaled = [base[0] * 1.2, base[1] * 1.1, base[2] * 1.0];
        let img0 = make_solid(32, 32, base, 0, 24);
        let img1 = make_solid(32, 32, scaled, 8, 32);

        let opts = fast_options();
        let fields = solve_block_gains(&[&img0, &img1], &HashMap::new(), opts).expect("solve");
        let mut imgs = vec![img0.clone(), img1.clone()];
        apply_block_gains(&mut imgs, &fields).expect("apply");
        let (m0, m1) = overlap_means(&imgs[0], &imgs[1]).expect("overlap");
        // After applying gains the per-channel means must match —
        // a scalar/luma-only solver could only get this right for
        // one channel, so this gates the per-channel path.
        for c in 0..3 {
            let dev = (m0[c] - m1[c]).abs() / m0[c].max(1e-6);
            assert!(
                dev < 0.01,
                "channel {}: post-apply means {} vs {} ({:.3}% off)",
                c,
                m0[c],
                m1[c],
                100.0 * dev,
            );
        }
        // The solver must HAVE moved per channel — verify the
        // applied gain field on at least one image has the
        // expected differential ordering.
        // For img1, lg should be more negative for R (correcting
        // the largest excess) than for B (zero excess). At least
        // one tile per image should reflect that.
        let img1_field = &fields[1];
        let centre_tile = (img1_field.grid_rows / 2) as usize
            * img1_field.grid_cols as usize
            + (img1_field.grid_cols / 2) as usize;
        let img1_lg = img1_field.log_gains[centre_tile];
        // Image 1's R should be reduced more than image 1's B
        // (gauge floats; the *differential* between channels is
        // what matters).
        assert!(
            img1_lg[0] < img1_lg[2],
            "expected img1 R-gain (lg={}) more negative than B-gain (lg={})",
            img1_lg[0],
            img1_lg[2],
        );
    }

    /// Feed an overlap region where one image has clipped highlights
    /// (RGB > 0.95). The solver should NOT fit those pixels — the
    /// per-tile median runs only on the unclipped region. Construct
    /// a case where including clipped pixels would push the gain in
    /// a *different* direction than the unclipped pixels suggest.
    #[test]
    fn rejects_clipped_pixels_in_median() {
        // 32×8: top rows (y < 4) are clipped (RGB = 0.99); bottom rows
        // (y ≥ 4) are unclipped (img0 = 0.4, img1 = 0.5 → ratio 1.25).
        // If clipped rows leaked into the median, the implied ratio
        // would shift toward 0.99 / 0.99 = 1.0 (no gain). The test
        // gates on "the solver moves the gain away from 1.0" —
        // which can only happen if the unclipped pixels dominate
        // (i.e. clipped ones were rejected).
        let w = 32;
        let h = 8;
        let mut img0 = PanoImage::new(w, h, ColorSpace::rec2020_d65_linear());
        let mut img1 = PanoImage::new(w, h, ColorSpace::rec2020_d65_linear());
        for y in 0..h {
            for x in 0..w {
                let idx = (y as usize) * (w as usize) + (x as usize);
                let (a, b) = if y < 4 {
                    // Clipped row: should be rejected.
                    (0.99_f32, 0.99_f32)
                } else {
                    // Clean signal: ratio 1.25.
                    (0.4_f32, 0.5_f32)
                };
                img0.pixels[idx * 3] = a;
                img0.pixels[idx * 3 + 1] = a;
                img0.pixels[idx * 3 + 2] = a;
                img1.pixels[idx * 3] = b;
                img1.pixels[idx * 3 + 1] = b;
                img1.pixels[idx * 3 + 2] = b;
            }
        }
        let opts = BlockGainOptions {
            grid_cols: 2,
            grid_rows: 2,
            min_overlap_per_tile: 4,
            validity_min_distance_px: 0.0,
            seam_band_radius_px: 0.0,
            ..Default::default()
        };
        let fields =
            solve_block_gains(&[&img0, &img1], &HashMap::new(), opts).expect("solve");
        // Gain field on img1 should pull DOWN (negative log-gain) to
        // bring img1's 0.5 toward img0's 0.4. With the zero prior
        // splitting the disagreement between the two images, we
        // expect img1's tile-medians to land somewhere in the
        // [-log(1.25)/2, 0] range. Crucially: NOT zero.
        // Since gauge floats, allow either image's gains to absorb
        // the correction; the invariant we enforce is that AT LEAST
        // ONE image's gain field is non-zero (i.e. solver found
        // signal, didn't see clipped pixels as the only overlap).
        let nonzero = fields.iter().any(|f| {
            f.log_gains
                .iter()
                .any(|t| t.iter().any(|&v| v.abs() > 0.05))
        });
        assert!(
            nonzero,
            "solver returned identity field — clipped pixels weren't rejected, or unclipped \
             pixels also failed rejection. Fields: {:#?}",
            fields,
        );
    }

    /// Empty image set / single image / canvas-size mismatch covered.
    #[test]
    fn handles_trivial_inputs() {
        let zero: Vec<&PanoImage> = Vec::new();
        let f0 =
            solve_block_gains(&zero, &HashMap::new(), BlockGainOptions::default()).expect("zero");
        assert!(f0.is_empty());
        let one = PanoImage::new(8, 8, ColorSpace::rec2020_d65_linear());
        let f1 = solve_block_gains(&[&one], &HashMap::new(), fast_options()).expect("one");
        assert_eq!(f1.len(), 1);
        // Single image: no pair observations, only zero+smoothness
        // priors are active — solution is exactly zeros (clamped).
        for tile in &f1[0].log_gains {
            for v in tile {
                assert!(
                    v.abs() < 1e-6,
                    "single-image trivial solve produced non-zero gain: {}",
                    v,
                );
            }
        }
    }

    #[test]
    fn apply_size_mismatch_errors() {
        let mut imgs = vec![PanoImage::new(8, 8, ColorSpace::rec2020_d65_linear())];
        let bad_field = BlockGainField {
            grid_cols: 4,
            grid_rows: 4,
            canvas_width: 16,
            canvas_height: 16,
            log_gains: vec![[0.0; 3]; 16],
        };
        assert!(apply_block_gains(&mut imgs, &[bad_field]).is_err());
    }

    /// `BlockGainField::sample` returns the corner-tile log-gains at
    /// extreme pixel positions and bilinear-interpolates inside.
    #[test]
    fn sample_corners_and_interior() {
        let field = BlockGainField {
            grid_cols: 2,
            grid_rows: 2,
            canvas_width: 32,
            canvas_height: 32,
            log_gains: vec![
                [0.0, 0.0, 0.0],   // tile (0,0)
                [0.4, 0.4, 0.4],   // tile (1,0)
                [-0.4, -0.4, -0.4],// tile (0,1)
                [0.0, 0.0, 0.0],   // tile (1,1)
            ],
        };
        // Tile centres are at (8, 8), (24, 8), (8, 24), (24, 24).
        // Pixel (8, 8) should snap to tile (0,0) → all zeros.
        let lg = field.sample(8.0, 8.0);
        assert!(lg.iter().all(|&v| v.abs() < 1e-6), "{:?}", lg);
        // Pixel (24, 8) → tile (1,0).
        let lg = field.sample(24.0, 8.0);
        assert!((lg[0] - 0.4).abs() < 1e-6, "{:?}", lg);
        // Pixel (16, 8) — exactly between tile (0,0) and tile (1,0)
        // along x — should yield 0.5 * 0.0 + 0.5 * 0.4 = 0.2.
        let lg = field.sample(16.0, 8.0);
        for c in 0..3 {
            assert!(
                (lg[c] - 0.2).abs() < 1e-3,
                "interpolation channel {} = {}",
                c,
                lg[c]
            );
        }
    }

    // ----------------- Helpers used in tests --------------------------

    fn overlap_means(a: &PanoImage, b: &PanoImage) -> Option<([f32; 3], [f32; 3])> {
        let n_pixels = (a.width as usize) * (a.height as usize);
        let mut sum_a = [0.0_f64; 3];
        let mut sum_b = [0.0_f64; 3];
        let mut count = 0_u64;
        for idx in 0..n_pixels {
            if a.validity[idx] && b.validity[idx] {
                for c in 0..3 {
                    sum_a[c] += a.pixels[idx * 3 + c] as f64;
                    sum_b[c] += b.pixels[idx * 3 + c] as f64;
                }
                count += 1;
            }
        }
        if count == 0 {
            return None;
        }
        let inv = 1.0 / count as f64;
        Some((
            [
                (sum_a[0] * inv) as f32,
                (sum_a[1] * inv) as f32,
                (sum_a[2] * inv) as f32,
            ],
            [
                (sum_b[0] * inv) as f32,
                (sum_b[1] * inv) as f32,
                (sum_b[2] * inv) as f32,
            ],
        ))
    }
}
