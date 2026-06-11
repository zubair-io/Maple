//! Levenberg–Marquardt loop over the BA residuals — in-tree, dense
//! normal equations + Cholesky (decision §9.1: no Ceres; see
//! [`crate::ba`] module docs for why in-tree beats `argmin` here).
//!
//! Standard Marquardt damping: solve `(H + λ·diag(H))·x = −g`, evaluate
//! the **true robust cost** at the trial state, accept on strict
//! decrease (λ ÷ 3) or reject and retry with λ × 4. The diagonal
//! scaling makes the damping unit-aware across the mixed
//! radians/pixels/dimensionless state. Huber weights are re-linearized
//! at every accepted iterate (IRLS — the gradient identity in
//! [`crate::ba::residual`] guarantees the same stationary points as the
//! true robust objective).

use crate::ba::residual::{assemble, total_cost, Block, FrameMeta, ParamLayout, State};
use crate::math::axis_angle_to_matrix;

/// A focal this small (pixels) means the step left the physically
/// meaningful domain; the trial is rejected like a cost increase.
const MIN_FOCAL_PX: f64 = 8.0;
/// λ escalation ceiling — past this the surface is not locally
/// improvable at working precision and the loop reports `converged:
/// false` honestly.
const LAMBDA_MAX: f64 = 1e16;
/// Absolute robust-cost floor (px² units). At or below this the
/// residuals are numerical noise — mean block residuals well under
/// 1e-8 px — and the relative-improvement criterion can never fire
/// (it scales with the near-zero cost), so the loop would grind out
/// noise-level "improvements". Stop immediately instead.
const COST_ABS_FLOOR: f64 = 1e-16;

#[derive(Debug, Clone)]
pub(crate) struct LmOptions {
    pub max_iterations: usize,
    /// Accepted-step relative cost-improvement threshold: stop when
    /// `cost_prev − cost ≤ tol · cost_prev`.
    pub cost_rel_tol: f64,
    /// Accepted-step infinity-norm threshold (secondary stop).
    pub step_tol: f64,
    pub lambda_init: f64,
}

