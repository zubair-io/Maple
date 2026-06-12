//! Stage F — per-frame local alignment for parallax absorption (spec §8,
//! #1218).
//!
//! Absorbs the cm-level camera position drift that a pure rotation model
//! cannot represent. After global BA + stage-D/E gating, residuals on
//! well-shot sets with finite-depth subjects are dominated by a structural
//! parallax floor (DJI Mavic 3 Pro 100 MP, ~10 cm baseline). A strongly
//! regularized per-frame **bilinear mesh correction** fit over the
//! stage-D/E survivors reduces those residuals without changing the BA
//! rotations or the compositing pipeline's resample count.
//!
//! # Model history — why a mesh and not an affine
//!
//! v1 of this stage fit a 4-DOF per-frame affine delta anchored at the
//! principal point. Measured on `pano_01` (21-frame DJI sweep) it reduced
//! the dropped frames' mean residuals by only ~12% (e.g. 2.15 → 1.92 px,
//! 1.62 → 1.37 px) and did not move their max residuals below the §5.3
//! budget at all; the fitted corrections stayed at 0.14–0.88 px RMS,
//! nowhere near [`MAX_CORRECTION_PX`] — i.e. the failure was *structural*,
//! not regularization strength. Parallax displacement depends on scene
//! depth, which varies across the frame (sea plane vs. foreground cliff);
//! no global linear field can represent that. The bilinear mesh is the
//! coarsest model that can: it subsumes the affine (a linear field is
//! reproduced exactly by bilinear interpolation of its node samples) and
//! adds the spatial locality that depth structure requires.
//!
//! # Correction model
//!
//! Each frame carries a [`GRID_COLS`] × [`GRID_ROWS`] grid of node
//! displacements spanning the frame rectangle. The correction at a pixel
//! is the bilinear blend of its cell's four node displacements:
//!
//! ```text
//! p_corrected = p_obs + D(p_obs),   D(p) = Σₖ wₖ(p) · dₖ
//! ```
//!
//! The fit minimises, over the node displacements `d` and the
//! destination-side residuals `r = q − p_obs` of the frame's blocks:
//!
//! ```text
//! Σ_blocks ‖D(p_obs) − r‖²
//!   + NODE_RIDGE_PX_SQ · Σₖ ‖dₖ‖²
//!   + SMOOTH_LAMBDA    · Σ_(a,b) adjacent ‖d_a − d_b‖²
//! ```
//!
//! The x and y displacement components decouple and share one normal
//! matrix (the bilinear weights are identical), so the solve is a single
//! 48×48 Cholesky factor applied to two right-hand sides — microseconds
//! per frame via [`crate::ba::linalg::PackedSymmetric`].
//!
//! **Ring-pano symmetry.** v1 deliberately omitted a global translation
//! DOF: a frame with overlap on both sides sees opposite-signed parallax
//! from its two neighbours, and a global translation would fit their
//! near-zero mean. The mesh resolves the same tension through locality
//! instead — nodes under the left overlap correct toward the left
//! neighbour while nodes under the right overlap correct toward the right
//! one, which is exactly the depth-dependent behaviour the translation
//! argument was protecting against. The smoothness term spreads those
//! corrections across the unobserved mid-frame; the ridge keeps the
//! globally-uniform component (the only mode smoothness cannot see)
//! anchored at zero.
//!
//! # Bounding
//!
//! After fitting, if any **node** displacement magnitude exceeds
//! [`MAX_CORRECTION_PX`] the whole field is uniformly scaled down so the
//! maximum node equals the cap. Because the bilinear blend is a convex
//! combination of the four cell nodes, the node maximum bounds the
//! displacement everywhere in the frame — the cap therefore holds at
//! every pixel, fitted or extrapolated.
//!
//! # Integration at composite time
//!
//! The correction is applied in `warp.rs` ([`crate::warp::warp_to_canvas`]
//! accepts an optional `LocalCorrection`): after the canvas → rotation →
//! source-pixel chain, the correction shifts the source sample point.
//! This is a **single resample** — no extra pass. The canvas bounding-box
//! margin is widened by [`MAX_CORRECTION_PX`] so coverage stays correct.
//!
//! # Identity guarantee (pure-rotation sets)
//!
//! On noiseless correspondences from a pure rotation-model set the fitted
//! correction is driven purely by regularisation toward zero. The test
//! `pure_rotation_correction_near_identity` confirms max correction
//! < 0.05 px.

use crate::ba::residual::{eval_residual, Block, FrameMeta, State};
use crate::ba::FrameStats;

mod fit;

pub(crate) use fit::fit_local_corrections;

/// Mesh resolution across the frame width. 8 × 6 puts one cell roughly
/// every 1.5–1.7 kpx on the 100 MP reference frames — coarse enough that
/// hundreds of matches support each occupied cell, fine enough to track
/// the sky / horizon / sea / foreground depth bands that defeat a global
/// linear model.
pub const GRID_COLS: usize = 8;
/// Mesh resolution across the frame height. See [`GRID_COLS`].
pub const GRID_ROWS: usize = 6;

