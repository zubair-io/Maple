use clap::{Parser, Subcommand};
use raw_core::{png, render, xmp};
use std::path::PathBuf;
use std::process::ExitCode;

#[derive(Parser)]
#[command(name = "maple-cli", about = "Maple raw-pipeline reference renderer")]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Render a RAW + XMP to a PNG.
    Render {
        /// Path to the RAW file (DNG, CR2, CR3, NEF, ARW, RAF, ORF, RW2,
        /// PEF, SRW, 3FR, FFF, DCR, MOS, IIQ, MRW).
        raw: PathBuf,
        /// Path to the ACR XMP sidecar carrying the parameter set.
        /// If omitted, renders with AdjustmentModel::default().
        #[arg(long)]
        params: Option<PathBuf>,
        /// Output PNG path.
        #[arg(long)]
        out: PathBuf,
    },
    /// Stubbed in slice 1.
    Batch,
    /// Stubbed in slice 1.
    Diff,
    /// Stubbed in slice 1.
    Inspect,
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    match cli.cmd {
        Cmd::Render { raw, params, out } => match do_render(&raw, params.as_deref(), &out) {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("error: {}", e);
                ExitCode::from(1)
            }
        },
        _ => {
            eprintln!("subcommand not implemented in slice 1");
            ExitCode::from(2)
        }
    }
}

fn do_render(
    raw: &std::path::Path,
    params: Option<&std::path::Path>,
    out: &std::path::Path,
) -> Result<(), Box<dyn std::error::Error>> {
    let model = match params {
        Some(p) => {
            let xml = std::fs::read_to_string(p)?;
            xmp::parse(&xml)?
        }
        None => xmp::AdjustmentModel::default(),
    };
    let (w, h, bytes) = render(raw, &model)?;
    png::write(out, w, h, &bytes)?;
    Ok(())
}