impl Default for LmOptions {
    fn default() -> Self {
        Self {
            max_iterations: 200,
            cost_rel_tol: 1e-12,
            step_tol: 1e-14,
            lambda_init: 1e-3,
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct LmSummary {
    pub iterations: usize,
    /// Diagnostic; read by the lm unit tests and kept for debugging —
    /// the lib build alone has no reader.
    #[allow(dead_code)]
    pub initial_cost: f64,
    pub final_cost: f64,
    pub converged: bool,
}

/// Minimize the robust BA cost over the parameters selected by `layout`,
/// updating `state` in place. Deterministic for a given input (the
/// residual assembly reduces in fixed chunk order).
pub(crate) fn minimize(
    blocks: &[Block],
    frames: &[FrameMeta],
    state: &mut State,
    layout: &ParamLayout,
    huber_delta: f64,
    opts: &LmOptions,
) -> LmSummary {
    let initial_cost = total_cost(blocks, frames, state, huber_delta);
    let mut summary = LmSummary {
        iterations: 0,
        initial_cost,
        final_cost: initial_cost,
        converged: false,
    };
    if layout.n_params == 0 || blocks.is_empty() || initial_cost <= COST_ABS_FLOOR {
        summary.converged = true;
        return summary;
    }

    let mut lambda = opts.lambda_init;
    let mut cost = initial_cost;
    for _ in 0..opts.max_iterations {
        summary.iterations += 1;
        let eqs = assemble(blocks, frames, state, layout, huber_delta);
        cost = eqs.cost;
        let neg_g: Vec<f64> = eqs.g.iter().map(|v| -v).collect();
        let diag = eqs.h.diagonal();
        let diag_floor = diag.iter().fold(0.0_f64, |m, &d| m.max(d)).max(1.0) * 1e-12;

        // Inner λ escalation: reuse H and g, only the damping changes.
        let mut accepted: Option<(State, f64, f64)> = None;
        while lambda <= LAMBDA_MAX {
            let damping: Vec<f64> = diag.iter().map(|&d| lambda * d.max(diag_floor)).collect();
            let Some(step) = eqs.h.solve_damped(&damping, &neg_g) else {
                lambda *= 4.0;
                continue;
            };
            let mut trial = state.clone();
            if !apply_step(&mut trial, layout, &step) {
                lambda *= 4.0;
                continue;
            }
            let trial_cost = total_cost(blocks, frames, &trial, huber_delta);
            if trial_cost.is_finite() && trial_cost < cost {
                let step_norm = step.iter().fold(0.0_f64, |m, &s| m.max(s.abs()));
                accepted = Some((trial, trial_cost, step_norm));
                lambda = (lambda / 3.0).max(1e-12);
                break;
            }
            lambda *= 4.0;
        }

        let Some((next, next_cost, step_norm)) = accepted else {
            // No improving step exists at working precision: this *is*
            // the (local) minimum for all practical purposes.
            summary.final_cost = cost;
            summary.converged = true;
            return summary;
        };
        let improvement = cost - next_cost;
        *state = next;
        cost = next_cost;
        summary.final_cost = cost;
        if cost <= COST_ABS_FLOOR
            || improvement <= opts.cost_rel_tol * cost.max(f64::MIN_POSITIVE)
            || step_norm <= opts.step_tol
        {
            summary.converged = true;
            return summary;
        }
    }
    summary.final_cost = cost;
    summary
}

/// Apply one LM step under `layout`: rotation increments compose on the
/// right (`R ← R·exp([δ]×)`, the local parameterization the Jacobians
/// are written for); scalars add. Returns `false` when the step leaves
/// the valid domain (non-positive-ish focal, non-finite values).
fn apply_step(state: &mut State, layout: &ParamLayout, step: &[f64]) -> bool {
    for (i, c0) in layout.rot_cols.iter().enumerate() {
        if let Some(c0) = *c0 {
            let delta = axis_angle_to_matrix([step[c0], step[c0 + 1], step[c0 + 2]]);
            state.rotations[i] = state.rotations[i].mul_mat(&delta);
        }
    }
    if let Some(c) = layout.shared_focal_col {
        state.shared_focal += step[c];
        if !state.shared_focal.is_finite() || state.shared_focal < MIN_FOCAL_PX {
            return false;
        }
    }
    for (i, c) in layout.focal_override_cols.iter().enumerate() {
        if let Some(c) = *c {
            let f = state.focal_overrides[i]
                .as_mut()
                .expect("layout frees a focal override the state does not carry");
            *f += step[c];
            if !f.is_finite() || *f < MIN_FOCAL_PX {
                return false;
            }
        }
    }
    if let Some(c) = layout.k1_col {
        state.k1 += step[c];
        if !state.k1.is_finite() {
            return false;
        }
    }
    if let Some(c) = layout.k2_col {
        state.k2 += step[c];
        if !state.k2.is_finite() {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::camera::Camera;
    use crate::math::{matrix_to_axis_angle, Mat3};
    use crate::twoview::rotation_angle_between;

    /// Two-camera fixture with exact correspondences: LM must pull a
    /// perturbed second camera back onto the ground truth.
    fn two_camera_problem(k1: f64, k2: f64) -> (Vec<Block>, Vec<FrameMeta>, State, Mat3) {
        let gt_rot1 = axis_angle_to_matrix([0.04, 0.5, -0.03]);
        let cam0 = Camera::new([0.0; 3], 700.0, k1, k2, 1024, 768);
        let cam1 = Camera::new(matrix_to_axis_angle(&gt_rot1), 700.0, k1, k2, 1024, 768);
        let mut blocks = Vec::new();
        for ix in (64..1024).step_by(64) {
            for iy in (64..768).step_by(64) {
                let p0 = (ix as f64, iy as f64);
                let Some(dir) = cam0.pixel_to_world_dir(p0.0, p0.1) else {
                    continue;
                };
                let Some(p1) = cam1.world_dir_to_pixel(dir) else {
                    continue;
                };
                if !cam1.pixel_in_bounds(p1.0, p1.1, 4.0) {
                    continue;
                }
                blocks.push(Block {
                    src: 0,
                    dst: 1,
                    p_src: p0,
                    p_dst: p1,
                });
                blocks.push(Block {
                    src: 1,
                    dst: 0,
                    p_src: p1,
                    p_dst: p0,
                });
            }
        }
        assert!(blocks.len() > 100, "fixture overlap too small");
        let frames = vec![
            FrameMeta {
                cx: 512.0,
                cy: 384.0,
            },
            FrameMeta {
                cx: 512.0,
                cy: 384.0,
            },
        ];
        let state = State {
            rotations: vec![Mat3::identity(), gt_rot1],
            shared_focal: 700.0,
            focal_overrides: vec![None, None],
            k1,
            k2,
        };
        (blocks, frames, state, gt_rot1)
    }

    #[test]
    fn recovers_a_perturbed_rotation_exactly() {
        let (blocks, frames, gt_state, gt_rot1) = two_camera_problem(-0.05, 0.01);
        let mut state = gt_state.clone();
        // 8° perturbation on camera 1.
        state.rotations[1] = state.rotations[1].mul_mat(&axis_angle_to_matrix([0.1, -0.05, 0.06]));
        let layout = ParamLayout::rotations_only(2, 0);
        let summary = minimize(
            &blocks,
            &frames,
            &mut state,
            &layout,
            2.0,
            &LmOptions::default(),
        );
        assert!(summary.converged, "LM must converge: {summary:?}");
        assert!(summary.final_cost < 1e-12, "cost {}", summary.final_cost);
        let err = rotation_angle_between(&state.rotations[1], &gt_rot1).to_degrees();
        assert!(err < 1e-5, "rotation error {err}° after LM");
        // Gauge frame untouched.
        assert!(state.rotations[0].max_abs_diff(&Mat3::identity()) < 1e-15);
    }

    #[test]
    fn recovers_focal_and_distortion_jointly() {
        let (blocks, frames, gt_state, _) = two_camera_problem(-0.06, 0.02);
        let mut state = gt_state.clone();
        state.rotations[1] = state.rotations[1].mul_mat(&axis_angle_to_matrix([0.02, -0.03, 0.01]));
        state.shared_focal = 660.0; // ~6% off
        state.k1 = 0.0;
        state.k2 = 0.0;
        let layout = ParamLayout::full(2, 0, &[]);
        let summary = minimize(
            &blocks,
            &frames,
            &mut state,
            &layout,
            2.0,
            &LmOptions::default(),
        );
        assert!(summary.converged);
        assert!(
            (state.shared_focal - 700.0).abs() < 0.01,
            "focal {} after LM",
            state.shared_focal
        );
        assert!((state.k1 + 0.06).abs() < 1e-5, "k1 {}", state.k1);
        assert!((state.k2 - 0.02).abs() < 1e-5, "k2 {}", state.k2);
    }

    #[test]
    fn empty_parameter_set_is_a_no_op() {
        let (blocks, frames, mut state, _) = two_camera_problem(0.0, 0.0);
        let layout = ParamLayout {
            rot_cols: vec![None, None],
            shared_focal_col: None,
            focal_override_cols: vec![None, None],
            k1_col: None,
            k2_col: None,
            n_params: 0,
        };
        let before = state.clone();
        let summary = minimize(
            &blocks,
            &frames,
            &mut state,
            &layout,
            2.0,
            &LmOptions::default(),
        );
        assert!(summary.converged);
        assert_eq!(summary.iterations, 0);
        assert!(state.rotations[1].max_abs_diff(&before.rotations[1]) == 0.0);
    }

    #[test]
    fn already_optimal_state_converges_immediately() {
        let (blocks, frames, mut state, _) = two_camera_problem(-0.05, 0.01);
        let layout = ParamLayout::full(2, 0, &[]);
        let summary = minimize(
            &blocks,
            &frames,
            &mut state,
            &layout,
            2.0,
            &LmOptions::default(),
        );
        assert!(summary.converged);
        assert!(summary.final_cost <= summary.initial_cost);
        assert!(
            summary.iterations <= 3,
            "took {} iterations",
            summary.iterations
        );
    }
}
