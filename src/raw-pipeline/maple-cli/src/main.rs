use clap::{Parser, Subcommand, ValueEnum};
use raw_core::decode::decode_bytes;
use raw_core::pipeline::render_from_raw;
use raw_core::xmp;
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};

/// Shell helper: read a RAW from disk, then run the pure raw-core pipeline.
/// Keeps I/O out of `raw-core` per spec §02 "The core is side-effect-free."
fn render_path(
    raw_path: &Path,
    model: &xmp::AdjustmentModel,
) -> Result<(u32, u32, Vec<u8>), Box<dyn std::error::Error>> {
    let bytes = std::fs::read(raw_path)?;
    let ext = raw_path.extension().and_then(|e| e.to_str()).unwrap_or("");
    let raw = decode_bytes(&bytes, ext)?;
    Ok(render_from_raw(&raw, model)?)
}

/// Shell helper: write a buffer to disk.
fn write_bytes(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    std::fs::write(path, bytes)
}

#[derive(ValueEnum, Clone, Copy, Debug)]
enum OutputFormat {
    Png,
    Jpeg,
    Tiff,
}

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
        /// Path to the ACR XMP sidecar carrying the parameter set.
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
    Inspect {
        path: PathBuf,
    },
}

#[derive(Deserialize)]
struct ManifestOutput {
    #[allow(dead_code)]
    resolution: String,
    #[allow(dead_code)]
    long_edge: u32,
    #[allow(dead_code)]
    png: PathBuf,
}

#[derive(Deserialize)]
struct ManifestCase {
    raw: PathBuf,
    xmp: PathBuf,
    name: String,
    #[allow(dead_code)]
    outputs: Vec<ManifestOutput>,
}

#[derive(Deserialize)]
struct Manifest {
    cases: Vec<ManifestCase>,
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    match cli.cmd {
        Cmd::Render { raw, params, out, format, quality } => run_or_exit(do_render(&raw, params.as_deref(), &out, format, quality)),
        Cmd::Batch { manifest, out_dir, cases_filter } => {
            run_or_exit(do_batch(&manifest, &out_dir, cases_filter.as_deref()))
        }
        Cmd::Diff { candidate, reference, budget } => {
            run_or_exit(do_diff(&candidate, &reference, budget))
        }
        Cmd::Inspect { path } => run_or_exit(do_inspect(&path)),
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

fn infer_format(out: &Path) -> OutputFormat {
    match out.extension().and_then(|e| e.to_str()).map(str::to_lowercase).as_deref() {
        Some("jpg" | "jpeg") => OutputFormat::Jpeg,
        Some("tif" | "tiff") => OutputFormat::Tiff,
        _                    => OutputFormat::Png,
    }
}

fn do_render(
    raw: &Path,
    params: Option<&Path>,
    out: &Path,
    format: Option<OutputFormat>,
    quality: u8,
) -> Result<i32, Box<dyn std::error::Error>> {
    let model = match params {
        Some(p) => xmp::parse(&std::fs::read_to_string(p)?)?,
        None => xmp::AdjustmentModel::default(),
    };
    let (w, h, bytes) = render_path(raw, &model)?;
    let fmt = format.unwrap_or_else(|| infer_format(out));
    let encoded = match fmt {
        OutputFormat::Png  => raw_core::png::encode(w, h, &bytes)?,
        OutputFormat::Jpeg => raw_core::jpeg::encode(w, h, &bytes, quality)?,
        OutputFormat::Tiff => raw_core::tiff::encode_from_u8(w, h, &bytes)?,
    };
    write_bytes(out, &encoded)?;
    Ok(0)
}

fn do_batch(
    manifest_path: &Path,
    out_dir: &Path,
    filter: Option<&str>,
) -> Result<i32, Box<dyn std::error::Error>> {
    let manifest: Manifest = serde_json::from_str(&std::fs::read_to_string(manifest_path)?)?;
    std::fs::create_dir_all(out_dir)?;
    let mut ok = 0usize;
    let mut fail = 0usize;
    for case in &manifest.cases {
        if let Some(f) = filter {
            if !case.name.contains(f) {
                continue;
            }
        }
        let flat = case.name.replace('/', "_");
        let out_png = out_dir.join(format!("{}.png", flat));
        match do_render(&case.raw, Some(&case.xmp), &out_png, None, 92) {
            Ok(_) => {
                eprintln!("ok  {}", case.name);
                ok += 1;
            }
            Err(e) => {
                eprintln!("err {}: {}", case.name, e);
                fail += 1;
            }
        }
    }
    eprintln!("batch complete: {} ok, {} failed", ok, fail);
    Ok(if fail == 0 { 0 } else { 1 })
}

fn do_diff(
    candidate: &Path,
    reference: &Path,
    budget: Option<f32>,
) -> Result<i32, Box<dyn std::error::Error>> {
    // Locate compare_images.py by walking ancestors of the current working
    // directory, then falling back to the binary's own location ancestors.
    let script = std::env::current_dir()?
        .ancestors()
        .find_map(|a| {
            let p = a.join("src/scripts/compare_images.py");
            if p.exists() { Some(p) } else { None }
        })
        .ok_or("src/scripts/compare_images.py not found in any parent directory")?;

    let output = Command::new("python3")
        .arg(&script)
        .arg(candidate)
        .arg(reference)
        .output()?;

    if !output.status.success() {
        return Err(format!(
            "compare_images.py failed: {}",
            String::from_utf8_lossy(&output.stderr)
        )
        .into());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    print!("{}", stdout);

    if let Some(b) = budget {
        // Parse mean_deltaE from the JSON without a dedicated serde target.
        let key = "\"mean_deltaE\":";
        if let Some(i) = stdout.find(key) {
            let rest = &stdout[i + key.len()..];
            let end = rest.find([',', '}']).unwrap_or(rest.len());
            let num_str = rest[..end].trim();
            if let Ok(mean) = num_str.parse::<f32>() {
                if mean > b {
                    eprintln!("diff: mean \u{0394}E {} exceeds budget {}", mean, b);
                    return Ok(1);
                }
            }
        }
    }

    Ok(0)
}

fn do_inspect(path: &Path) -> Result<i32, Box<dyn std::error::Error>> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    if ext == "xmp" {
        let xml = std::fs::read_to_string(path)?;
        let model = xmp::parse(&xml)?;
        println!("{:#?}", model);
        return Ok(0);
    }

    // Try as RAW.
    let bytes = std::fs::read(path)?;
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
    let raw = raw_core::decode::decode_bytes(&bytes, ext)?;
    println!("RAW metadata for {}", path.display());
    println!("  dimensions: {} \u{00d7} {}", raw.width, raw.height);
    println!("  CFA:        {:?}", raw.cfa);
    println!("  black:      {:?}", raw.black_level);
    println!("  white:      {}", raw.white_level);
    println!("  camera:     {} {}", raw.camera_make, raw.camera_model);
    println!("  as-shot WB: {:?}", raw.as_shot_neutral);
    println!("  as-shot CCT:{:?}", raw.as_shot_cct);
    println!("  color matrices: {} illuminants", raw.color_matrices.len());
    for (illum, _) in &raw.color_matrices {
        println!("    {:?}", illum);
    }

    Ok(0)
}
