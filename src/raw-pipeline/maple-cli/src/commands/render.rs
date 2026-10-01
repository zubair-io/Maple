//! `maple-cli render` — render one RAW + XMP to a PNG / JPEG / TIFF.
//!
//! Also exposes the small I/O helpers that wrap `raw_core::pipeline` so the
//! `batch` command can reuse `run` directly (keeping batch a true superset of
//! render — same defaults, same view tail).

use raw_core::decode::decode_bytes;
use raw_core::film;
use raw_core::pipeline::{
    render_export_from_raw_with_film, render_from_raw_with_quality_source_and_film, ExportDepth,
    ExportPixels, RawInput, RenderQuality,
};
use raw_core::view::encode::TargetPrimaries;
use raw_core::xmp;
use std::path::{Path, PathBuf};

use super::render_lens;
use super::types::{DemosaicChoice, OutputFormat, PrimariesChoice, ProfileChoice};

/// Default `--film-lut-dir` value: `resources/film-luts` resolved from the
/// repo root (not the process cwd, which varies by how `maple-cli` is
/// invoked). `CARGO_MANIFEST_DIR` is baked in at compile time as
/// `<repo>/src/raw-pipeline/maple-cli`, so three `..` hops reach the root —
/// same resolution `commands::film_pack_tests` uses to find the committed
/// pack.
pub(super) fn default_film_lut_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../resources/film-luts")
}

/// Resolve `model.film_look` (a `papp:FilmLook` id, e.g.
/// `"slide_fuji_velvia_50"`) to a decoded [`film::FilmLut`] by reading
/// `<film_lut_dir>/<id>.mlut`.
///
/// `model.film_look` empty, the file missing, or the file undecodable are
/// all non-fatal: each warns to stderr and returns `None`, which callers
/// pass straight to `render_from_raw_with_quality_source_and_film` — that
/// entry treats `None` as a hard no-op render (byte-identical to no look
/// applied), never an error render.
pub(super) fn resolve_film_lut(
    model: &xmp::AdjustmentModel,
    film_lut_dir: &Path,
) -> Option<film::FilmLut> {
    if model.film_look.is_empty() {
        return None;
    }
    let path = film_lut_dir.join(format!("{}.mlut", model.film_look));
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(e) => {
            eprintln!(
                "warning: film-look {:?} not found at {} ({e}); rendering without it",
                model.film_look,
                path.display()
            );
            return None;
        }
    };
    match film::decode_mlut(&bytes) {
        Ok(lut) => Some(lut),
        Err(e) => {
            eprintln!(
                "warning: film-look {:?} at {} failed to decode ({e}); rendering without it",
                model.film_look,
                path.display()
            );
            None
        }
    }
}

