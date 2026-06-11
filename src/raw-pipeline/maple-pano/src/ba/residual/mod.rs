//! Symmetric reprojection residuals + analytic Jacobians for the global
//! bundle adjustment (spec §5.3).
//!
//! # Residual model
//!
//! Every verified inlier correspondence between frames `a` and `b`
//! becomes **two directed blocks**: the observation in `a` is
//! back-projected through `a`'s intrinsics + pose and projected into `b`
//! (residual measured in `b`'s pixels), and vice versa — the "symmetric
//! reprojection error" of the spec. One directed block, source `s` →
//! destination `d`:
//!
//! ```text
//! u = (p_s − c_s) / f_s              source normalized, distorted
//! m = undistort(u; k1, k2)           Newton inverse (crate::distortion)
//! h = (m_x, m_y, 1)                  source ray (unnormalized — the
//!                                    projective chain is scale-free)
//! v = R_dᵀ · R_s · h                 destination camera coords, need v_z > 0
//! n = (v_x / v_z, v_y / v_z)         destination ideal
//! e = n · (1 + k1·ρ + k2·ρ²)         ρ = |n|², forward distortion
//! q = f_d · e + c_d                  predicted pixel
//! r = q − p_d                        residual, pixels
//! ```
//!
//! # Jacobians (analytic)
//!
//! Rotations use the **local axis-angle parameterization** of the spec:
//! the state stores `R` as a matrix and each LM step solves for a small
//! increment `δ` applied as `R ← R·exp([δ]×)` (right multiplication —
//! a perturbation in the camera frame), so all rotation Jacobians are
//! evaluated at `δ = 0` where they are exact and simple:
//! `∂(R·exp([δ])·h)/∂δ = −R·[h]×` and `∂(exp(−[δ])·v)/∂δ = [v]×`.
//! Focal and distortion derivatives chain through both the projection
//! *and* the source unprojection; the unprojection side differentiates
//! the Newton inverse exactly via the implicit function theorem on
//! `F(m) = m·D(|m|²) − u = 0` (a 2×2 solve). Every column is verified
//! against central finite differences in this module's tests.
//!
//! # Robustness, invalid blocks, determinism
//!
//! Blocks are scored with the Huber loss (δ = 2 px, spec §5.3) in IRLS
//! form: weight `w = min(1, δ/‖r‖)` on the normal equations. The IRLS
//! gradient `Σ w·Jᵀr` equals the true gradient of `Σ ρ_huber(‖r‖)`
//! exactly (`w = ρ′(s)/s`), so stationary points are those of the robust
//! cost; only the curvature approximation differs from a Triggs-corrected
//! Hessian, which affects the path, not the destination.
//!
//! A block whose chain is undefined at the current state (ray behind the
//! destination camera, distortion not invertible) contributes a fixed
//! Huber-linear penalty [`INVALID_BLOCK_RESIDUAL_PX`] and no gradient:
//! cost stays comparable across trial states (a step that pushes blocks
//! out of the valid domain pays for it) without a gradient discontinuity.
//!
//! Assembly is rayon-parallel over **fixed-size chunks merged in chunk
//! order**, so the floating-point reduction order — and therefore the
//! whole solve — is deterministic for a given input regardless of thread
//! count or scheduling.

use rayon::prelude::*;

use crate::ba::linalg::PackedSymmetric;
use crate::distortion::undistort;
use crate::math::{Mat3, Vec3};

/// Residual magnitude (px) charged for a block whose projection chain is
/// undefined at the current state. Enters the cost through the Huber
/// loss (linear regime), so it is a finite, constant penalty.
pub(crate) const INVALID_BLOCK_RESIDUAL_PX: f64 = 1e4;

/// Fixed rayon chunk size for cost/normal-equation accumulation. Chunks
/// are merged sequentially in chunk order — see the module docs on
/// determinism. 2048 blocks per chunk keeps ≥ ~10 chunks alive on the
/// gate-scale problems while bounding per-chunk accumulator memory.
const ASSEMBLY_CHUNK: usize = 2048;

/// Per-frame constants that never enter the state: the principal point
/// (fixed at the image center, crate convention).
#[derive(Debug, Clone, Copy)]
pub(crate) struct FrameMeta {
    pub cx: f64,
    pub cy: f64,
}

