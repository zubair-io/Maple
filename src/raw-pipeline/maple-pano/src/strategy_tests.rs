//! Unit tests for strategy.rs, split out to respect the file-size budget
//! (CONTRIBUTING.md § File-size budget).

use super::*;
use crate::graph::{MatchGraph, VerifiedEdge};
use crate::ingest::FramePriors;
use crate::math::Mat3;

fn dummy_edge(a: usize, b: usize, mean_residual_rad: f64) -> VerifiedEdge {
    VerifiedEdge {
        a,
        b,
        rotation: Mat3::identity(),
        inlier_count: 30,
        mean_residual_rad,
        inlier_matches: Vec::new(),
    }
}

fn dummy_graph(edges: Vec<VerifiedEdge>, n: usize) -> MatchGraph {
    MatchGraph {
        image_count: n,
        edges,
        rejected: vec![],
        components: vec![(0..n).collect()],
        orphans: vec![],
    }
}

fn dummy_priors(n: usize) -> Vec<FramePriors> {
    (0..n)
        .map(|_| FramePriors {
            focal_mm: None,
            focal_35mm_equiv: None,
            focal_px: None,
            gimbal: None,
        })
        .collect()
}

#[test]
fn explicit_rotation_always_selects_rotation() {
    let graph = dummy_graph(vec![dummy_edge(0, 1, 0.001)], 2);
    let priors = dummy_priors(2);
    let report = select_strategy(StrategyRequest::Rotation, &graph, &priors, 1000.0, 0);
    assert_eq!(report.selected, Strategy::Rotation);
    assert!(report.warning.is_none());
}

#[test]
fn explicit_tile_always_selects_tile_no_warning() {
    let graph = dummy_graph(vec![dummy_edge(0, 1, 0.001)], 2);
    let priors = dummy_priors(2);
    let report = select_strategy(StrategyRequest::Tile, &graph, &priors, 1000.0, 0);
    assert_eq!(report.selected, Strategy::Tile);
    assert!(report.warning.is_none()); // no warning for explicit
}

#[test]
fn auto_with_no_edges_defaults_to_rotation() {
    let graph = dummy_graph(vec![], 1);
    let priors = dummy_priors(1);
    let report = select_strategy(StrategyRequest::Auto, &graph, &priors, 1000.0, 0);
    assert_eq!(report.selected, Strategy::Rotation); // no votes → rotation wins
}

#[test]
fn auto_warns_when_tile_selected() {
    // Create a graph with a pure-translation edge.
    // We'll use a translation-generating match set.
    use crate::similarity::Similarity2d;
    use crate::twoview::PixelCorrespondence;

    let sim_gt = Similarity2d {
        scale: 1.0,
        theta: 0.0,
        tx: 500.0,
        ty: 0.0,
    };
    let matches: Vec<PixelCorrespondence> = (0..80)
        .map(|i| {
            let ax = (i as f64) * 4.0 + 50.0;
            let ay = ((i as f64) * 2.1).sin() * 100.0 + 200.0;
            let (bx, by) = sim_gt.apply(ax, ay);
            PixelCorrespondence {
                a: (ax, ay),
                b: (bx, by),
            }
        })
        .collect();

    // Make the rotation model look very poor (5 px residual), similarity excellent.
    let mut edge = dummy_edge(0, 1, 0.005); // 5mrad ≈ 5px at f=1000
    edge.inlier_matches = matches;
    let graph = dummy_graph(vec![edge], 2);
    let priors = dummy_priors(2);
    let report = select_strategy(StrategyRequest::Auto, &graph, &priors, 1000.0, 42);

    // Evidence: planar_rms should be near 0, rotation_rms ~5px → votes tile.
    assert_eq!(
        report.selected,
        Strategy::Tile,
        "setup must produce a tile vote"
    );
    assert!(report.warning.is_some(), "auto tile must warn");
}

#[test]
fn gimbal_identity_detected() {
    use crate::ingest::GimbalPrior;
    let priors: Vec<FramePriors> = (0..3)
        .map(|_| FramePriors {
            focal_mm: None,
            focal_35mm_equiv: None,
            focal_px: Some(1000.0),
            gimbal: Some(GimbalPrior {
                yaw_deg: 125.0,
                pitch_deg: -90.0,
                roll_deg: 0.0,
            }),
        })
        .collect();
    assert!(check_gimbal_identity(&priors));
}

#[test]
fn gimbal_rotation_not_identical() {
    use crate::ingest::GimbalPrior;
    let priors: Vec<FramePriors> = (0..3)
        .map(|i| FramePriors {
            focal_mm: None,
            focal_35mm_equiv: None,
            focal_px: Some(1000.0),
            gimbal: Some(GimbalPrior {
                yaw_deg: (i as f64) * 15.0,
                pitch_deg: -45.0,
                roll_deg: 0.0,
            }),
        })
        .collect();
    assert!(!check_gimbal_identity(&priors));
}

