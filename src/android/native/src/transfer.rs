use raw_core::{
    pipeline::{ExportDepth, ExportPixels, RawInput},
    view::encode::TargetPrimaries,
};
use std::path::Path;

pub fn thumbnail(path: &str, destination: &str, xml: &str, edge: u32) -> Result<(), String> {
    if needs_develop(xml)? {
        return render_jpeg(path, xml, destination, Some(edge));
    }
    let extension = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if super::preview::is_raw(&extension) {
        if let Some(image) =
            raw_core::view::auto_profile::preview::extract_preview_display_oriented(path)
        {
            return image
                .thumbnail(edge, edge)
                .save_with_format(destination, image::ImageFormat::Jpeg)
                .map_err(|e| e.to_string());
        }
    }
    // Raster previews must use the core's ICC-aware ingestion, not image::open
    // followed by untagged JPEG output. The RAW-without-preview fallback shares it.
    render_jpeg(path, "", destination, Some(edge))
}

fn needs_develop(xml: &str) -> Result<bool, String> {
    if xml.is_empty() {
        return Ok(false);
    }
    let model = raw_core::xmp::parse(xml).map_err(|e| e.to_string())?;
    Ok(model != raw_core::types::AdjustmentModel::default())
}

#[cfg(test)]
mod tests {
    use super::needs_develop;

    #[test]
    fn culling_sidecars_keep_the_embedded_preview_path() {
        fn xml(attributes: &str) -> String {
            format!(
                r#"<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" xmlns:papp="http://ns.justmaple.app/photo/1.0/" {attributes} /></rdf:RDF></x:xmpmeta>"#
            )
        }
        assert!(!needs_develop(&xml(r#"xmp:Rating="3.0" papp:Flag="pick" xmp:Label="Red" papp:Profile="Auto" crs:HasSettings="True" crs:ProcessVersion="11.0""#)).unwrap());
        for pixel_edit in [
            r#"crs:Exposure2012="0.5""#,
            r#"papp:Profile="Neutral""#,
            r#"crs:Temperature="6500""#,
        ] {
            assert!(needs_develop(&xml(pixel_edit)).unwrap(), "{pixel_edit}");
        }
    }
}

pub fn export(path: &str, xml: &str, destination: &str) -> Result<(), String> {
    if Path::new(destination).exists() {
        return Err("Export destination already exists".into());
    }
    render_jpeg(path, xml, destination, None)
}

fn render_jpeg(path: &str, xml: &str, destination: &str, edge: Option<u32>) -> Result<(), String> {
    let model = if xml.is_empty() {
        raw_core::types::AdjustmentModel::default()
    } else {
        raw_core::xmp::parse(xml).map_err(|e| e.to_string())?
    };
    let film = crate::film::resolve(&model.film_look)?;
    let extension = Path::new(path)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let bytes = if super::preview::is_raw(&extension) {
        let raw = raw_core::decode::decode(Path::new(path)).map_err(|e| e.to_string())?;
        raw_core::export::export_from_raw_with_film(
            &raw,
            &model,
            Some(RawInput::Path(Path::new(path))),
            &raw_core::export::ExportOptions {
                format: raw_core::export::ExportFormat::Jpeg,
                quality: 95,
                target: TargetPrimaries::Srgb,
                max_long_edge: edge,
            },
            film.map(|f| f.0),
        )
        .map_err(|e| e.to_string())?
        .bytes
    } else {
        let input = std::fs::read(path).map_err(|e| e.to_string())?;
        let (w, h, output) = raw_core::pipeline::render_export_raster(
            &input,
            &model,
            edge,
            TargetPrimaries::Srgb,
            ExportDepth::Eight,
            film.map(|f| f.0),
        )
        .map_err(|e| e.to_string())?;
        let ExportPixels::Eight(rgb) = output else {
            return Err("Unexpected export depth".into());
        };
        raw_core::export::encode_raster(
            &raw_core::raster::RasterImage::new_rgb(w, h, rgb),
            raw_core::export::ExportFormat::Jpeg,
            95,
        )
        .map_err(|e| e.to_string())?
    };
    use std::io::Write;
    let mut file = if edge.is_some() {
        std::fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(destination)
    } else {
        std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(destination)
    }
    .map_err(|e| e.to_string())?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())
}
