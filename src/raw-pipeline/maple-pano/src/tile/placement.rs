//! Global tile placement: anchored least-squares over the similarity-edge
//! graph → per-frame 2D similarity poses on the planar canvas (spec §8,
//! ticket #1226).
//!
//! # Problem formulation
//!
//! Let `S_i = (ln_s_i, θ_i, tx_i, ty_i)` be the absolute pose of frame
//! `i` on the canvas (frame pixel → canvas pixel). For each verified tile
//! edge `(a, b)` with measured relative similarity `S_ab` (from
//! [`crate::similarity::estimate_similarity`]):
//!
//! ```text
//! S_b ≈ S_ab ∘ S_a   (composition of 2D similarities)
//! ```
//!
//! In the log domain, scale and rotation decouple from translation:
//!
//! - `ln_s_b ≈ ln_s_ab + ln_s_a`
//! - `θ_b    ≈ θ_ab    + θ_a`
//! - `(tx_b, ty_b)` from the composed affine (coupled to `s` and `θ`).
//!
//! We anchor frame 0 at the identity (`S_0 = I`, i.e. canvas pixels ≡
//! frame-0 pixels at the anchor's position). This fixes the gauge (no
//! global similarity freedom remains). The remaining frames are placed by
//! minimizing the sum of squared consistency errors, weighted by inlier
//! count (more matches → more reliable constraint):
//!
//! ```text
//! Σ_{(a,b)} w_{ab} · ‖S_b − S_ab ∘ S_a‖²   →   linear LS per DOF
//! ```
//!
//! The system is solved with in-tree Gaussian elimination (the same
//! style as `ba/linalg.rs`'s dense normal equations — no external
//! dependency). For small tile sets (≤ 20 frames) this is exact and fast.
//!
//! # Translation coupling
//!
//! The translation components couple to the scale/rotation solution:
//! after solving `ln_s_i` and `θ_i` first (two independent 1-D systems),
//! the translation constraints become linear in `(tx_i, ty_i)` and are
//! solved in a second pass (a 2×N system per frame, reduced to normal
//! equations).
//!
//! # Spanning-tree initialization
//!
//! The LS solve is unconstrained except for the anchor row, so it gives
//! the global minimum directly. For disconnected subgraphs (which the
//! strategy caller handles — tile composite only stitch the largest
//! connected component, same as rotation), the anchor frame must be in
//! the component.

use std::collections::VecDeque;

use crate::similarity::Similarity2d;

/// The absolute canvas pose of one frame in the tile strategy.
///
/// A pixel `(fx, fy)` in the source frame maps to canvas pixel:
/// `(cx, cy) = sim.apply(fx, fy)`.
#[derive(Debug, Clone)]
pub struct TilePose {
    /// Absolute 2D similarity: source pixel → canvas pixel.
    pub sim: Similarity2d,
    /// Frame index in the input image list.
    pub frame_idx: usize,
}

/// A pairwise similarity constraint edge, with weight.
#[derive(Debug, Clone)]
pub struct TileConstraint {
    pub a: usize,             // global frame index
    pub b: usize,             // global frame index
    pub sim_ab: Similarity2d, // S_ab: "a pixel" → "b pixel" (same space as edges)
    pub weight: f64,          // inlier count or other quality measure
}

/// The planar canvas specification for the tile strategy.
#[derive(Debug, Clone)]
pub struct TileCanvasSpec {
    pub width: u32,
    pub height: u32,
    /// Pixel offset to add to canvas coordinates so frame-0 anchor maps
    /// to `(offset_x, offset_y)` within the canvas. Typically the
    /// bounding-box origin of the placed frame-0 corner.
    pub offset_x: f64,
    pub offset_y: f64,
}

