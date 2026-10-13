use std::path::PathBuf;

use super::*;
use crate::graph::{RejectedPair, VerifiedEdge};
use crate::ingest::{GimbalPrior, GpsPrior};
use crate::math::Mat3;
use crate::robust::VerifyFailure;
use crate::seam::SeamStrategy;
use crate::strategy::Strategy;
use crate::twoview::PixelCorrespondence;

struct TempFrames {
    dir: PathBuf,
    paths: Vec<PathBuf>,
}

impl TempFrames {
    fn new(tag: &str, count: usize) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "maple-pano-4578-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let paths = (0..count)
            .map(|i| {
                let p = dir.join(format!("FRAME{i:02}.DNG"));
                std::fs::write(&p, vec![i as u8; 64 + i]).unwrap();
                p
            })
            .collect();
        Self { dir, paths }
    }
}

impl Drop for TempFrames {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn key(frames: &TempFrames, opts: &StitchOptions) -> AlignmentKey {
    AlignmentKey::for_run(&frames.paths, opts).unwrap()
}

#[test]
fn composite_only_options_keep_the_alignment_valid() {
    let frames = TempFrames::new("composite", 3);
    let base = StitchOptions::default();
    let stored = key(&frames, &base);
    let composite_only = [
        StitchOptions {
            seam_strategy: SeamStrategy::GraphCut,
            ..base.clone()
        },
        StitchOptions {
            max_canvas_px: 12_000_000,
            ..base.clone()
        },
        StitchOptions {
            canvas_tile_rows: Some(64),
            ..base.clone()
        },
        StitchOptions {
            local_align: !base.local_align,
            ..base.clone()
        },
        StitchOptions {
            retention: crate::ba::RetentionPolicy::Strict,
            mean_budget_px: 3.0,
            max_budget_px: 12.0,
            ..base.clone()
        },
        StitchOptions {
            seam_strategy: SeamStrategy::GraphCut,
            seam_constraints: vec![crate::seam::SeamConstraint::ForceExclude(
                1,
                crate::seam::CanvasRect {
                    x: 0,
                    y: 0,
                    width: 8,
                    height: 8,
                },
            )],
            ..base.clone()
        },
    ];
    for opts in &composite_only {
        assert_eq!(stored.mismatch(&key(&frames, opts)), None);
    }
}

#[test]
fn geometry_options_invalidate_the_alignment() {
    let frames = TempFrames::new("geometry", 3);
    let base = StitchOptions::default();
    let stored = key(&frames, &base);
    let geometry = [
        StitchOptions {
            strategy: StrategyRequest::Tile,
            ..base.clone()
        },
        StitchOptions {
            proxy_long_edge: 1280,
            ..base.clone()
        },
        StitchOptions {
            models_dir: Some(PathBuf::from("/elsewhere/models")),
            ..base.clone()
        },
        StitchOptions {
            use_coreml: true,
            ..base.clone()
        },
        StitchOptions {
            grid: Some(crate::graph::GridLayout {
                rows: 1,
                cols: 3,
                order: crate::graph::GridOrder::Serpentine,
                diagonals: false,
            }),
            ..base.clone()
        },
    ];
    for opts in &geometry {
        let reason = stored
            .mismatch(&key(&frames, opts))
            .expect("must invalidate");
        assert!(reason.starts_with("geometry options changed"), "{reason}");
    }
}

#[test]
fn a_rewritten_or_reordered_input_invalidates_the_alignment() {
    let frames = TempFrames::new("inputs", 3);
    let opts = StitchOptions::default();
    let stored = key(&frames, &opts);

    let reordered: Vec<PathBuf> = frames.paths.iter().rev().cloned().collect();
    let reason = stored
        .mismatch(&AlignmentKey::for_run(&reordered, &opts).unwrap())
        .unwrap();
    assert!(reason.contains("different file"), "{reason}");

    let fewer = AlignmentKey::for_run(&frames.paths[..2], &opts).unwrap();
    assert!(stored.mismatch(&fewer).unwrap().contains("frame count"));

    std::fs::write(&frames.paths[1], vec![7u8; 999]).unwrap();
    let reason = stored.mismatch(&key(&frames, &opts)).unwrap();
    assert!(reason.contains("changed on disk"), "{reason}");
}

#[test]
fn a_missing_input_is_a_decode_error() {
    let frames = TempFrames::new("missing", 2);
    let gone = vec![frames.paths[0].clone(), frames.dir.join("NOPE.DNG")];
    assert!(matches!(
        AlignmentKey::for_run(&gone, &StitchOptions::default()),
        Err(StitchError::Decode { .. })
    ));
}

fn awkward_graph(image_count: usize) -> MatchGraph {
    let awkward = [
        0.1 + 0.2,
        1.0 / 3.0,
        std::f64::consts::PI / 7.0,
        5e-324,
        -2.2250738585072014e-308,
        1234.5 / 7.0,
        9_007_199_254_740_992.0 + 2.0,
        (2.0_f64).sqrt() * 1e-4,
    ];
    let at = |i: usize| awkward[i % awkward.len()] * (1.0 + i as f64 * 1e-13);
    let edges = (1..image_count)
        .map(|b| VerifiedEdge {
            a: b - 1,
            b,
            rotation: Mat3(std::array::from_fn(|r| {
                std::array::from_fn(|c| at(b * 9 + r * 3 + c))
            })),
            inlier_count: 6,
            mean_residual_rad: at(b + 3),
            inlier_matches: (0..6)
                .map(|k| PixelCorrespondence {
                    a: (100.0 * at(k) + k as f64, 50.0 + at(k + 1)),
                    b: (90.0 + at(k + 2), 40.0 * at(k + 3) + k as f64),
                })
                .collect(),
        })
        .collect();
    MatchGraph {
        image_count,
        edges,
        rejected: vec![
            RejectedPair {
                a: 0,
                b: image_count - 1,
                reason: VerifyFailure::BelowMinInliers {
                    inliers: 3,
                    required: 12,
                },
            },
            RejectedPair {
                a: 0,
                b: 2,
                reason: VerifyFailure::NoModel { iterations: 500 },
            },
            RejectedPair {
                a: 1,
                b: image_count - 1,
                reason: VerifyFailure::LoopClosureUnconfirmed {
                    best_triangle_error_deg: Some(0.1 + 0.2),
                },
            },
            RejectedPair {
                a: 0,
                b: 1,
                reason: VerifyFailure::LoopClosureBeyondGroundFootprint {
                    distance_m: 1.0 / 3.0,
                    limit_m: 1e-300,
                },
            },
        ],
        components: vec![(0..image_count).collect()],
        orphans: vec![],
    }
}

fn awkward_alignment(strategy: StrategyRequest, frames: &TempFrames) -> SolvedAlignment {
    let opts = StitchOptions {
        strategy,
        ..StitchOptions::default()
    };
    let n = frames.paths.len();
    let aligned: Vec<AlignedFrame> = (0..n)
        .map(|i| AlignedFrame {
            full_dims: (11_648, 8_736),
            proxy_dims: (1600, 1200),
            proxy_scale: (11_648.0 / 1600.0, 8_736.0 / 1200.0),
            focal_full_px: 0.1 + 0.2 + 3653.6 * (1.0 + i as f64 / 3.0),
            priors: FramePriors {
                focal_mm: Some(12.29 + i as f32 * 0.1),
                focal_35mm_equiv: (i % 2 == 0).then_some(24.0),
                focal_px: Some(3653.6 / 3.0),
                gimbal: (i != 1).then_some(GimbalPrior {
                    yaw_deg: -179.9 + i as f64 / 7.0,
                    pitch_deg: -0.1 - 0.2,
                    roll_deg: 1e-17,
                }),
                gps: (i != 0).then_some(GpsPrior {
                    lat_deg: 51.5 + 1.0 / 3.0 + i as f64 * 1e-9,
                    lon_deg: -0.1 - 0.2,
                    relative_altitude_m: (i == 1).then_some(120.0 / 7.0),
                }),
            },
            applied_opcodes: vec![format!("WarpRectilinear#{i}")],
        })
        .collect();
    let graph = awkward_graph(n);
    let priors: Vec<FramePriors> = aligned.iter().map(|f| f.priors.clone()).collect();
    let focals: Vec<f64> = aligned.iter().map(|f| f.focal_full_px).collect();
    let strategy_report = select_strategy_for(strategy, &graph, &priors, &focals);
    let tile_graph = (strategy_report.selected == Strategy::Tile).then(|| awkward_graph(n));
    SolvedAlignment {
        key: AlignmentKey::for_run(&frames.paths, &opts).unwrap(),
        frames: aligned,
        focal_seed_source: FocalSeedSource::HomographyFallback,
        graph,
        tile_graph,
        strategy_report,
        lenses: crate::gain::LensGroups {
            labels: vec!["DJI L3D-100c 12.3mm".into()],
            of_frame: (0..n).map(|i| (i != 0).then_some(0)).collect(),
        },
    }
}

fn assert_bit_identical(a: &SolvedAlignment, b: &SolvedAlignment) {
    assert_eq!(a.key, b.key);
    assert_eq!(a.frames, b.frames);
    assert_eq!(a.focal_seed_source, b.focal_seed_source);
    assert_eq!(a.graph, b.graph);
    assert_eq!(a.tile_graph, b.tile_graph);
    assert_eq!(a.lenses, b.lenses);
    assert_eq!(a.strategy_report.selected, b.strategy_report.selected);
    assert_eq!(a.strategy_report.requested, b.strategy_report.requested);
    assert_eq!(a.strategy_report.warning, b.strategy_report.warning);
    let bits = |g: &MatchGraph| -> Vec<u64> {
        g.edges
            .iter()
            .flat_map(|e| {
                e.inlier_matches
                    .iter()
                    .flat_map(|m| [m.a.0, m.a.1, m.b.0, m.b.1])
                    .chain(e.rotation.0.iter().flatten().copied())
                    .chain([e.mean_residual_rad])
            })
            .map(f64::to_bits)
            .collect()
    };
    assert_eq!(bits(&a.graph), bits(&b.graph));
    let full_bits = |s: &SolvedAlignment| -> Vec<u64> {
        s.full_images()
            .iter()
            .chain(s.proxy_images().iter())
            .flat_map(|g| {
                g.camera
                    .rotation
                    .0
                    .into_iter()
                    .flatten()
                    .chain([g.camera.focal_px])
            })
            .map(f64::to_bits)
            .collect()
    };
    assert_eq!(full_bits(a), full_bits(b));
}

#[test]
fn json_round_trip_is_bit_identical_for_rotation() {
    let frames = TempFrames::new("codec-rot", 4);
    let solved = awkward_alignment(StrategyRequest::Rotation, &frames);
    let reloaded = SolvedAlignment::from_json(&solved.to_json()).unwrap();
    assert_bit_identical(&solved, &reloaded);
    assert_eq!(reloaded.tile_graph, None);
    assert_eq!(reloaded.to_json(), solved.to_json());
}

#[test]
fn json_round_trip_is_bit_identical_for_tile() {
    let frames = TempFrames::new("codec-tile", 3);
    let solved = awkward_alignment(StrategyRequest::Tile, &frames);
    assert!(solved.tile_graph.is_some());
    let reloaded = SolvedAlignment::from_json(&solved.to_json()).unwrap();
    assert_bit_identical(&solved, &reloaded);
}

#[test]
fn a_reloaded_alignment_is_reused_only_under_its_own_key() {
    let frames = TempFrames::new("reuse", 3);
    let solved = awkward_alignment(StrategyRequest::Rotation, &frames);
    let reloaded = SolvedAlignment::from_json(&solved.to_json()).unwrap();
    let same = StitchOptions {
        strategy: StrategyRequest::Rotation,
        seam_strategy: SeamStrategy::GraphCut,
        ..StitchOptions::default()
    };
    let (hit, verdict) = usable(Some(&reloaded), &key(&frames, &same));
    assert!(hit.is_some());
    assert_eq!(verdict, AlignmentReuse::Reused);

    let other = StitchOptions {
        strategy: StrategyRequest::Auto,
        ..same.clone()
    };
    let (miss, verdict) = usable(Some(&reloaded), &key(&frames, &other));
    assert!(miss.is_none());
    assert!(matches!(verdict, AlignmentReuse::Stale(r) if r.contains("strategy rotation → auto")));

    assert_eq!(usable(None, &key(&frames, &same)).1, AlignmentReuse::Solved);
}

#[test]
fn a_foreign_format_version_is_stale_not_reused() {
    let frames = TempFrames::new("version", 2);
    let solved = awkward_alignment(StrategyRequest::Rotation, &frames);
    let mut old = solved.clone();
    old.key.format_version = ALIGNMENT_FORMAT_VERSION + 1;
    let (hit, verdict) = usable(Some(&old), &solved.key);
    assert!(hit.is_none());
    assert!(matches!(verdict, AlignmentReuse::Stale(r) if r.contains("format")));
}

#[test]
fn malformed_or_inconsistent_files_are_errors() {
    assert!(SolvedAlignment::from_json("{\"key\":").is_err());
    let frames = TempFrames::new("inconsistent", 3);
    let mut solved = awkward_alignment(StrategyRequest::Rotation, &frames);
    solved.tile_graph = Some(awkward_graph(3));
    let err = SolvedAlignment::from_json(&solved.to_json()).unwrap_err();
    assert!(err.contains("tile graph"), "{err}");
}

#[test]
fn the_alignment_key_records_the_feature_engine() {
    let frames = TempFrames::new("engine-key", 2);
    let opts = StitchOptions::default();
    assert_eq!(
        key(&frames, &opts).feature_engine,
        opts.feature_engine.as_str()
    );
}

#[test]
fn switching_the_matcher_marks_the_alignment_stale() {
    let frames = TempFrames::new("engine-switch", 3);
    let solved = awkward_alignment(StrategyRequest::Rotation, &frames);
    let reloaded = SolvedAlignment::from_json(&solved.to_json()).unwrap();
    let current = key(
        &frames,
        &StitchOptions {
            strategy: StrategyRequest::Rotation,
            ..StitchOptions::default()
        },
    );
    let [this, other] = ["classical", "ml"].map(|engine| AlignmentKey {
        feature_engine: engine.into(),
        ..current.clone()
    });
    let offered = SolvedAlignment {
        key: this,
        ..reloaded
    };
    assert_eq!(
        usable(Some(&offered), &offered.key.clone()).1,
        AlignmentReuse::Reused
    );
    let (hit, verdict) = usable(Some(&offered), &other);
    assert!(hit.is_none());
    assert!(
        matches!(&verdict, AlignmentReuse::Stale(r) if r.contains("matcher classical → ml")),
        "{verdict:?}"
    );
}