/// Shell helper: read a RAW from disk, then run the pure raw-core pipeline.
/// Keeps I/O out of `raw-core` per spec §02 "The core is side-effect-free."
///
/// Passes `raw_path` through so the view tail can read the embedded JPEG
/// for `Profile::Auto` (Auto Profile, #537). Other profiles ignore it.
///
/// `film_lut: None` is byte-identical to the pre-#2683 `render_path` (see
/// `render_from_raw_with_quality_source_and_film`'s doc comment), so this
/// single entry replaces the old film-agnostic one for every caller.
pub(super) fn render_path(
    raw_path: &Path,
    model: &xmp::AdjustmentModel,
    film_lut: Option<&film::FilmLut>,
) -> Result<(u32, u32, Vec<u8>), Box<dyn std::error::Error>> {
    let bytes = std::fs::read(raw_path)?;
    let ext = raw_path.extension().and_then(|e| e.to_str()).unwrap_or("");
    let raw = decode_bytes(&bytes, ext)?;
    render_lens::report_lens_resolution(&raw, model)?;
    if let Some((saved, original)) = super::removal::prepare(&raw, &bytes, model, raw_path)? {
        return Ok(saved.render_display(
            &raw,
            &original,
            model,
            RenderQuality::Full,
            Some(RawInput::Path(raw_path)),
            None,
            film_lut,
        )?);
    }
    Ok(render_from_raw_with_quality_source_and_film(
        &raw,
        model,
        RenderQuality::Full,
        Some(RawInput::Path(raw_path)),
        film_lut,
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
    film_lut: Option<&film::FilmLut>,
) -> Result<(u32, u32, Vec<u8>), Box<dyn std::error::Error>> {
    let bytes = std::fs::read(raw_path)?;
    let ext = raw_path.extension().and_then(|e| e.to_str()).unwrap_or("");
    let raw = decode_bytes(&bytes, ext)?;
    render_lens::report_lens_resolution(&raw, model)?;
    if let Some((saved, original)) = super::removal::prepare(&raw, &bytes, model, raw_path)? {
        return Ok(saved.render_display(
            &raw,
            &original,
            model,
            quality,
            Some(RawInput::Path(raw_path)),
            None,
            film_lut,
        )?);
    }
    Ok(render_from_raw_with_quality_source_and_film(
        &raw,
        model,
        quality,
        Some(RawInput::Path(raw_path)),
        film_lut,
    )?)
}

/// Non-sRGB sibling of `render_path` / `render_path_with_quality` (#1339, P3
/// phase 3): routes through the EXPORT entry rather than the display entry,
/// because only the export entry threads a `TargetPrimaries` choice down to
/// `rec2020_to_display` (#1337). At `TargetPrimaries::Srgb` + `ExportDepth::
/// Eight` this produces byte-identical output to the display entry (both
/// share `render_display_scene`, then the same quantize + geometry tail) —
/// but that equivalence is exactly why the sRGB (default) path above stays
/// on the display entry rather than switching everything to this one: it
/// keeps the historical call untouched for the parity harnesses that depend
/// on it, and confines this new code path to the case that actually needs it.
fn render_path_with_primaries(
    raw_path: &Path,
    model: &xmp::AdjustmentModel,
    quality: RenderQuality,
    target_primaries: TargetPrimaries,
    film_lut: Option<&film::FilmLut>,
) -> Result<(u32, u32, Vec<u8>), Box<dyn std::error::Error>> {
    let bytes = std::fs::read(raw_path)?;
    let ext = raw_path.extension().and_then(|e| e.to_str()).unwrap_or("");
    let raw = decode_bytes(&bytes, ext)?;
    render_lens::report_lens_resolution(&raw, model)?;
    if let Some((saved, original)) = super::removal::prepare(&raw, &bytes, model, raw_path)? {
        let (w, h, pixels) = saved.render_export(
            &raw,
            &original,
            model,
            quality,
            Some(RawInput::Path(raw_path)),
            None,
            target_primaries,
            ExportDepth::Eight,
            film_lut,
        )?;
        let ExportPixels::Eight(rgb) = pixels else {
            unreachable!("Eight terminal returned Sixteen")
        };
        return Ok((w, h, rgb));
    }
    let (w, h, pixels) = render_export_from_raw_with_film(
        &raw,
        model,
        quality,
        Some(RawInput::Path(raw_path)),
        None,
        target_primaries,
        ExportDepth::Eight,
        film_lut,
    )?;
    let out = match pixels {
        ExportPixels::Eight(out) => out,
        ExportPixels::Sixteen(_) => unreachable!("ExportDepth::Eight always returns Eight"),
    };
    Ok((w, h, out))
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
    film_lut_dir: Option<&Path>,
    target_primaries: PrimariesChoice,
    lens: &render_lens::LensProfileArgs,
) -> Result<i32, Box<dyn std::error::Error>> {
    let mut model = match params {
        Some(p) => xmp::parse(&std::fs::read_to_string(p)?)?,
        None => xmp::AdjustmentModel::default(),
    };
    raw_core::lens_profile::set_auto_match_enabled(!lens.no_bundled_lens);
    if let Some((path, acknowledged)) = lens.selection() {
        render_lens::apply_lens_profile_selection(&mut model, path, acknowledged)?;
    }
    if let Some(choice) = lens.lens.as_deref() {
        render_lens::apply_lens_choice(&mut model, choice)?;
    }
    if render_lens::maybe_dump_warp(raw, &model, lens.lens_warp_out.as_deref())? {
        return Ok(0);
    }
    // CLI override for Auto Profile (#537). `Xmp` honours the sidecar;
    // `Neutral` pins the view transform for the color-parity harness;
    // `Auto` is exposed for symmetry / spot-checks.
    match profile {
        ProfileChoice::Xmp => {}
        ProfileChoice::Auto => model.profile = raw_core::types::adjustment::Profile::Auto,
        ProfileChoice::Neutral => model.profile = raw_core::types::adjustment::Profile::Neutral,
    }
    let resolved_lut_dir = film_lut_dir
        .map(Path::to_path_buf)
        .unwrap_or_else(default_film_lut_dir);
    let film_lut = resolve_film_lut(&model, &resolved_lut_dir);
    // `DemosaicChoice::Full` at `PrimariesChoice::Srgb` (both defaults)
    // routes through `render_path` for byte-for-byte identity with the
    // historical entry the parity harnesses depend on. Non-default
    // demosaic (still sRGB) routes through the quality-aware entry.
    // `render_from_raw` itself dispatches to
    // `render_from_raw_with_quality(_, _, RenderQuality::Full)` so the
    // two paths produce the same bytes when `demosaic == Full`, but we
    // keep the dispatch explicit to make the harness invariant obvious.
    // `PrimariesChoice::P3` (#1339) is the one case that needs a
    // DIFFERENT underlying entry (the export path — see
    // `render_path_with_primaries`), so it gets its own arm regardless of
    // `demosaic`, rather than threading primaries through the two sRGB
    // helpers and risking their byte-identity guarantee.
    let (w, h, bytes) = match (target_primaries, demosaic) {
        (PrimariesChoice::Srgb, DemosaicChoice::Full) => {
            render_path(raw, &model, film_lut.as_ref())?
        }
        (PrimariesChoice::Srgb, other) => {
            render_path_with_quality(raw, &model, other.into(), film_lut.as_ref())?
        }
        (PrimariesChoice::P3, demosaic) => render_path_with_primaries(
            raw,
            &model,
            demosaic.into(),
            target_primaries.into(),
            film_lut.as_ref(),
        )?,
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

#[cfg(test)]
#[path = "render_tests.rs"]
mod tests;
