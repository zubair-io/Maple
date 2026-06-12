//! Linear-system solvers for [`crate::tile::placement`].
//! Kept in a separate file for the file-size budget.
//!
//! This file is included as a child module of `placement.rs` via
//! `mod placement_solve;`, so `super` refers to `placement` items.

use super::{TileCanvasSpec, TileConstraint, TilePose};

/// Weighted scalar least-squares with anchor constraint (log-scale or
/// rotation). Solves for `x` in `Ax = b` where the anchor row is an
/// identity constraint `x[anchor] = init[anchor]` (= 0 for the anchor
/// itself, or the spanning-tree init value).
///
/// `use_log_scale`: if true, uses `sim_ab.scale.ln()` for the rhs;
/// otherwise uses `sim_ab.theta`.
pub(super) fn ls_scalar(
    n: usize,
    anchor_local: usize,
    init: &[f64],
    constraints: &[TileConstraint],
    local_idx: &[usize],
    use_log_scale: bool,
) -> Vec<f64> {
    // Build and solve n×n normal equations (dense, n ≤ ~50).
    let mut a = vec![0.0_f64; n * n];
    let mut b = vec![0.0_f64; n];

    // Anchor constraint: x[anchor] = init[anchor].
    a[anchor_local * n + anchor_local] = 1.0;
    b[anchor_local] = init[anchor_local];

    for c in constraints {
        let la = local_idx[c.a];
        let lb = local_idx[c.b];
        if la == usize::MAX || lb == usize::MAX {
            continue;
        }
        // Constraint: ln_s_b − ln_s_a = −ln_s_ab  (pose_b = pose_a ∘ sim_ab.inverse())
        //             θ_b − θ_a = −θ_ab
        // So rhs = −(sim_ab value), which is the negation of the raw edge value.
        let rhs = if use_log_scale {
            -c.sim_ab.scale.ln()
        } else {
            -c.sim_ab.theta
        };
        let w = c.weight;
        // Minimise w·(x[lb] − x[la] − rhs)² w.r.t. x[la], x[lb].
        a[lb * n + lb] += w;
        a[la * n + la] += w;
        a[lb * n + la] -= w;
        a[la * n + lb] -= w;
        b[lb] += w * rhs;
        b[la] -= w * rhs;
    }

    // Dirichlet BC for the anchor: substitute x[anchor] = init[anchor]
    // into every other equation, then replace the anchor row with the
    // identity constraint.
    for j in 0..n {
        if j != anchor_local {
            // Substitute the known anchor value into equation j.
            b[j] -= a[j * n + anchor_local] * init[anchor_local];
            a[j * n + anchor_local] = 0.0;
            // Remove the anchor equation's coupling to frame j.
            a[anchor_local * n + j] = 0.0;
        }
    }
    // Reset the anchor row to the identity constraint (the constraint
    // loop may have overwritten A[anchor,anchor] and b[anchor]).
    a[anchor_local * n + anchor_local] = 1.0;
    b[anchor_local] = init[anchor_local];

    gauss_eliminate(&mut a, &mut b, n)
}

/// Weighted 2-D least-squares for translations, given solved scale/theta.
/// Returns `(tx, ty)` per local frame index.
pub(super) fn ls_translation(
    n: usize,
    anchor_local: usize,
    init_tx: &[f64],
    init_ty: &[f64],
    lns: &[f64],
    theta: &[f64],
    constraints: &[TileConstraint],
    local_idx: &[usize],
) -> (Vec<f64>, Vec<f64>) {
    // Pose semantics: pose_i maps frame_i pixels → canvas via
    //   canvas = pose_i.sim.apply(src_i) + offset.
    //
    // Given pose_b = pose_a ∘ sim_ab.inverse():
    //   t_b = s_a · R(θ_a) · sim_ab_inv.t + t_a
    //
    // where sim_ab_inv.t = −R(−θ_ab) · t_ab / s_ab.
    //
    // For each constraint (a, b, s_ab, θ_ab, t_ab):
    //   rhs_x = s_a · (cos_a · sim_ab_inv.tx − sin_a · sim_ab_inv.ty)
    //   rhs_y = s_a · (sin_a · sim_ab_inv.tx + cos_a · sim_ab_inv.ty)
    //
    // Constraint: tx_b − tx_a = rhs_x,  ty_b − ty_a = rhs_y.
    // Since s_a and θ_a depend on the solved lns/theta (not the unknowns
    // tx/ty), each constraint is linear in (tx_a, tx_b).
    //
    // Normal equations for the least-squares system (x and y decouple):
    //   A[lb,lb] += w, A[la,la] += w, A[lb,la] −= w, A[la,lb] −= w
    //   bx[lb] += w·rhs_x,  bx[la] −= w·rhs_x
    //   by[lb] += w·rhs_y,  by[la] −= w·rhs_y
    let mut a = vec![0.0_f64; n * n];
    let mut bx = vec![0.0_f64; n];
    let mut by = vec![0.0_f64; n];

    // Anchor constraint.
    a[anchor_local * n + anchor_local] = 1.0;
    bx[anchor_local] = init_tx[anchor_local];
    by[anchor_local] = init_ty[anchor_local];

    for c in constraints {
        let la = local_idx[c.a];
        let lb = local_idx[c.b];
        if la == usize::MAX || lb == usize::MAX {
            continue;
        }
        let s_ab = c.sim_ab.scale;
        let (_sin_ab, _cos_ab) = c.sim_ab.theta.sin_cos();
        let w = c.weight;

        // sim_ab_inv.t = −R(−θ_ab)·t_ab / s_ab
        let inv_s = 1.0 / s_ab.max(1e-12);
        let (sin_inv, cos_inv) = (-c.sim_ab.theta).sin_cos();
        let inv_tx = inv_s * (cos_inv * (-c.sim_ab.tx) - sin_inv * (-c.sim_ab.ty));
        let inv_ty = inv_s * (sin_inv * (-c.sim_ab.tx) + cos_inv * (-c.sim_ab.ty));

        // s_a · R(θ_a) · sim_ab_inv.t
        let sa = lns[la].exp();
        let (sin_a, cos_a) = theta[la].sin_cos();
        let rhs_x = sa * (cos_a * inv_tx - sin_a * inv_ty);
        let rhs_y = sa * (sin_a * inv_tx + cos_a * inv_ty);

        // Constraint: tx_b − tx_a = rhs_x, ty_b − ty_a = rhs_y
        a[lb * n + lb] += w;
        a[la * n + la] += w;
        a[lb * n + la] -= w;
        a[la * n + lb] -= w;
        bx[lb] += w * rhs_x;
        bx[la] -= w * rhs_x;
        by[lb] += w * rhs_y;
        by[la] -= w * rhs_y;
    }

    // Anchor Dirichlet: remove the anchor variable from all other
    // equations, then fix the anchor row.
    for j in 0..n {
        if j != anchor_local {
            bx[j] -= a[j * n + anchor_local] * init_tx[anchor_local];
            by[j] -= a[j * n + anchor_local] * init_ty[anchor_local];
            a[j * n + anchor_local] = 0.0;
            a[anchor_local * n + j] = 0.0;
        }
    }
    // Reset anchor row to identity constraint (normal-eq loop may have
    // overwritten A[anchor,anchor] and b[anchor]).
    a[anchor_local * n + anchor_local] = 1.0;
    bx[anchor_local] = init_tx[anchor_local];
    by[anchor_local] = init_ty[anchor_local];

    let tx = gauss_eliminate(&mut a.clone(), &mut bx, n);
    let ty = gauss_eliminate(&mut a, &mut by, n);
    (tx, ty)
}

