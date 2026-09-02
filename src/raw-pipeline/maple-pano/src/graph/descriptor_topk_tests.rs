//! Unit tests for `graph/descriptor_topk.rs`, split out to respect the
//! file-size budget (CONTRIBUTING.md § File-size budget).
//!
//! [`grid_set_shuffled_no_priors_reconnects_and_matches_ordered_priors_ba_solution`]
//! is ticket #1215's acceptance gate: a synthetic grid set with priors
//! stripped and capture order shuffled reconnects into one component
//! via [`DescriptorTopKProvider`] alone (`CaptureOrderProvider` and
//! `GimbalPriorProvider` contribute nothing useful once order is
//! meaningless and priors are gone), and bundle adjustment converges to
//! the same relative geometry as an ordered+priors baseline run,
//! compared gauge-free (relative rotations to a common anchor frame).
//!
//! `FeatureSet` has a `pub(crate)` field (`norm_keypoints`), so it can
//! only be struct-literal-constructed from inside this crate — that's
//! why this gate lives here rather than in `tests/` alongside the other
//! `--all-features` gate binaries.

use super::*;
use crate::ba::{self, BaOptions};
use crate::features::Keypoint;
use crate::graph::{build_match_graph, CaptureOrderProvider, GimbalPriorProvider};
use crate::prng::SplitMix64;
use crate::render::{build_camera_set, CameraSetOptions, Pattern};
use crate::robust::RobustOptions;
use crate::testkit::{generate_pair_correspondences, CorrespondenceOptions};
use crate::twoview::rotation_angle_between;

/// One-keypoint feature set (the shape every ranking test below needs —
/// only the pooled result matters there, and pooling one row is a
/// no-op on the mean).
fn feature_set_with_descriptor(descriptor: Vec<f32>, dim: usize) -> FeatureSet {
    feature_set_with_descriptor_rows(descriptor, dim, 1)
}

/// `n_rows` keypoints, each a `dim`-wide slice of `descriptors`
/// (row-major, matching [`FeatureSet::descriptor`]'s layout).
fn feature_set_with_descriptor_rows(
    descriptors: Vec<f32>,
    dim: usize,
    n_rows: usize,
) -> FeatureSet {
    FeatureSet {
        keypoints: (0..n_rows)
            .map(|i| Keypoint {
                x: i as f32,
                y: 0.0,
                score: 1.0,
            })
            .collect(),
        descriptors,
        descriptor_dim: dim,
        norm_keypoints: vec![[0.0, 0.0]; n_rows],
    }
}

#[test]
fn pooled_descriptor_is_the_l2_normalized_mean() {
    let fs = feature_set_with_descriptor_rows(vec![3.0, 0.0, 0.0, 0.0, 4.0, 0.0], 3, 2);
    let pooled = pooled_descriptor(&fs);
    // Mean = (1.5, 2.0, 0.0), norm = 2.5 -> normalized = (0.6, 0.8, 0.0).
    assert!((pooled[0] - 0.6).abs() < 1e-6);
    assert!((pooled[1] - 0.8).abs() < 1e-6);
    assert!((pooled[2] - 0.0).abs() < 1e-6);
}

#[test]
fn pooled_descriptor_of_empty_feature_set_is_zero_not_nan() {
    let fs = FeatureSet {
        keypoints: vec![],
        descriptors: vec![],
        descriptor_dim: 4,
        norm_keypoints: vec![],
    };
    let pooled = pooled_descriptor(&fs);
    assert_eq!(pooled, vec![0.0; 4]);
    // And it must never poison ranking with NaN similarity.
    assert_eq!(cosine(&pooled, &pooled), 0.0);
}

#[test]
fn cosine_identical_is_one_orthogonal_is_zero() {
    assert!((cosine(&[1.0, 0.0], &[1.0, 0.0]) - 1.0).abs() < 1e-6);
    assert!(cosine(&[1.0, 0.0], &[0.0, 1.0]).abs() < 1e-6);
}

fn dummy_images(n: usize) -> Vec<GraphImage> {
    (0..n)
        .map(|_| GraphImage {
            camera: crate::camera::Camera::new([0.0; 3], 1000.0, 0.0, 0.0, 640, 480),
            prior_rotation: None,
        })
        .collect()
}

#[test]
fn candidates_ranks_similar_frames_together() {
    // Two well-separated clusters: {0, 1} similar, {2, 3} similar,
    // clusters far apart.
    let sets = vec![
        feature_set_with_descriptor(vec![1.0, 0.0], 2),
        feature_set_with_descriptor(vec![0.95, 0.05_f32.sqrt()], 2),
        feature_set_with_descriptor(vec![0.0, 1.0], 2),
        feature_set_with_descriptor(vec![0.05_f32.sqrt(), 0.95], 2),
    ];
    let provider = DescriptorTopKProvider {
        feature_sets: &sets,
        k: 1,
    };
    let pairs = provider.candidates(&dummy_images(4));
    assert!(pairs.contains(&(0, 1)), "{pairs:?}");
    assert!(pairs.contains(&(1, 0)), "{pairs:?}");
    assert!(pairs.contains(&(2, 3)), "{pairs:?}");
    assert!(pairs.contains(&(3, 2)), "{pairs:?}");
}