/// One directed residual block (see module docs). Frame indices are
/// local to the active solve subset.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Block {
    pub src: usize,
    pub dst: usize,
    /// Observed pixel in the source frame.
    pub p_src: (f64, f64),
    /// Observed pixel in the destination frame.
    pub p_dst: (f64, f64),
}

/// The BA state vector in structured form. Rotations are camera-to-world
/// (`d_world = R · d_cam`), matching [`crate::camera::Camera`].
#[derive(Debug, Clone)]
pub(crate) struct State {
    pub rotations: Vec<Mat3>,
    /// Shared focal length, pixels.
    pub shared_focal: f64,
    /// Per-frame focal overrides (decision §9.2 fallback); `None` ⇒ the
    /// frame uses `shared_focal`.
    pub focal_overrides: Vec<Option<f64>>,
    pub k1: f64,
    pub k2: f64,
}

impl State {
    pub fn focal(&self, frame: usize) -> f64 {
        self.focal_overrides[frame].unwrap_or(self.shared_focal)
    }
}

/// Maps state components to parameter-vector columns for one LM stage.
/// `None` ⇒ the component is held fixed in this stage (the gauge frame's
/// rotation, or frozen intrinsics).
#[derive(Debug, Clone)]
pub(crate) struct ParamLayout {
    /// First column of each frame's 3-parameter rotation increment.
    pub rot_cols: Vec<Option<usize>>,
    pub shared_focal_col: Option<usize>,
    /// Column of each frame's *override* focal (fallback frames only).
    pub focal_override_cols: Vec<Option<usize>>,
    pub k1_col: Option<usize>,
    pub k2_col: Option<usize>,
    pub n_params: usize,
}

impl ParamLayout {
    /// Stage-A layout: rotations only (intrinsics frozen), `gauge`
    /// excluded to pin the global rotation ambiguity.
    pub fn rotations_only(n_frames: usize, gauge: usize) -> Self {
        let mut rot_cols = vec![None; n_frames];
        let mut col = 0;
        for (i, slot) in rot_cols.iter_mut().enumerate() {
            if i != gauge {
                *slot = Some(col);
                col += 3;
            }
        }
        Self {
            rot_cols,
            shared_focal_col: None,
            focal_override_cols: vec![None; n_frames],
            k1_col: None,
            k2_col: None,
            n_params: col,
        }
    }

    /// Full joint layout: rotations (gauge excluded) + shared focal +
    /// per-frame focal overrides for `freed` frames + k1 + k2.
    pub fn full(n_frames: usize, gauge: usize, freed: &[usize]) -> Self {
        let mut layout = Self::rotations_only(n_frames, gauge);
        let mut col = layout.n_params;
        layout.shared_focal_col = Some(col);
        col += 1;
        for &f in freed {
            layout.focal_override_cols[f] = Some(col);
            col += 1;
        }
        layout.k1_col = Some(col);
        col += 1;
        layout.k2_col = Some(col);
        col += 1;
        layout.n_params = col;
        layout
    }

    /// Single-parameter layout freeing only `frame`'s focal override —
    /// the §9.2 fallback probe.
    pub fn focal_probe(n_frames: usize, frame: usize) -> Self {
        let mut focal_override_cols = vec![None; n_frames];
        focal_override_cols[frame] = Some(0);
        Self {
            rot_cols: vec![None; n_frames],
            shared_focal_col: None,
            focal_override_cols,
            k1_col: None,
            k2_col: None,
            n_params: 1,
        }
    }

    /// The column `frame`'s focal maps to under this layout (its
    /// override column when freed, else the shared column), if any.
    fn focal_col(&self, frame: usize) -> Option<usize> {
        self.focal_override_cols[frame].or(self.shared_focal_col)
    }
}

/// Huber loss value for a residual magnitude `s ≥ 0`.
pub(crate) fn huber_cost(delta: f64, s: f64) -> f64 {
    if s <= delta {
        0.5 * s * s
    } else {
        delta * (s - 0.5 * delta)
    }
}

/// IRLS weight `ρ′(s)/s` of the Huber loss.
pub(crate) fn huber_weight(delta: f64, s: f64) -> f64 {
    if s <= delta {
        1.0
    } else {
        delta / s
    }
}

