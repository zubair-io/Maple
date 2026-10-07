//! Shared-core export with atomic, create-only publication.
use crate::library::MediaKind;
use raw_core::{
    export::{ExportFormat, ExportOptions},
    pipeline::{self, ExportDepth, ExportPixels, RawInput},
    types::adjustment::AdjustmentModel,
    view::encode::TargetPrimaries,
};
use std::{io::Write, path::Path};

pub fn export(
    original: &Path,
    kind: MediaKind,
    model: &AdjustmentModel,
    destination: &Path,
) -> Result<(), String> {
    let film = crate::film::resolve(&model.film_look)?;
    let extension = destination
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let format = match extension.as_str() {
        "jpg" | "jpeg" => ExportFormat::Jpeg,
        "png" => ExportFormat::Png,
        "tif" | "tiff" if kind == MediaKind::Raw => ExportFormat::Tiff16,
        _ => return Err("Choose JPEG or PNG; RAW photographs also support 16-bit TIFF.".into()),
    };
    if destination.exists() || std::fs::symlink_metadata(destination).is_ok() {
        return Err("Export requires a new filename. Existing files are never overwritten.".into());
    }
    let bytes = match kind {
        MediaKind::Raw => {
            let raw = raw_core::decode::decode(original).map_err(|e| e.to_string())?;
            raw_core::export::export_from_raw_with_film(
                &raw,
                model,
                Some(RawInput::Path(original)),
                &ExportOptions {
                    format,
                    quality: 95,
                    target: TargetPrimaries::Srgb,
                    max_long_edge: None,
                },
                film.as_ref().map(|film| film.lut),
            )
            .map_err(|e| e.to_string())?
            .bytes
        }
        MediaKind::Raster => {
            let source = std::fs::read(original).map_err(|e| e.to_string())?;
            let (w, h, pixels) = pipeline::render_export_raster(
                &source,
                model,
                None,
                TargetPrimaries::Srgb,
                ExportDepth::Eight,
                film.as_ref().map(|film| film.lut),
            )
            .map_err(|e| e.to_string())?;
            let ExportPixels::Eight(rgb) = pixels else {
                unreachable!("eight-bit export")
            };
            let raster = raw_core::raster::RasterImage::new_rgb(w, h, rgb);
            raw_core::export::encode_raster(&raster, format, 95).map_err(|e| e.to_string())?
        }
    };
    let parent = destination
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let mut file = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    file.write_all(&bytes).map_err(|e| e.to_string())?;
    file.as_file().sync_all().map_err(|e| e.to_string())?;
    file.persist_noclobber(destination)
        .map_err(|e| e.to_string())?;
    std::fs::File::open(parent)
        .and_then(|f| f.sync_all())
        .map_err(|e| format!("Export was created, but directory sync failed: {e}"))
}