/// Ridge regularisation on each node displacement (px²). Anchors the
/// globally-uniform field component (invisible to the smoothness term)
/// and pins nodes in cells with no match support. Sized well below one
/// match's data weight: the identity guarantee does not come from the
/// ridge (zero residuals give a zero fit at any λ) — it only has to
/// break the uniform-mode tie, so a single coherent match already
/// outvotes it.
pub const NODE_RIDGE_PX_SQ: f64 = 0.25;

/// First-difference smoothness weight between grid-adjacent nodes.
/// Dominates the ridge (4×) so unobserved nodes follow their neighbours
/// rather than snapping to zero, while staying below the per-node data
/// weight of even sparsely-supported cells (a handful of matches), so
/// coherent parallax evidence bends the field where it has support and
/// the smoothness prior only carries the unobserved cells between.
/// Production frames put tens-to-hundreds of matches in each overlap
/// cell, so data outvotes this prior decisively wherever it speaks.
pub const SMOOTH_LAMBDA: f64 = 1.0;

/// Maximum pixel displacement this stage may introduce at any node (and
/// therefore, by bilinear convexity, at any pixel). Corrections exceeding
/// this ceiling are uniformly scaled down.
pub const MAX_CORRECTION_PX: f64 = 8.0;

/// Parallax envelope: the largest correction (RMS over the fitted match
/// points) this stage will accept. A fit larger than this is refused
/// outright — the frame keeps its raw residuals for gating and is never
/// warped by the rejected field.
///
/// Why: stage F exists to absorb *cm-level camera drift*, and that has a
/// size — `f·B/Z` puts the reference captures' parallax floor at ~1–3 px
/// (measured needs on `pano_01`: ~1.5–2.8 px RMS). A genuinely
/// misregistered frame needs far more: the `ba_gates` 4° pitch-impostor
/// scenario demands 3.2–4.0 px RMS fields to look "fixed", and absorbing
/// them would mask a wrong pose as a clean solve. The mesh is expressive
/// enough to do exactly that, so the envelope — not the model's
/// flexibility — is what keeps misregistration un-maskable. Sized between
/// the two measured populations; ratchet with evidence, never above the
/// smallest field that ever rescued a wrong pose.
pub const GATE_RESCUE_MAX_RMS_PX: f64 = 3.0;

/// Per-frame corrective displacement mesh.
///
/// `nodes` is row-major: node `(col, row)` lives at `row * cols + col`,
/// node `(0, 0)` sits at pixel `(0, 0)` and node `(cols−1, rows−1)` at
/// pixel `(w, h)`. All-zero nodes are the identity (no correction).
#[derive(Debug, Clone, PartialEq)]
pub struct LocalCorrection {
    /// Frame extent in pixels (the grid spans `[0, w] × [0, h]`).
    pub w: f64,
    pub h: f64,
    /// Grid dimensions (≥ 2 each).
    pub cols: usize,
    pub rows: usize,
    /// Node displacements `[dx, dy]`, row-major.
    pub nodes: Vec<[f64; 2]>,
    /// RMS correction magnitude at the fitted match points (px) — logged
    /// in the stitch report.
    pub rms_px: f64,
    /// Maximum node displacement magnitude (px) — bounds the field
    /// everywhere (bilinear convexity).
    pub max_correction_px: f64,
    /// Number of destination-side blocks the correction was fit on.
    pub fit_blocks: usize,
}

impl LocalCorrection {
    /// The identity correction (zero mesh) for a `w × h` frame.
    pub fn identity(w: f64, h: f64) -> Self {
        Self {
            w,
            h,
            cols: GRID_COLS,
            rows: GRID_ROWS,
            nodes: vec![[0.0; 2]; GRID_COLS * GRID_ROWS],
            rms_px: 0.0,
            max_correction_px: 0.0,
            fit_blocks: 0,
        }
    }

    /// Locate `(px, py)`: cell base node index and the four bilinear
    /// weights, ordered `[n00, n10, n01, n11]` (col-then-row offsets).
    /// Coordinates outside the frame clamp to the border cells.
    #[inline]
    pub(crate) fn cell(&self, px: f64, py: f64) -> ([usize; 4], [f64; 4]) {
        let gx = (px / self.w).clamp(0.0, 1.0) * (self.cols - 1) as f64;
        let gy = (py / self.h).clamp(0.0, 1.0) * (self.rows - 1) as f64;
        let cx = (gx as usize).min(self.cols - 2);
        let cy = (gy as usize).min(self.rows - 2);
        let fx = gx - cx as f64;
        let fy = gy - cy as f64;
        let i00 = cy * self.cols + cx;
        let idx = [i00, i00 + 1, i00 + self.cols, i00 + self.cols + 1];
        let wts = [
            (1.0 - fx) * (1.0 - fy),
            fx * (1.0 - fy),
            (1.0 - fx) * fy,
            fx * fy,
        ];
        (idx, wts)
    }