/// Jacobian of one directed block: 2-row derivative slabs per state
/// component (see module docs for the derivations).
#[derive(Debug, Clone, Copy)]
pub(crate) struct BlockJacobian {
    pub d_rot_src: [[f64; 3]; 2],
    pub d_rot_dst: [[f64; 3]; 2],
    /// Through the *source unprojection* (`∂u/∂f_s = −u/f_s` + implicit
    /// undistort derivative).
    pub d_f_src: [f64; 2],
    /// Through the *destination projection* (`∂q/∂f_d = e`).
    pub d_f_dst: [f64; 2],
    pub d_k1: [f64; 2],
    pub d_k2: [f64; 2],
}

/// Evaluate one block's residual; `None` when the chain is undefined at
/// this state (the caller charges [`INVALID_BLOCK_RESIDUAL_PX`]).
pub(crate) fn eval_residual(
    state: &State,
    frames: &[FrameMeta],
    block: &Block,
) -> Option<[f64; 2]> {
    eval_block(state, frames, block, false).map(|(r, _)| r)
}

/// Evaluate one block's residual and analytic Jacobian.
pub(crate) fn eval_with_jacobian(
    state: &State,
    frames: &[FrameMeta],
    block: &Block,
) -> Option<([f64; 2], BlockJacobian)> {
    eval_block(state, frames, block, true).map(|(r, j)| (r, j.expect("jacobian requested")))
}

#[allow(clippy::similar_names)]
fn eval_block(
    state: &State,
    frames: &[FrameMeta],
    block: &Block,
    with_jacobian: bool,
) -> Option<([f64; 2], Option<BlockJacobian>)> {
    let (k1, k2) = (state.k1, state.k2);
    let f_s = state.focal(block.src);
    let f_d = state.focal(block.dst);
    let (cx_s, cy_s) = (frames[block.src].cx, frames[block.src].cy);
    let (cx_d, cy_d) = (frames[block.dst].cx, frames[block.dst].cy);
    let r_s = &state.rotations[block.src];
    let r_d = &state.rotations[block.dst];

    // Source unprojection.
    let u = ((block.p_src.0 - cx_s) / f_s, (block.p_src.1 - cy_s) / f_s);
    let (mx, my) = undistort(u.0, u.1, k1, k2)?;
    let sigma = mx * mx + my * my;
    let h = Vec3::new(mx, my, 1.0);

    // Through the rotations into the destination camera frame.
    let v = r_d.transpose().mul_vec(r_s.mul_vec(h));
    if v.z <= 1e-9 {
        return None;
    }

    // Destination projection.
    let n = (v.x / v.z, v.y / v.z);
    let rho = n.0 * n.0 + n.1 * n.1;
    let d_t = 1.0 + k1 * rho + k2 * rho * rho;
    let e = (n.0 * d_t, n.1 * d_t);
    let q = (f_d * e.0 + cx_d, f_d * e.1 + cy_d);
    let r = [q.0 - block.p_dst.0, q.1 - block.p_dst.1];

    if !with_jacobian {
        return Some((r, None));
    }

    // ∂n/∂v (2×3) and ∂e/∂n (2×2, distortion tangent).
    let inv_vz = 1.0 / v.z;
    let p_mat = [
        [inv_vz, 0.0, -n.0 * inv_vz],
        [0.0, inv_vz, -n.1 * inv_vz],
    ];
    let dprime_t = k1 + 2.0 * k2 * rho;
    let e_mat = [
        [d_t + 2.0 * dprime_t * n.0 * n.0, 2.0 * dprime_t * n.0 * n.1],
        [2.0 * dprime_t * n.0 * n.1, d_t + 2.0 * dprime_t * n.1 * n.1],
    ];
    // M1 = f_d · E · P  (2×3): ∂q/∂v.
    let mut m1 = [[0.0; 3]; 2];
    for row in 0..2 {
        for col in 0..3 {
            m1[row][col] = f_d * (e_mat[row][0] * p_mat[0][col] + e_mat[row][1] * p_mat[1][col]);
        }
    }

    // Destination rotation: ∂v/∂δ_d = [v]× at δ = 0.
    let skew_v = skew(v);
    let d_rot_dst = mul_2x3_3x3(&m1, &skew_v);

    // Source rotation: ∂v/∂δ_s = −Q·[h]× with Q = R_dᵀ·R_s.
    let q_mat = r_d.transpose().mul_mat(r_s);
    let skew_h = skew(h);
    let m1q = mul_2x3_3x3(&m1, &q_mat.0);
    let mut d_rot_src = mul_2x3_3x3(&m1q, &skew_h);
    for row in &mut d_rot_src {
        for cell in row.iter_mut() {
            *cell = -*cell;
        }
    }

    // M2 = ∂q/∂m (2×2): M1·Q restricted to the (x, y) columns of h.
    let m2 = [[m1q[0][0], m1q[0][1]], [m1q[1][0], m1q[1][1]]];

    // Implicit derivative of the undistort: A = ∂F/∂m for
    // F(m) = m·D(σ) − u, with A⁻¹ = ∂m/∂u.
    let d_src = 1.0 + k1 * sigma + k2 * sigma * sigma;
    let dprime_s = k1 + 2.0 * k2 * sigma;
    let a_mat = [
        [d_src + 2.0 * dprime_s * mx * mx, 2.0 * dprime_s * mx * my],
        [2.0 * dprime_s * mx * my, d_src + 2.0 * dprime_s * my * my],
    ];
    let det = a_mat[0][0] * a_mat[1][1] - a_mat[0][1] * a_mat[1][0];
    if det.abs() < 1e-12 {
        return None; // At the distortion fold — chain not differentiable.
    }
    let inv_det = 1.0 / det;
    let a_inv = [
        [a_mat[1][1] * inv_det, -a_mat[0][1] * inv_det],
        [-a_mat[1][0] * inv_det, a_mat[0][0] * inv_det],
    ];

    // ∂r/∂f_s = M2 · A⁻¹ · (−u/f_s).
    let du_df = (-u.0 / f_s, -u.1 / f_s);
    let dm_df = mul_2x2_vec(&a_inv, du_df);
    let d_f_src = mul_2x2_vec_arr(&m2, dm_df);

    // ∂r/∂f_d = e.
    let d_f_dst = [e.0, e.1];

    // ∂r/∂k = f_d·n·ρᵖ (projection side) − M2·A⁻¹·m·σᵖ (unprojection).
    let dm_dk1 = mul_2x2_vec(&a_inv, (mx * sigma, my * sigma));
    let dm_dk2 = mul_2x2_vec(&a_inv, (mx * sigma * sigma, my * sigma * sigma));
    let proj_k1 = (f_d * n.0 * rho, f_d * n.1 * rho);
    let proj_k2 = (f_d * n.0 * rho * rho, f_d * n.1 * rho * rho);
    let src_k1 = mul_2x2_vec_arr(&m2, dm_dk1);
    let src_k2 = mul_2x2_vec_arr(&m2, dm_dk2);
    let d_k1 = [proj_k1.0 - src_k1[0], proj_k1.1 - src_k1[1]];
    let d_k2 = [proj_k2.0 - src_k2[0], proj_k2.1 - src_k2[1]];

    Some((
        r,
        Some(BlockJacobian {
            d_rot_src,
            d_rot_dst,
            d_f_src,
            d_f_dst,
            d_k1,
            d_k2,
        }),
    ))
}

