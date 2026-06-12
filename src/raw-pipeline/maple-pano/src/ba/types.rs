//! Result and option types for the global bundle adjustment
//! ([`super::solve`]). Split from `ba/mod.rs` for the file-size budget.

use crate::camera::Camera;
use crate::math::{matrix_to_axis_angle, Mat3};

/// Tuning for [`solve`]. The defaults are the spec values; tests and
/// benches override selectively.
#[derive(Debug, Clone)]
pub struct BaOptions {
    /// Huber loss scale, pixels (spec §5.3: 2 px).
    pub huber_delta_px: f64,
    /// Per-frame acceptance gate on the mean reprojection error (spec
    /// §5.3: 1.5 px).
    pub mean_budget_px: f64,
    /// Per-frame acceptance gate on the max reprojection error (spec
    /// §5.3: 6 px).
    pub max_budget_px: f64,
    /// LM iteration cap per stage.
    pub max_lm_iterations: usize,
    /// LM relative cost-improvement stop (tight — the basin bench
    /// asserts run-to-run cost identity at ~1e-6 on top of this).
    pub cost_rel_tol: f64,
    /// Warm-start hook: per-image camera-to-world rotations that
    /// override the spanning-tree initialization where `Some`. Used by
    /// the convergence-basin bench (perturbed inits) and re-solves.
    pub initial_rotations: Option<Vec<Option<Mat3>>>,
}

impl Default for BaOptions {
    fn default() -> Self {
        Self {
            huber_delta_px: 2.0,
            mean_budget_px: 1.5,
            max_budget_px: 6.0,
            max_lm_iterations: 200,
            cost_rel_tol: 1e-12,
            initial_rotations: None,
        }
    }
}

/// Why a frame is absent from the solved set. The shapes consume the
/// match graph's component/orphan reporting (spec: "report, never
/// silently drop").
#[derive(Debug, Clone, PartialEq)]
pub enum DropReason {
    /// Outside the largest connected component of the verified match
    /// graph (either from the start, or after a high-residual drop cut
    /// the component).
    Disconnected,
    /// Failed the spec §5.3 acceptance gate after the global solve.
    HighResidual { mean_px: f64, max_px: f64 },
}

/// One dropped frame with its reason; `index` is the position in the
/// input image list.
#[derive(Debug, Clone, PartialEq)]
pub struct DroppedFrame {
    pub index: usize,
    pub reason: DropReason,
}

/// Per-frame residual summary over the blocks measured in this frame's
/// pixel plane.
#[derive(Debug, Clone, PartialEq)]
pub struct FrameStats {
    pub mean_px: f64,
    pub max_px: f64,
    pub median_px: f64,
    /// Number of residual blocks (a frame in `k` verified edges with
    /// `m` total inlier matches has `m` blocks here — one direction of
    /// each correspondence lands in this frame's plane).
    pub blocks: usize,
}

/// The global solve result. `cameras[i]` is `None` exactly when frame
/// `i` appears in `dropped`.
#[derive(Debug, Clone)]
pub struct BaSolution {
    /// Final posed cameras (rotation + focal + k1/k2 + frame size).
    pub cameras: Vec<Option<Camera>>,
    pub shared_focal_px: f64,
    pub k1: f64,
    pub k2: f64,
    pub frame_stats: Vec<Option<FrameStats>>,
    pub dropped: Vec<DroppedFrame>,
    /// Mean/max reprojection error over all solved blocks (px). 0 when
    /// fewer than two frames survive (no blocks to measure).
    pub mean_reproj_px: f64,
    pub max_reproj_px: f64,
    /// Total LM iterations across stages and re-solve rounds.
    pub lm_iterations: usize,
    pub final_cost: f64,
    /// `false` when any LM stage hit its iteration cap before its
    /// tolerance — the solution is still the best state reached.
    pub converged: bool,
    /// Solve rounds executed (1 + one per high-residual drop).
    pub solve_rounds: usize,
    /// Correspondences removed by stage-D outlier rejection (both
    /// directed blocks of a match count once). Bad matches that survive
    /// the pairwise verifier, not misalignment — see the stage-D note
    /// in [`solve`]'s implementation.
    pub pruned_matches: usize,
}

impl BaSolution {
    /// Rotate the whole solved camera set by a global rotation
    /// (`R_i ← g·R_i`) — the application hook for
    /// [`crate::leveling`]. Gauge-only: relative geometry and all
    /// residual statistics are unchanged.
    pub fn apply_global_rotation(&mut self, g: &Mat3) {
        for cam in self.cameras.iter_mut().flatten() {
            let rotated = g.mul_mat(&cam.rotation);
            *cam = Camera::new(
                matrix_to_axis_angle(&rotated),
                cam.focal_px,
                cam.k1,
                cam.k2,
                cam.width,
                cam.height,
            );
        }
    }
}

/// Input validation failures for [`solve`].
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum BaError {
    #[error("image list length {images} != graph image count {graph}")]
    ImageCountMismatch { images: usize, graph: usize },
    #[error("initial_rotations length {given} != image count {expected}")]
    InitialRotationsLength { given: usize, expected: usize },
}
