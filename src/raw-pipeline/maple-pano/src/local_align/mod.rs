//! Stage F — per-frame local alignment for parallax absorption (spec §8,
//! #1218).
//!
//! Absorbs the cm-level camera position drift that a pure rotation model
//! cannot represent. After global BA + stage-D/E gating, residuals on
//! well-shot sets with far-field subjects are dominated by a nearly-uniform
//! parallax floor (DJI Mavic 3 Pro 100 MP, ~10 cm baseline). A strongly
//! regularized per-frame **2D affine correction** fit over the stage-D/E
//! survivors reduces those residuals without changing the BA rotations or
//! the compositing pipeline's resample count.
//!
//! # Correction model
//!
//! For each active frame `i`, define a corrective affine map in the frame's
//! own pixel coordinates:
//!
//! ```text
//! p_corrected = p_obs + δA · (p_obs − c_i)
//! ```
//!
//! where `c_i = (cx, cy)` is the image centre (principal point), `δA` is a
//! 2×2 matrix (the **delta** from identity — `δA = 0` gives identity).
//! The parameter vector per frame is 4-DOF: `(δa00, δa01, δa10, δa11)`.
//!
//! **Why no global translation (`δt`):**  In pano sweeps, each frame has
//! neighbours on both sides (ring and strip panos).  Parallax from the
//! left neighbour creates residuals with the opposite sign of those from
//! the right neighbour.  A global translation would be fit to their
//! *mean* — near zero for symmetric scenes — and then SUBTRACT from the
//! magnitude on both sides, *worsening* the effective correction.  The
//! affine-only model is zero at the principal point (physically correct: no
//! parallax at the optical axis) and grows linearly with distance — which
//! is exactly the first-order parallax model for a lateral camera shift.
//!
//! The fit minimises, over residuals `r_i = q_i − p_obs_i`:
//!
//! ```text
//! Σ ‖δA · (p_obs − c_i) − r‖² + λ · ‖δA‖_F²
//! ```
//!
//! with regularisation `λ = LAMBDA_PX_SQ = 4.0`.  The system is a straight
//! Ridge-regression closed form on the 4×4 affine normal matrix — no
//! iterative solver.
//!
//! # Symmetry
//!
//! Each block is a directed edge `j → i` (source `j`, destination `i`).
//! Frame `i` fits the residuals measured **in its own plane** (destination
//! blocks only).  Partner frames independently fit their own residuals.
//! On average each frame absorbs roughly half the parallax discrepancy
//! between the pair, without any explicit coupling.
//!
//! # Bounding
//!
//! After fitting, if the maximum pixel displacement at any of the frame's
//! match points exceeds `MAX_CORRECTION_PX` the whole correction is
//! uniformly scaled down so the maximum equals `MAX_CORRECTION_PX`.  This
//! keeps the warp well inside the bicubic support radius and prevents
//! runaway fits on sparse evidence.
//!
//! # Integration at composite time
//!
//! The correction is applied in `warp.rs`
//! ([`crate::warp::warp_to_canvas`] now accepts an optional
//! `LocalCorrection`): after the canvas → rotation → source-pixel chain,
//! the correction shifts the source sample point.  This is a **single
//! resample** — no extra pass.  The canvas bounding-box margin is widened
//! by `MAX_CORRECTION_PX` so coverage stays correct.
//!
//! # Identity guarantee (pure-rotation sets)
//!
//! On noiseless correspondences from a pure rotation-model set the fitted
//! correction is driven purely by regularisation toward zero.  The test
//! `pure_rotation_correction_near_identity` confirms max correction
//! < 0.05 px.

use crate::ba::residual::{eval_residual, Block, FrameMeta, State};
use crate::ba::FrameStats;

/// Ridge regularisation coefficient on the affine DOFs.
/// Equivalent to a ~2 px / half-image-width Gaussian prior on each
/// affine coefficient (`λ = 4`).
pub const LAMBDA_PX_SQ: f64 = 4.0;