fn skew(v: Vec3) -> [[f64; 3]; 3] {
    [
        [0.0, -v.z, v.y],
        [v.z, 0.0, -v.x],
        [-v.y, v.x, 0.0],
    ]
}

fn mul_2x3_3x3(a: &[[f64; 3]; 2], b: &[[f64; 3]; 3]) -> [[f64; 3]; 2] {
    let mut out = [[0.0; 3]; 2];
    for row in 0..2 {
        for col in 0..3 {
            out[row][col] = a[row][0] * b[0][col] + a[row][1] * b[1][col] + a[row][2] * b[2][col];
        }
    }
    out
}

fn mul_2x2_vec(a: &[[f64; 2]; 2], v: (f64, f64)) -> (f64, f64) {
    (
        a[0][0] * v.0 + a[0][1] * v.1,
        a[1][0] * v.0 + a[1][1] * v.1,
    )
}

fn mul_2x2_vec_arr(a: &[[f64; 2]; 2], v: (f64, f64)) -> [f64; 2] {
    [
        a[0][0] * v.0 + a[0][1] * v.1,
        a[1][0] * v.0 + a[1][1] * v.1,
    ]
}

/// Assembled normal equations + robust cost at one state.
pub(crate) struct NormalEqs {
    pub h: PackedSymmetric,
    /// Gradient `Σ w·Jᵀ·r` (the LM step solves `(H + λD)·x = −g`).
    pub g: Vec<f64>,
    pub cost: f64,
}

