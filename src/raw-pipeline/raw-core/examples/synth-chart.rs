//! Generate a synthetic 24-patch ColorChecker DNG (#1521) — the RAW analog of
//! `tools/sanity-checks/make_color_target.py`. The known scene-linear Rec.2020
//! colors (see `test_support::colorchecker`) survive the full RAW pipeline up
//! to a single global exposure gain, so the file is a controlled known-color
//! input: open it in Maple to inspect color + sliders on the RAW path, or
//! render it headlessly and measure per-patch ΔE.
//!
//! Build:
//!   cargo build --release -p raw-core --features test-support \
//!       --example synth-chart
//!
//! Run:
//!   # Rec.2020 chart (test_0018, default):
//!   cargo run --release -p raw-core --features test-support \
//!       --example synth-chart -- --out /tmp/chart.dng
//!
//!   # Camera-encoded chart (test_0019, Canon 5D IV DCP):
//!   cargo run --release -p raw-core --features test-support \
//!       --example synth-chart -- --encoding camera --out /tmp/chart_camera.dng
//!
//!   # Larger patches for comfortable on-screen inspection:
//!   cargo run ... -- --patch-size 128 --guard 16 --out /tmp/chart.dng

use clap::Parser;
use raw_core::image::CfaPattern;
use raw_core::test_support::synth_chart::{ChartEncoding, SyntheticColorChart};
use std::path::PathBuf;

#[derive(Parser)]
#[command(about = "Synthesise a 24-patch ColorChecker Bayer DNG for color-pipeline tests")]
struct Args {
    /// Pixel size of each patch (default 32).
    #[arg(long, default_value_t = 32)]
    patch_size: u32,
    /// Guard band between patches in pixels (default 8).
    #[arg(long, default_value_t = 8)]
    guard: u32,
    /// CFA pattern: rggb | bggr | grbg | gbrg.
    #[arg(long, default_value = "rggb")]
    cfa: String,
    /// Raw value encoding: rec2020 (default, camera space = Rec.2020) or
    /// camera (Canon EOS 5D Mark IV DCP, for test_0019).
    #[arg(long, default_value = "rec2020")]
    encoding: String,
    /// Output DNG path.
    #[arg(long)]
    out: PathBuf,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = Args::parse();
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
        other => {
            return Err(format!("unknown encoding '{}': use rec2020|camera", other).into())
        }
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