/// Why global tile placement failed.
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum TilePlacementError {
    #[error("no frames to place")]
    NoFrames,
    #[error("frame count mismatch: {have} constraints reference index {bad}")]
    IndexOutOfBounds { have: usize, bad: usize },
    #[error("disconnected graph: frame {frame} is unreachable from anchor")]
    Disconnected { frame: usize },
}

/// The result of [`solve_tile_poses`].
#[derive(Debug, Clone)]
pub struct TilePlacement {
    /// Per-frame absolute poses, parallel to the `frame_count` input.
    /// Frames unreachable from the anchor (disconnected graph) are
    /// absent from this list — the caller drops them like orphans in the
    /// rotation path.
    pub poses: Vec<TilePose>,
}

/// Solve absolute canvas poses for all frames via anchored LS over the
/// similarity-edge graph.
///
/// `frame_count`: total number of frames (some may be unreachable).
/// `constraints`: per-edge relative similarities + weights.
/// `anchor`: the frame index to fix at the identity (must be in the graph).
/// `frame_dims`: `(width, height)` per frame — used to size the canvas.
///
/// Returns poses for all frames reachable from `anchor`. The canvas spec
/// is sized to the bounding box of all placed frame corners.
pub fn solve_tile_poses(
    frame_count: usize,
    constraints: &[TileConstraint],
    anchor: usize,
    frame_dims: &[(u32, u32)],
) -> Result<(Vec<TilePose>, TileCanvasSpec), TilePlacementError> {
    if frame_count == 0 {
        return Err(TilePlacementError::NoFrames);
    }
    // Validate indices.
    for c in constraints {
        if c.a >= frame_count {
            return Err(TilePlacementError::IndexOutOfBounds {
                have: frame_count,
                bad: c.a,
            });
        }
        if c.b >= frame_count {
            return Err(TilePlacementError::IndexOutOfBounds {
                have: frame_count,
                bad: c.b,
            });
        }
    }

    // Build adjacency for reachability check + spanning-tree init.
    let mut adj: Vec<Vec<usize>> = vec![vec![]; frame_count];
    for (ci, c) in constraints.iter().enumerate() {
        adj[c.a].push(ci);
        adj[c.b].push(ci);
    }

    // BFS reachability from anchor.
    let mut visited = vec![false; frame_count];
    visited[anchor] = true;
    let mut queue = VecDeque::from([anchor]);
    while let Some(node) = queue.pop_front() {
        for &ci in &adj[node] {
            let c = &constraints[ci];
            let other = if c.a == node { c.b } else { c.a };
            if !visited[other] {
                visited[other] = true;
                queue.push_back(other);
            }
        }
    }

    // Only solve for reachable frames. Unreachable are silently skipped
    // (caller reports them as disconnected — same policy as rotation path).
    let reachable: Vec<usize> = (0..frame_count).filter(|&i| visited[i]).collect();
    let n = reachable.len();
    // Local index map: global frame index → local index in [0, n).
    let mut local_idx = vec![usize::MAX; frame_count];
    for (li, &gi) in reachable.iter().enumerate() {
        local_idx[gi] = li;
    }
    let anchor_local = local_idx[anchor];

    // --- Stage 1: solve log-scale (ln_s) and rotation (θ) ---
    // Each constraint (a, b) with weight w contributes:
    //   w · (θ_b − θ_a − θ_ab)²  and  w · (ln_s_b − ln_s_a − ln_s_ab)²
    // The anchor row pins θ_anchor = 0, ln_s_anchor = 0.
    // We solve two independent scalar least-squares systems of size n.

    let mut lns = vec![0.0_f64; n]; // log scale for each frame
    let mut theta = vec![0.0_f64; n]; // rotation for each frame

    // Solve with spanning-tree propagation first, then one global LS
    // refinement over all constraints.
    //
    // Spanning-tree BFS init: assign each unvisited frame's pose from
    // the first constraint that connects it to a visited frame.
    let mut initialized = vec![false; n];
    initialized[anchor_local] = true;
    // BFS order for spanning-tree init.
    let mut bfs = VecDeque::from([anchor]);
    while let Some(gnode) = bfs.pop_front() {
        let lnode = local_idx[gnode];
        for &ci in &adj[gnode] {
            let c = &constraints[ci];
            let (gother, forward) = if c.a == gnode {
                (c.b, true)
            } else {
                (c.a, false)
            };
            let lother = local_idx[gother];
            if lother == usize::MAX || initialized[lother] {
                continue;
            }
            // Pose semantics: pose_i maps frame_i pixels → canvas pixels via
            //   canvas = pose_i.sim.apply(src_i) + offset.
            // Consistency: pose_a.sim.apply(m.a) ≈ pose_b.sim.apply(m.b)
            //   when m.a and m.b are the same scene point.
            //
            // Given sim_ab maps frame_a → frame_b (i.e. sim_ab.apply(m.a) = m.b),
            // the pose composition is:
            //   pose_b = pose_a ∘ sim_ab.inverse()
            // In log domain:
            //   ln_s_b = ln_s_a − ln_s_ab
            //   θ_b    = θ_a   − θ_ab
            // (forward: a→b uses sim_ab.inverse; backward: b→a uses sim_ab)
            if forward {
                // pose_b = pose_a ∘ sim_ab.inverse()
                lns[lother] = lns[lnode] - c.sim_ab.scale.ln();
                theta[lother] = theta[lnode] - c.sim_ab.theta;
            } else {
                // pose_a = pose_b ∘ sim_ab (since sim_ba = sim_ab.inverse().inverse() = sim_ab)
                lns[lother] = lns[lnode] + c.sim_ab.scale.ln();
                theta[lother] = theta[lnode] + c.sim_ab.theta;
            }
            initialized[lother] = true;
            bfs.push_back(gother);
        }
    }

    // Global LS refinement of log-scale and rotation (optional but
    // improves multi-constraint frames). We use weighted normal equations:
    // for each constraint (a, b, s_ab, θ_ab, w):
    //   ∂/∂θ_b: w(θ_b − θ_a − θ_ab) = 0 → normal eq row for θ_b
    //   ∂/∂θ_a: w(θ_a − θ_b + θ_ab) = 0 → normal eq row for θ_a
    // Anchor row fixes the corresponding variable.
    lns = ls_scalar(n, anchor_local, &lns, constraints, &local_idx, true);
    theta = ls_scalar(n, anchor_local, &theta, constraints, &local_idx, false);

    // --- Stage 2: solve translations ---
    // Given ln_s_i and θ_i, the translation constraint for edge (a,b):
    //   t_b ≈ s_ab·R(θ_ab)·t_a + t_ab  (evaluated at p=0)
    //
    // This is a linear system in (tx, ty) per frame: each constraint
    // contributes a row coupling t_a and t_b.
    let mut tx = vec![0.0_f64; n];
    let mut ty = vec![0.0_f64; n];
    // BFS spanning-tree initialization for translations.
    let mut init_t = vec![false; n];
    init_t[anchor_local] = true;
    let mut bfs2 = VecDeque::from([anchor]);
    while let Some(gnode) = bfs2.pop_front() {
        let lnode = local_idx[gnode];
        for &ci in &adj[gnode] {
            let c = &constraints[ci];
            let (gother, forward) = if c.a == gnode {
                (c.b, true)
            } else {
                (c.a, false)
            };
            let lother = local_idx[gother];
            if lother == usize::MAX || init_t[lother] {
                continue;
            }
            if forward {
                // pose_b = pose_a ∘ sim_ab.inverse()
                // sim_ab_inv: s_inv=1/s, θ_inv=-θ, t_inv = -R(-θ)·t_ab/s
                // Translation composition: t_b = R(θ_a)·(1/s_a)·t_ab_inv + t_a
                // But since pose_a = (s_a, θ_a, t_a) and we're applying pose_a to
                // the translation of sim_ab.inverse:
                //   t_b = pose_a.apply(sim_ab_inv.t) = s_a·R(θ_a)·sim_ab_inv.t + t_a
                //
                // For anchor (s_a=1, θ_a=0, t_a=0): t_b = sim_ab_inv.t
                let s = c.sim_ab.scale;
                let (sin_ab, cos_ab) = c.sim_ab.theta.sin_cos();
                let inv_s = 1.0 / s;
                // sim_ab_inv.t = -R(-θ_ab)·t_ab / s
                let (sin_inv, cos_inv) = (-c.sim_ab.theta).sin_cos();
                let sim_ab_inv_tx = inv_s * (cos_inv * (-c.sim_ab.tx) - sin_inv * (-c.sim_ab.ty));
                let sim_ab_inv_ty = inv_s * (sin_inv * (-c.sim_ab.tx) + cos_inv * (-c.sim_ab.ty));

                let (sin_a, cos_a) = theta[lnode].sin_cos();
                let sa = lns[lnode].exp();
                tx[lother] = sa * (cos_a * sim_ab_inv_tx - sin_a * sim_ab_inv_ty) + tx[lnode];
                ty[lother] = sa * (sin_a * sim_ab_inv_tx + cos_a * sim_ab_inv_ty) + ty[lnode];
            } else {
                // pose_a = pose_b ∘ sim_ab
                // t_a = pose_b.apply(sim_ab.t) = s_b·R(θ_b)·t_ab + t_b
                let s_b = lns[lnode].exp();
                let (sin_b, cos_b) = theta[lnode].sin_cos();
                tx[lother] = s_b * (cos_b * c.sim_ab.tx - sin_b * c.sim_ab.ty) + tx[lnode];
                ty[lother] = s_b * (sin_b * c.sim_ab.tx + cos_b * c.sim_ab.ty) + ty[lnode];
            }
            init_t[lother] = true;
            bfs2.push_back(gother);
        }
    }

    // Global LS refinement for translations (2-D system per frame,
    // same structure as scalar LS above but coupled x/y).
    let (tx_out, ty_out) = ls_translation(
        n,
        anchor_local,
        &tx,
        &ty,
        &lns,
        &theta,
        constraints,
        &local_idx,
    );
    tx = tx_out;
    ty = ty_out;

    // --- Assemble absolute poses ---
    let poses: Vec<TilePose> = reachable
        .iter()
        .enumerate()
        .map(|(li, &gi)| TilePose {
            sim: Similarity2d {
                scale: lns[li].exp(),
                theta: theta[li],
                tx: tx[li],
                ty: ty[li],
            },
            frame_idx: gi,
        })
        .collect();

    // --- Canvas sizing ---
    let canvas = size_canvas(&poses, frame_dims);

    Ok((poses, canvas))
}

