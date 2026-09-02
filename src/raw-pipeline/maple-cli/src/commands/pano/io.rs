//! Output helpers for [`super`] (`pano stitch`): pixel-buffer encode +
//! the `StitchReport` JSON assembly. Split from `pano/mod.rs` for the
//! file-size budget.

use std::path::{Path, PathBuf};

use maple_pano::ba::BaSolution;
use maple_pano::composite::CompositeReport;
use maple_pano::graph::ReverifySummary;
use maple_pano::ingest::PlanarImage;
use maple_pano::render::{write_frame_png, PngMetadata};
use maple_pano::strategy::StrategyReport;
use maple_pano::tile::TileCompositeReport;

/// Everything the stitch report serializes, borrowed from the
/// pipeline's locals — one struct so the builder stays a single call.
pub(super) struct ReportContext<'a> {
    pub inputs: &'a [PathBuf],
    pub applied_opcodes: &'a [Vec<String>],
    pub solution: &'a BaSolution,
    pub refined_matches: usize,
    pub fallback_matches: usize,
    pub reverify: &'a ReverifySummary,
    pub leveled: bool,
    pub horizon_tilt_deg: Option<f64>,
    /// `(mean_budget_px, max_budget_px)` the §5.3 gate ran at.
    pub gate_budgets: (f64, f64),
    /// Frame-retention policy + local-alignment mode the solve ran with
    /// (CLI `--retention` / `--local-align`), for report auditability.
    pub retention: &'static str,
    pub local_align: &'static str,
    /// Which source produced the shared camera focal seed — EXIF, or
    /// the homography self-calibration fallback (spec §5.3, #1214).
    pub focal_seed_source: &'static str,
    pub comp_report: &'a CompositeReport,
    /// Stage timings, serialized in array order.
    pub timings_s: [(&'static str, f64); 8],
}

/// Spec §8 failure-mode threshold: "Mixed exposure without brackets:
/// gain solve produces large spread → apply gains; warn if spread >
/// 2 EV." (#1192)
const GAIN_SPREAD_WARNING_EV: f64 = 2.0;

/// Plain-language notice for the §8 mixed-exposure failure mode
/// (product spec §8.3 table).
const GAIN_SPREAD_WARNING_TEXT: &str =
    "Exposure varied widely between shots; brightness was equalized";

/// EV spread of the per-frame gains `solve_gains` produced, after its
/// gauge normalization (spec §8). Each frame's `[r, g, b]` gain
/// collapses to its mean (scalar-mode gains store the same value three
/// times; per-channel mode averages the channels), then the spread is
/// `log2(max / min)` over frames with a defined, positive gain. `0.0`
/// when fewer than two frames have a usable gain (nothing to spread),
/// matching the rest of the report's "zero means no signal" convention.
fn gain_spread_ev(gains: &[[f32; 3]]) -> f64 {
    // Single pass: (count, min, max) over the per-frame means of frames whose
    // three channel gains are each finite and positive — `solve_gains` can
    // leave a non-positive channel in per-channel mode, and a mean that
    // happens to stay > 0 must not smuggle that frame into the spread.
    let (count, min, max) = gains
        .iter()
        .filter(|g| g.iter().all(|c| c.is_finite() && *c > 0.0))
        .map(|g| (g[0] as f64 + g[1] as f64 + g[2] as f64) / 3.0)
        .fold(
            (0usize, f64::INFINITY, f64::NEG_INFINITY),
            |(n, lo, hi), m| (n + 1, lo.min(m), hi.max(m)),
        );
    if count < 2 {
        0.0
    } else {
        (max / min).log2()
    }
}

/// The `StitchReport`-shaped JSON (stitching spec §6).
pub(super) fn stitch_report(ctx: &ReportContext) -> serde_json::Value {
    let solution = ctx.solution;
    let comp_report = ctx.comp_report;
    let timings: serde_json::Map<String, serde_json::Value> = ctx
        .timings_s
        .iter()
        .map(|&(k, v)| (k.to_string(), serde_json::json!(v)))
        .collect();
    let gain_spread = gain_spread_ev(&comp_report.gains);
    let mut warnings: Vec<String> = Vec::new();
    if !solution.motion_affected.is_empty() {
        warnings.push("Movement detected, some areas may show ghosting".to_string());
    }
    if gain_spread > GAIN_SPREAD_WARNING_EV {
        warnings.push(GAIN_SPREAD_WARNING_TEXT.to_string());
    }
    serde_json::json!({
        "inputs": ctx.inputs.iter().map(|p| p.display().to_string()).collect::<Vec<_>>(),
        "retention": ctx.retention,
        "local_align": ctx.local_align,
        "focal_seed_source": ctx.focal_seed_source,
        "applied_opcodes": ctx.applied_opcodes,
        "cameras": solution.cameras.iter().map(|c| c.as_ref().map(|c| serde_json::json!({
            "axis_angle": c.axis_angle,
            "focal_px": c.focal_px,
            "k1": c.k1,
            "k2": c.k2,
        }))).collect::<Vec<_>>(),
        "mean_reproj_error_px": solution.mean_reproj_px,
        "max_reproj_error_px": solution.max_reproj_px,
        // Pre-local-alignment residuals for auditability (spec §8 + #1218).
        // Always populated by the solve; with --local-align off the
        // corrections are identity so these equal the post values. Zero
        // only when fewer than two frames survive.
        "mean_reproj_before_local_px": solution.mean_reproj_before_local_px,
        "max_reproj_before_local_px": solution.max_reproj_before_local_px,
        // Per-frame stage-F correction RMS (px), 0.0 for frames with no
        // correction (dropped, pure-rotation, or insufficient support).
        "local_correction_rms_px": solution.local_correction_rms,
        "shared_focal_px": solution.shared_focal_px,
        "k1": solution.k1,
        "k2": solution.k2,
        "dropped_images": solution.dropped.iter().map(|d| format!("{d:?}")).collect::<Vec<_>>(),
        "pruned_matches": solution.pruned_matches,
        // Spec §8 moving-subjects handling (#1216): frames kept on their
        // static cores after motion pruning, with per-frame pruned
        // counts (parallel arrays). Non-empty ⇒ the §8 product warning
        // below.
        "motion_affected": solution.motion_affected,
        "motion_pruned_matches": solution.motion_pruned_matches,
        // Plain-language actionable notices (spec §6/§9.4 StitchReport
        // contract): the §8 movement warning and the §8 mixed-exposure
        // gain-spread warning.
        "warnings": warnings,
        // EV spread of the solved per-frame gains (spec §8: "warn if
        // spread > 2 EV"). Not gated by the harness — capture-technique
        // information, not a pipeline defect.
        "gain_spread_ev": gain_spread,
        "refined_matches": ctx.refined_matches,
        "fallback_matches": ctx.fallback_matches,
        "reverify_edges_dropped": ctx.reverify.edges_dropped,
        "reverify_matches_dropped": ctx.reverify.matches_dropped,
        // Per-frame residual summaries for surviving frames (px in that
        // frame's plane) — null for dropped frames. Triage data: which
        // frame sits where against the §5.3 budgets.
        "frame_stats": solution.frame_stats.iter().map(|s| s.as_ref().map(|s| serde_json::json!({
            "mean_px": s.mean_px,
            "max_px": s.max_px,
            "median_px": s.median_px,
            "blocks": s.blocks,
        }))).collect::<Vec<_>>(),
        "leveled": ctx.leveled,
        "horizon_tilt_deg": ctx.horizon_tilt_deg,
        "gate_mean_budget_px": ctx.gate_budgets.0,
        "gate_max_budget_px": ctx.gate_budgets.1,
        "projection": format!("{:?}", comp_report.projection),
        "canvas": { "width": comp_report.canvas.width, "height": comp_report.canvas.height },
        "gains": comp_report.gains,
        "blend_levels": comp_report.blend_levels,
        "min_overlap_width_px": comp_report.min_overlap_width_px,
        "timings_s": timings,
    })
}

/// Quantize the composite to 16-bit PNG. `srgb` applies the IEC 61966
/// transfer for an eyeball-able preview AND tags the PNG with an `sRGB`
/// chunk so viewers interpret the pixels correctly. When `srgb = false`
/// values stay linear (clamped to [0, 1]) and the PNG carries no colour
/// space tag (scene-linear data is not display-referred sRGB; tagging it
/// as such would mislead viewers).
///
/// Note: callers that need EXIF embedding (the display pano PNG) call
/// `write_frame_png` directly with a populated [`PngMetadata`] — this
/// helper is for the plain sRGB-or-linear case only.
pub(super) fn write_png16(path: &Path, img: &PlanarImage, srgb: bool) -> Result<(), String> {
    let n = img.pixel_count();
    let mut data = Vec::with_capacity(n * 3);
    for i in 0..n {
        for plane in [&img.r, &img.g, &img.b] {
            let v = plane[i].clamp(0.0, 1.0);
            let v = if srgb { srgb_encode(v) } else { v };
            data.push((v * 65535.0).round() as u16);
        }
    }
    let meta = if srgb {
        PngMetadata {
            tag_srgb: true,
            ..Default::default()
        }
    } else {
        // Scene-linear carrier: no colour-space tag (would mislead viewers).
        PngMetadata::default()
    };
    write_frame_png(path, img.width(), img.height(), &data, &meta)
        .map_err(|e| format!("{}: {e}", path.display()))
}

/// Context for the tile strategy stitch report (no BA solution / leveling /
/// wrap closure — those keys are absent, not zeroed).
pub(super) struct TileReportContext<'a> {
    pub inputs: &'a [PathBuf],
    pub applied_opcodes: &'a [Vec<String>],
    pub strategy: &'a StrategyReport,
    pub refined_matches: usize,
    pub fallback_matches: usize,
    pub reverify: &'a ReverifySummary,
    pub tile_report: &'a TileCompositeReport,
    /// Frame indices disconnected from anchor (the tile-path orphan list).
    /// Parallel to the rotation path's `dropped_images`; empty on a
    /// fully-connected tile set.
    pub tile_orphans: &'a [usize],
    /// Which source produced the shared camera focal seed — EXIF, or
    /// the homography self-calibration fallback (spec §5.3, #1214).
    /// `None` only when the outcome came from the standalone
    /// `stitch_tile` entry point, which never resolves one (unit focal).
    pub focal_seed_source: Option<&'static str>,
    /// Stage timings, serialized in array order.
    pub timings_s: [(&'static str, f64); 8],
}

/// JSON report for the tile composite path (spec §8 / #1226).
///
/// Absent keys vs rotation report: `cameras`, `mean_reproj_error_px`,
/// `max_reproj_error_px`, `mean_reproj_before_local_px`,
/// `max_reproj_before_local_px`, `local_correction_rms_px`,
/// `shared_focal_px`, `k1`, `k2`, `dropped_images`, `pruned_matches`,
/// `motion_affected`, `motion_pruned_matches`, `leveled`, `horizon_tilt_deg`,
/// `gate_mean_budget_px`, `gate_max_budget_px`, `projection`.
///
/// Present keys unique to tile: `strategy` block, `tile_placement`,
/// `mean_planar_residual_px`, `max_planar_residual_px`.
pub(super) fn tile_stitch_report(ctx: &TileReportContext) -> serde_json::Value {
    let timings: serde_json::Map<String, serde_json::Value> = ctx
        .timings_s
        .iter()
        .map(|&(k, v)| (k.to_string(), serde_json::json!(v)))
        .collect();

    let tr = ctx.tile_report;
    let strat = ctx.strategy;

    let placements: Vec<serde_json::Value> = tr
        .placements
        .iter()
        .map(|pose| {
            serde_json::json!({
                "frame_idx": pose.frame_idx,
                "tx_px": pose.sim.tx,
                "ty_px": pose.sim.ty,
                "scale": pose.sim.scale,
                "theta_rad": pose.sim.theta,
            })
        })
        .collect();

    // Serialize per-edge evidence compactly.
    let edge_evidence: Vec<serde_json::Value> = strat
        .evidence
        .per_edge
        .iter()
        .map(|e| {
            serde_json::json!({
                "a": e.a,
                "b": e.b,
                "rotation_rms_px": e.rotation_rms_px,
                "planar_rms_px": e.planar_rms_px,
                "votes_tile": e.votes_tile,
            })
        })
        .collect();

    let gain_spread = gain_spread_ev(&tr.gains);
    let mut warnings: Vec<String> = Vec::new();
    if let Some(w) = strat.warning {
        warnings.push(w.to_string());
    }
    if gain_spread > GAIN_SPREAD_WARNING_EV {
        warnings.push(GAIN_SPREAD_WARNING_TEXT.to_string());
    }

    serde_json::json!({
        "inputs": ctx.inputs.iter().map(|p| p.display().to_string()).collect::<Vec<_>>(),
        "applied_opcodes": ctx.applied_opcodes,
        "focal_seed_source": ctx.focal_seed_source,
        // Tile strategy orphans — frames disconnected from the anchor
        // component. Empty for a fully-connected set (the normal case).
        // The harness gates dropped_frames=0 via this field.
        "dropped_images": ctx.tile_orphans.iter().map(|i| format!("Disconnected({i})")).collect::<Vec<_>>(),
        "strategy": {
            "requested": strat.requested.as_str(),
            "selected": strat.selected.as_str(),
            "evidence": {
                "tile_votes": strat.evidence.tile_votes,
                "rotation_votes": strat.evidence.rotation_votes,
                "mean_rotation_rms_px": strat.evidence.mean_rotation_rms_px,
                "mean_planar_rms_px": strat.evidence.mean_planar_rms_px,
                "gimbal_corroboration": strat.evidence.gimbal_corroboration,
                "per_edge": edge_evidence,
            },
        },
        "warnings": warnings,
        "refined_matches": ctx.refined_matches,
        "fallback_matches": ctx.fallback_matches,
        "reverify_edges_dropped": ctx.reverify.edges_dropped,
        "reverify_matches_dropped": ctx.reverify.matches_dropped,
        "tile_placement": placements,
        "mean_planar_residual_px": tr.mean_planar_residual_px,
        "max_planar_residual_px": tr.max_planar_residual_px,
        // EV spread of the solved per-frame gains (spec §8: "warn if
        // spread > 2 EV"). Not gated by the harness — capture-technique
        // information, not a pipeline defect.
        "gain_spread_ev": gain_spread,
        "canvas": {
            "width": tr.canvas.width,
            "height": tr.canvas.height,
            "offset_x": tr.canvas.offset_x,
            "offset_y": tr.canvas.offset_y,
        },
        "gains": tr.gains,
        "blend_levels": tr.blend_levels,
        "min_overlap_width_px": tr.min_overlap_width_px,
        // #350 photometric correction: shared per-frame ramp + residual
        // exposure-field magnitudes (EV). Slopes ~0 and 0 EV mean the
        // scalar gains told the whole story.
        "photometric_slope_x": tr.photometric_slope_x,
        "photometric_slope_y": tr.photometric_slope_y,
        "exposure_field_mean_abs_ev": tr.exposure_field_mean_abs_ev,
        "exposure_field_max_abs_ev": tr.exposure_field_max_abs_ev,
        "timings_s": timings,
    })
}

fn srgb_encode(v: f32) -> f32 {
    if v <= 0.003_130_8 {
        12.92 * v
    } else {
        1.055 * v.powf(1.0 / 2.4) - 0.055
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gain_spread_ev_matches_pano_01_measurement() {
        // #1192: pano_01's auto-exposure sky-to-ground sweep measured a
        // 4.76x gain spread = 2.25 EV. log2(4.76) ≈ 2.2515.
        let gains = [[1.0_f32, 1.0, 1.0], [4.76, 4.76, 4.76]];
        let spread = gain_spread_ev(&gains);
        assert!(
            (spread - 2.25).abs() < 0.01,
            "expected ~2.25 EV, got {spread}"
        );
        assert!(spread > GAIN_SPREAD_WARNING_EV);
    }

    #[test]
    fn gain_spread_ev_averages_per_channel_gains() {
        // Per-channel (GainMode::PerChannel) gains collapse to their
        // mean before the spread is computed.
        let gains = [[0.9_f32, 1.0, 1.1], [1.8, 2.0, 2.2]];
        // means: 1.0 and 2.0 -> spread = log2(2.0) = 1.0
        let spread = gain_spread_ev(&gains);
        assert!((spread - 1.0).abs() < 1e-6, "got {spread}");
        assert!(spread < GAIN_SPREAD_WARNING_EV);
    }

    #[test]
    fn gain_spread_ev_zero_below_two_frames() {
        assert_eq!(gain_spread_ev(&[]), 0.0);
        assert_eq!(gain_spread_ev(&[[1.0, 1.0, 1.0]]), 0.0);
    }

    #[test]
    fn gain_spread_ev_ignores_non_positive_gains() {
        // A degenerate zero/negative gain (should not occur post
        // gauge-normalization, but the spread computation must not
        // divide by, or log2 of, a non-positive value) is excluded
        // rather than poisoning the whole spread with NaN/inf.
        let gains = [[0.0_f32, 0.0, 0.0], [1.0, 1.0, 1.0], [3.0, 3.0, 3.0]];
        let spread = gain_spread_ev(&gains);
        assert!((spread - 3.0_f64.log2()).abs() < 1e-6, "got {spread}");
    }

    #[test]
    fn gain_spread_ev_drops_frames_with_one_non_positive_channel() {
        // Per-channel mode can leave a single non-positive channel while the
        // frame's mean stays > 0; that frame must not enter the spread.
        let clean = [[1.0f32, 1.0, 1.0], [2.0, 2.0, 2.0]];
        let poisoned = [[1.0f32, 1.0, 1.0], [2.0, 2.0, 2.0], [9.0, 9.0, -0.5]];
        assert_eq!(gain_spread_ev(&poisoned), gain_spread_ev(&clean));
        assert!((gain_spread_ev(&clean) - 1.0).abs() < 1e-6);
    }

    #[test]
    fn gain_spread_ev_uniform_gains_is_zero() {
        let gains = [[1.0_f32, 1.0, 1.0]; 5];
        assert_eq!(gain_spread_ev(&gains), 0.0);
    }
}