/// Dense Gaussian elimination with partial pivoting (in-place). Solves
/// `A·x = b` for `x`, modifying both `a` (n×n, row-major) and `b` (n).
/// Returns the solution vector; returns zeros for singular systems.
pub(super) fn gauss_eliminate(a: &mut [f64], b: &mut [f64], n: usize) -> Vec<f64> {
    for col in 0..n {
        // Partial pivot.
        let pivot = (col..n).max_by(|&i, &j| {
            a[i * n + col]
                .abs()
                .partial_cmp(&a[j * n + col].abs())
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        if let Some(pivot) = pivot {
            if pivot != col {
                for k in 0..n {
                    a.swap(col * n + k, pivot * n + k);
                }
                b.swap(col, pivot);
            }
        }

        let diag = a[col * n + col];
        if diag.abs() < 1e-15 {
            continue; // singular (underdetermined constraint)
        }
        for row in (col + 1)..n {
            let factor = a[row * n + col] / diag;
            for k in col..n {
                a[row * n + k] -= factor * a[col * n + k];
            }
            b[row] -= factor * b[col];
        }
    }
    // Back substitution.
    let mut x = vec![0.0_f64; n];
    for row in (0..n).rev() {
        let mut s = b[row];
        for k in (row + 1)..n {
            s -= a[row * n + k] * x[k];
        }
        let diag = a[row * n + row];
        x[row] = if diag.abs() < 1e-15 { 0.0 } else { s / diag };
    }
    x
}

/// Size the planar canvas from the bounding box of all placed frame
/// corners, with a fixed margin.
pub(super) fn size_canvas(poses: &[TilePose], frame_dims: &[(u32, u32)]) -> TileCanvasSpec {
    const MARGIN: f64 = 8.0;

    let mut min_x = f64::INFINITY;
    let mut min_y = f64::INFINITY;
    let mut max_x = f64::NEG_INFINITY;
    let mut max_y = f64::NEG_INFINITY;

    for pose in poses {
        let (fw, fh) = if pose.frame_idx < frame_dims.len() {
            (
                frame_dims[pose.frame_idx].0 as f64,
                frame_dims[pose.frame_idx].1 as f64,
            )
        } else {
            continue;
        };
        for &(cx, cy) in &[(0.0, 0.0), (fw, 0.0), (0.0, fh), (fw, fh)] {
            let (mapped_x, mapped_y) = pose.sim.apply(cx, cy);
            min_x = min_x.min(mapped_x);
            min_y = min_y.min(mapped_y);
            max_x = max_x.max(mapped_x);
            max_y = max_y.max(mapped_y);
        }
    }

    if min_x.is_infinite() {
        // Fallback: single frame at identity.
        let (fw, fh) = frame_dims.first().copied().unwrap_or((1024, 768));
        return TileCanvasSpec {
            width: fw + 2 * MARGIN as u32,
            height: fh + 2 * MARGIN as u32,
            offset_x: MARGIN,
            offset_y: MARGIN,
        };
    }

    let offset_x = MARGIN - min_x;
    let offset_y = MARGIN - min_y;
    let width = ((max_x - min_x) + 2.0 * MARGIN).ceil() as u32;
    let height = ((max_y - min_y) + 2.0 * MARGIN).ceil() as u32;

    TileCanvasSpec {
        width: width.max(1),
        height: height.max(1),
        offset_x,
        offset_y,
    }
}
