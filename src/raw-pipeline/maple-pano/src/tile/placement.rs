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

#[path = "placement_solve.rs"]
mod placement_solve;
use placement_solve::{ls_scalar, ls_translation, size_canvas};

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
    /// absent from this list.
    pub poses: Vec<TilePose>,
    /// Frame indices (ascending) that are not reachable from `anchor` —
    /// the tile-path analogue of [`crate::graph::MatchGraph::orphans`].
    /// Empty when the graph is connected or has ≤ 1 frame.
    pub orphans: Vec<usize>,
}

/// Solve absolute canvas poses for all frames via anchored LS over the
/// similarity-edge graph.
///
/// `frame_count`: total number of frames (some may be unreachable).
/// `constraints`: per-edge relative similarities + weights.
/// `anchor`: the frame index to fix at the identity (must be `< frame_count`).
/// `frame_dims`: `(width, height)` per frame — used to size the canvas.
///
/// Returns `(poses, canvas_spec, orphans)`:
/// - `poses` contains only frames reachable from `anchor` (mirroring the
///   rotation path's largest-component policy). Each pose's `frame_idx`
///   is the global frame index so callers can filter frames and edges to
///   match without ambiguity.
/// - `orphans` is the ascending list of frame indices that are not
///   reachable from `anchor` — the caller reports and drops them,
///   exactly as [`crate::graph::MatchGraph::orphans`] is used in the
///   rotation path. Never silently misaligned.
pub fn solve_tile_poses(
    frame_count: usize,
    constraints: &[TileConstraint],
    anchor: usize,
    frame_dims: &[(u32, u32)],
) -> Result<(Vec<TilePose>, TileCanvasSpec, Vec<usize>), TilePlacementError> {
    if frame_count == 0 {
        return Err(TilePlacementError::NoFrames);
    }
    // Validate anchor before indexing visited[anchor].
    if anchor >= frame_count {
        return Err(TilePlacementError::IndexOutOfBounds {
            have: frame_count,
            bad: anchor,
        });
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

    // Collect orphans: frame indices not reachable from anchor.
    let mut orphans: Vec<usize> = (0..frame_count).filter(|&i| !visited[i]).collect();
    orphans.sort_unstable();

    Ok((poses, canvas, orphans))
}

/// Apply the total-canvas pixel cap (`--max-canvas-px`) to a tile
/// placement: when `canvas.width × canvas.height` exceeds `max_px`, scale
/// every pose and the canvas spec uniformly so the canvas fits (#3086).
///
/// The full source→canvas map is `pose.sim.apply(src) + offset`, so a
/// uniform downscale by `s` multiplies `sim.scale`, `sim.tx/ty`, and the
/// canvas offsets by `s` (θ unchanged). Within budget the inputs pass
/// through untouched.
pub fn apply_canvas_cap(
    poses: Vec<TilePose>,
    canvas: TileCanvasSpec,
    max_px: usize,
) -> (Vec<TilePose>, TileCanvasSpec) {
    let px = canvas.width as usize * canvas.height as usize;
    if px <= max_px || px == 0 {
        return (poses, canvas);
    }
    let s = (max_px as f64 / px as f64).sqrt();
    let scaled_poses = poses
        .into_iter()
        .map(|p| TilePose {
            sim: Similarity2d {
                scale: p.sim.scale * s,
                theta: p.sim.theta,
                tx: p.sim.tx * s,
                ty: p.sim.ty * s,
            },
            frame_idx: p.frame_idx,
        })
        .collect();
    let scaled_canvas = TileCanvasSpec {
        width: ((canvas.width as f64 * s).floor() as u32).max(1),
        height: ((canvas.height as f64 * s).floor() as u32).max(1),
        offset_x: canvas.offset_x * s,
        offset_y: canvas.offset_y * s,
    };
    (scaled_poses, scaled_canvas)
}

// Solver functions (ls_scalar, ls_translation, gauss_eliminate, size_canvas)
// are in placement_solve.rs, imported via `use` above.

#[cfg(test)]
#[path = "placement_tests.rs"]
mod tests;
