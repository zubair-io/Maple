use clap::{Parser, Subcommand, ValueEnum};
use raw_core::decode::decode_bytes;
use raw_core::pipeline::{render_from_raw, render_from_raw_with_quality, render_from_scene_linear, render_from_scene_linear_with_chain, RenderQuality};
use raw_core::synthetic_input::{halo_disk, hue_patch, neutral_ramp, Primary};
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

/// Variant of `render_path` that lets the caller override `RenderQuality`.
/// Used by `do_render` when `--demosaic amaze` (or `full` / `preview`) is
/// passed on the CLI; the default `--demosaic full` matches `render_path`'s
/// behaviour, so existing harnesses (`test_color_pipeline.sh`,
/// `calibrate_color_pipeline.sh`) are unaffected.
fn render_path_with_quality(
    raw_path: &Path,
    model: &xmp::AdjustmentModel,
    quality: RenderQuality,
) -> Result<(u32, u32, Vec<u8>), Box<dyn std::error::Error>> {
    let bytes = std::fs::read(raw_path)?;
    let ext = raw_path.extension().and_then(|e| e.to_str()).unwrap_or("");
    let raw = decode_bytes(&bytes, ext)?;
    Ok(render_from_raw_with_quality(&raw, model, quality)?)
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

/// Demosaic / `RenderQuality` choice exposed on the CLI. `Full` is the
/// default and matches the historical `maple-cli render` behaviour
/// (Hamilton-Adams when compiled with `high-quality-demosaic`, bilinear
/// otherwise) — the parity harnesses depend on this default. `Amaze`
/// switches to the AMaZE demosaic for finer-detail / moiré-resistant
/// renders. `Preview` exists for symmetry with the FFI/tile path so a
/// user can generate a half-res candidate from the CLI.
#[derive(ValueEnum, Clone, Copy, Debug)]
enum DemosaicChoice {
    Preview,
    Full,
    Amaze,
}

/// Synthetic-input kind exposed by `maple-cli synthetic`. Each kind picks
/// one of the `raw_core::synthetic_input::*` generators and feeds the
/// resulting scene-linear `Image` through the view transform (or the
/// slider chain, when `--params` is supplied).
#[derive(ValueEnum, Clone, Copy, Debug)]
enum SyntheticKind {
    NeutralRamp,
    HuePatch,
    HaloDisk,
}

impl From<DemosaicChoice> for RenderQuality {
    fn from(c: DemosaicChoice) -> Self {
        match c {
            DemosaicChoice::Preview => RenderQuality::Preview,
            DemosaicChoice::Full    => RenderQuality::Full,
            DemosaicChoice::Amaze   => RenderQuality::Amaze,
        }
    }
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
    Inspect {
        path: PathBuf,
    },
    /// Render a single source-pixel tile to a PNG. Validates the FFI tile
    /// math without UI. Output is sRGB after CPU AgX + Rec.2020->sRGB
    /// (matches the legacy display-encoded path so the result is viewable
    /// directly in Preview.app).
    Tile {
        raw: PathBuf,
        #[arg(long)]
        params: Option<PathBuf>,
        #[arg(long = "src-x")] src_x: u32,
        #[arg(long = "src-y")] src_y: u32,
        #[arg(long = "src-w")] src_w: u32,
        #[arg(long = "src-h")] src_h: u32,
        #[arg(long = "out-w")] out_w: u32,
        #[arg(long = "out-h")] out_h: u32,
        #[arg(long)] out: PathBuf,
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
        Cmd::Render { raw, params, out, format, quality, demosaic } => run_or_exit(do_render(&raw, params.as_deref(), &out, format, quality, demosaic)),
        Cmd::Batch { manifest, out_dir, cases_filter } => {
            run_or_exit(do_batch(&manifest, &out_dir, cases_filter.as_deref()))
        }
        Cmd::Diff { candidate, reference, budget } => {
            run_or_exit(do_diff(&candidate, &reference, budget))
        }
        Cmd::Inspect { path } => run_or_exit(do_inspect(&path)),
        Cmd::Tile { raw, params, src_x, src_y, src_w, src_h, out_w, out_h, out, quality } => {
            run_or_exit(do_tile(&raw, params.as_deref(), src_x, src_y, src_w, src_h, out_w, out_h, &out, &quality))
        }
        Cmd::Synthetic { kind, primary, ev, out, width, height, params } => {
            run_or_exit(do_synthetic(kind, primary.as_deref(), ev, &out, width, height, params.as_deref()))
        }
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
    demosaic: DemosaicChoice,
) -> Result<i32, Box<dyn std::error::Error>> {
    let model = match params {
        Some(p) => xmp::parse(&std::fs::read_to_string(p)?)?,
        None => xmp::AdjustmentModel::default(),
    };
    // `DemosaicChoice::Full` (the default) routes through `render_path`
    // for byte-for-byte identity with the historical entry the parity
    // harnesses depend on. Non-default choices route through the
    // quality-aware entry. `render_from_raw` itself dispatches to
    // `render_from_raw_with_quality(_, _, RenderQuality::Full)` so the
    // two paths produce the same bytes when `demosaic == Full`, but we
    // keep the dispatch explicit to make the harness invariant obvious.
    let (w, h, bytes) = match demosaic {
        DemosaicChoice::Full => render_path(raw, &model)?,
        other                => render_path_with_quality(raw, &model, other.into())?,
    };
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
        match do_render(&case.raw, Some(&case.xmp), &out_png, None, 92, DemosaicChoice::Full) {
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

/// Render one source-pixel tile to a viewable PNG. Validates the FFI tile
/// math without UI. The fp16 RGBA returned by the tile entry goes through
/// the legacy CPU view tail (AgX + Rec.2020→sRGB + quantize) so the
/// resulting PNG is directly viewable in Preview.app — this is a sanity
/// check, not a parity gate.
#[allow(clippy::too_many_arguments)]
fn do_tile(
    raw: &Path, params: Option<&Path>,
    src_x: u32, src_y: u32, src_w: u32, src_h: u32,
    out_w: u32, out_h: u32, out: &Path, quality: &str,
) -> Result<i32, Box<dyn std::error::Error>> {
    use raw_core::pipeline::{render_scene_linear_tile_from_raw_with_quality, RenderQuality};
    let model = match params {
        Some(p) => xmp::parse(&std::fs::read_to_string(p)?)?,
        None => xmp::AdjustmentModel::default(),
    };
    let bytes = std::fs::read(raw)?;
    let ext = raw.extension().and_then(|e| e.to_str()).unwrap_or("");
    let raw_img = decode_bytes(&bytes, ext)?;
    let q = match quality {
        "preview" => RenderQuality::Preview,
        "full"    => RenderQuality::Full,
        "amaze"   => RenderQuality::Amaze,
        other     => return Err(format!(
            "invalid quality '{}': use 'preview', 'full', or 'amaze'", other).into()),
    };
    let (w, h, fp16) = render_scene_linear_tile_from_raw_with_quality(
        &raw_img, &model, src_x, src_y, src_w, src_h, out_w, out_h, q,
    )?;
    // Decode fp16 → f32, build an Image, run the legacy view tail (AgX +
    // Rec.2020→sRGB + quantize) so we can write a viewable PNG.
    let mut img = raw_core::image::Image::new(w, h, raw_core::image::ColorSpace::SceneLinearRec2020);
    for (i, p) in img.pixels.iter_mut().enumerate() {
        let r = decode_fp16(fp16[i * 4]);
        let g = decode_fp16(fp16[i * 4 + 1]);
        let b = decode_fp16(fp16[i * 4 + 2]);
        *p = [r, g, b];
    }
    raw_core::view::agx::apply(&mut img, model.contrast);
    raw_core::view::encode::rec2020_to_srgb(&mut img);
    let u8_bytes = raw_core::view::encode::quantize_u8(&mut img);
    // DisplayLookCurve (#371) was retired in #443 — see `render_from_raw_*`.
    let png = raw_core::png::encode(w, h, &u8_bytes)?;
    std::fs::write(out, png)?;
    Ok(0)
}

/// Render a synthetic scene-linear input through the view transform (or
/// the slider chain when `params` is set). The image is generated in-Rust
/// per the `--kind` flag — no committed binaries needed. `MAPLE_STAGE_DUMP`
/// applies the same as on a real-raw render.
fn do_synthetic(
    kind: SyntheticKind,
    primary: Option<&str>,
    ev: f32,
    out: &Path,
    width: Option<u32>,
    height: Option<u32>,
    params: Option<&Path>,
) -> Result<i32, Box<dyn std::error::Error>> {
    let model = match params {
        Some(p) => xmp::parse(&std::fs::read_to_string(p)?)?,
        None => xmp::AdjustmentModel::default(),
    };

    // Per-kind defaults give the detectors enough resolution to be
    // useful without wasting time on huge buffers.
    let (default_w, default_h) = match kind {
        SyntheticKind::NeutralRamp => (1024u32, 8u32),
        SyntheticKind::HuePatch    => (64u32, 64u32),
        SyntheticKind::HaloDisk    => (256u32, 256u32),
    };
    let w = width.unwrap_or(default_w);
    let h = height.unwrap_or(default_h);

    // Validate against each kind's minimum dimensions BEFORE calling the
    // generator — otherwise raw_core::synthetic_input::* panics on failed
    // assertions (the generators use `assert!`, which fires in both debug
    // and release builds) and leaves the user with a stack trace instead of
    // a CLI error. Constraints mirror the asserts in synthetic_input.rs.
    let (min_w, min_h) = match kind {
        SyntheticKind::NeutralRamp => (2u32, 1u32),
        SyntheticKind::HuePatch    => (1u32, 1u32),
        SyntheticKind::HaloDisk    => (4u32, 4u32),
    };
    if w < min_w || h < min_h {
        return Err(format!(
            "--kind {:?}: width must be >= {} and height must be >= {} (got {}x{})",
            kind, min_w, min_h, w, h,
        ).into());
    }

    let image = match kind {
        SyntheticKind::NeutralRamp => neutral_ramp(w, h),
        SyntheticKind::HuePatch => {
            let letter = primary
                .ok_or("--primary is required for --kind hue-patch")?;
            let p = Primary::from_letter(letter).ok_or_else(|| {
                format!("--primary '{}' not recognised — use r/g/b/c/m/y", letter)
            })?;
            hue_patch(p, ev, w, h)
        }
        SyntheticKind::HaloDisk => halo_disk(w, h),
    };

    // With `--params`, run the slider chain so clarity / dehaze etc.
    // take effect — needed by the halo detector to compare
    // clarity=+100 / dehaze=+100 against a clean control. Without
    // `--params`, only AgX + sRGB encode run (the cheap path for
    // banding / hue-stability detectors that don't care about the
    // slider stages).
    let (w_out, h_out, bytes) = if params.is_some() {
        render_from_scene_linear_with_chain(image, &model)?
    } else {
        render_from_scene_linear(image, &model)?
    };
    let png = raw_core::png::encode(w_out, h_out, &bytes)?;
    if let Some(parent) = out.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
        }
    }
    std::fs::write(out, png)?;
    Ok(0)
}

/// Local fp16 → f32 decoder for the CLI tile path. Mirrors the inverse of
/// `pipeline::f32_to_f16_bits`.
fn decode_fp16(bits: u16) -> f32 {
    let sign = ((bits & 0x8000) as u32) << 16;
    let exp = ((bits & 0x7c00) >> 10) as u32;
    let mant = (bits & 0x03ff) as u32;
    if exp == 0 && mant == 0 {
        return f32::from_bits(sign);
    }
    if exp == 0 {
        // Subnormal — find the leading 1 and re-bias.
        let mut e: i32 = -14;
        let mut m = mant;
        while (m & 0x0400) == 0 {
            m <<= 1;
            e -= 1;
        }
        m &= 0x03ff;
        let f = sign | (((127 + e) as u32) << 23) | (m << 13);
        return f32::from_bits(f);
    }
    if exp == 0x1f {
        return f32::from_bits(sign | 0x7f800000 | (mant << 13));
    }
    let e = (exp + 127 - 15) << 23;
    f32::from_bits(sign | e | (mant << 13))
}
