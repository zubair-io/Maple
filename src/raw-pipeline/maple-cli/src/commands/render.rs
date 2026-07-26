//! `maple-cli render` — render one RAW + XMP to a PNG / JPEG / TIFF.
//!
//! Also exposes the small I/O helpers that wrap `raw_core::pipeline` so the
//! `batch` command can reuse `run` directly (keeping batch a true superset of
//! render — same defaults, same view tail).

use raw_core::decode::decode_bytes;
use raw_core::pipeline::{render_from_raw_with_quality_and_source, RawInput, RenderQuality};
use raw_core::xmp;
use std::path::Path;

use super::types::{DemosaicChoice, OutputFormat, ProfileChoice};

/// Shell helper: read a RAW from disk, then run the pure raw-core pipeline.
/// Keeps I/O out of `raw-core` per spec §02 "The core is side-effect-free."
///
/// Passes `raw_path` through so the view tail can read the embedded JPEG
/// for `Profile::Auto` (Auto Profile, #537). Other profiles ignore it.
pub(super) fn render_path(
    raw_path: &Path,
    model: &xmp::AdjustmentModel,
) -> Result<(u32, u32, Vec<u8>), Box<dyn std::error::Error>> {
    let bytes = std::fs::read(raw_path)?;
    let ext = raw_path.extension().and_then(|e| e.to_str()).unwrap_or("");
    let raw = decode_bytes(&bytes, ext)?;
    Ok(render_from_raw_with_quality_and_source(
        &raw,
        model,
        RenderQuality::Full,
        Some(RawInput::Path(raw_path)),
    )?)
}

/// Variant of `render_path` that lets the caller override `RenderQuality`.
/// Used by `run` when `--demosaic amaze` (or `full` / `preview`) is
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
    Ok(render_from_raw_with_quality_and_source(
        &raw,
        model,
        quality,
        Some(RawInput::Path(raw_path)),
    )?)
}

/// Shell helper: write a buffer to disk.
fn write_bytes(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    std::fs::write(path, bytes)
}

pub(super) fn infer_format(out: &Path) -> OutputFormat {
    match out
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_lowercase)
        .as_deref()
    {
        Some("jpg" | "jpeg") => OutputFormat::Jpeg,
        Some("tif" | "tiff") => OutputFormat::Tiff,
        _ => OutputFormat::Png,
    }
}

pub fn run(
    raw: &Path,
    params: Option<&Path>,
    out: &Path,
    format: Option<OutputFormat>,
    quality: u8,
    demosaic: DemosaicChoice,
    profile: ProfileChoice,
) -> Result<i32, Box<dyn std::error::Error>> {
    let mut model = match params {
        Some(p) => xmp::parse(&std::fs::read_to_string(p)?)?,
        None => xmp::AdjustmentModel::default(),
    };
    // CLI override for Auto Profile (#537). `Xmp` honours the sidecar;
    // `Neutral` pins the view transform for the color-parity harness;
    // `Auto` is exposed for symmetry / spot-checks.
    match profile {
        ProfileChoice::Xmp => {}
        ProfileChoice::Auto => model.profile = raw_core::types::adjustment::Profile::Auto,
        ProfileChoice::Neutral => model.profile = raw_core::types::adjustment::Profile::Neutral,
    }
    // `DemosaicChoice::Full` (the default) routes through `render_path`
    // for byte-for-byte identity with the historical entry the parity
    // harnesses depend on. Non-default choices route through the
    // quality-aware entry. `render_from_raw` itself dispatches to
    // `render_from_raw_with_quality(_, _, RenderQuality::Full)` so the
    // two paths produce the same bytes when `demosaic == Full`, but we
    // keep the dispatch explicit to make the harness invariant obvious.
    let (w, h, bytes) = match demosaic {
        DemosaicChoice::Full => render_path(raw, &model)?,
        other => render_path_with_quality(raw, &model, other.into())?,
    };
    let fmt = format.unwrap_or_else(|| infer_format(out));
    let encoded = match fmt {
        OutputFormat::Png => raw_core::png::encode(w, h, &bytes)?,
        OutputFormat::Jpeg => raw_core::jpeg::encode(w, h, &bytes, quality)?,
        OutputFormat::Tiff => raw_core::tiff::encode_from_u8(w, h, &bytes)?,
    };
    write_bytes(out, &encoded)?;
    Ok(0)
}