/// Maximum pixel displacement this stage may introduce at any match point.
/// Corrections exceeding this ceiling are uniformly scaled down.
pub const MAX_CORRECTION_PX: f64 = 8.0;

/// Per-frame corrective affine map (4-DOF, no global translation).
///
/// Applied as:
/// `p_corrected = p_obs + δA · (p_obs − center) + δt`
///
/// where `center = (cx, cy)` is the image principal point.  `δA = 0`
/// and `δt = 0` is the identity (no correction).  The fit sets `δt = [0,0]`
/// always — the field is retained for forward-compat with the `apply`
/// API used in `warp.rs`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LocalCorrection {
    /// Image centre (principal point), pixels — the affine origin.
    pub cx: f64,
    pub cy: f64,
    /// Affine delta rows: `[[δa00, δa01], [δa10, δa11]]`.
    pub da: [[f64; 2]; 2],
    /// Translation delta (always `[0, 0]` from the fit; kept for API compat).
    pub dt: [f64; 2],
    /// RMS correction magnitude at the fitted match points (px) — logged
    /// in the stitch report.
    pub rms_px: f64,
    /// Maximum correction magnitude at any fitted match point (px).
    pub max_correction_px: f64,
    /// Number of destination-side blocks the correction was fit on.
    pub fit_blocks: usize,
}

impl LocalCorrection {
    /// The identity correction (no shift).
    pub fn identity(cx: f64, cy: f64) -> Self {
        Self {
            cx,
            cy,
            da: [[0.0; 2]; 2],
            dt: [0.0; 2],
            rms_px: 0.0,
            max_correction_px: 0.0,
            fit_blocks: 0,
        }
    }

    /// Apply the correction to a source image coordinate `(px, py)`:
    /// returns the corrected coordinate.
    ///
    /// Called from the warp inner loop — kept tight.
    #[inline]
    pub fn apply(&self, px: f64, py: f64) -> (f64, f64) {
        let dx = px - self.cx;
        let dy = py - self.cy;
        let corr_x = self.da[0][0] * dx + self.da[0][1] * dy + self.dt[0];
        let corr_y = self.da[1][0] * dx + self.da[1][1] * dy + self.dt[1];
        (px + corr_x, py + corr_y)
    }

    /// Displacement magnitude at `(px, py)`.
    #[inline]
    fn displacement_at(&self, px: f64, py: f64) -> f64 {
        let dx = px - self.cx;
        let dy = py - self.cy;
        let corr_x = self.da[0][0] * dx + self.da[0][1] * dy + self.dt[0];
        let corr_y = self.da[1][0] * dx + self.da[1][1] * dy + self.dt[1];
        (corr_x * corr_x + corr_y * corr_y).sqrt()
    }
}

