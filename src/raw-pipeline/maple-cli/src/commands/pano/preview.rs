//! `pano stitch --preview-out` and the `--alignment-in/--alignment-out`
//! file plumbing (#4578). The preview and the alignment reuse rule live in
//! [`maple_pano::stitch::preview`] / [`maple_pano::stitch::stitch_reusing`];
//! this module only reads and writes files and reports what happened.

use std::path::{Path, PathBuf};
use std::time::Instant;

use maple_pano::render::{write_frame_png, PngMetadata};
use maple_pano::stitch::{self, AlignmentReuse, SolvedAlignment};
use serde_json::json;

use super::StitchArgs;

/// Read and decode an alignment file; `Ok(None)` when no path was given.
pub(super) fn load_alignment(path: Option<&Path>) -> Result<Option<SolvedAlignment>, String> {
    path.map(|p| {
        std::fs::read_to_string(p)
            .map_err(|e| format!("{}: {e}", p.display()))
            .and_then(|json| SolvedAlignment::from_json(&json))
    })
    .transpose()
}

/// Load `--alignment-in`, folding an unusable file into the reuse verdict
/// the run will report (`Stale`) instead of failing the stitch.
pub(super) fn offered_alignment(args: &StitchArgs) -> (Option<SolvedAlignment>, Option<String>) {
    match load_alignment(args.alignment_in.as_deref()) {
        Ok(offered) => (offered, None),
        Err(reason) => {
            eprintln!("pano: alignment — ignoring --alignment-in ({reason})");
            (None, Some(reason))
        }
    }
}

pub(super) fn save_alignment(
    path: Option<&Path>,
    alignment: &SolvedAlignment,
) -> Result<(), String> {
    path.map_or(Ok(()), |p| {
        std::fs::write(p, alignment.to_json()).map_err(|e| format!("{}: {e}", p.display()))
    })
}

/// The report block (and log line) describing how the alignment was used.
pub(super) fn alignment_report(reuse: &AlignmentReuse) -> serde_json::Value {
    eprintln!(
        "pano: alignment — {}{}",
        reuse.as_str(),
        reuse
            .reason()
            .map(|r| format!(" ({r}); matching re-ran"))
            .unwrap_or_default()
    );
    json!({ "status": reuse.as_str(), "stale_reason": reuse.reason() })
}

pub(super) fn verdict(reuse: AlignmentReuse, unreadable: Option<String>) -> AlignmentReuse {
    unreadable.map_or(reuse, AlignmentReuse::Stale)
}

pub(super) fn run_preview(
    inputs: &[PathBuf],
    preview_out: &Path,
    args: &StitchArgs,
) -> Result<(), String> {
    let t0 = Instant::now();
    let opts = super::stitch_options(args, (args.max_mean_px, args.max_residual_px));
    let (offered, unreadable) = offered_alignment(args);
    let preview = stitch::preview(inputs, &opts, offered.as_ref(), |_, _| {}, || false)
        .map_err(|e| e.to_string())?;

    let t_out = Instant::now();
    write_frame_png(
        preview_out,
        preview.width,
        preview.height,
        &preview.display_rgb16,
        &PngMetadata {
            exif_blob: None,
            tag_srgb: true,
        },
    )
    .map_err(|e| format!("{}: {e}", preview_out.display()))?;
    save_alignment(args.alignment_out.as_deref(), &preview.alignment)?;
    let write_s = t_out.elapsed().as_secs_f64();

    let [decode, features, match_graph, refine, solve, composite] = preview.stage_timings_s;
    let report = json!({
        "mode": "preview",
        "frames": inputs.len(),
        "strategy": preview.strategy.as_str(),
        "width": preview.width,
        "height": preview.height,
        "alignment": alignment_report(&verdict(preview.reuse, unreadable)),
        "timings_s": {
            "decode": decode,
            "features": features,
            "match_graph": match_graph,
            "refine": refine,
            "solve": solve,
            "composite": composite,
            "write": write_s,
            "total": t0.elapsed().as_secs_f64(),
        },
    });
    let pretty = serde_json::to_string_pretty(&report).expect("report serializes");
    if let Some(path) = &args.report {
        std::fs::write(path, &pretty).map_err(|e| format!("{}: {e}", path.display()))?;
    }
    eprintln!(
        "pano: preview {}x{} → {} in {:.1}s",
        preview.width,
        preview.height,
        preview_out.display(),
        t0.elapsed().as_secs_f64()
    );
    eprintln!("{pretty}");
    Ok(())
}
