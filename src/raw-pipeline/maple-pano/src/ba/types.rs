//! Result and option types for the global bundle adjustment
//! ([`super::solve`]). Split from `ba/mod.rs` for the file-size budget.

use crate::camera::Camera;
use crate::local_align::LocalCorrection;
use crate::math::{matrix_to_axis_angle, Mat3};

/// Frame-retention policy: what the §5.3 residual budgets mean for a
/// frame's survival (spec §8 vs strict acceptance).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum RetentionPolicy {
    /// Product default. A frame with a certified rigid core (stage E
    /// conditions (a)+(b)) is KEPT regardless of how much of its
    /// support is non-rigid: over-budget matches are pruned, seams
    /// route around the rest, and the report carries the spec §8
    /// warning. Drops are pose-evidence-only — disconnected frames and
    /// frames with no certifiable core. This is the §8 failure-mode
    /// table's prescribed behavior (warn + seam-route, never silently
    /// discard a posable photo).
    #[default]
    KeepAlignable,
    /// The §5.3 budgets act as frame drop criteria, including the
    /// motion-dominated ceiling (stage E condition (c)). The harness's
    /// adversarial scenarios and residual-perfect outputs use this.
    Strict,
}

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
    /// Frame-retention policy (see [`RetentionPolicy`]).
    pub retention: RetentionPolicy,
    /// Stage-F local alignment (#1218): when false the geometric chain
    /// ends at the BA rotations (pure #1213 geometry) — no mesh fit, no
    /// corrected gating, no correction at warp time.
    pub local_align: bool,
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
            retention: RetentionPolicy::default(),
            local_align: true,
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
    /// Spec §8 motion path ([`super::motion`]): the frame HAS a
    /// qualifying static core (`core_matches` tight correspondences at
    /// `core_mean_px`) but more than the motion ceiling of its support
    /// is over the max budget (`motion_fraction`, of the frame's
    /// gate-round-start support) — too little static truth remains to
    /// pose the frame reliably, so it drops with its core evidence
    /// attached instead of a bare residual summary.
    MotionDominated {
        core_mean_px: f64,
        core_matches: usize,
        motion_fraction: f64,
    },
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
    /// Per-frame residual summaries AFTER local alignment (#1218).
    /// Null for dropped frames. These are the stats the acceptance gate
    /// is measured against (spec §5.3 — end-of-chain measurement).
    pub frame_stats: Vec<Option<FrameStats>>,
    pub dropped: Vec<DroppedFrame>,
    /// Mean/max reprojection error over all solved blocks AFTER local
    /// alignment (px). 0 when fewer than two frames survive.
    /// End-of-chain measurement per spec §5.3 + #1218 requirement.
    pub mean_reproj_px: f64,
    pub max_reproj_px: f64,
    /// Pre-local-alignment mean/max for auditability (StitchReport §6).
    pub mean_reproj_before_local_px: f64,
    pub max_reproj_before_local_px: f64,
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
    /// in [`solve`]'s implementation. Motion prunes are counted
    /// separately in [`Self::motion_pruned_matches`].
    pub pruned_matches: usize,
    /// Frames the spec §8 gate ([`super::motion`]) reclassified as
    /// motion-affected: they failed the §5.3 budgets on their raw
    /// residuals but carry a qualifying static core, so their motion
    /// matches were pruned and the frame was KEPT. Sorted global frame
    /// indices; always a subset of the solved (non-dropped) frames.
    /// Non-empty ⇒ the product surfaces the §8 movement warning.
    pub motion_affected: Vec<usize>,
    /// Correspondences pruned as motion per entry of
    /// [`Self::motion_affected`] (parallel vector; a pair touching two
    /// motion-affected frames counts toward both).
    pub motion_pruned_matches: Vec<usize>,
    /// Spec §8 low-texture failure mode: frames with **zero verified
    /// edges to any neighbor** (e.g. sky-only content) that were placed
    /// from their gimbal-prior rotation instead of reported as
    /// [`DropReason::Disconnected`]. Sorted global frame indices; always
    /// a subset of the solved (non-dropped) frames — `cameras[i]` is
    /// `Some` for every entry, same invariant as a normally-solved
    /// frame, but the pose is the gauge-aligned advisory prior verbatim
    /// (never refined — there is no correspondence data to refine it
    /// against) at the shared solved focal/k1/k2. Never populated for a
    /// frame that had ANY verified edge, even one to a disconnected
    /// sub-component: that is a real geometry/motion signal
    /// ([`DropReason::Disconnected`] or [`DropReason::HighResidual`])
    /// this fallback must not paper over. Non-empty ⇒ the product
    /// surfaces the §8 "placed using the drone's camera data" notice.
    pub placed_by_prior: Vec<usize>,
    /// Per-frame local alignment corrections (#1218, spec §8): the
    /// stage-F bilinear mesh fields applied at composite time to absorb
    /// the parallax floor. Indexed by global frame index; `None` for
    /// dropped frames, for retained frames with zero contributing
    /// blocks, and for frames whose fit came back identity (no signal,
    /// or refused by the parallax envelope) — a stored correction
    /// always moves at least one node.
    pub local_corrections: Vec<Option<LocalCorrection>>,
    /// Per-frame correction RMS magnitudes (px), parallel to
    /// `local_corrections` — logged in the stitch report for auditability.
    /// 0.0 for frames with no correction.
    pub local_correction_rms: Vec<f64>,
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