/// Weighted scalar least-squares with anchor constraint (log-scale or
/// rotation). Solves for `x` in `Ax = b` where the anchor row is an
/// identity constraint `x[anchor] = init[anchor]` (= 0 for the anchor
/// itself, or the spanning-tree init value).
///
/// `use_log_scale`: if true, uses `sim_ab.scale.ln()` for the rhs;
/// otherwise uses `sim_ab.theta`.
fn ls_scalar(
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
fn ls_translation(
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
        let (sin_ab, cos_ab) = c.sim_ab.theta.sin_cos();
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
fn gauss_eliminate(a: &mut [f64], b: &mut [f64], n: usize) -> Vec<f64> {
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
fn size_canvas(poses: &[TilePose], frame_dims: &[(u32, u32)]) -> TileCanvasSpec {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::similarity::Similarity2d;

    fn translation_constraint(a: usize, b: usize, tx: f64, ty: f64, w: f64) -> TileConstraint {
        TileConstraint {
            a,
            b,
            sim_ab: Similarity2d {
                scale: 1.0,
                theta: 0.0,
                tx,
                ty,
            },
            weight: w,
        }
    }

    #[test]
    fn three_frame_strip_places_correctly() {
        // 3 frames in a horizontal strip. sim_01 and sim_12 have tx=100,
        // meaning frame_1 is 100px to the right of frame_0 in the sense that
        // sim_01.apply(frame_0_px) ≈ frame_1_px (frame_1 pixel = frame_0 pixel + 100).
        //
        // Pose semantics: pose_i maps frame_i → canvas via
        //   canvas = pose.sim.apply(src) + offset.
        // With pose_b = pose_a ∘ sim_ab.inverse():
        //   pose_1.tx = -(sim_01.tx) = -100 (frame_1's left edge at canvas = offset + 0)
        //   pose_2.tx = -200
        //
        // Consistency check: for a match at frame_0.px=50 → frame_1.px=150:
        //   canvas_a = pose_0.apply(50) + offset = 50 + offset
        //   canvas_b = pose_1.apply(150) + offset = (150 - 100) + offset = 50 + offset ✓
        let dims = vec![(200u32, 200u32); 3];
        let constraints = vec![
            translation_constraint(0, 1, 100.0, 0.0, 50.0),
            translation_constraint(1, 2, 100.0, 0.0, 50.0),
        ];
        let (poses, canvas) = solve_tile_poses(3, &constraints, 0, &dims).unwrap();

        // frame 0 at identity.
        assert!(
            (poses[0].sim.tx).abs() < 1.0,
            "frame-0 tx={}",
            poses[0].sim.tx
        );
        assert!(
            (poses[0].sim.ty).abs() < 1.0,
            "frame-0 ty={}",
            poses[0].sim.ty
        );

        // frame 1: pose.tx = -100 (sim_01.tx=100 → inverse=-100).
        assert!(
            (poses[1].sim.tx + 100.0).abs() < 2.0,
            "frame-1 tx={}",
            poses[1].sim.tx
        );
        assert!(
            (poses[1].sim.ty).abs() < 2.0,
            "frame-1 ty={}",
            poses[1].sim.ty
        );

        // frame 2: pose.tx = -200.
        assert!(
            (poses[2].sim.tx + 200.0).abs() < 2.0,
            "frame-2 tx={}",
            poses[2].sim.tx
        );
        assert!(
            (poses[2].sim.ty).abs() < 2.0,
            "frame-2 ty={}",
            poses[2].sim.ty
        );

        // Canvas must be wide enough for 3 frames side by side.
        // With offset = MARGIN - min_x = 8 - (-200) = 208, width ≈ 200 + 200 + 200 + 16.
        assert!(canvas.width >= 400, "canvas width {}", canvas.width);
        assert!(canvas.height >= 200, "canvas height {}", canvas.height);
    }

    #[test]
    fn single_frame_returns_identity() {
        let dims = vec![(640u32, 480u32)];
        let (poses, _canvas) = solve_tile_poses(1, &[], 0, &dims).unwrap();
        assert_eq!(poses.len(), 1);
        assert!((poses[0].sim.tx).abs() < 1e-10);
        assert!((poses[0].sim.ty).abs() < 1e-10);
        assert!((poses[0].sim.scale - 1.0).abs() < 1e-10);
        assert!((poses[0].sim.theta).abs() < 1e-10);
    }

    #[test]
    fn gauss_eliminate_identity_system() {
        let n = 3;
        let mut a = vec![1.0, 0.0, 0.0, 0.0, 2.0, 0.0, 0.0, 0.0, 3.0f64];
        let mut b = vec![5.0, 10.0, 15.0];
        let x = gauss_eliminate(&mut a, &mut b, n);
        assert!((x[0] - 5.0).abs() < 1e-10);
        assert!((x[1] - 5.0).abs() < 1e-10);
        assert!((x[2] - 5.0).abs() < 1e-10);
    }
}