    /// Displacement vector at `(px, py)`.
    #[inline]
    fn displacement(&self, px: f64, py: f64) -> (f64, f64) {
        let (idx, wts) = self.cell(px, py);
        let mut dx = 0.0;
        let mut dy = 0.0;
        for k in 0..4 {
            let n = &self.nodes[idx[k]];
            dx += wts[k] * n[0];
            dy += wts[k] * n[1];
        }
        (dx, dy)
    }

    /// Apply the correction to a source image coordinate `(px, py)`:
    /// returns the corrected coordinate.
    ///
    /// Called from the warp inner loop — kept tight.
    #[inline]
    pub fn apply(&self, px: f64, py: f64) -> (f64, f64) {
        let (dx, dy) = self.displacement(px, py);
        (px + dx, py + dy)
    }

    /// Displacement magnitude at `(px, py)`.
    #[inline]
    pub(crate) fn displacement_at(&self, px: f64, py: f64) -> f64 {
        let (dx, dy) = self.displacement(px, py);
        (dx * dx + dy * dy).sqrt()
    }
}

/// One block's end-of-chain residual magnitude: the BA residual minus
/// the local-alignment displacement at the destination observation.
/// Invalid chains count as gross, same as everywhere else in stage D.
///
/// This is THE residual definition for every §5.3 decision once stage F
/// is in the chain — gate stats, core membership, and motion pruning
/// must all use it or they police a quantity the gate no longer reads
/// (a match that disagrees with the local parallax field has
/// corrected > raw, and raw-measured pruning can never remove it).
pub(crate) fn corrected_block_residual(
    state: &State,
    frames: &[FrameMeta],
    corrections: &[LocalCorrection],
    block: &Block,
) -> f64 {
    use crate::ba::residual::INVALID_BLOCK_RESIDUAL_PX;
    match eval_residual(state, frames, block) {
        Some(r) => {
            let (cx, cy) = corrections[block.dst].apply(block.p_dst.0, block.p_dst.1);
            let rx = r[0] - (cx - block.p_dst.0);
            let ry = r[1] - (cy - block.p_dst.1);
            (rx * rx + ry * ry).sqrt()
        }
        None => INVALID_BLOCK_RESIDUAL_PX,
    }
}

/// Identity corrections for every frame — the stage-F no-op used when
/// local alignment is disabled ([`crate::ba::BaOptions::local_align`]).
pub(crate) fn identity_corrections(frames: &[FrameMeta], n_local: usize) -> Vec<LocalCorrection> {
    (0..n_local)
        .map(|f| LocalCorrection::identity(frames[f].cx * 2.0, frames[f].cy * 2.0))
        .collect()
}

/// Measure per-frame reprojection stats **after** applying the local
/// corrections.
///
/// For each block with destination `d`, the corrected residual is:
/// `r_corrected = r_BA − correction(p_obs_d)`
/// where `r_BA = q − p_obs` is the BA residual and `correction` is the
/// local-alignment displacement at `p_obs_d`.
///
/// `corrections` is indexed by local frame (output of
/// [`fit_local_corrections`]).
pub(crate) fn stats_after_local(
    blocks: &[Block],
    frames: &[FrameMeta],
    state: &State,
    corrections: &[LocalCorrection],
    n_local: usize,
) -> Vec<FrameStats> {
    let mut per_frame: Vec<Vec<f64>> = vec![Vec::new(); n_local];
    for block in blocks {
        per_frame[block.dst].push(corrected_block_residual(state, frames, corrections, block));
    }
    per_frame
        .into_iter()
        .map(|mut v| {
            if v.is_empty() {
                return FrameStats {
                    mean_px: 0.0,
                    max_px: 0.0,
                    median_px: 0.0,
                    blocks: 0,
                };
            }
            v.sort_by(f64::total_cmp);
            let n = v.len();
            FrameStats {
                mean_px: v.iter().sum::<f64>() / n as f64,
                max_px: v[n - 1],
                median_px: if n % 2 == 1 {
                    v[n / 2]
                } else {
                    0.5 * (v[n / 2 - 1] + v[n / 2])
                },
                blocks: n,
            }
        })
        .collect()
}

/// Measure global mean/max over all blocks **after** corrections.
///
/// Returns `(mean_px, max_px)`.
// Not called from production code (ba/mod.rs computes pre/post stats inline
// via gate_frames); kept for unit tests and future tooling.
#[allow(dead_code)]
pub(crate) fn global_stats_after_local(
    blocks: &[Block],
    frames: &[FrameMeta],
    state: &State,
    corrections: &[LocalCorrection],
) -> (f64, f64) {
    let (mut sum, mut max, mut count) = (0.0_f64, 0.0_f64, 0usize);
    for block in blocks {
        let s = corrected_block_residual(state, frames, corrections, block);
        sum += s;
        if s > max {
            max = s;
        }
        count += 1;
    }
    if count > 0 {
        (sum / count as f64, max)
    } else {
        (0.0, 0.0)
    }
}

#[cfg(test)]
mod tests;
