//! `maple-cli pano stitch` (#1182) — the end-to-end panorama pipeline.
//!
//! This module is a thin orchestrator: it parses CLI arguments, drives
//! [`maple_pano::stitch`] for the rotation strategy, falls through to
//! [`tile`] for the tile strategy, and assembles the `StitchReport` JSON
//! (spec §6) via [`io`].
//!
//! All geometry runs inside `maple_pano::stitch` — the shared single
//! source of truth for both this CLI and the `maple_pano_stitch` FFI
//! entry (CLAUDE.md principle #4 — Apple↔CLI parity is a merge gate).
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

mod io;
mod tile;

use std::path::{Path, PathBuf};
use std::time::Instant;

use clap::Subcommand;

use maple_pano::stitch::{self, StitchError, StitchOptions};
use maple_pano::strategy::Strategy;

use io::{stitch_report, tile_stitch_report, write_png16, ReportContext};

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
        PanoCmd::Stitch(args) => run_stitch(args),
    }
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

fn run_stitch(args: StitchArgs) -> Result<(), String> {
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
        return stitch_manifest(manifest_path, out_dir, &args);
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
fn stitch_manifest(manifest_path: &Path, out_dir: &Path, args: &StitchArgs) -> Result<(), String> {
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
    inputs: &[PathBuf],
    outs: &SetOutputs,
    gate_budgets: (f64, f64),
    args: &StitchArgs,
) -> Result<serde_json::Value, String> {
    let t0 = Instant::now();

    let opts = StitchOptions {
        retention: args.retention.policy(),
        local_align: args.local_align.enabled(),
        strategy: args.strategy.to_request(),
        mean_budget_px: gate_budgets.0,
        max_budget_px: gate_budgets.1,
        models_dir: args.models_dir.clone(),
        proxy_long_edge: args.proxy_long_edge,
        max_canvas_px: args.max_canvas_px,
        canvas_tile_rows: args.canvas_tile_rows,
        // CLI/macOS path is CPU-ORT (parity-verified); CoreML is the
        // iOS-FFI-only path (M6-C, #1253). See StitchOptions::use_coreml.
        use_coreml: false,
    };

    let progress = |stage: u32, _frac: f32| {
        // Progress to stderr so it doesn't pollute the report JSON on stdout.
        let label = match stage {
            0 => "decode",
            1 => "features",
            2 => "match_graph",
            3 => "refine",
            4 => "solve",
            5 => "composite",
            _ => "?",
        };
        let _ = label; // consumed only at stage start (frac == 0.0)
    };

    match stitch::stitch(inputs, &opts, progress, || false) {
        Ok(outcome) => {
            // ---- write outputs -----------------------------------------------
            let t_out = Instant::now();
            write_png16(&outs.linear, &outcome.image, false)?;
            if let Some(display) = &outs.display {
                write_png16(display, &outcome.image, true)?;
            }
            let write_s = t_out.elapsed().as_secs_f64();

            eprintln!(
                "pano: solve — mean {:.3}px max {:.3}px over {} rounds ({} LM iters), \
                 focal {:.1}px, dropped {:?}, leveled={}",
                outcome.solution.mean_reproj_px,
                outcome.solution.max_reproj_px,
                outcome.solution.solve_rounds,
                outcome.solution.lm_iterations,
                outcome.solution.shared_focal_px,
                outcome.solution.dropped,
                outcome.leveled,
            );
            if !outcome.solution.motion_affected.is_empty() {
                eprintln!(
                    "pano: motion — frame(s) {:?} kept on their static cores (spec §8), \
                     {:?} motion match(es) pruned",
                    outcome.solution.motion_affected, outcome.solution.motion_pruned_matches
                );
            }
            eprintln!(
                "pano: wrote {} ({}x{}) in {:.1}s",
                outs.linear.display(),
                outcome.image.width(),
                outcome.image.height(),
                t0.elapsed().as_secs_f64()
            );

            let [decode_s, features_s, graph_s, refine_s, solve_s, composite_s] =
                outcome.stage_timings_s;
            let report = stitch_report(&ReportContext {
                inputs,
                applied_opcodes: &outcome.applied_opcodes,
                solution: &outcome.solution,
                refined_matches: outcome.refined_matches,
                fallback_matches: outcome.fallback_matches,
                reverify: &outcome.reverify,
                leveled: outcome.leveled,
                horizon_tilt_deg: outcome.horizon_tilt_deg,
                gate_budgets,
                retention: args.retention.label(),
                local_align: args.local_align.label(),
                comp_report: &outcome.comp_report,
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
            Ok(report)
        }

        // ---- Tile strategy: fall through to the tile path -------------------
        Err(StitchError::TileNotSupported(strategy_report)) => {
            eprintln!(
                "pano: strategy — selected=tile tile_votes={} rotation_votes={}{}",
                strategy_report.evidence.tile_votes,
                strategy_report.evidence.rotation_votes,
                strategy_report
                    .warning
                    .map(|w| format!(" [WARN: {w}]"))
                    .unwrap_or_default(),
            );
            // Re-decode for the tile path (stitch() consumed the frames in
            // the rotation path before detecting tile). The tile path owns
            // its own decode + feature loop.
            tile::run_tile_from_paths(tile::TilePathArgs {
                inputs,
                opts: &opts,
                strategy_report: &strategy_report,
                outs_linear: &outs.linear,
                outs_display: outs.display.as_deref(),
                outs_report: outs.report.as_deref(),
                t0,
            })
        }

        Err(e) => Err(e.to_string()),
    }
}
