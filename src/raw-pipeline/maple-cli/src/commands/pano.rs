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

use std::path::{Path, PathBuf};
use std::time::Instant;

use clap::{Args, Subcommand};

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
use maple_pano::render::write_frame_png;
use maple_pano::robust::RobustOptions;
use maple_pano::twoview::PixelCorrespondence;

/// Spec §5.3 acceptance-gate defaults (single source for both modes).
const SPEC_MEAN_BUDGET_PX: f64 = 1.5;
const SPEC_MAX_BUDGET_PX: f64 = 6.0;

#[derive(Subcommand)]
pub enum PanoCmd {
    /// Stitch a panorama from RAW frames.
    Stitch(StitchArgs),
}

#[derive(Args)]
pub struct StitchArgs {
    /// Input RAW frames (2+; single-set mode). Sorted by file name =
    /// capture order. Mutually exclusive with --manifest.
    #[arg(num_args = 0..)]
    inputs: Vec<PathBuf>,
    /// Output PNG path (16-bit, scene-linear; single-set mode).
    #[arg(long)]
    out: Option<PathBuf>,
    /// Also write an sRGB-encoded 16-bit preview PNG here (single-set).
    #[arg(long)]
    display: Option<PathBuf>,
    /// Write the stitch report JSON here (always printed to stderr).
    #[arg(long)]
    report: Option<PathBuf>,
    /// Batch mode: pano manifest JSON (the harness contract — see the
    /// module docs). Requires --out-dir.
    #[arg(long, conflicts_with_all = ["out", "display", "report"])]
    manifest: Option<PathBuf>,
    /// Batch mode: candidate output directory.
    #[arg(long, requires = "manifest")]
    out_dir: Option<PathBuf>,
    /// Long-edge cap for the feature-extraction proxy. The ALIKED
    /// export letterboxes to 1280² internally; larger proxies only
    /// cost decode time.
    #[arg(long, default_value_t = 1600)]
    proxy_long_edge: u32,
    /// Total canvas pixel cap (uniform downscale to fit).
    #[arg(long, default_value_t = 256_000_000)]
    max_canvas_px: usize,
    /// Per-frame mean reprojection-error budget (px; single-set mode
    /// only). The spec §5.3 gate is 1.5; relax it for input with
    /// uncorrected lens distortion (DJI `WarpRectilinear` opcodes
    /// raw-core does not yet apply, #1159), which inflates residuals
    /// the k1/k2 model only partly absorbs.
    #[arg(long, default_value_t = SPEC_MEAN_BUDGET_PX)]
    max_mean_px: f64,
    /// Per-frame max reprojection-error budget (px; single-set mode
    /// only). Spec §5.3 gate is 6.
    #[arg(long, default_value_t = SPEC_MAX_BUDGET_PX)]
    max_residual_px: f64,
    /// Models directory (defaults to $MAPLE_PANO_MODELS).
    #[arg(long)]
    models_dir: Option<PathBuf>,
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

    // ---- Full-resolution match refinement (#1210) -------------------------
    // Re-localize every verified inlier on the full-res frames (borrowed
    // from `frames` — no clones) and REPLACE the edge payloads with the
    // full-res coordinates, so BA below solves at full resolution. The
    // pair geometry (full-res intrinsics + the edge's verified rotation)
    // drives perspective compensation of the template — without it the
    // overlap strip's ~30% A→B compression caps accuracy at ~2 px.
    // Matches the refiner cannot honestly improve keep their proxy
    // accuracy (scaled up, counted as fallbacks in the report).
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
    let refine_s = t_refine.elapsed().as_secs_f64();
    eprintln!(
        "pano: refine — {refined_matches} matches NCC-refined at full res, \
         {fallback_matches} kept proxy accuracy ({refine_s:.1}s)"
    );

