//! `maple-cli pano stitch` (#1182) — the end-to-end panorama pipeline:
//! decode → priors → proxy → ALIKED+LightGlue → match graph →
//! full-resolution match refinement (#1210) → global BA → leveling →
//! composite → 16-bit PNG (+ optional sRGB preview) + a
//! `StitchReport`-shaped JSON.
//!
//! Geometry runs at two scales by design: matching + robust pairwise
//! verification on the long-edge-capped proxies (the resolution the
//! matcher carries its accuracy at), then every verified inlier match is
//! re-localized on the full-resolution frames (`maple_pano::refine`) and
//! bundle adjustment solves in FULL-RES coordinates. The §5.3 gates
//! (mean ≤ 1.5 px / max ≤ 6 px) therefore apply at the resolution the
//! spec wrote them for ("1.5 px on 24 MP input") — closing the
//! proxy-vs-spec scale ambiguity this module previously documented.
//!
//! Two modes:
//!
//! - **Single set** (positional frames + `--out`): the operator flow.
//!   `--max-mean-px` / `--max-residual-px` can relax the spec §5.3
//!   acceptance gate for input with uncorrected lens distortion (#1159).
//! - **Batch** (`--manifest` + `--out-dir`): the regression-harness
//!   contract (`src/scripts/test_pano_pipeline.sh`). Each case stitches
//!   at the **spec-default gates** — the harness encodes the product
//!   bar (zero dropped frames, ≤ 1.5 px mean) and must measure the
//!   pipeline, not an operator override; relax flags are rejected here.
//!   Per case the candidate `<name>.png` is **sRGB-display-encoded**
//!   (references are display renders), with `<name>.linear.png` and
//!   `<name>.report.json` alongside.
//!
//! The ML environment is a hard, actionable error in both modes (the
//! CLI is the operator surface; only the harness skip-passes, and it
//! does so before invoking this command).
//!
//! The linear PNG carries the scene-linear Rec.2020 composite (the
//! values the linear-DNG writer of spec step 9 will carry), clamped to
//! the display-range slice.

mod io;

use std::path::{Path, PathBuf};
use std::time::Instant;

use clap::Subcommand;

use maple_pano::ba::{self, BaOptions};
use maple_pano::camera::Camera;
use maple_pano::canvas::{CanvasOptions, ProjectionMode};
use maple_pano::composite::{composite, CompositeOptions};
use maple_pano::features::{AlikedDetector, DetectorOptions, FeatureSet, LinearRgbFrame};
use maple_pano::glue::{ml_matches_to_correspondences, DEFAULT_MIN_SCORE};
use maple_pano::graph::{build_match_graph, CaptureOrderProvider, GimbalPriorProvider, GraphImage};
use maple_pano::ingest::{ingest_file, proxy_to_long_edge, IngestedFrame, PlanarImage};
use maple_pano::leveling;
use maple_pano::matching::LightGlueMatcher;
use maple_pano::models::ModelDir;
use maple_pano::refine::{refine_correspondences, RefineGeometry, RefineOptions};
use maple_pano::robust::RobustOptions;
use maple_pano::strategy::{select_strategy, Strategy};
use maple_pano::tile::placement::{solve_tile_poses, TileConstraint};
use maple_pano::tile::{composite_tile, verify_tile_edges};
use maple_pano::twoview::PixelCorrespondence;

use io::{
    interleave, stitch_report, tile_stitch_report, write_png16, ReportContext, TileReportContext,
};

mod args;
pub use args::StitchArgs;

/// Spec §5.3 acceptance-gate defaults (single source for both modes).
const SPEC_MEAN_BUDGET_PX: f64 = 1.5;
const SPEC_MAX_BUDGET_PX: f64 = 6.0;

#[derive(Subcommand)]
pub enum PanoCmd {
    /// Stitch a panorama from RAW frames.
    Stitch(StitchArgs),
}

pub fn run(cmd: PanoCmd) -> Result<(), String> {
    match cmd {
        PanoCmd::Stitch(args) => stitch(args),
    }
}

/// The loaded ML stack (one load per invocation, shared across cases).
struct Ml {
    detector: AlikedDetector,
    matcher: LightGlueMatcher,
}