/// #3087: recorded pano_01 evidence — 39 tile votes vs 36 rotation
/// (39/75 ≈ 0.52, a bare majority) plus a real gimbal yaw sweep (well
/// past GIMBAL_SWEEP_DEG) must select rotation, not tile. Exercised
/// directly against `decide` on constructed evidence, since
/// reproducing this exact vote split through real match geometry
/// isn't practical in a unit test.
#[test]
fn gimbal_sweep_evidence_vetoes_near_tie_tile_vote() {
    let evidence = StrategyEvidence {
        per_edge: vec![],
        tile_votes: 39,
        rotation_votes: 36,
        gimbal_corroboration: false,
        gimbal_rotation_spread_deg: Some(90.0),
        mean_rotation_rms_px: 1.0,
        mean_planar_rms_px: Some(1.0),
    };
    assert_eq!(decide(StrategyRequest::Auto, &evidence), Strategy::Rotation);
}

/// Same 39–36 knife-edge split, but with no gimbal spread evidence
/// (metadata-free or non-rotational capture): the bare-majority rule
/// is unchanged — tile still wins. This pins down that the new
/// supermajority requirement is gated on gimbal-sweep evidence and
/// doesn't silently tighten the general case.
#[test]
fn bare_majority_without_gimbal_sweep_evidence_still_selects_tile() {
    let evidence = StrategyEvidence {
        per_edge: vec![],
        tile_votes: 39,
        rotation_votes: 36,
        gimbal_corroboration: false,
        gimbal_rotation_spread_deg: None,
        mean_rotation_rms_px: 1.0,
        mean_planar_rms_px: Some(1.0),
    };
    assert_eq!(decide(StrategyRequest::Auto, &evidence), Strategy::Tile);
}

/// A gimbal spread below the sweep threshold (attitude-hold jitter,
/// not a pivot) must not trigger the supermajority requirement.
#[test]
fn small_gimbal_spread_below_threshold_does_not_veto() {
    let evidence = StrategyEvidence {
        per_edge: vec![],
        tile_votes: 39,
        rotation_votes: 36,
        gimbal_corroboration: false,
        gimbal_rotation_spread_deg: Some(GIMBAL_SWEEP_DEG - 1.0),
        mean_rotation_rms_px: 1.0,
        mean_planar_rms_px: Some(1.0),
    };
    assert_eq!(decide(StrategyRequest::Auto, &evidence), Strategy::Tile);
}

/// A clear tile supermajority still wins even with gimbal-sweep
/// evidence present — the veto raises the bar, it doesn't forbid
/// tile outright.
#[test]
fn gimbal_sweep_evidence_does_not_block_a_clear_tile_supermajority() {
    let evidence = StrategyEvidence {
        per_edge: vec![],
        tile_votes: 90,
        rotation_votes: 10,
        gimbal_corroboration: false,
        gimbal_rotation_spread_deg: Some(45.0),
        mean_rotation_rms_px: 1.0,
        mean_planar_rms_px: Some(1.0),
    };
    assert_eq!(decide(StrategyRequest::Auto, &evidence), Strategy::Tile);
}

#[test]
fn gimbal_rotation_spread_reports_none_below_two_frames() {
    use crate::ingest::GimbalPrior;
    let priors: Vec<FramePriors> = vec![FramePriors {
        focal_mm: None,
        focal_35mm_equiv: None,
        focal_px: Some(1000.0),
        gimbal: Some(GimbalPrior {
            yaw_deg: 10.0,
            pitch_deg: -45.0,
            roll_deg: 0.0,
        }),
    }];
    assert_eq!(gimbal_rotation_spread(&priors), None);
}

#[test]
fn gimbal_rotation_spread_matches_yaw_sweep_range() {
    use crate::ingest::GimbalPrior;
    // A 21-frame-style yaw sweep from -45 to +45 (90 deg total).
    let priors: Vec<FramePriors> = (0..21)
        .map(|i| FramePriors {
            focal_mm: None,
            focal_35mm_equiv: None,
            focal_px: Some(1000.0),
            gimbal: Some(GimbalPrior {
                yaw_deg: -45.0 + (i as f64) * 4.5,
                pitch_deg: -90.0,
                roll_deg: 0.0,
            }),
        })
        .collect();
    let spread = gimbal_rotation_spread(&priors).expect("spread present");
    assert!((spread - 90.0).abs() < 1e-9, "spread was {spread}");
}

#[test]
fn gimbal_rotation_spread_is_wrap_aware() {
    use crate::ingest::GimbalPrior;
    // Frames straddling the ±180 seam: -175 and +175 are 10 deg
    // apart on the circle, not 350.
    let priors: Vec<FramePriors> = vec![-175.0, 175.0]
        .into_iter()
        .map(|yaw_deg| FramePriors {
            focal_mm: None,
            focal_35mm_equiv: None,
            focal_px: Some(1000.0),
            gimbal: Some(GimbalPrior {
                yaw_deg,
                pitch_deg: -45.0,
                roll_deg: 0.0,
            }),
        })
        .collect();
    let spread = gimbal_rotation_spread(&priors).expect("spread present");
    assert!((spread - 10.0).abs() < 1e-9, "spread was {spread}");
}