#[test]
fn candidates_tie_break_is_deterministic_by_ascending_index() {
    // Identical embeddings -> every pairwise similarity ties at 1.0.
    let sets: Vec<FeatureSet> = (0..5)
        .map(|_| feature_set_with_descriptor(vec![1.0, 0.0, 0.0], 3))
        .collect();
    let provider = DescriptorTopKProvider {
        feature_sets: &sets,
        k: 2,
    };
    let pairs = provider.candidates(&dummy_images(5));
    // Frame 2's top-2 (excluding itself) must be the two smallest other
    // indices: 0 and 1.
    assert!(pairs.contains(&(2, 0)));
    assert!(pairs.contains(&(2, 1)));
    assert!(!pairs.contains(&(2, 3)));
    assert!(!pairs.contains(&(2, 4)));
}

#[test]
fn candidates_empty_on_degenerate_input() {
    let sets = vec![feature_set_with_descriptor(vec![1.0], 1)];
    // Fewer than 2 images.
    assert!(DescriptorTopKProvider {
        feature_sets: &sets,
        k: 6
    }
    .candidates(&dummy_images(1))
    .is_empty());
    // k = 0.
    let sets2: Vec<FeatureSet> = (0..3)
        .map(|_| feature_set_with_descriptor(vec![1.0], 1))
        .collect();
    assert!(DescriptorTopKProvider {
        feature_sets: &sets2,
        k: 0
    }
    .candidates(&dummy_images(3))
    .is_empty());
    // feature_sets length mismatch vs images.
    assert!(DescriptorTopKProvider {
        feature_sets: &sets2,
        k: 6
    }
    .candidates(&dummy_images(5))
    .is_empty());
}

/// Synthesize a plausible per-frame descriptor set whose pooled vector
/// encodes grid position `(row, col)` — a stand-in for what real ALIKED
/// descriptors do for genuinely overlapping content, without needing
/// actual images or ONNX. Offset by 1 so no frame's signal is the zero
/// vector; a fixed per-keypoint jitter (small relative to the signal)
/// exercises the mean-pooling averaging without destroying the ranking.
fn synthetic_grid_feature_set(row: u32, col: u32, rng: &mut SplitMix64) -> FeatureSet {
    const DIM: usize = 8;
    const N_KEYPOINTS: usize = 24;
    const SIGNAL_SCALE: f32 = 6.0;
    const JITTER: f64 = 0.3;

    let mut keypoints = Vec::with_capacity(N_KEYPOINTS);
    let mut norm_keypoints = Vec::with_capacity(N_KEYPOINTS);
    let mut descriptors = Vec::with_capacity(N_KEYPOINTS * DIM);
    for i in 0..N_KEYPOINTS {
        let mut d = vec![0.0_f32; DIM];
        d[0] = (row as f32 + 1.0) * SIGNAL_SCALE;
        d[1] = (col as f32 + 1.0) * SIGNAL_SCALE;
        for v in d.iter_mut().skip(2) {
            *v = rng.next_range(-JITTER, JITTER) as f32;
        }
        let norm = d.iter().map(|x| x * x).sum::<f32>().sqrt();
        for v in d.iter_mut() {
            *v /= norm;
        }
        descriptors.extend(d);
        keypoints.push(Keypoint {
            x: i as f32,
            y: 0.0,
            score: 1.0,
        });
        norm_keypoints.push([0.0, 0.0]);
    }
    FeatureSet {
        keypoints,
        descriptors,
        descriptor_dim: DIM,
        norm_keypoints,
    }
}

