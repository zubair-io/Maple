//! `pano-gt-render` — synthetic ground-truth renderer for the Maple Pano
//! acceptance gates (M0a, #1119).
//!
//! Renders N virtual cameras with exactly known rotation/focal/distortion
//! from an equirectangular linear source, writing 16-bit PNG frames plus
//! `ground_truth.json` (schema: `maple_pano::gt`). Deterministic: the same
//! flags + seed produce byte-identical outputs on a given platform and
//! toolchain (cross-platform runs agree to float tolerance, not bytes).
//!
//! ```text
//! # Self-sufficient: procedural source, 6-camera ring, defaults
//! pano-gt-render --synthetic --out-dir /tmp/gt
//!
//! # From a 16-bit equirect PNG (treated as LINEAR — no sRGB decode),
//! # 8 cameras in a 2×4 grid with jitter + barrel distortion
//! pano-gt-render --input pano.png --out-dir /tmp/gt \
//!     --cameras 8 --pattern grid --rows 2 --fov-deg 50 --overlap 0.35 \
//!     --jitter-deg 1.5 --k1 -0.06 --k2 0.025 --seed 7
//! ```

use std::path::PathBuf;
use std::process::ExitCode;

use clap::{ArgGroup, Parser, ValueEnum};
use maple_pano::render::{CameraSetOptions, Pattern, RenderJob, SourceKind};

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
enum PatternArg {
    /// One row of yaws at the base pitch.
    Ring,
    /// `--rows` rows × ceil(cameras/rows) columns, centered on yaw 0.
    Grid,
}

/// Synthetic ground-truth renderer for Maple Pano (M0a).
///
/// Input images and all rendering are LINEAR light: PNG sources are
/// normalized to [0, 1] with no transfer-function decode, and the 16-bit
/// output frames are linear too.
#[derive(Debug, Parser)]
#[command(name = "pano-gt-render", version, about)]
#[command(group(ArgGroup::new("src").required(true).args(["input", "synthetic"])))]
struct Args {
    /// Output directory for frame_NNNN.png + ground_truth.json.
    #[arg(long)]
    out_dir: PathBuf,

    /// Equirectangular source PNG (16- or 8-bit; treated as linear).
    /// Must be full-sphere 2:1 (width = 2 × height).
    #[arg(long)]
    input: Option<PathBuf>,

    /// Generate a procedural equirect source instead of reading a file
    /// (smooth gradients + moderate checkers + Gaussian point features).
    #[arg(long)]
    synthetic: bool,

    /// Width of the procedural source (height = width/2). Synthetic only.
    #[arg(long, default_value_t = 2048)]
    source_width: u32,

    /// Number of cameras.
    #[arg(long, default_value_t = 6)]
    cameras: u32,

    /// Camera placement pattern.
    #[arg(long, value_enum, default_value_t = PatternArg::Ring)]
    pattern: PatternArg,

    /// Rows for the grid pattern.
    #[arg(long, default_value_t = 2)]
    rows: u32,

    /// Ring only: space cameras 360°/count apart (closed loop), ignoring
    /// --overlap.
    #[arg(long)]
    ring_full: bool,

    /// Per-camera horizontal field of view, degrees.
    #[arg(long, default_value_t = 60.0)]
    fov_deg: f64,

    /// Fraction of FOV shared between pattern neighbors (0–0.95).
    #[arg(long, default_value_t = 0.3)]
    overlap: f64,

    /// Base pitch, degrees (positive = up).
    #[arg(long, default_value_t = 0.0, allow_negative_numbers = true)]
    pitch_deg: f64,

    /// Max random per-camera rotation jitter, degrees (0 = exact pattern).
    #[arg(long, default_value_t = 0.0)]
    jitter_deg: f64,

    /// Radial distortion k1 (r² coefficient).
    #[arg(long, default_value_t = 0.0, allow_negative_numbers = true)]
    k1: f64,