fn load_ml(models_dir: Option<&Path>) -> Result<Ml, String> {
    let models = ModelDir::resolve(models_dir).map_err(|e| {
        format!(
            "ML environment unavailable: {e}\n\
             The pano pipeline needs the ALIKED + LightGlue models and an \
             ONNX Runtime dylib:\n\
             set MAPLE_PANO_MODELS to the models directory (SHA-pinned in \
             maple-pano/models.toml)\n\
             and ORT_DYLIB_PATH to libonnxruntime (>= 1.23)."
        )
    })?;
    let detector = AlikedDetector::load(&models, DetectorOptions::default())
        .map_err(|e| format!("ALIKED load failed: {e}"))?;
    let matcher = LightGlueMatcher::load(&models, Default::default())
        .map_err(|e| format!("LightGlue load failed: {e}"))?;
    Ok(Ml { detector, matcher })
}

/// Where one stitched set's artifacts go.
struct SetOutputs {
    /// Scene-linear 16-bit PNG.
    linear: PathBuf,
    /// sRGB-encoded 16-bit PNG.
    display: Option<PathBuf>,
    /// Report JSON.
    report: Option<PathBuf>,
}

fn stitch(args: StitchArgs) -> Result<(), String> {
    let mut ml = load_ml(args.models_dir.as_deref())?;

    if let Some(manifest_path) = &args.manifest {
        // Batch mode = the harness bar: spec gates only.
        if args.max_mean_px != SPEC_MEAN_BUDGET_PX || args.max_residual_px != SPEC_MAX_BUDGET_PX {
            return Err("--max-mean-px / --max-residual-px are single-set operator \
                 overrides; batch mode gates at the spec defaults so the \
                 harness measures the pipeline, not an override"
                .into());
        }
        let out_dir = args
            .out_dir
            .as_ref()
            .expect("clap: --out-dir required with --manifest");
        return stitch_manifest(&mut ml, manifest_path, out_dir, &args);
    }

    if args.inputs.len() < 2 {
        return Err("single-set mode needs 2+ input frames (or use --manifest)".into());
    }
    let out = args
        .out
        .as_ref()
        .ok_or("single-set mode requires --out")?
        .clone();
    let mut inputs = args.inputs.clone();
    inputs.sort();
    let report = stitch_set(
        &mut ml,
        &inputs,
        &SetOutputs {
            linear: out,
            display: args.display.clone(),
            report: args.report.clone(),
        },
        (args.max_mean_px, args.max_residual_px),
        &args,
    )?;
    eprintln!(
        "{}",
        serde_json::to_string_pretty(&report).expect("report serializes")
    );
    Ok(())
}

/// Batch over a harness manifest:
/// `{ "cases": [ { "name", "frames": [...], "reference"?, "options"? } ] }`.
/// Candidate `<name>.png` is the display encode (see module docs).
fn stitch_manifest(
    ml: &mut Ml,
    manifest_path: &Path,
    out_dir: &Path,
    args: &StitchArgs,
) -> Result<(), String> {
    let bytes =
        std::fs::read(manifest_path).map_err(|e| format!("{}: {e}", manifest_path.display()))?;
    let manifest: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|e| format!("{}: invalid JSON: {e}", manifest_path.display()))?;
    let cases = manifest["cases"]
        .as_array()
        .ok_or_else(|| format!("{}: no \"cases\" array", manifest_path.display()))?;
    std::fs::create_dir_all(out_dir).map_err(|e| format!("{}: {e}", out_dir.display()))?;

    let mut failures = Vec::new();
    for case in cases {
        let name = case["name"].as_str().unwrap_or("<unnamed>").to_string();
        let frames: Vec<PathBuf> = case["frames"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str())
                    .map(PathBuf::from)
                    .collect()
            })
            .unwrap_or_default();
        if frames.len() < 2 {
            eprintln!(
                "pano[{name}]: skipped — {} frame(s) in manifest",
                frames.len()
            );
            failures.push(name);
            continue;
        }
        eprintln!("pano[{name}]: stitching {} frames ...", frames.len());
        let outs = SetOutputs {
            linear: out_dir.join(format!("{name}.linear.png")),
            display: Some(out_dir.join(format!("{name}.png"))),
            report: Some(out_dir.join(format!("{name}.report.json"))),
        };
        match stitch_set(
            ml,
            &frames,
            &outs,
            (SPEC_MEAN_BUDGET_PX, SPEC_MAX_BUDGET_PX),
            args,
        ) {
            Ok(_) => {}
            Err(e) => {
                eprintln!("pano[{name}]: FAILED — {e}");
                failures.push(name);
            }
        }
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "{} of {} case(s) failed: {}",
            failures.len(),
            cases.len(),
            failures.join(", ")
        ))
    }
}