/// Fit per-frame local corrections from the post-BA, post-gate residuals.
///
/// `blocks` must be the final block set (after stage-D/E): motion outliers
/// and blunders are already pruned so the fit sees only the structural
/// parallax signal.
///
/// Returns a `Vec<LocalCorrection>` indexed by **local frame index**
/// (same indexing as `state.rotations`), length `n_local`.  Frames with no
/// contributing blocks get `LocalCorrection::identity`.
pub(crate) fn fit_local_corrections(
    blocks: &[Block],
    frames: &[FrameMeta],
    state: &State,
    n_local: usize,
) -> Vec<LocalCorrection> {
    // Per-frame accumulator for the 4-DOF Ridge normal equations.
    //
    // Design matrix for one destination-side block at `p_obs = (px, py)`
    // with centre offset `(dx, dy) = (px−cx, py−cy)`:
    //
    //   x-component row: [dx, dy,  0,  0]
    //   y-component row: [ 0,  0, dx, dy]
    //
    // Target for each row is the corresponding residual component r[·].
    // We accumulate H = JᵀJ (4×4) and rhs = Jᵀr (4-dimensional), then
    // solve (H + λI)·δ = rhs.
    //
    // No global translation DOF: see module-level docs for why the
    // translation term degrades ring-pano corrections.

    struct FrameAccum {
        h: [f64; 10], // upper-triangle of 4×4, packed row-major (i*(7-i)/2 + j)
        rhs: [f64; 4],
        n: usize,
        cx: f64,
        cy: f64,
        // Candidate match points for post-fit magnitude measurement.
        pts: Vec<(f64, f64)>,
    }

    impl FrameAccum {
        fn new(cx: f64, cy: f64) -> Self {
            Self {
                h: [0.0; 10],
                rhs: [0.0; 4],
                n: 0,
                cx,
                cy,
                pts: Vec::new(),
            }
        }
    }

    let mut acc: Vec<FrameAccum> = (0..n_local)
        .map(|f| FrameAccum::new(frames[f].cx, frames[f].cy))
        .collect();

    for block in blocks {
        let Some(r) = eval_residual(state, frames, block) else {
            continue;
        };
        let d = block.dst;
        let a = &mut acc[d];
        let (px, py) = block.p_dst;
        let dx = px - a.cx;
        let dy = py - a.cy;

        // Row vectors for the two residual components (4-DOF, no translation).
        let fx = [dx, dy, 0.0_f64, 0.0_f64];
        let fy = [0.0_f64, 0.0_f64, dx, dy];

        // H += fxᵀfx + fyᵀfy  (both contribute to the 4×4 normal matrix).
        for i in 0..4 {
            for j in i..4 {
                a.h[packed4_idx(i, j)] += fx[i] * fx[j] + fy[i] * fy[j];
            }
            a.rhs[i] += fx[i] * r[0] + fy[i] * r[1];
        }
        a.n += 1;
        a.pts.push((px, py));
    }

    // Solve per frame and construct LocalCorrections.
    acc.into_iter()
        .map(|a| {
            if a.n == 0 {
                return LocalCorrection::identity(a.cx, a.cy);
            }

            // Ridge: add λ to the diagonal.
            let mut h = a.h;
            for i in 0..4 {
                h[packed4_idx(i, i)] += LAMBDA_PX_SQ;
            }

            let Some(params) = solve_4x4_sym(&h, &a.rhs) else {
                return LocalCorrection::identity(a.cx, a.cy);
            };

            // params = [δa00, δa01, δa10, δa11]  (δt = [0, 0])
            let mut corr = LocalCorrection {
                cx: a.cx,
                cy: a.cy,
                da: [[params[0], params[1]], [params[2], params[3]]],
                dt: [0.0, 0.0],
                rms_px: 0.0,
                max_correction_px: 0.0,
                fit_blocks: a.n,
            };

            // Measure correction magnitudes at the fitted match points.
            let (mut sum_sq, mut max_sq) = (0.0_f64, 0.0_f64);
            for &(px, py) in &a.pts {
                let d = corr.displacement_at(px, py);
                let d2 = d * d;
                sum_sq += d2;
                if d2 > max_sq {
                    max_sq = d2;
                }
            }
            corr.rms_px = (sum_sq / a.n as f64).sqrt();
            corr.max_correction_px = max_sq.sqrt();

            // Cap: scale down uniformly if max displacement exceeds the bound.
            if corr.max_correction_px > MAX_CORRECTION_PX {
                let scale = MAX_CORRECTION_PX / corr.max_correction_px;
                for row in corr.da.iter_mut() {
                    row[0] *= scale;
                    row[1] *= scale;
                }
                corr.dt[0] *= scale;
                corr.dt[1] *= scale;
                corr.rms_px *= scale;
                corr.max_correction_px = MAX_CORRECTION_PX;
            }

            corr
        })
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
// Used in unit tests (`local_align/tests.rs`); the production path
// computes stats via `gate_frames` on the corrected gate_blocks.
#[allow(dead_code)]
pub(crate) fn stats_after_local(
    blocks: &[Block],
    frames: &[FrameMeta],
    state: &State,
    corrections: &[LocalCorrection],
    n_local: usize,
) -> Vec<FrameStats> {
    use crate::ba::residual::INVALID_BLOCK_RESIDUAL_PX;

    let mut per_frame: Vec<Vec<f64>> = vec![Vec::new(); n_local];
    for block in blocks {
        let s = match eval_residual(state, frames, block) {
            Some(r) => {
                let d = block.dst;
                // correction(p_obs_d) = p_corrected − p_obs_d
                let (cx, cy) = corrections[d].apply(block.p_dst.0, block.p_dst.1);
                let corr_x = cx - block.p_dst.0;
                let corr_y = cy - block.p_dst.1;
                let rx = r[0] - corr_x;
                let ry = r[1] - corr_y;
                (rx * rx + ry * ry).sqrt()
            }
            None => INVALID_BLOCK_RESIDUAL_PX,
        };
        per_frame[block.dst].push(s);
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
    use crate::ba::residual::INVALID_BLOCK_RESIDUAL_PX;

    let (mut sum, mut max, mut count) = (0.0_f64, 0.0_f64, 0usize);
    for block in blocks {
        let s = match eval_residual(state, frames, block) {
            Some(r) => {
                let d = block.dst;
                let (cx, cy) = corrections[d].apply(block.p_dst.0, block.p_dst.1);
                let corr_x = cx - block.p_dst.0;
                let corr_y = cy - block.p_dst.1;
                let rx = r[0] - corr_x;
                let ry = r[1] - corr_y;
                (rx * rx + ry * ry).sqrt()
            }
            None => INVALID_BLOCK_RESIDUAL_PX,
        };
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

/// Packed upper-triangle index for a 4×4 symmetric matrix.
/// Row `i`, column `j` (`j >= i`): index = `i*(7 - i)/2 + j`.
/// Slots: 10 elements total (0..10).
#[inline]
const fn packed4_idx(i: usize, j: usize) -> usize {
    i * (7 - i) / 2 + j
}

/// Solve a 4×4 symmetric positive-definite system `H_sym · x = rhs` via
/// Gaussian elimination with partial pivoting (the matrix is symmetric so
/// it is SPD after Ridge regularisation, but pivoting handles any edge
/// cases from degenerate geometry gracefully).
///
/// `h_sym` is the packed upper-triangle (10 elements, see [`packed4_idx`]).
/// Returns `None` on numerical singularity.
fn solve_4x4_sym(h_packed: &[f64; 10], rhs: &[f64; 4]) -> Option<[f64; 4]> {
    // Expand to a full augmented 4×5 matrix.
    let mut a = [[0.0_f64; 5]; 4];
    for i in 0..4 {
        for j in 0..4 {
            a[i][j] = if j >= i {
                h_packed[packed4_idx(i, j)]
            } else {
                h_packed[packed4_idx(j, i)]
            };
        }
        a[i][4] = rhs[i];
    }

    // Forward elimination with partial pivoting.
    for col in 0..4 {
        let pivot = (col..4)
            .max_by(|&r1, &r2| a[r1][col].abs().total_cmp(&a[r2][col].abs()))
            .expect("non-empty range");
        if a[pivot][col].abs() < 1e-14 {
            return None; // Singular even after regularisation — defensive.
        }
        a.swap(col, pivot);
        let inv = 1.0 / a[col][col];
        for row in (col + 1)..4 {
            let factor = a[row][col] * inv;
            for k in col..=4 {
                let v = a[col][k] * factor;
                a[row][k] -= v;
            }
        }
    }

    // Back substitution.
    let mut x = [0.0_f64; 4];
    for i in (0..4).rev() {
        let mut s = a[i][4];
        for j in (i + 1)..4 {
            s -= a[i][j] * x[j];
        }
        x[i] = s / a[i][i];
    }
    Some(x)
}

#[cfg(test)]
mod tests;
