//! Stage-F mesh fit — per-frame Ridge + smoothness normal equations over
//! the bilinear node displacements. Model and objective in the module
//! docs ([`super`]).

use crate::ba::linalg::PackedSymmetric;
use crate::ba::residual::{eval_residual, Block, FrameMeta, State};

use super::{
    LocalCorrection, GATE_RESCUE_MAX_RMS_PX, GRID_COLS, GRID_ROWS, MAX_CORRECTION_PX,
    NODE_RIDGE_PX_SQ, SMOOTH_LAMBDA,
};

/// Fit per-frame local corrections from the post-BA, post-gate residuals.
///
/// `blocks` must be the final block set (after stage-D/E pruning): motion
/// outliers and blunders are already pruned so the fit sees only the
/// structural parallax signal.
///
/// Returns a `Vec<LocalCorrection>` indexed by **local frame index**
/// (same indexing as `state.rotations`), length `n_local`. Frames with no
/// contributing blocks get `LocalCorrection::identity`.
pub(crate) fn fit_local_corrections(
    blocks: &[Block],
    frames: &[FrameMeta],
    state: &State,
    n_local: usize,
) -> Vec<LocalCorrection> {
    // Gather destination-side residuals per frame. The principal point is
    // the image centre (crate convention), so the frame extent is (2cx, 2cy).
    let mut pts: Vec<Vec<(f64, f64)>> = vec![Vec::new(); n_local];
    let mut res: Vec<Vec<[f64; 2]>> = vec![Vec::new(); n_local];
    for block in blocks {
        let Some(r) = eval_residual(state, frames, block) else {
            continue;
        };
        pts[block.dst].push(block.p_dst);
        res[block.dst].push(r);
    }

    (0..n_local)
        .map(|f| {
            let w = frames[f].cx * 2.0;
            let h = frames[f].cy * 2.0;
            let mut corr = LocalCorrection::identity(w, h);
            if pts[f].is_empty() || !(w > 0.0) || !(h > 0.0) {
                return corr;
            }
            corr.fit_blocks = pts[f].len();

            let n_nodes = GRID_COLS * GRID_ROWS;
            // The x and y displacement components decouple and share the
            // bilinear design matrix, so one normal matrix serves two
            // right-hand sides.
            let mut h_mat = PackedSymmetric::zeros(n_nodes);
            let mut rhs_x = vec![0.0_f64; n_nodes];
            let mut rhs_y = vec![0.0_f64; n_nodes];

            for (&(px, py), r) in pts[f].iter().zip(&res[f]) {
                let (idx, wts) = corr.cell(px, py);
                for a in 0..4 {
                    for b in a..4 {
                        h_mat.add(idx[a], idx[b], wts[a] * wts[b]);
                    }
                    rhs_x[idx[a]] += wts[a] * r[0];
                    rhs_y[idx[a]] += wts[a] * r[1];
                }
            }

            // First-difference smoothness between grid-adjacent nodes:
            // λ_s·‖d_a − d_b‖² contributes (+λ_s, +λ_s, −λ_s) to
            // (a,a), (b,b), (a,b).
            for row in 0..GRID_ROWS {
                for col in 0..GRID_COLS {
                    let a = row * GRID_COLS + col;
                    if col + 1 < GRID_COLS {
                        let b = a + 1;
                        h_mat.add(a, a, SMOOTH_LAMBDA);
                        h_mat.add(b, b, SMOOTH_LAMBDA);
                        h_mat.add(a, b, -SMOOTH_LAMBDA);
                    }
                    if row + 1 < GRID_ROWS {
                        let b = a + GRID_COLS;
                        h_mat.add(a, a, SMOOTH_LAMBDA);
                        h_mat.add(b, b, SMOOTH_LAMBDA);
                        h_mat.add(a, b, -SMOOTH_LAMBDA);
                    }
                }
            }

                        // diagonal the system is SPD, so a solve failure is purely
            // defensive (degenerate inputs) and falls back to identity.
            let damping = vec![NODE_RIDGE_PX_SQ; n_nodes];
            let Some(sol_x) = h_mat.solve_damped(&damping, &rhs_x) else {
                return corr;
            };
            let Some(sol_y) = h_mat.solve_damped(&damping, &rhs_y) else {
                return corr;
            };
            corr.nodes = sol_x.into_iter().zip(sol_y).map(|(x, y)| [x, y]).collect();

            // Measure: RMS at the fitted match points (report), max over
            // the nodes (bounds the field everywhere — module docs).
            let mut sum_sq = 0.0_f64;
            for &(px, py) in &pts[f] {
                let d = corr.displacement_at(px, py);
                sum_sq += d * d;
            }
            corr.rms_px = (sum_sq / pts[f].len() as f64).sqrt();
            corr.max_correction_px = corr
                .nodes
                .iter()
                .map(|n| (n[0] * n[0] + n[1] * n[1]).sqrt())
                .fold(0.0, f64::max);

            // Cap: scale the whole field down uniformly so the maximum
            // node displacement equals the bound (preserves field shape).
            if corr.max_correction_px > MAX_CORRECTION_PX {
                let scale = MAX_CORRECTION_PX / corr.max_correction_px;
                for node in corr.nodes.iter_mut() {
                    node[0] *= scale;
                    node[1] *= scale;
                }
                corr.rms_px *= scale;
                corr.max_correction_px = MAX_CORRECTION_PX;
            }

            // Parallax envelope (module docs): a fit this large is not
            // drift, it is misregistration — refuse it entirely so the
            // frame gates on raw residuals and is never warped by it.
            // The envelope checks the pre-cap magnitude: a capped field
            // is by definition over-envelope.
            if corr.rms_px > GATE_RESCUE_MAX_RMS_PX || corr.max_correction_px >= MAX_CORRECTION_PX {
                let fit_blocks = corr.fit_blocks;
                corr = LocalCorrection::identity(w, h);
                corr.fit_blocks = fit_blocks;
            }

            corr
        })
        .collect()
}