/// The full per-set pipeline. Returns the report JSON (also written to
/// `outs.report` when set).
fn stitch_set(
    ml: &mut Ml,
    inputs: &[PathBuf],
    outs: &SetOutputs,
    (mean_budget_px, max_budget_px): (f64, f64),
    args: &StitchArgs,
) -> Result<serde_json::Value, String> {
    let t0 = Instant::now();

    // ---- Decode + priors ------------------------------------------------
    let t_decode = Instant::now();
    let mut frames: Vec<IngestedFrame> = Vec::with_capacity(inputs.len());
    for path in inputs {
        eprintln!("pano: decoding {}", path.display());
        frames.push(ingest_file(path).map_err(|e| format!("{}: {e}", path.display()))?);
    }
    let decode_s = t_decode.elapsed().as_secs_f64();
    // Captured before `frames` is consumed by the composite lift below.
    let applied_opcodes: Vec<Vec<String>> =
        frames.iter().map(|f| f.applied_opcodes.clone()).collect();

    // ---- Features on proxies ---------------------------------------------
    // Matching and pairwise verification run in PROXY coordinates: that
    // is the resolution the matches carry their accuracy at, and the
    // verifier's noise model (sigma_max_px) is calibrated there. The
    // verified inliers are then re-localized at FULL resolution
    // (#1210, below), so BA and the §5.3 px gates run in full-res
    // coordinates — the resolution the spec wrote them for.
    let t_feat = Instant::now();
    let mut feature_sets: Vec<FeatureSet> = Vec::with_capacity(frames.len());
    let mut proxy_scale: Vec<f64> = Vec::with_capacity(frames.len());
    let mut proxy_dims: Vec<(u32, u32)> = Vec::with_capacity(frames.len());
    for (frame, path) in frames.iter().zip(inputs) {
        let proxy = proxy_to_long_edge(&frame.image, args.proxy_long_edge);
        proxy_scale.push(frame.image.width() as f64 / proxy.width() as f64);
        proxy_dims.push((proxy.width(), proxy.height()));
        let rgb = interleave(&proxy);
        let lin = LinearRgbFrame::new(proxy.width(), proxy.height(), rgb)
            .map_err(|e| format!("{}: {e}", path.display()))?;
        let fs = ml
            .detector
            .detect(&lin)
            .map_err(|e| format!("{}: detect: {e}", path.display()))?;
        eprintln!(
            "pano: {} — {} keypoints on {}x{} proxy",
            path.display(),
            fs.len(),
            proxy.width(),
            proxy.height()
        );
        feature_sets.push(fs);
    }
    let features_s = t_feat.elapsed().as_secs_f64();

    // Cameras at FULL resolution (EXIF focal in native pixels) — the BA
    // input once refinement lifts the matches to full-res coordinates.
    // The proxy-scale clones below serve matching + verification only.
    let full_images: Vec<GraphImage> = frames
        .iter()
        .zip(inputs)
        .map(|(f, path)| {
            let focal_px = f.priors.focal_px.ok_or_else(|| {
                format!(
                    "{}: no EXIF 35mm-equivalent focal length — cannot seed \
                     the camera model (spec §5.3 initialization)",
                    path.display()
                )
            })?;
            Ok(GraphImage {
                camera: Camera::new(
                    [0.0; 3],
                    focal_px,
                    0.0,
                    0.0,
                    f.image.width(),
                    f.image.height(),
                ),
                prior_rotation: f.priors.gimbal.as_ref().map(ba::init::rotation_from_gimbal),
            })
        })
        .collect::<Result<_, String>>()?;
    let proxy_images: Vec<GraphImage> = full_images
        .iter()
        .enumerate()
        .map(|(i, img)| GraphImage {
            camera: Camera::new(
                [0.0; 3],
                img.camera.focal_px / proxy_scale[i],
                0.0,
                0.0,
                proxy_dims[i].0,
                proxy_dims[i].1,
            ),
            prior_rotation: img.prior_rotation,
        })
        .collect();

    // ---- Match graph (capture order + gimbal prior candidates) ----------
    let t_graph = Instant::now();
    let mut match_failures: Vec<String> = Vec::new();
    let matcher = &mut ml.matcher;
    let mut graph = build_match_graph(
        &proxy_images,
        &[&CaptureOrderProvider, &GimbalPriorProvider::default()],
        |a, b| -> Vec<PixelCorrespondence> {
            match matcher.match_features(&feature_sets[a], &feature_sets[b]) {
                Ok(ml_matches) => ml_matches_to_correspondences(&ml_matches, DEFAULT_MIN_SCORE),
                Err(e) => {
                    match_failures.push(format!("pair ({a},{b}): {e}"));
                    Vec::new()
                }
            }
        },
        &RobustOptions::default(),
    );
    let graph_s = t_graph.elapsed().as_secs_f64();
    if !match_failures.is_empty() {
        return Err(format!(
            "LightGlue failed on {} pair(s):\n{}",
            match_failures.len(),
            match_failures.join("\n")
        ));
    }
    eprintln!(
        "pano: graph — {} verified edges, components {:?}, orphans {:?}",
        graph.edges.len(),
        graph.components.iter().map(|c| c.len()).collect::<Vec<_>>(),
        graph.orphans
    );

    // ---- Strategy selection (#1226) --------------------------------------
    // Auto / rotation / tile: content-based per-pair comparison of the
    // rotation-model RMS vs similarity-model RMS; gimbal metadata
    // corroborates but never decides.
    //
    // IMPORTANT: selection runs on the PROXY-verified graph (before full-res
    // reverification) so that nadir/translation-dominant sets still have
    // their edges present for evidence. The rotation-model full-res
    // reverification would drop all edges on a pure-translation set — using
    // a post-reverify graph would give zero evidence and silently misclassify
    // every nadir capture as rotation (which then fails with no frames).
    let mean_focal_px = {
        let vals: Vec<f64> = full_images.iter().map(|img| img.camera.focal_px).collect();
        if vals.is_empty() {
            1.0
        } else {
            vals.iter().sum::<f64>() / vals.len() as f64
        }
    };
    let priors: Vec<maple_pano::ingest::FramePriors> =
        frames.iter().map(|f| f.priors.clone()).collect();
    let strategy_report = select_strategy(
        args.strategy.to_request(),
        &graph,
        &priors,
        mean_focal_px,
        0x1226_cafe_dead_beef,
    );
    eprintln!(
        "pano: strategy — requested={} selected={} tile_votes={} rotation_votes={}{}",
        strategy_report.requested.as_str(),
        strategy_report.selected.as_str(),
        strategy_report.evidence.tile_votes,
        strategy_report.evidence.rotation_votes,
        strategy_report
            .warning
            .map(|w| format!(" [WARN: {w}]"))
            .unwrap_or_default(),
    );

    match strategy_report.selected {
        // ---- Tile strategy -----------------------------------------------
        // Skip full-res rotation reverification — the tile path uses
        // similarity estimation on the proxy-lifted matches directly.
        // Full-res NCC refinement still runs (below) for sub-pixel accuracy.
        Strategy::Tile => {
            let t_refine = Instant::now();
            let (mut refined_matches, mut fallback_matches) = (0usize, 0usize);
            for edge in &mut graph.edges {
                let (img_a, img_b) = (&frames[edge.a].image, &frames[edge.b].image);
                let scale_of = |img: &PlanarImage, i: usize| {
                    (
                        img.width() as f64 / proxy_dims[i].0 as f64,
                        img.height() as f64 / proxy_dims[i].1 as f64,
                    )
                };
                // For tile path, refine without rotation-model geometry
                // compensation (the geometry is a translation, not a rotation).
                let outcome = refine_correspondences(
                    img_a,
                    img_b,
                    scale_of(img_a, edge.a),
                    scale_of(img_b, edge.b),
                    None,
                    &edge.inlier_matches,
                    &RefineOptions::default(),
                );
                refined_matches += outcome.refined_count;
                fallback_matches += outcome.fallback_count;
                edge.inlier_matches = outcome.refined;
            }
            // No full-res rotation reverification for tile: the rotation model
            // would drop all edges on translation-dominant sets.
            let reverify = maple_pano::graph::ReverifySummary {
                edges_dropped: 0,
                matches_dropped: 0,
            };
            let refine_s = t_refine.elapsed().as_secs_f64();
            eprintln!(
                "pano: tile refine — {refined_matches} matches NCC-refined at full res, \
                 {fallback_matches} kept proxy accuracy ({refine_s:.1}s)"
            );

            let t_solve = Instant::now();

            // Verify tile edges (similarity model on full-res matches).
            let tile_edges = verify_tile_edges(&graph, 0x1226_cafe_dead_bee1, &Default::default());
            if tile_edges.is_empty() {
                return Err(
                    "tile strategy selected but no edges passed the similarity verifier — \
                     try --strategy rotation or capture with more overlap"
                        .into(),
                );
            }
            let frame_dims: Vec<(u32, u32)> = frames
                .iter()
                .map(|f| (f.image.width(), f.image.height()))
                .collect();
            let constraints: Vec<TileConstraint> = tile_edges
                .iter()
                .map(|e| TileConstraint {
                    a: e.a,
                    b: e.b,
                    sim_ab: e.estimate.transform,
                    weight: e.inlier_matches.len() as f64,
                })
                .collect();
            let (poses, canvas_spec) = solve_tile_poses(frames.len(), &constraints, 0, &frame_dims)
                .map_err(|e| format!("tile placement failed: {e}"))?;
            let solve_s = t_solve.elapsed().as_secs_f64();
            eprintln!(
                "pano: tile solve — {} poses, canvas {}×{} ({solve_s:.1}s)",
                poses.len(),
                canvas_spec.width,
                canvas_spec.height,
            );

            let frame_images: Vec<PlanarImage> = frames.into_iter().map(|f| f.image).collect();
            let t_comp = Instant::now();
            let (out_img, tile_report) = composite_tile(
                &frame_images,
                frame_images.len(),
                &tile_edges,
                &poses,
                &canvas_spec,
                &Default::default(),
                None,
            )
            .map_err(|e| e.to_string())?;
            let composite_s = t_comp.elapsed().as_secs_f64();
            eprintln!(
                "pano: tile composite — {}×{}, mean planar {:.3}px, max {:.3}px ({composite_s:.1}s)",
                out_img.width(),
                out_img.height(),
                tile_report.mean_planar_residual_px,
                tile_report.max_planar_residual_px,
            );

            let t_out = Instant::now();
            write_png16(&outs.linear, &out_img, false)?;
            if let Some(display) = &outs.display {
                write_png16(display, &out_img, true)?;
            }
            let write_s = t_out.elapsed().as_secs_f64();

            let report = tile_stitch_report(&TileReportContext {
                inputs,
                applied_opcodes: &applied_opcodes,
                strategy: &strategy_report,
                refined_matches,
                fallback_matches,
                reverify: &reverify,
                tile_report: &tile_report,
                timings_s: [
                    ("decode", decode_s),
                    ("features", features_s),
                    ("match_graph", graph_s),
                    ("refine", refine_s),
                    ("solve", solve_s),
                    ("composite", composite_s),
                    ("write", write_s),
                    ("total", t0.elapsed().as_secs_f64()),
                ],
            });
            if let Some(path) = &outs.report {
                let pretty = serde_json::to_string_pretty(&report).expect("report serializes");
                std::fs::write(path, &pretty).map_err(|e| format!("{}: {e}", path.display()))?;
            }
            eprintln!(
                "pano: wrote {} ({}x{}) in {:.1}s",
                outs.linear.display(),
                out_img.width(),
                out_img.height(),
                t0.elapsed().as_secs_f64()
            );
            Ok(report)
        }

        // ---- Rotation strategy (existing path) ---------------------------
        // Full-res NCC refinement + rotation reverification before BA.
        Strategy::Rotation => {
            let t_refine = Instant::now();
            let (mut refined_matches, mut fallback_matches) = (0usize, 0usize);
            for edge in &mut graph.edges {
                let (img_a, img_b) = (&frames[edge.a].image, &frames[edge.b].image);
                let scale_of = |img: &PlanarImage, i: usize| {
                    (
                        img.width() as f64 / proxy_dims[i].0 as f64,
                        img.height() as f64 / proxy_dims[i].1 as f64,
                    )
                };
                let geometry = RefineGeometry {
                    cam_a: &full_images[edge.a].camera,
                    cam_b: &full_images[edge.b].camera,
                    rotation: &edge.rotation,
                };
                let outcome = refine_correspondences(
                    img_a,
                    img_b,
                    scale_of(img_a, edge.a),
                    scale_of(img_b, edge.b),
                    Some(&geometry),
                    &edge.inlier_matches,
                    &RefineOptions::default(),
                );
                refined_matches += outcome.refined_count;
                fallback_matches += outcome.fallback_count;
                edge.inlier_matches = outcome.refined;
            }
            let reverify = graph
                .reverify(&full_images, &RobustOptions::default())
                .map_err(|e| e.to_string())?;
            let refine_s = t_refine.elapsed().as_secs_f64();
            eprintln!(
                "pano: refine — {refined_matches} matches NCC-refined at full res, \
                 {fallback_matches} kept proxy accuracy; full-res re-verification \
                 dropped {} edge(s) / {} match(es) ({refine_s:.1}s)",
                reverify.edges_dropped, reverify.matches_dropped
            );
            if !graph.orphans.is_empty() {
                eprintln!(
                    "pano: re-verification orphaned image(s) {:?} — reported as \
                     Disconnected by the solve",
                    graph.orphans
                );
            }

            let t_solve = Instant::now();
            let mut solution = ba::solve(
                &full_images,
                &graph,
                &BaOptions {
                    mean_budget_px,
                    max_budget_px,
                    retention: args.retention.policy(),
                    local_align: args.local_align.enabled(),
                    ..Default::default()
                },
            )
            .map_err(|e| e.to_string())?;
            let leveled = leveling::apply(&mut solution);
            let horizon_tilt_deg = leveled.then(|| leveling::horizon_tilt_deg(&solution));
            let solve_s = t_solve.elapsed().as_secs_f64();
            eprintln!(
                "pano: solve — mean {:.3}px max {:.3}px over {} rounds ({} LM iters), focal {:.1}px, dropped {:?}, leveled={leveled}",
                solution.mean_reproj_px,
                solution.max_reproj_px,
                solution.solve_rounds,
                solution.lm_iterations,
                solution.shared_focal_px,
                solution.dropped
            );
            if !solution.motion_affected.is_empty() {
                eprintln!(
                    "pano: motion — frame(s) {:?} kept on their static cores (spec §8), \
                     {:?} motion match(es) pruned",
                    solution.motion_affected, solution.motion_pruned_matches
                );
            }

            let (kept, kept_local): (
                Vec<(PlanarImage, Camera)>,
                Vec<Option<maple_pano::local_align::LocalCorrection>>,
            ) = frames
                .into_iter()
                .zip(&solution.cameras)
                .zip(&solution.local_corrections)
                .filter_map(|((f, cam), lc)| {
                    cam.as_ref().map(|c| ((f.image, c.clone()), lc.clone()))
                })
                .unzip();
            if kept.len() < 2 {
                return Err(format!(
                    "only {} frame(s) survived the solve — nothing to composite \
                     (drops: {:?})",
                    kept.len(),
                    solution.dropped
                ));
            }
            let t_comp = Instant::now();
            let (kept_frames, kept_cams): (Vec<_>, Vec<_>) = kept.into_iter().unzip();
            let (out_img, comp_report) = composite(
                &kept_frames,
                &kept_cams,
                &CompositeOptions {
                    canvas: CanvasOptions {
                        projection: ProjectionMode::Auto,
                        max_pixels: args.max_canvas_px,
                        ..Default::default()
                    },
                    ..Default::default()
                },
                &kept_local,
            )
            .map_err(|e| e.to_string())?;
            let composite_s = t_comp.elapsed().as_secs_f64();

            let t_out = Instant::now();
            write_png16(&outs.linear, &out_img, false)?;
            if let Some(display) = &outs.display {
                write_png16(display, &out_img, true)?;
            }
            let write_s = t_out.elapsed().as_secs_f64();

            let report = stitch_report(&ReportContext {
                inputs,
                applied_opcodes: &applied_opcodes,
                solution: &solution,
                refined_matches,
                fallback_matches,
                reverify: &reverify,
                leveled,
                horizon_tilt_deg,
                gate_budgets: (mean_budget_px, max_budget_px),
                retention: args.retention.label(),
                local_align: args.local_align.label(),
                comp_report: &comp_report,
                timings_s: [
                    ("decode", decode_s),
                    ("features", features_s),
                    ("match_graph", graph_s),
                    ("refine", refine_s),
                    ("solve", solve_s),
                    ("composite", composite_s),
                    ("write", write_s),
                    ("total", t0.elapsed().as_secs_f64()),
                ],
            });
            if let Some(path) = &outs.report {
                let pretty = serde_json::to_string_pretty(&report).expect("report serializes");
                std::fs::write(path, &pretty).map_err(|e| format!("{}: {e}", path.display()))?;
            }
            eprintln!(
                "pano: wrote {} ({}x{}) in {:.1}s",
                outs.linear.display(),
                out_img.width(),
                out_img.height(),
                t0.elapsed().as_secs_f64()
            );
            Ok(report)
        }
    }
}
