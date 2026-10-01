//! Verified saved companions for retained CPU and WebGPU RAW sessions (#3955).
//! Model execution and filesystem reads stay outside rendering.
use raw_core::{
    image::RawImage,
    pipeline::{RawInput, RenderQuality, ResolvedCalibrationRemovals},
    types::accepted_removal::ContentDigest,
};
use serde::Deserialize;
use std::collections::BTreeMap;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Companion {
    name: String,
    length: usize,
}

pub(crate) fn prepare(
    raw: &RawImage,
    original: &ContentDigest,
    xmp: &str,
    manifest: &str,
    bytes: &[u8],
) -> Result<ResolvedCalibrationRemovals, String> {
    let model = crate::mask_registry::parse_model(Some(xmp)).map_err(|e| e.to_string())?;
    let records = raw_core::types::inpaint::encode_removals(&model.inpaint_removals)?;
    let expected = raw_core::pipeline::removal_asset_names(&records)?;
    let entries: Vec<Companion> = serde_json::from_str(manifest).map_err(|e| e.to_string())?;
    if entries.len() != expected.len() {
        return Err("saved companion count changed".into());
    }
    let mut assets = BTreeMap::new();
    let mut offset = 0usize;
    for entry in entries {
        if !expected.contains(&entry.name) || assets.contains_key(&entry.name) {
            return Err("unexpected or duplicate saved companion name".into());
        }
        let end = offset
            .checked_add(entry.length)
            .ok_or("saved companion length overflows")?;
        let value = bytes
            .get(offset..end)
            .ok_or("saved companion bundle is truncated")?;
        assets.insert(entry.name, value.to_vec());
        offset = end;
    }
    if offset != bytes.len() {
        return Err("saved companion bundle has trailing bytes".into());
    }
    ResolvedCalibrationRemovals::prepare(raw, original, &model.inpaint_removals, &assets)
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

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ExportRequest {
    format: String,
    quality: u8,
    color_space: String,
    max_long_edge: u32,
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
    let request: ExportRequest = serde_json::from_str(options).map_err(|e| e.to_string())?;
    let format = raw_core::export::ExportFormat::from_str(&request.format)
        .ok_or("unsupported export format")?;
    let cap = (request.max_long_edge > 0).then_some(request.max_long_edge);
    crate::cpu_budget::validate_export_dimensions(raw.width, raw.height, cap)?;
    let options = raw_core::export::ExportOptions {
        format,
        quality: request.quality,
        max_long_edge: cap,
        target: match request.color_space.as_str() {
            "srgb" => raw_core::view::encode::TargetPrimaries::Srgb,
            "display-p3" => raw_core::view::encode::TargetPrimaries::P3,
            _ => return Err("unsupported export colour space".into()),
        },
    };
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
