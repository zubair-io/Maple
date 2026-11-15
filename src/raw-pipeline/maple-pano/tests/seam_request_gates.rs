#![cfg(feature = "classical-features")]

use std::path::PathBuf;
use std::process::Command;

use maple_pano::composite::CanvasCollector;
use maple_pano::seam::{SeamConstraintError, SeamConstraintsRequest, SeamStrategy};
use maple_pano::stitch::{
    preview, stitch_reusing, FeatureEngine, StitchError, StitchOptions, StitchSuccess,
};
use maple_pano::strategy::StrategyRequest;

#[test]
fn preview_authored_constraints_reach_refined_stitch_and_conflicts_refuse() {
    let dir = tempfile::tempdir().unwrap();
    assert!(Command::new(env!("CARGO_BIN_EXE_pano-gen-fixture"))
        .arg("--out-dir")
        .arg(dir.path())
        .args([
            "--cameras",
            "3",
            "--width",
            "640",
            "--height",
            "480",
            "--source-width",
            "2048"
        ])
        .status()
        .unwrap()
        .success());
    let inputs: Vec<PathBuf> = (0..3)
        .map(|i| dir.path().join(format!("frame_{i:04}.dng")))
        .collect();
    let mut options = StitchOptions {
        feature_engine: FeatureEngine::Classical,
        strategy: StrategyRequest::Rotation,
        seam_strategy: SeamStrategy::GraphCut,
        max_canvas_px: 1_000_000,
        ..StitchOptions::default()
    };
    let base = preview(&inputs, &options, None, |_, _| {}, || false).unwrap();
    let mut request = SeamConstraintsRequest::parse(&serde_json::json!({
        "version":1,"canvas":{"width":base.width,"height":base.height},
        "regions":[{"kind":"include","frame":1,"x":base.width/2,"y":base.height/2,"width":2,"height":2}]
    }).to_string(), inputs.len()).unwrap();
    options.seam_constraints = Some(request.clone());
    let constrained = preview(
        &inputs,
        &options,
        Some(&base.alignment),
        |_, _| {},
        || false,
    )
    .unwrap();
    assert!(constrained.width > 0 && constrained.height > 0);
    let mut sink = CanvasCollector::default();
    let result = stitch_reusing(
        &inputs,
        &options,
        Some(&base.alignment),
        &mut sink,
        |_, _| {},
        || false,
    )
    .unwrap();
    let StitchSuccess::Rotation(outcome) = result.success else {
        panic!("rotation requested")
    };
    assert_eq!(outcome.comp_report.seam_strategy, SeamStrategy::GraphCut);
    let mut excluded = request.regions[0];
    excluded.kind = maple_pano::seam::SeamRegionKind::Exclude;
    request.regions.push(excluded);
    options.seam_constraints = Some(request);
    assert!(matches!(
        preview(
            &inputs,
            &options,
            Some(&base.alignment),
            |_, _| {},
            || false
        ),
        Err(StitchError::SeamConstraint(
            SeamConstraintError::IncludeExcluded { .. }
        ))
    ));
    options.strategy = StrategyRequest::Auto;
    let mut tile_alignment = base.alignment.clone();
    tile_alignment.key = maple_pano::stitch::AlignmentKey::for_run(&inputs, &options).unwrap();
    tile_alignment.strategy_report.selected = maple_pano::strategy::Strategy::Tile;
    tile_alignment.strategy_report.requested = StrategyRequest::Auto;
    tile_alignment.tile_graph = Some(tile_alignment.graph.clone());
    assert!(matches!(
        preview(
            &inputs,
            &options,
            Some(&tile_alignment),
            |_, _| {},
            || false
        ),
        Err(StitchError::SeamConstraint(
            SeamConstraintError::RequiresGraphCut
        ))
    ));
}
