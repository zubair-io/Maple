//! Generate a synthetic ColorChecker or dense sweep DNG (#1521, #1719).
//!
//! Build:
//!   cargo build --release -p raw-core --features test-support \
//!       --example synth-chart
//!
//! Run:
//!   # Macbeth 24-patch chart (default):
//!   cargo run --release -p raw-core --features test-support \
//!       --example synth-chart -- --out /tmp/chart.dng
//!
//!   # Dense 3072-patch ACR sweep chart:
//!   cargo run --release -p raw-core --features test-support \
//!       --example synth-chart -- --chart sweep --out /tmp/sweep.dng \
//!       --dump-spec /tmp/sweep.spec.json
//!
//!   # Camera-encoded Macbeth chart (test_0019, Canon 5D IV DCP):
//!   cargo run ... -- --encoding camera --out /tmp/chart_camera.dng
//!
//!   # Larger Macbeth patches for comfortable on-screen inspection:
//!   cargo run ... -- --patch-size 128 --guard 16 --out /tmp/chart.dng

use clap::Parser;
use raw_core::image::CfaPattern;
use raw_core::test_support::synth_chart::{ChartEncoding, SyntheticColorChart};
use raw_core::test_support::synth_sweep::SyntheticSweepChart;
use std::path::PathBuf;

/// Which chart generator to use.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ChartKind {
    Macbeth,
    Sweep,
}

impl std::str::FromStr for ChartKind {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "macbeth" => Ok(ChartKind::Macbeth),
            "sweep" => Ok(ChartKind::Sweep),
            other => Err(format!("unknown chart kind '{}': use macbeth|sweep", other)),
        }
    }
}

#[derive(Parser)]
#[command(about = "Synthesise a ColorChecker or dense sweep Bayer DNG for color-pipeline tests")]
struct Args {
    /// Which chart to generate: macbeth (24-patch ColorChecker) or sweep
    /// (3072-patch dense ACR sweep grid). Default: macbeth.
    #[arg(long, default_value = "macbeth")]
    chart: ChartKind,

    // ── macbeth-only options ──────────────────────────────────────────────────
    /// Pixel size of each patch (default 32). Macbeth only.
    #[arg(long, default_value_t = 32)]
    patch_size: u32,
    /// Guard band between patches in pixels (default 8). Macbeth only.
    #[arg(long, default_value_t = 8)]
    guard: u32,
    /// CFA pattern: rggb | bggr | grbg | gbrg. Macbeth only.
    #[arg(long, default_value = "rggb")]
    cfa: String,
    /// Raw value encoding: rec2020 (default) or camera (Canon 5D IV DCP).
    /// Macbeth only.
    #[arg(long, default_value = "rec2020")]
    encoding: String,

    // ── sweep-only options ────────────────────────────────────────────────────
    /// When generating a sweep chart, also write the patch spec to this path
    /// as a JSON array. Sweep only.
    #[arg(long)]
    dump_spec: Option<PathBuf>,

    // ── shared ───────────────────────────────────────────────────────────────
    /// Output DNG path.
    #[arg(long)]
    out: PathBuf,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = Args::parse();

    match args.chart {
        ChartKind::Macbeth => run_macbeth(&args),
        ChartKind::Sweep => run_sweep(&args),
    }
}

fn run_macbeth(args: &Args) -> Result<(), Box<dyn std::error::Error>> {
    let cfa = match args.cfa.to_lowercase().as_str() {
        "rggb" => CfaPattern::Rggb,
        "bggr" => CfaPattern::Bggr,
        "grbg" => CfaPattern::Grbg,
        "gbrg" => CfaPattern::Gbrg,
        other => return Err(format!("unknown cfa '{}': use rggb|bggr|grbg|gbrg", other).into()),
    };
    let encoding = match args.encoding.to_lowercase().as_str() {
        "rec2020" => ChartEncoding::Rec2020,
        "camera" => ChartEncoding::Camera,
        other => return Err(format!("unknown encoding '{}': use rec2020|camera", other).into()),
    };
    let chart = SyntheticColorChart {
        patch_size: args.patch_size,
        guard: args.guard,
        cfa,
        encoding,
        ..Default::default()
    };
    chart.write_to(&args.out)?;
    eprintln!(
        "wrote {} ({}x{}, 24 patches, {}px each)",
        args.out.display(),
        chart.width(),
        chart.height(),
        args.patch_size
    );
    Ok(())
}

fn run_sweep(args: &Args) -> Result<(), Box<dyn std::error::Error>> {
    let chart = SyntheticSweepChart::new();
    chart.write_to(&args.out)?;
    eprintln!(
        "wrote {} ({}x{}, 3072 patches)",
        args.out.display(),
        chart.width(),
        chart.height(),
    );

    if let Some(ref spec_path) = args.dump_spec {
        let json = chart.spec_to_json();
        std::fs::write(spec_path, &json)?;
        eprintln!("wrote spec to {}", spec_path.display());
    }
    Ok(())
}
