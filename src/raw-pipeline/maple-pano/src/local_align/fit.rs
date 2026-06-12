//! Stage-F mesh fit — per-frame Ridge + smoothness normal equations over
//! the bilinear node displacements. Model and objective in the module
//! docs ([`super`]).

use crate::ba::linalg::PackedSymmetric;
use crate::ba::residual::{eval_residual, huber_weight, Block, FrameMeta, State};

use super::{
    LocalCorrection, GRID_COLS, GRID_ROWS, IRLS_DELTA_PX, IRLS_ROUNDS, NODE_RIDGE_PX_SQ,
    NODE_TRUST_MAX_PX, SMOOTH_LAMBDA,
};

/// Fit per-frame local corrections from the post-BA, post-gate residuals.
///
/// Two-stage robust fit:
///
/// 1. **Initialization on the rigid-candidate subset** — blocks whose
///    raw residual is within `fit_max_residual_px` (callers pass the
///    §5.3 max budget, stage-D's own exclusion rule). On
///    water-dominated frames an unweighted fit over everything chases
///    the water majority, blows the rescue envelope, and gets refused —
///    leaving the static core uncorrected and uncertifiable. The subset
///    breaks that >50%-contamination tie.
/// 2. **[`IRLS_ROUNDS`] Huber reweighting rounds over ALL blocks** —
///    each match weighted by its agreement with the current field
///    (`huber_weight(IRLS_DELTA_PX, |D(p) − r|)`). This re-admits the
///    over-budget parallax TAILS (depth edges at 6–8 px agree with the
///    smooth field the subset fit extrapolates — excluding them was
///    measured to push tail-heavy frames over the mean budget), while
///    incoherent motion keeps disagreeing and stays downweighted.
///
/// A wrong POSE is caught either way: its residuals are mutually
/// coherent, so the rounds converge on the full misregistration field —
/// over the envelope, refused. The envelope RMS is measured on the
/// subset points (the population it was calibrated on).
///
/// Returns a `Vec<LocalCorrection>` indexed by **local frame index**
/// (same indexing as `state.rotations`), length `n_local`. Frames with no
/// contributing blocks get `LocalCorrection::identity`.
pub(crate) fn fit_local_corrections(
    blocks: &[Block],
    frames: &[FrameMeta],
    state: &State,
    n_local: usize,
    fit_max_residual_px: f64,
) -> Vec<LocalCorrection> {
    // Gather destination-side residuals per frame. The principal point is
    // the image centre (crate convention), so the frame extent is (2cx, 2cy).
    let mut pts: Vec<Vec<(f64, f64)>> = vec![Vec::new(); n_local];
    let mut res: Vec<Vec<[f64; 2]>> = vec![Vec::new(); n_local];
    let mut in_subset: Vec<Vec<bool>> = vec![Vec::new(); n_local];
    for block in blocks {
        let Some(r) = eval_residual(state, frames, block) else {
            continue;
        };
        let mag = (r[0] * r[0] + r[1] * r[1]).sqrt();
        pts[block.dst].push(block.p_dst);
        res[block.dst].push(r);
        in_subset[block.dst].push(mag <= fit_max_residual_px);
    }

    (0..n_local)
        .map(|f| {
            let w = frames[f].cx * 2.0;
            let h = frames[f].cy * 2.0;
            let mut corr = LocalCorrection::identity(w, h);
            let n_subset = in_subset[f].iter().filter(|&&x| x).count();
            if n_subset == 0 || !(w > 0.0) || !(h > 0.0) {
                return corr;
            }
            corr.fit_blocks = n_subset;

            // Round 0: rigid-candidate subset only (0/1 weights).
            let mut weights: Vec<f64> = in_subset[f]
                .iter()
                .map(|&x| if x { 1.0 } else { 0.0 })
                .collect();
            for round in 0..=IRLS_ROUNDS {
                let Some(nodes) = solve_weighted(&corr, &pts[f], &res[f], &weights) else {
                    // Defensive (the damped system is SPD): no fit.
                    return LocalCorrection {
                        fit_blocks: n_subset,
                        ..LocalCorrection::identity(w, h)
                    };
                };
                corr.nodes = nodes;
                if round < IRLS_ROUNDS {
                    // Reweight ALL matches by agreement with the field.
                    for (k, (&(px, py), r)) in pts[f].iter().zip(&res[f]).enumerate() {
                        let (dx, dy) = {
                            let (qx, qy) = corr.apply(px, py);
                            (qx - px, qy - py)
                        };
                        let ex = r[0] - dx;
                        let ey = r[1] - dy;
                        weights[k] = huber_weight(IRLS_DELTA_PX, (ex * ex + ey * ey).sqrt());
                    }
                }
            }

            // Per-node trust ceiling (module docs): a node displacement
            // beyond parallax scale is not drift — zero it individually.
            // A wrong pose loses every node (identity, gates raw); local
            // coherent motion loses its cells while the static field
            // survives.
            for node in corr.nodes.iter_mut() {
                if (node[0] * node[0] + node[1] * node[1]).sqrt() > NODE_TRUST_MAX_PX {
                    *node = [0.0, 0.0];
                }
            }

            // Measure on the trusted field: RMS at the subset points
            // (reported + logged), max over the nodes (bounds the field
            // everywhere — bilinear convexity, module docs).
            let mut sum_sq = 0.0_f64;
            for (&(px, py), _) in pts[f].iter().zip(&in_subset[f]).filter(|(_, &keep)| keep) {
                let d = corr.displacement_at(px, py);
                sum_sq += d * d;
            }
            corr.rms_px = (sum_sq / n_subset as f64).sqrt();
            corr.max_correction_px = corr
                .nodes
                .iter()
                .map(|n| (n[0] * n[0] + n[1] * n[1]).sqrt())
                .fold(0.0, f64::max);

            corr
        })
        .collect()
}

/// One weighted Ridge + smoothness solve over the node displacements:
/// returns the row-major node vector, or `None` on (defensive) numerical
/// failure. Weights of zero drop a match from the system entirely.
fn solve_weighted(
    proto: &LocalCorrection,
    pts: &[(f64, f64)],
    res: &[[f64; 2]],
    weights: &[f64],
) -> Option<Vec<[f64; 2]>> {
    let n_nodes = GRID_COLS * GRID_ROWS;
    // The x and y displacement components decouple and share the
    // bilinear design matrix, so one normal matrix serves two
    // right-hand sides.
    let mut h_mat = PackedSymmetric::zeros(n_nodes);
    let mut rhs_x = vec![0.0_f64; n_nodes];
    let mut rhs_y = vec![0.0_f64; n_nodes];

    for ((&(px, py), r), &wt) in pts.iter().zip(res).zip(weights) {
        if wt <= 0.0 {
            continue;
        }
        let (idx, wts) = proto.cell(px, py);
        for a in 0..4 {
            for b in a..4 {
                h_mat.add(idx[a], idx[b], wt * wts[a] * wts[b]);
            }
            rhs_x[idx[a]] += wt * wts[a] * r[0];
            rhs_y[idx[a]] += wt * wts[a] * r[1];
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

    // Ridge enters as Cholesky damping; with a positive λ_r on the
    // diagonal the system is SPD, so a solve failure is purely
    // defensive (degenerate inputs).
    let damping = vec![NODE_RIDGE_PX_SQ; n_nodes];
    let sol_x = h_mat.solve_damped(&damping, &rhs_x)?;
    let sol_y = h_mat.solve_damped(&damping, &rhs_y)?;
    Some(sol_x.into_iter().zip(sol_y).map(|(x, y)| [x, y]).collect())
}
