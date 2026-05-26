//! `maple-cli` — CLI front-end over the `raw-core` pipeline. Used by every
//! parity / detector harness (`test_color_pipeline.sh`, `test_banding.sh`,
//! `test_halo_detection.sh`, …) plus ad-hoc renders during pipeline work.
//!
//! Per #525, subcommand bodies live in `commands::<name>::run(...)`; this
//! file keeps only the clap derives, the dispatcher, and the shared
//! error-to-exit-code wrapper.

mod commands;

use clap::{Parser, Subcommand};
use std::path::PathBuf;
use std::process::ExitCode;

use commands::types::{DemosaicChoice, OutputFormat, SyntheticKind};

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
        /// Demosaic algorithm: `full` (default — Hamilton-Adams or bilinear
        /// per cargo features), `amaze` (higher-quality, slower), or
        /// `preview` (half-res quad). The default keeps the historical
        /// `maple-cli render` behaviour the parity harnesses depend on.
        #[arg(long, value_enum, default_value_t = DemosaicChoice::Full)]
        demosaic: DemosaicChoice,
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
        } => run_or_exit(commands::render::run(
            &raw,
            params.as_deref(),
            &out,
            format,
            quality,
            demosaic,
        )),
        Cmd::Batch {
            manifest,
            out_dir,
            cases_filter,
        } => run_or_exit(commands::batch::run(
            &manifest,
            &out_dir,
            cases_filter.as_deref(),
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
        Cmd::Synthetic {
            kind,
            primary,
            ev,
            out,
            width,
            height,
            params,
        } => run_or_exit(commands::synthetic::run(
            kind,
            primary.as_deref(),
            ev,
            &out,
            width,
            height,
            params.as_deref(),
        )),
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