    // ---- Global solve + leveling ----------------------------------------
    let t_solve = Instant::now();
    let mut solution = ba::solve(
        &full_images,
        &graph,
        &BaOptions {
            mean_budget_px,
            max_budget_px,
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

    // ---- Composite --------------------------------------------------------
    // The solve already ran at full resolution (full-res matches, full
    // dims, EXIF-native focal) — solved cameras feed compositing as-is.
    // Move images out of `frames` (which is not used afterwards) instead of
    // cloning to avoid doubling peak memory for large panorama sets.
    let kept: Vec<(PlanarImage, Camera)> = frames
        .into_iter()
        .zip(&solution.cameras)
        .filter_map(|(f, cam)| cam.as_ref().map(|c| (f.image, c.clone())))
        .collect();
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
    )
    .map_err(|e| e.to_string())?;
    let composite_s = t_comp.elapsed().as_secs_f64();

    // ---- Outputs ----------------------------------------------------------
    let t_out = Instant::now();
    write_png16(&outs.linear, &out_img, false)?;
    if let Some(display) = &outs.display {
        write_png16(display, &out_img, true)?;
    }
    let write_s = t_out.elapsed().as_secs_f64();

    let report = serde_json::json!({
        "inputs": inputs.iter().map(|p| p.display().to_string()).collect::<Vec<_>>(),
        "applied_opcodes": applied_opcodes,
        "cameras": solution.cameras.iter().map(|c| c.as_ref().map(|c| serde_json::json!({
            "axis_angle": c.axis_angle,
            "focal_px": c.focal_px,
            "k1": c.k1,
            "k2": c.k2,
        }))).collect::<Vec<_>>(),
        "mean_reproj_error_px": solution.mean_reproj_px,
        "max_reproj_error_px": solution.max_reproj_px,
        "shared_focal_px": solution.shared_focal_px,
        "k1": solution.k1,
        "k2": solution.k2,
        "dropped_images": solution.dropped.iter().map(|d| format!("{d:?}")).collect::<Vec<_>>(),
        "pruned_matches": solution.pruned_matches,
        "refined_matches": refined_matches,
        "fallback_matches": fallback_matches,
        // Per-frame residual summaries for surviving frames (px in that
        // frame's plane) — null for dropped frames. Triage data: which
        // frame sits where against the §5.3 budgets.
        "frame_stats": solution.frame_stats.iter().map(|s| s.as_ref().map(|s| serde_json::json!({
            "mean_px": s.mean_px,
            "max_px": s.max_px,
            "median_px": s.median_px,
            "blocks": s.blocks,
        }))).collect::<Vec<_>>(),
        "leveled": leveled,
        "horizon_tilt_deg": horizon_tilt_deg,
        "gate_mean_budget_px": mean_budget_px,
        "gate_max_budget_px": max_budget_px,
        "projection": format!("{:?}", comp_report.projection),
        "canvas": { "width": comp_report.canvas.width, "height": comp_report.canvas.height },
        "gains": comp_report.gains,
        "blend_levels": comp_report.blend_levels,
        "min_overlap_width_px": comp_report.min_overlap_width_px,
        "timings_s": {
            "decode": decode_s,
            "features": features_s,
            "match_graph": graph_s,
            "refine": refine_s,
            "solve": solve_s,
            "composite": composite_s,
            "write": write_s,
            "total": t0.elapsed().as_secs_f64(),
        },
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

/// Interleave a planar image into the detector's RGB f32 layout.
fn interleave(img: &PlanarImage) -> Vec<f32> {
    let n = img.pixel_count();
    let mut out = Vec::with_capacity(n * 3);
    for i in 0..n {
        out.push(img.r[i]);
        out.push(img.g[i]);
        out.push(img.b[i]);
    }
    out
}

/// Quantize the composite to 16-bit PNG. `srgb` applies the IEC 61966
/// transfer for an eyeball-able preview; otherwise values stay linear
/// (clamped to [0, 1] — the PNG carries the display-range slice of the
/// scene; the DNG writer of spec step 9 is the full-range carrier).
fn write_png16(path: &Path, img: &PlanarImage, srgb: bool) -> Result<(), String> {
    let n = img.pixel_count();
    let mut data = Vec::with_capacity(n * 3);
    for i in 0..n {
        for plane in [&img.r, &img.g, &img.b] {
            let v = plane[i].clamp(0.0, 1.0);
            let v = if srgb { srgb_encode(v) } else { v };
            data.push((v * 65535.0).round() as u16);
        }
    }
    write_frame_png(path, img.width(), img.height(), &data)
        .map_err(|e| format!("{}: {e}", path.display()))
}

fn srgb_encode(v: f32) -> f32 {
    if v <= 0.003_130_8 {
        12.92 * v
    } else {
        1.055 * v.powf(1.0 / 2.4) - 0.055
    }
}
