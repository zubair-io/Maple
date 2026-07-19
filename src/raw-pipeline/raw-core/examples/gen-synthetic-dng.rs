//! Generate a large synthetic Bayer DNG with NO OpcodeList3 for the
//! native-detail 1:1-zoom perf bench (#2114).
//!
//! The 100MP color reference `test_0000.DNG` (Hasselblad L3D-100c) carries an
//! OpcodeList3 (GainMap / WarpRectilinear), which the tile develop chain
//! refuses (#1932) — so a 1:1 zoom on it falls back to the whole-image render
//! and the native-detail develop can't be profiled. This emits a same-scale
//! (~100MP) DNG that carries no OpcodeList3, so the tile path actually runs.
//!
//! The output goes under `test-fixtures/raws/` (gitignored — never committed);
//! this generator plus the `NativeDetailPerfTests` Swift bench are the
//! committed artifacts. The bench skip-passes when the fixture is absent.
//!
//! Build:
//!   cargo build --release -p raw-core --features test-support \
//!       --example gen-synthetic-dng
//!
//! Run (defaults to 12288×8192 = 100.7 MP, matching the L3D-100c):
//!   cargo run --release -p raw-core --features test-support \
//!       --example gen-synthetic-dng -- \
//!       --out test-fixtures/raws/synthetic-100mp-noopcode.dng
//!
//!   # Smaller, for a quick smoke test:
//!   cargo run ... -- --width 4096 --height 2731 --out /tmp/small.dng

use clap::Parser;
use raw_core::image::CfaPattern;
use raw_core::test_support::synth_perf::{SyntheticPerfDng, DEFAULT_HEIGHT, DEFAULT_WIDTH};
use std::path::PathBuf;

#[derive(Parser)]
#[command(
    about = "Synthesise a large textured Bayer DNG with NO OpcodeList3 for the \
             native-detail 1:1-zoom perf bench (#2114)"
)]
struct Args {
    /// Image width in pixels. Default 12288 (Hasselblad L3D-100c width).
    #[arg(long, default_value_t = DEFAULT_WIDTH)]
    width: u32,
    /// Image height in pixels. Default 8192 (Hasselblad L3D-100c height).
    #[arg(long, default_value_t = DEFAULT_HEIGHT)]
    height: u32,
    /// CFA pattern: rggb | bggr | grbg | gbrg. Default rggb.
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
    let dng = SyntheticPerfDng {
        width: args.width,
        height: args.height,
        cfa,
    };
    dng.write_to(&args.out)?;
    let mp = (args.width as f64) * (args.height as f64) / 1e6;
    eprintln!(
        "wrote {} ({}x{}, {:.1} MP, no OpcodeList3)",
        args.out.display(),
        args.width,
        args.height,
        mp
    );
    Ok(())
}