/// Total robust cost at `state` — the LM accept/reject metric.
/// Deterministic rayon reduction (fixed chunks, ordered merge).
pub(crate) fn total_cost(
    blocks: &[Block],
    frames: &[FrameMeta],
    state: &State,
    huber_delta: f64,
) -> f64 {
    blocks
        .par_chunks(ASSEMBLY_CHUNK)
        .map(|chunk| {
            chunk
                .iter()
                .map(|b| {
                    let s = match eval_residual(state, frames, b) {
                        Some(r) => (r[0] * r[0] + r[1] * r[1]).sqrt(),
                        None => INVALID_BLOCK_RESIDUAL_PX,
                    };
                    huber_cost(huber_delta, s)
                })
                .sum::<f64>()
        })
        .collect::<Vec<f64>>()
        .into_iter()
        .sum()
}

/// Assemble `H = Σ w·JᵀJ`, `g = Σ w·Jᵀr`, and the robust cost at `state`
/// under `layout`. Deterministic rayon reduction (fixed chunks, ordered
/// merge).
pub(crate) fn assemble(
    blocks: &[Block],
    frames: &[FrameMeta],
    state: &State,
    layout: &ParamLayout,
    huber_delta: f64,
) -> NormalEqs {
    let partials: Vec<NormalEqs> = blocks
        .par_chunks(ASSEMBLY_CHUNK)
        .map(|chunk| {
            let mut eqs = NormalEqs {
                h: PackedSymmetric::zeros(layout.n_params),
                g: vec![0.0; layout.n_params],
                cost: 0.0,
            };
            for block in chunk {
                accumulate_block(&mut eqs, frames, state, layout, huber_delta, block);
            }
            eqs
        })
        .collect();

    let mut total = NormalEqs {
        h: PackedSymmetric::zeros(layout.n_params),
        g: vec![0.0; layout.n_params],
        cost: 0.0,
    };
    for part in &partials {
        total.h.add_assign(&part.h);
        for (a, b) in total.g.iter_mut().zip(&part.g) {
            *a += b;
        }
        total.cost += part.cost;
    }
    total
}

fn accumulate_block(
    eqs: &mut NormalEqs,
    frames: &[FrameMeta],
    state: &State,
    layout: &ParamLayout,
    huber_delta: f64,
    block: &Block,
) {
    let Some((r, jac)) = eval_with_jacobian(state, frames, block) else {
        eqs.cost += huber_cost(huber_delta, INVALID_BLOCK_RESIDUAL_PX);
        return;
    };
    let s = (r[0] * r[0] + r[1] * r[1]).sqrt();
    eqs.cost += huber_cost(huber_delta, s);
    let w = huber_weight(huber_delta, s);

    // Collect this block's nonzero Jacobian columns, merging duplicates
    // (a shared focal serves both the source and destination paths).
    let mut entries: [(usize, [f64; 2]); 10] = [(0, [0.0; 2]); 10];
    let mut count = 0;
    let mut push = |col: usize, j: [f64; 2]| {
        for entry in entries.iter_mut().take(count) {
            if entry.0 == col {
                entry.1[0] += j[0];
                entry.1[1] += j[1];
                return;
            }
        }
        entries[count] = (col, j);
        count += 1;
    };
    if let Some(c0) = layout.rot_cols[block.src] {
        for k in 0..3 {
            push(c0 + k, [jac.d_rot_src[0][k], jac.d_rot_src[1][k]]);
        }
    }
    if let Some(c0) = layout.rot_cols[block.dst] {
        for k in 0..3 {
            push(c0 + k, [jac.d_rot_dst[0][k], jac.d_rot_dst[1][k]]);
        }
    }
    if let Some(c) = layout.focal_col(block.src) {
        push(c, jac.d_f_src);
    }
    if let Some(c) = layout.focal_col(block.dst) {
        push(c, jac.d_f_dst);
    }
    if let Some(c) = layout.k1_col {
        push(c, jac.d_k1);
    }
    if let Some(c) = layout.k2_col {
        push(c, jac.d_k2);
    }

    for i in 0..count {
        let (ci, ji) = entries[i];
        eqs.g[ci] += w * (ji[0] * r[0] + ji[1] * r[1]);
        for entry in entries.iter().take(i + 1) {
            let (cj, jj) = *entry;
            eqs.h.add(ci, cj, w * (ji[0] * jj[0] + ji[1] * jj[1]));
        }
    }
}


#[cfg(test)]
mod tests;
