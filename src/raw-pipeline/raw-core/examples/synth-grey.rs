//! Generate a synthetic grey DNG. See
//! `.archived-plans/specs/2026-04-28-synthetic-grey-dng-design.md`.
//!
//! Build:
//!   cargo build --release -p raw-core --features test-support \
//!       --example synth-grey
//!
//! Run:
//!   cargo run --release -p raw-core --features test-support \
//!       --example synth-grey -- --value 0.18 --out /tmp/grey.dng

use clap::Parser;
use raw_core::image::CfaPattern;
use raw_core::test_support::synth_dng::SyntheticGreyDng;
use std::path::PathBuf;

#[derive(Parser)]
#[command(about = "Synthesise a flat-grey Bayer DNG for pipeline neutrality tests")]
struct Args {
    /// Scene-linear neutral target after black + WB. Range 0.0-1.0.
    #[arg(long, default_value_t = 0.18)]
    value: f32,
    /// Image width in pixels (default 64).
    #[arg(long, default_value_t = 64)]
    width: u32,
    /// Image height in pixels (default 64).
    #[arg(long, default_value_t = 64)]
    height: u32,
    /// CFA pattern: rggb | bggr | grbg | gbrg.
    #[arg(long, default_value = "rggb")]
    cfa: String,
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
    let dng = SyntheticGreyDng {
        linear_value: args.value,
        width: args.width,
        height: args.height,
        cfa,
        ..Default::default()
    };
    dng.write_to(&args.out)?;
    eprintln!(
        "wrote {} ({}x{}, L={})",
        args.out.display(),
        args.width,
        args.height,
        args.value
    );
    Ok(())
}
