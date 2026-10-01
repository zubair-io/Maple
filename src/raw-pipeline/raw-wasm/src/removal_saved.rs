//! Verified saved companions for retained CPU and WebGPU RAW sessions (#3955).
//! Model execution and filesystem reads stay outside rendering.
use raw_core::{
    image::RawImage,
    pipeline::{RawInput, RenderQuality, ResolvedCalibrationRemovals},
    types::accepted_removal::ContentDigest,
};

/// Ordinary entries have no companion owner. They must not claim a complete
/// RAW render while silently ignoring a persisted accepted edit.
pub(crate) fn require_no_unresolved_removals(
    model: &raw_core::xmp::AdjustmentModel,
) -> Result<(), String> {
    if model.inpaint_removals.is_empty() {
        Ok(())
    } else {
        Err("saved removal companions are required; use the verified saved renderer".into())
    }
}

pub(crate) fn prepare(
    raw: &RawImage,
    original: &ContentDigest,
    xmp: &str,
    manifest: &str,
    bytes: &[u8],
) -> Result<ResolvedCalibrationRemovals, String> {
    let model = crate::mask_registry::parse_model(Some(xmp)).map_err(|e| e.to_string())?;
    ResolvedCalibrationRemovals::prepare_bundle(
        raw,
        original,
        &model.inpaint_removals,
        manifest,
        bytes,
    )
}

fn film(bytes: &[u8]) -> Result<Option<raw_core::film::FilmLut>, String> {
    if bytes.is_empty() {
        Ok(None)
    } else {
        raw_core::film::decode_mlut(bytes)
            .map(Some)
            .map_err(|e| e.to_string())
    }
}

pub(crate) fn render(
    stack: Option<&ResolvedCalibrationRemovals>,
    raw: &RawImage,
    original: &ContentDigest,
    bytes: &[u8],
    ext: &str,
    xmp: &str,
    cap: u32,
    film_bytes: &[u8],
) -> Result<crate::native_detail::NativeDetailPatch, String> {
    let stack = stack.ok_or("saved removals have not been prepared")?;
    let model = crate::mask_registry::parse_model(Some(xmp)).map_err(|e| e.to_string())?;
    let cap =
        crate::cpu_budget::clamp_develop_long_edge(raw.width, raw.height, (cap > 0).then_some(cap));
    let film = film(film_bytes)?;
    let (w, h, rgb) = stack
        .render_display(
            raw,
            original,
            &model,
            RenderQuality::Auto,
            Some(RawInput::Bytes { bytes, ext }),
            cap,
            film.as_ref(),
        )
        .map_err(|e| e.to_string())?;
    Ok(crate::native_detail::NativeDetailPatch::from_rgb(w, h, rgb))
}

pub(crate) fn export(
    stack: Option<&ResolvedCalibrationRemovals>,
    raw: &RawImage,
    original: &ContentDigest,
    bytes: &[u8],
    ext: &str,
    xmp: &str,
    options: &str,
    film_bytes: &[u8],
) -> Result<crate::export::MapleExport, String> {
    let stack = stack.ok_or("saved removals have not been prepared")?;
    let options = raw_core::export::parse_removal_export_options(options)?;
    let format = options.format;
    crate::cpu_budget::validate_export_dimensions(raw.width, raw.height, options.max_long_edge)?;
    let model = crate::mask_registry::parse_model(Some(xmp)).map_err(|e| e.to_string())?;
    let film = film(film_bytes)?;
    let image = stack
        .export_encoded(
            raw,
            original,
            &model,
            Some(RawInput::Bytes { bytes, ext }),
            &options,
            film.as_ref(),
        )
        .map_err(|e| e.to_string())?;
    Ok(crate::export::MapleExport::from_image(image, format))
}

#[cfg(test)]
#[path = "removal_saved_tests.rs"]
mod tests;
