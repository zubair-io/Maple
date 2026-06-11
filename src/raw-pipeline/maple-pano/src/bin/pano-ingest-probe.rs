//! Ingest sanity probe (#1156).
//!
//! Points at a directory of RAW pano frames (e.g. the gitignored
//! `test-fixtures/raws/pano_01/`), fully ingests the first frame
//! (per-channel min/mean/max over the scene-linear planes, validity,
//! proxy dims), then prints the EXIF/gimbal priors table for **every**
//! frame via the cheap metadata-only pass. Build `--release` — the full
//! decode runs a 21 MP demosaic.
//!
//! ```text
//! cargo run --release -p maple-pano --bin pano-ingest-probe -- \
//!     ../../test-fixtures/raws/pano_01
//! ```

use std::path::PathBuf;
use std::process::ExitCode;

use clap::Parser;
use maple_pano::ingest::{ingest_file, proxy_to_long_edge, FramePriors};

#[derive(Parser, Debug)]
#[command(
    name = "pano-ingest-probe",
    about = "Decode pano frames via raw_core::decode_for_pano and print stats + priors"
)]
struct Args {
    /// Directory containing the RAW frames (sorted by filename).
    dir: PathBuf,

    /// Fully decode every frame (default: first frame only; priors for
    /// the rest come from the metadata-only pass).
    #[arg(long)]
    full: bool,

    /// Long-edge cap for the feature-proxy dims printout.
    #[arg(long, default_value_t = 2048)]
    proxy_long_edge: u32,
}

fn main() -> ExitCode {
    let args = Args::parse();
    let mut frames: Vec<PathBuf> = match std::fs::read_dir(&args.dir) {
        Ok(rd) => rd
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| {
                p.extension().and_then(|e| e.to_str()).is_some_and(|e| {
                    matches!(
                        e.to_ascii_lowercase().as_str(),
                        "dng" | "cr2" | "cr3" | "arw" | "nef" | "raf" | "orf" | "rw2"
                    )
                })
            })
            .collect(),
        Err(e) => {
            eprintln!("error: cannot read {}: {e}", args.dir.display());
            return ExitCode::FAILURE;
        }
    };
    frames.sort();
    if frames.is_empty() {
        eprintln!("error: no RAW frames found under {}", args.dir.display());
        return ExitCode::FAILURE;
    }
    println!("{} frames under {}", frames.len(), args.dir.display());

    // Full decode: first frame (or all with --full).
    let full_set: &[PathBuf] = if args.full { &frames } else { &frames[..1] };
    for path in full_set {
        let name = path.file_name().unwrap_or_default().to_string_lossy();
        let t0 = std::time::Instant::now();
        let frame = match ingest_file(path) {
            Ok(f) => f,
            Err(e) => {
                eprintln!("error: ingest {name}: {e}");
                return ExitCode::FAILURE;
            }
        };
        let img = &frame.image;
        println!(
            "\n[{name}] {} {} — {}x{} scene-linear Rec.2020 D65 (ingest {:.2?})",
            frame.camera_make,
            frame.camera_model,
            img.width(),
            img.height(),
            t0.elapsed(),
        );
        for (label, plane) in [("R", &img.r), ("G", &img.g), ("B", &img.b)] {
            let mut min = f32::INFINITY;
            let mut max = f32::NEG_INFINITY;
            let mut sum = 0.0f64;
            let mut nonfinite = 0usize;
            for &v in plane {
                if !v.is_finite() {
                    nonfinite += 1;
                    continue;
                }
                min = min.min(v);
                max = max.max(v);
                sum += v as f64;
            }
            println!(
                "  {label}: min {min:>9.5}  mean {:>9.5}  max {:>9.5}{}",
                sum / plane.len() as f64,
                max,
                if nonfinite > 0 {
                    format!("  [{nonfinite} NON-FINITE]")
                } else {
                    String::new()
                },
            );
        }
        println!(
            "  validity: {}/{} valid",
            img.validity.count_valid(),
            img.pixel_count()
        );
        let proxy = proxy_to_long_edge(img, args.proxy_long_edge);
        println!(
            "  proxy @ long-edge {}: {}x{}",
            args.proxy_long_edge,
            proxy.width(),
            proxy.height()
        );
    }

    // Priors table: every frame, metadata-only pass (no develop).
    println!(
        "\n{:<14} {:>11} {:>9} {:>7} {:>10} {:>9} {:>10} {:>9}",
        "frame", "dims", "focal_mm", "f35mm", "focal_px", "yaw°", "pitch°", "roll°"
    );
    for path in &frames {
        let name = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let md = std::fs::read(path)
            .map_err(|e| e.to_string())
            .and_then(|bytes| {
                let ext = path
                    .extension()
                    .and_then(|e| e.to_str())
                    .map(str::to_ascii_lowercase)
                    .unwrap_or_default();
                raw_core::read_pano_metadata(&bytes, &ext).map_err(|e| e.to_string())
            });
        match md {
            Ok(md) => {
                let p = FramePriors::from_metadata(&md);
                let opt_f32 =
                    |v: Option<f32>| v.map(|x| format!("{x:.1}")).unwrap_or_else(|| "—".into());
                let (yaw, pitch, roll) = match p.gimbal {
                    Some(g) => (
                        format!("{:+.2}", g.yaw_deg),
                        format!("{:+.2}", g.pitch_deg),
                        format!("{:+.2}", g.roll_deg),
                    ),
                    None => ("—".into(), "—".into(), "—".into()),
                };
                println!(
                    "{:<14} {:>11} {:>9} {:>7} {:>10} {:>9} {:>10} {:>9}",
                    name,
                    format!("{}x{}", md.output_dims.0, md.output_dims.1),
                    opt_f32(p.focal_mm),
                    opt_f32(p.focal_35mm_equiv),
                    p.focal_px
                        .map(|x| format!("{x:.1}"))
                        .unwrap_or_else(|| "—".into()),
                    yaw,
                    pitch,
                    roll,
                );
            }
            Err(e) => println!("{name:<14} ERROR: {e}"),
        }
    }
    ExitCode::SUCCESS
}
