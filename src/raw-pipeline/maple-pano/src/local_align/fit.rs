//! Stage-F mesh fit — per-frame Ridge + smoothness normal equations over
//! the bilinear node displacements. Model and objective in the module
//! docs ([`super`]).

use crate::ba::linalg::PackedSymmetric;
use crate::ba::residual::{eval_residual, Block, FrameMeta, State};

use super::{
    LocalCorrection, GATE_RESCUE_MAX_RMS_PX, GRID_COLS, GRID_ROWS, MAX_CORRECTION_PX,
    NODE_RIDGE_PX_SQ, SMOOTH_LAMBDA,
};

/// Size limits on one fitted mesh: the node cap the field is scaled down
/// to, and the RMS envelope above which the fit is refused outright.
#[derive(Debug, Clone, Copy)]
pub(crate) struct MeshBounds {
    pub max_node_px: f64,
    pub max_rms_px: f64,
}

/// Rotation-path bounds — see [`MAX_CORRECTION_PX`] and
/// [`GATE_RESCUE_MAX_RMS_PX`].
pub(crate) const ROTATION_BOUNDS: MeshBounds = MeshBounds {
    max_node_px: MAX_CORRECTION_PX,
    max_rms_px: GATE_RESCUE_MAX_RMS_PX,
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
            fit_mesh(
                frames[f].cx * 2.0,
                frames[f].cy * 2.0,
                &pts[f],
                &res[f],
                ROTATION_BOUNDS,
            )
        })
        .collect()
}

/// Fit one frame's mesh so that `D(pts[i]) ≈ targets[i]`, then apply the
/// node cap and the RMS envelope from `bounds`. A frame with no points,
/// a degenerate extent, or a refused fit gets the identity mesh.
pub(crate) fn fit_mesh(
    w: f64,
    h: f64,
    pts: &[(f64, f64)],
    targets: &[[f64; 2]],
    bounds: MeshBounds,
) -> LocalCorrection {
    let mut corr = LocalCorrection::identity(w, h);
    if pts.is_empty() || w.is_nan() || h.is_nan() || w <= 0.0 || h <= 0.0 {
        return corr;
    }
    corr.fit_blocks = pts.len();

    let n_nodes = GRID_COLS * GRID_ROWS;
    // The x and y displacement components decouple and share the
    // bilinear design matrix, so one normal matrix serves two
    // right-hand sides.
    let mut h_mat = PackedSymmetric::zeros(n_nodes);
    let mut rhs_x = vec![0.0_f64; n_nodes];
    let mut rhs_y = vec![0.0_f64; n_nodes];

    for (&(px, py), r) in pts.iter().zip(targets) {
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
    for &(px, py) in pts {
        let d = corr.displacement_at(px, py);
        sum_sq += d * d;
    }
    corr.rms_px = (sum_sq / pts.len() as f64).sqrt();
    corr.max_correction_px = corr
        .nodes
        .iter()
        .map(|n| (n[0] * n[0] + n[1] * n[1]).sqrt())
        .fold(0.0, f64::max);

    // Cap: scale the whole field down uniformly so the maximum
    // node displacement equals the bound (preserves field shape).
    if corr.max_correction_px > bounds.max_node_px {
        let scale = bounds.max_node_px / corr.max_correction_px;
        for node in corr.nodes.iter_mut() {
            node[0] *= scale;
            node[1] *= scale;
        }
        corr.rms_px *= scale;
        corr.max_correction_px = bounds.max_node_px;
    }

    // Envelope (module docs): a fit this large is not parallax, it is
    // misregistration — refuse it entirely so the frame is never warped
    // by it. A capped field is by definition over-envelope.
    if corr.rms_px > bounds.max_rms_px || corr.max_correction_px >= bounds.max_node_px {
        let fit_blocks = corr.fit_blocks;
        corr = LocalCorrection::identity(w, h);
        corr.fit_blocks = fit_blocks;
    }

    corr
}