/// Ticket #1215's acceptance gate (see module docs).
#[test]
fn grid_set_shuffled_no_priors_reconnects_and_matches_ordered_priors_ba_solution() {
    const ROWS: u32 = 3;
    const COLS: u32 = 3;
    const N: usize = (ROWS * COLS) as usize;
    // Tolerance for the gauge-free relative-rotation comparison: both
    // runs solve the *same* synthetic correspondences per physical pair
    // (seeded by original grid index, not run-local index — see below),
    // so the only source of drift is a different candidate topology
    // between the two provider sets. A couple tenths of a degree is
    // headroom for that, well under "a materially different solution."
    const MAX_REL_ROTATION_ERR_DEG: f64 = 2.0;

    let grid_opts = CameraSetOptions {
        count: N as u32,
        pattern: Pattern::Grid { rows: ROWS },
        fov_deg: 55.0,
        overlap: 0.35,
        pitch_deg: 0.0,
        jitter_deg: 2.0,
        k1: 0.0,
        k2: 0.0,
        width: 960,
        height: 720,
    };
    let mut build_rng = SplitMix64::new(0x1215_0001);
    let cams: Vec<crate::camera::Camera> = build_camera_set(&grid_opts, &mut build_rng)
        .expect("grid build")
        .iter()
        .map(|g| g.to_camera())
        .collect();

    let corr_opts = CorrespondenceOptions {
        count: 200,
        noise_sigma_px: 0.5,
        outlier_fraction: 0.2,
        ..Default::default()
    };
    // Correspondences for physical pair (original indices oa < ob) are
    // generated once, deterministically, and reused verbatim by
    // whichever run requests that pair — so a difference between the
    // two runs' solutions can only come from *topology* (which pairs
    // got verified), not from independent noise draws of the same pair.
    let matches_for = |oa: usize, ob: usize| -> Vec<crate::twoview::PixelCorrespondence> {
        let mut rng = SplitMix64::new(0x1215_0002 ^ ((oa as u64) << 32) ^ ob as u64);
        generate_pair_correspondences(&cams[oa], &cams[ob], &corr_opts, &mut rng).pixel_pairs()
    };

    let ba_opts = BaOptions {
        local_align: false,
        ..Default::default()
    };

    // ── baseline: ordered index, with priors (gimbal-style) ───────────
    let baseline_images: Vec<GraphImage> = cams
        .iter()
        .map(|c| GraphImage {
            camera: c.clone(),
            prior_rotation: Some(c.rotation),
        })
        .collect();
    let baseline_graph = build_match_graph(
        &baseline_images,
        &[&CaptureOrderProvider, &GimbalPriorProvider::default()],
        |a, b| matches_for(a, b),
        &RobustOptions::default(),
    );
    assert!(
        baseline_graph.is_connected(),
        "baseline (ordered+priors) must connect the grid: orphans {:?}",
        baseline_graph.orphans
    );
    let baseline_solution =
        ba::solve(&baseline_images, &baseline_graph, &ba_opts).expect("baseline solve");
    assert!(
        baseline_solution.dropped.is_empty(),
        "baseline dropped: {:?}",
        baseline_solution.dropped
    );

    // ── shuffled index, no priors, descriptor top-k only ───────────────
    // A fixed, non-trivial permutation (reverse) — deliberately not the
    // identity, and deliberately not a "nice" order a chain provider
    // could stumble into connecting by luck.
    let perm: Vec<usize> = (0..N).rev().collect();
    let shuffled_images: Vec<GraphImage> = perm
        .iter()
        .map(|&orig| GraphImage {
            camera: cams[orig].clone(),
            prior_rotation: None,
        })
        .collect();
    let mut feature_rng = SplitMix64::new(0x1215_0003);
    let feature_sets: Vec<FeatureSet> = perm
        .iter()
        .map(|&orig| {
            let (row, col) = (orig as u32 / COLS, orig as u32 % COLS);
            synthetic_grid_feature_set(row, col, &mut feature_rng)
        })
        .collect();
    let topk = DescriptorTopKProvider {
        feature_sets: &feature_sets,
        k: DEFAULT_TOP_K,
    };
    let shuffled_graph = build_match_graph(
        &shuffled_images,
        &[
            &CaptureOrderProvider,
            &GimbalPriorProvider::default(),
            &topk,
        ],
        |a, b| matches_for(perm[a], perm[b]),
        &RobustOptions::default(),
    );
    assert!(
        shuffled_graph.is_connected(),
        "shuffled+no-priors set must reconnect via descriptor top-k: orphans {:?}",
        shuffled_graph.orphans
    );
    assert!(shuffled_graph.orphans.is_empty());

    let shuffled_solution =
        ba::solve(&shuffled_images, &shuffled_graph, &ba_opts).expect("shuffled solve");
    assert!(
        shuffled_solution.dropped.is_empty(),
        "shuffled dropped: {:?}",
        shuffled_solution.dropped
    );

    // ── gauge-free comparison ──────────────────────────────────────────
    let base_rot = |orig: usize| {
        baseline_solution.cameras[orig]
            .as_ref()
            .expect("baseline frame solved")
            .rotation
    };
    let shuf_rot = |orig: usize| {
        let idx = perm.iter().position(|&x| x == orig).expect("in perm");
        shuffled_solution.cameras[idx]
            .as_ref()
            .expect("shuffled frame solved")
            .rotation
    };

    let anchor_base = base_rot(0);
    let anchor_shuf = shuf_rot(0);
    let mut worst_err_deg = 0.0_f64;
    for orig in 0..N {
        let rel_base = base_rot(orig).transpose().mul_mat(&anchor_base);
        let rel_shuf = shuf_rot(orig).transpose().mul_mat(&anchor_shuf);
        let err_deg = rotation_angle_between(&rel_base, &rel_shuf).to_degrees();
        worst_err_deg = worst_err_deg.max(err_deg);
        assert!(
            err_deg < MAX_REL_ROTATION_ERR_DEG,
            "frame {orig}: relative rotation off by {err_deg:.4}° (max {MAX_REL_ROTATION_ERR_DEG}°)"
        );
    }
    assert!(worst_err_deg.is_finite());
}
