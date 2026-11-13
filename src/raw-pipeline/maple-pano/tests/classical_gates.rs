//! #4523 — the clean-room classical detector/matcher, end to end: Harris
//! scale-space keypoints and gradient-histogram descriptors on a pair
//! rendered from the value-noise equirect
//! ([`maple_pano::testkit::value_noise_source`]), ratio-test matches adapted through [`maple_pano::glue`]
//! and verified into a match-graph edge whose rotation is compared to the
//! renderer's ground truth.
//!
//! No ONNX Runtime, models or fixtures are involved, so this runs on every
//! CI runner:
//!
//! ```text
//! cargo test -p maple-pano --no-default-features \
//!     --features classical-features,testkit --test classical_gates
//! ```

use maple_pano::camera::Camera;
use maple_pano::features::classical::{
    detect_classical, match_classical, ClassicalMatchOptions, ClassicalOptions,
};
use maple_pano::features::LinearRgbFrame;
use maple_pano::glue::{ml_matches_to_correspondences, DEFAULT_MIN_SCORE};
use maple_pano::graph::{build_match_graph, CaptureOrderProvider, GraphImage};
use maple_pano::prng::SplitMix64;
use maple_pano::render::{build_camera_set, render_frame, CameraSetOptions, Pattern};
use maple_pano::robust::RobustOptions;
use maple_pano::source::EquirectSource;
use maple_pano::testkit::value_noise_source;
use maple_pano::twoview::{relative_rotation_ground_truth, rotation_angle_between};

/// The noisy-correspondence two-view gate (`twoview_gates.rs`,
/// `gate_noisy_rotation_within_0_3_deg`).
const TWO_VIEW_GATE_DEG: f64 = 0.3;
/// Spec pair-acceptance floor (same as `ml_glue.rs`).
const MIN_INLIERS: usize = 30;

struct PairOutcome {
    inliers: usize,
    err_deg: f64,
}

fn render_pair(
    source: &EquirectSource,
    opts: &CameraSetOptions,
    seed: u64,
) -> Vec<(Camera, LinearRgbFrame)> {
    build_camera_set(opts, &mut SplitMix64::new(seed))
        .expect("camera set")
        .iter()
        .map(|gt| {
            let cam = gt.to_camera();
            let data = render_frame(source, &cam, 2).expect("render");
            let frame = LinearRgbFrame::from_u16_rgb(cam.width, cam.height, &data).expect("frame");
            (cam, frame)
        })
        .collect()
}

fn run_pair(source: &EquirectSource, opts: &CameraSetOptions, seed: u64) -> PairOutcome {
    let pair = render_pair(source, opts, seed);
    let detector = ClassicalOptions::default();
    let fs0 = detect_classical(&pair[0].1, &detector);
    let fs1 = detect_classical(&pair[1].1, &detector);
    let matches = match_classical(&fs0, &fs1, &ClassicalMatchOptions::default());
    let correspondences = ml_matches_to_correspondences(&matches, DEFAULT_MIN_SCORE);

    let images: Vec<GraphImage> = pair
        .iter()
        .map(|(cam, _)| GraphImage {
            camera: cam.clone(),
            prior_rotation: None,
        })
        .collect();
    let graph = build_match_graph(
        &images,
        &[&CaptureOrderProvider],
        |_, _| correspondences.clone(),
        &RobustOptions::default(),
    );
    assert!(
        graph.orphans.is_empty(),
        "both frames must verify ({} / {} keypoints, {} correspondences)",
        fs0.len(),
        fs1.len(),
        correspondences.len()
    );
    assert_eq!(graph.edges.len(), 1);
    let edge = &graph.edges[0];
    let gt_rel = relative_rotation_ground_truth(&pair[0].0, &pair[1].0);
    let outcome = PairOutcome {
        inliers: edge.inlier_count,
        err_deg: rotation_angle_between(&edge.rotation, &gt_rel).to_degrees(),
    };
    eprintln!(
        "classical_gates: {} / {} keypoints, {} correspondences, {} inliers, R_rel error {:.4}°",
        fs0.len(),
        fs1.len(),
        correspondences.len(),
        outcome.inliers,
        outcome.err_deg
    );
    outcome
}

fn assert_within_gate(outcome: &PairOutcome) {
    assert!(
        outcome.inliers >= MIN_INLIERS,
        "pair-acceptance floor: {} inliers < {MIN_INLIERS}",
        outcome.inliers
    );
    assert!(
        outcome.err_deg < TWO_VIEW_GATE_DEG,
        "relative rotation error {:.4}° exceeds the {TWO_VIEW_GATE_DEG}° two-view gate",
        outcome.err_deg
    );
}

fn ring_pair(jitter_deg: f64) -> CameraSetOptions {
    CameraSetOptions {
        count: 2,
        pattern: Pattern::Ring { full: false },
        fov_deg: 65.0,
        overlap: 0.5,
        pitch_deg: 8.0,
        jitter_deg,
        k1: 0.0,
        k2: 0.0,
        width: 1280,
        height: 960,
    }
}

#[test]
fn classical_pair_recovers_relative_rotation_within_two_view_gate() {
    assert_within_gate(&run_pair(
        &value_noise_source(4096, 2048),
        &ring_pair(1.0),
        21,
    ));
}

#[test]
fn classical_pair_with_strong_roll_recovers_relative_rotation() {
    assert_within_gate(&run_pair(
        &value_noise_source(4096, 2048),
        &ring_pair(20.0),
        7,
    ));
}
