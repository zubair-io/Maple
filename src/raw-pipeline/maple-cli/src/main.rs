//! `maple-cli` — CLI front-end over the `raw-core` pipeline. Used by every
//! parity / detector harness (`test_color_pipeline.sh`, `test_banding.sh`,
//! `test_halo_detection.sh`, …) plus ad-hoc renders during pipeline work.
//!
//! Per #525, subcommand bodies live in `commands::<name>::run(...)`; this
//! file keeps only the clap derives, the dispatcher, and the shared
//! error-to-exit-code wrapper.

mod commands;

use clap::{Parser, Subcommand};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use commands::types::{DemosaicChoice, OutputFormat, ProfileChoice, SyntheticKind};

#[derive(Parser)]
#[command(name = "maple-cli", about = "Maple raw-pipeline reference renderer")]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Render a RAW + XMP to an image file.
    Render {
        /// Path to the RAW file (DNG, CR2, CR3, NEF, ARW, RAF, ORF, RW2,
        /// PEF, SRW, 3FR, FFF, DCR, MOS, IIQ, MRW).
        raw: PathBuf,
        /// Path to the `crs:`-style XMP sidecar carrying the parameter set.
        /// If omitted, renders with AdjustmentModel::default().
        #[arg(long)]
        params: Option<PathBuf>,
        /// Output image path.
        #[arg(long)]
        out: PathBuf,
        /// Output format. Defaults to inferring from --out extension (.png, .jpg,
        /// .jpeg, .tif, .tiff).
        #[arg(long, value_enum)]
        format: Option<OutputFormat>,
        /// JPEG quality 1..100 (default 92). Ignored for PNG/TIFF.
        #[arg(long, default_value_t = 92)]
        quality: u8,
        /// Demosaic algorithm: `amaze` (default since #940 — highest
        /// quality, tiled + parallel), `full` (Hamilton-Adams or bilinear
        /// per cargo features; the pre-#940 default), or `preview`
        /// (half-res quad). The parity budgets are baselined against the
        /// AMaZE default.
        #[arg(long, value_enum, default_value_t = DemosaicChoice::Amaze)]
        demosaic: DemosaicChoice,
        /// Auto Profile override (#537). `xmp` (default) honours the
        /// sidecar's `papp:Profile`; `auto` and `neutral` force the
        /// choice regardless of XMP. The color-parity harness
        /// (`src/scripts/test_color_pipeline.sh`) pins `neutral` so it
        /// keeps measuring Maple-vs-ACR fidelity, not Maple-vs-embedded-JPEG.
        #[arg(long, value_enum, default_value_t = ProfileChoice::Xmp)]
        profile: ProfileChoice,
    },
    /// Panorama stitching (requires the `pano` build feature).
    #[cfg(feature = "pano")]
    Pano {
        #[command(subcommand)]
        cmd: commands::pano::PanoCmd,
    },
    /// Render every case in a JSON manifest.
    Batch {
        #[arg(long)]
        manifest: PathBuf,
        #[arg(long = "out-dir")]
        out_dir: PathBuf,
        /// Only run cases whose name contains this substring.
        #[arg(long = "cases-filter")]
        cases_filter: Option<String>,
        /// Auto Profile override (#537). See `Render` doc-comment.
        /// `xmp` is the default; the color-parity harness uses
        /// `neutral` to keep the gate measuring ACR fidelity.
        #[arg(long, value_enum, default_value_t = ProfileChoice::Xmp)]
        profile: ProfileChoice,
        /// Demosaic algorithm for every case (same choices as `render`).
        #[arg(long, value_enum, default_value_t = DemosaicChoice::Amaze)]
        demosaic: DemosaicChoice,
    },
    /// Compare two PNGs via compare_images.py; print JSON; exit non-zero if
    /// --budget is set and mean ΔE exceeds it.
    Diff {
        candidate: PathBuf,
        reference: PathBuf,
        #[arg(long)]
        budget: Option<f32>,
    },
    /// Print parsed AdjustmentModel (for .xmp) or RAW metadata (for any RAW).
    Inspect { path: PathBuf },
    /// Render a single source-pixel tile to a PNG. Validates the FFI tile
    /// math without UI. Output is sRGB after CPU AgX + Rec.2020->sRGB
    /// (matches the legacy display-encoded path so the result is viewable
    /// directly in Preview.app).
    Tile {
        raw: PathBuf,
        #[arg(long)]
        params: Option<PathBuf>,
        #[arg(long = "src-x")]
        src_x: u32,
        #[arg(long = "src-y")]
        src_y: u32,
        #[arg(long = "src-w")]
        src_w: u32,
        #[arg(long = "src-h")]
        src_h: u32,
        #[arg(long = "out-w")]
        out_w: u32,
        #[arg(long = "out-h")]
        out_h: u32,
        #[arg(long)]
        out: PathBuf,
        /// Quality: `preview` (half-res quad demosaic), `full`, or `amaze`
        /// (high-quality AMaZE demosaic). Default `full`.
        #[arg(long, default_value = "full")]
        quality: String,
    },
    /// Extract the embedded JPEG preview from a RAW file and write it to
    /// disk (typically as PNG; format inferred from `--out` extension).
    ///
    /// Wraps `raw_core::view::auto_profile::preview::extract_preview`. Used
    /// by `src/scripts/test_auto_profile_match.sh` to obtain the camera-
    /// baked reference for the Auto Profile gate. Exits with the dedicated
    /// sentinel code 3 when the RAW is readable but carries no embedded
    /// preview (so the harness can SKIP cleanly); a missing / unreadable
    /// RAW or a write failure exits with the generic error code 1.
    ExtractPreview {
        /// Path to the RAW file.
        raw: PathBuf,
        /// Output image path (extension determines format: .png, .jpg, ...).
        #[arg(long)]
        out: PathBuf,
    },
    /// Compute Auto Tone slider values for a RAW file and print as JSON.
    ///
    /// Decodes the RAW, runs the development chain to scene-linear
    /// Rec.2020, and hands the buffer to `compute_auto_tone_from_rgba`.
    /// Output is a single JSON object: `{"exposure": <f32>, "contrast":
    /// 0.0, "whites": 0.0, "blacks": 0.0, "highlights": 0.0, "shadows":
    /// 0.0}`. Phase 1a populates `exposure` only; the other fields are
    /// slider rest position until Phase 1b/1c expand the mapping. See
    /// `docs/superpowers/specs/2026-05-26-auto-tone-and-looks-design.md`.
    AutoTone {
        /// Path to the RAW file (DNG, CR2, CR3, NEF, ARW, RAF, etc.).
        raw: PathBuf,
    },
    /// Compute all eight Auto slider values for a RAW file and print as JSON.
    ///
    /// Develops ONE AE-Off/D65 probe buffer (Preview quality for speed)
    /// and derives exposure, temperature, tint, contrast, highlights,
    /// shadows, whites, and blacks from it. See the design contract in
    /// `docs/superpowers/specs/2026-06-18-auto-adjustments-m0-spec.md`.
    ///
    /// NOTE: the returned `exposure` is relative to the AE-Off base. Any
    /// consumer writing the result back to XMP MUST also set
    /// `papp:AutoExposure="Off"` to avoid stacking the scene anchor.
    AutoAdjustments {
        /// Path to the RAW file (DNG, CR2, CR3, NEF, ARW, RAF, etc.).
        raw: PathBuf,
    },
    /// Generate a synthetic scene-linear input and run it through the
    /// view transform (or the slider chain, when `--params` is given).
    /// Used by the diagnostic harnesses (`test_banding.sh`,
    /// `test_hue_stability.sh`, `test_halo_detection.sh`). Honours
    /// `MAPLE_STAGE_DUMP` for per-stage EXR output.
    Synthetic {
        /// Which synthetic generator to call.
        #[arg(long, value_enum)]
        kind: SyntheticKind,
        /// For `--kind hue-patch`: which primary (r, g, b, c, m, y).
        #[arg(long)]
        primary: Option<String>,
        /// For `--kind chroma-ramp`: which named hue axis (foliage, blue,
        /// magenta, skin).
        #[arg(long)]
        hue: Option<String>,
        /// For `--kind hue-patch`: scene-linear exposure offset from
        /// mid-gray (EV).
        #[arg(long, default_value_t = 0.0)]
        ev: f32,
        /// Output PNG path.
        #[arg(long)]
        out: PathBuf,
        /// Output width (defaults pick reasonable shapes per kind).
        #[arg(long)]
        width: Option<u32>,
        /// Output height.
        #[arg(long)]
        height: Option<u32>,
        /// Optional XMP — when given, runs the scene-linear slider chain
        /// (clarity / dehaze / NR / etc.) on the synthetic input before
        /// the view transform. Without it, only AgX + sRGB encode run.
        #[arg(long)]
        params: Option<PathBuf>,
    },
    /// Fit a structured ACR-match model (tonescale + hue/chroma field) from
    /// one or more ACR renders of a dense sweep chart at different exposure
    /// offsets.
    ///
    /// Requires `--features test-support`.  Pass the spec JSON produced by
    /// `SyntheticSweepChart::spec_to_json()` and one or more 8-bit sRGB
    /// ACR-rendered PNGs via `--render <path>@<ev>`.  Exactly one render must
    /// have ev=0 (the baseline).  Multiple renders allow the solver to observe
    /// ACR's highlight shoulder above the baseline clip point.
    ///
    /// `--acr <path>` is a backward-compatible alias for `--render <path>@0`.
    FitAcr {
        /// Path to the sweep chart spec JSON.
        #[arg(long)]
        spec: PathBuf,
        /// ACR-rendered PNG at a given exposure offset: `<path>@<ev>`.
        /// Repeatable; exactly one must have ev=0.
        /// Example: `--render baseline.png@0 --render dark.png@-2`
        #[arg(long = "render", value_name = "PATH@EV")]
        render: Vec<String>,
        /// Alias for `--render <path>@0` (backward compat).
        #[arg(long)]
        acr: Option<PathBuf>,
        /// Output model JSON path.
        #[arg(long)]
        out: PathBuf,
    },
    /// Auto 2.0 milestone M0 (#1740): offline fit-quality report comparing
    /// the Auto 1.0 free residual LUT against the structured fit-acr
    /// solver's JPEG-pair front-end, for one RAW file's own embedded JPEG.
    /// Measurement only — no pipeline wiring, no profile switch.
    ///
    /// Requires `--features test-support`. Exits with the dedicated
    /// sentinel code 3 when the RAW has no usable embedded JPEG preview, OR
    /// when the preview yields too few display pairs (< 256) to fit either
    /// model (so a batch script can skip either skip-reason cleanly); a
    /// missing/unreadable RAW or a write failure exits with the generic
    /// error code 1.
    FitAuto2 {
        /// Path to the RAW file.
        #[arg(long)]
        raw: PathBuf,
        /// Output report path (plain text; see `commands::fit_auto2`).
        #[arg(long)]
        report: PathBuf,
    },
    /// Fit the SHIPPING Auto Profile tail from a real RAW (production entry
    /// point — Auto 2.0 by default, `MAPLE_AUTO1=1` restores Auto 1.0,
    /// exactly as in the app), apply it to smooth display-space ramps
    /// (neutral + the four
    /// named chroma-ramp hues), and write `18_auto_tail.exr` stage dumps
    /// for `src/scripts/banding_check.py` — the Auto Profile section of the
    /// banding gate (`src/scripts/test_banding.sh`, #1740 M1).
    ///
    /// Requires `--features stage-dump`. Exit 3 = no embedded preview
    /// (skip); exit 4 = the fit produced no tail (gate-visible failure).
    AutoTailRamp {
        /// Path to the RAW file.
        #[arg(long)]
        raw: PathBuf,
        /// Directory to write `<ramp>/18_auto_tail.exr` dumps under.
        #[arg(long = "out-dir")]
        out_dir: PathBuf,
        /// Ramp width in pixels (the sweep axis).
        #[arg(long, default_value_t = 1024)]
        width: u32,
        /// Ramp height in pixels.
        #[arg(long, default_value_t = 8)]
        height: u32,
    },
    /// Repack a v1 (inline) DCP `profiles.bin` into the v3 split layout
    /// (dedup HSM pool + per-entry zlib + offset directory; #829 / PR #831).
    /// Prints dedup stats + the pool byte size.
    TranscodeDcp {
        /// Input v1 `profiles.bin` (inline matrices/HSM).
        src: PathBuf,
        /// Output path. With `--out-pool`, this is the index region
        /// (`profiles.idx`); without it, the combined single file.
        #[arg(long)]
        out: PathBuf,
        /// When set, writes the two-file split: `--out` = index region,
        /// `--out-pool` = pool region. Omit for the combined single file.
        #[arg(long)]
        out_pool: Option<PathBuf>,
    },
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    match cli.cmd {
        Cmd::Render {
            raw,
            params,
            out,
            format,
            quality,
            demosaic,
            profile,
        } => run_or_exit(commands::render::run(
            &raw,
            params.as_deref(),
            &out,
            format,
            quality,
            demosaic,
            profile,
        )),
        Cmd::Batch {
            manifest,
            out_dir,
            cases_filter,
            profile,
            demosaic,
        } => run_or_exit(commands::batch::run(
            &manifest,
            &out_dir,
            cases_filter.as_deref(),
            profile,
            demosaic,
        )),
        Cmd::Diff {
            candidate,
            reference,
            budget,
        } => run_or_exit(commands::diff::run(&candidate, &reference, budget)),
        Cmd::Inspect { path } => run_or_exit(commands::inspect::run(&path)),
        Cmd::Tile {
            raw,
            params,
            src_x,
            src_y,
            src_w,
            src_h,
            out_w,
            out_h,
            out,
            quality,
        } => run_or_exit(commands::tile::run(
            &raw,
            params.as_deref(),
            src_x,
            src_y,
            src_w,
            src_h,
            out_w,
            out_h,
            &out,
            &quality,
        )),
        Cmd::ExtractPreview { raw, out } => run_or_exit(commands::extract_preview::run(&raw, &out)),
        Cmd::AutoTone { raw } => run_or_exit(commands::auto_tone::run(&raw)),
        Cmd::AutoAdjustments { raw } => run_or_exit(commands::auto_adjustments::run(&raw)),
        Cmd::Synthetic {
            kind,
            primary,
            hue,
            ev,
            out,
            width,
            height,
            params,
        } => run_or_exit(commands::synthetic::run(
            kind,
            primary.as_deref(),
            hue.as_deref(),
            ev,
            &out,
            width,
            height,
            params.as_deref(),
        )),
        Cmd::FitAcr {
            spec,
            render,
            acr,
            out,
        } => {
            run_or_exit((|| -> Result<i32, Box<dyn std::error::Error>> {
                // Parse `--render <path>@<ev>` entries.
                let mut entries: Vec<(PathBuf, f32)> = render
                    .iter()
                    .map(|s| {
                        let (path_str, ev_str) = s
                            .rsplit_once('@')
                            .ok_or_else(|| format!("--render value must be <path>@<ev>: {s}"))?;
                        let ev = ev_str
                            .parse::<f32>()
                            .map_err(|e| format!("invalid EV in --render {s}: {e}"))?;
                        Ok((PathBuf::from(path_str), ev))
                    })
                    .collect::<Result<Vec<_>, String>>()
                    .map_err(|e| Box::<dyn std::error::Error>::from(e))?;
                // `--acr <path>` is an alias for `--render <path>@0`.
                if let Some(acr_path) = acr {
                    entries.push((acr_path, 0.0));
                }
                if entries.is_empty() {
                    return Err(
                        "fit-acr: at least one --render <path>@<ev> or --acr <path> is required"
                            .into(),
                    );
                }
                let refs: Vec<(&Path, f32)> =
                    entries.iter().map(|(p, ev)| (p.as_path(), *ev)).collect();
                commands::fit_acr::run(&spec, &refs, &out)
            })())
        }
        Cmd::FitAuto2 { raw, report } => run_or_exit(commands::fit_auto2::run(&raw, &report)),
        Cmd::AutoTailRamp {
            raw,
            out_dir,
            width,
            height,
        } => run_or_exit(commands::auto_tail_ramp::run(&raw, &out_dir, width, height)),
        Cmd::TranscodeDcp { src, out, out_pool } => run_or_exit(commands::transcode_dcp::run(
            &src,
            &out,
            out_pool.as_deref(),
        )),
        #[cfg(feature = "pano")]
        Cmd::Pano { cmd } => run_or_exit(
            commands::pano::run(cmd)
                .map(|()| 0)
                .map_err(|e| Box::<dyn std::error::Error>::from(e)),
        ),
    }
}

fn run_or_exit(r: Result<i32, Box<dyn std::error::Error>>) -> ExitCode {
    match r {
        Ok(code) => ExitCode::from(code as u8),
        Err(e) => {
            eprintln!("error: {}", e);
            ExitCode::from(1)
        }
    }
}