    /// Radial distortion k2 (r⁴ coefficient).
    #[arg(long, default_value_t = 0.0, allow_negative_numbers = true)]
    k2: f64,

    /// Frame width in pixels.
    #[arg(long, default_value_t = 960)]
    width: u32,

    /// Frame height in pixels.
    #[arg(long, default_value_t = 720)]
    height: u32,

    /// Supersampling factor per axis: N → N×N sub-samples per pixel.
    /// The default 2 gives 2×2 = 4 samples (4× supersampling).
    #[arg(long, default_value_t = 2)]
    supersample: u32,

    /// Master seed (synthetic scene + camera jitter). Same seed + flags →
    /// byte-identical outputs on the same platform + toolchain.
    #[arg(long, default_value_t = 0)]
    seed: u64,
}

fn validate(args: &Args) -> Result<(), String> {
    if args.cameras == 0 {
        return Err("--cameras must be >= 1".into());
    }
    if !(1.0..=175.0).contains(&args.fov_deg) {
        return Err(format!(
            "--fov-deg must be in [1, 175], got {}",
            args.fov_deg
        ));
    }
    if !(0.0..=0.95).contains(&args.overlap) {
        return Err(format!(
            "--overlap must be in [0, 0.95], got {}",
            args.overlap
        ));
    }
    if args.jitter_deg < 0.0 {
        return Err("--jitter-deg must be >= 0".into());
    }
    if args.width < 8 || args.height < 8 {
        return Err("--width/--height must be >= 8".into());
    }
    if !(1..=8).contains(&args.supersample) {
        return Err(format!(
            "--supersample must be in [1, 8], got {}",
            args.supersample
        ));
    }
    if args.pattern == PatternArg::Grid {
        if args.ring_full {
            return Err("--ring-full only applies to --pattern ring".into());
        }
        if args.rows == 0 || args.rows > args.cameras {
            return Err(format!(
                "--rows must be in [1, cameras]; got rows {} with {} cameras",
                args.rows, args.cameras
            ));
        }
    }
    if args.synthetic && (args.source_width < 16 || args.source_width % 2 != 0) {
        return Err(format!(
            "--source-width must be even and >= 16, got {}",
            args.source_width
        ));
    }
    Ok(())
}

fn run(args: &Args) -> Result<(), String> {
    validate(args)?;
    let job = RenderJob {
        source: if args.synthetic {
            SourceKind::Synthetic {
                width: args.source_width,
                height: args.source_width / 2,
            }
        } else {
            SourceKind::File {
                // The `src` ArgGroup guarantees input is set when
                // --synthetic is absent.
                path: args.input.clone().expect("clap group"),
            }
        },
        set: CameraSetOptions {
            count: args.cameras,
            pattern: match args.pattern {
                PatternArg::Ring => Pattern::Ring {
                    full: args.ring_full,
                },
                PatternArg::Grid => Pattern::Grid { rows: args.rows },
            },
            fov_deg: args.fov_deg,
            overlap: args.overlap,
            pitch_deg: args.pitch_deg,
            jitter_deg: args.jitter_deg,
            k1: args.k1,
            k2: args.k2,
            width: args.width,
            height: args.height,
        },
        supersample: args.supersample,
        seed: args.seed,
    };
    let gt = maple_pano::render::run(&job, &args.out_dir, |i, frame| {
        eprintln!("rendered {}/{} {}", i + 1, args.cameras, frame);
    })
    .map_err(|e| e.to_string())?;
    println!(
        "wrote {} frames + ground_truth.json to {} (source {}x{}, seed {})",
        gt.cameras.len(),
        args.out_dir.display(),
        gt.source.width,
        gt.source.height,
        gt.render.seed,
    );
    Ok(())
}

fn main() -> ExitCode {
    let args = Args::parse();
    match run(&args) {
        Ok(()) => ExitCode::SUCCESS,
        Err(msg) => {
            eprintln!("error: {msg}");
            ExitCode::FAILURE
        }
    }
}
