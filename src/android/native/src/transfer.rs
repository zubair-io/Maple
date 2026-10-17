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

/// The shared folder tiers have fixed parameters, independent of a UI request.
pub fn shared_derivative(
    path: &str,
    destination: &str,
    xml: &str,
    preview: bool,
) -> Result<(), String> {
    let (edge, quality) = if preview { (1280, 70) } else { (512, 55) };
    let extension = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");
    if !needs_develop(xml)? && super::preview::is_raw(&extension.to_ascii_lowercase()) {
        if let Some(image) =
            raw_core::view::auto_profile::preview::extract_preview_display_oriented(path)
        {
            let rgb = image.thumbnail(edge, edge).to_rgb8();
            let bytes = raw_core::export::encode_raster(
                &raw_core::raster::RasterImage::new_rgb(rgb.width(), rgb.height(), rgb.into_raw()),
                raw_core::export::ExportFormat::Avif,
                quality,
            )
            .map_err(|e| e.to_string())?;
            return std::fs::write(destination, bytes).map_err(|e| e.to_string());
        }
    }
    render_encoded(
        path,
        xml,
        destination,
        Some(edge),
        raw_core::export::ExportFormat::Avif,
        quality,
    )
}

/// Probe before decode so an untrusted shared artifact cannot allocate a full RAW-sized bitmap.
pub fn cache_valid(fd: i32, edge: u32, format: &str) -> Result<bool, String> {
    Ok(cache_raster(fd, edge, format)?.is_some())
}

/// Android 10/11 cannot display AVIF. Decode the bounded derivative, not the RAW,
/// into an alpha-preserving, sRGB-tagged private PNG without applying edits again.
pub fn cache_png(fd: i32, destination: &str) -> Result<(), String> {
    let raster = cache_raster(fd, 1280, "avif")?.ok_or("Invalid shared AVIF")?;
    let bytes = raw_core::raster_encode::encode_raster_opts(
        &raster,
        &raw_core::raster_encode::RasterEncodeOptions {
            format: raw_core::export::ExportFormat::Png,
            quality: 0,
            avif_speed: 6,
            primaries: TargetPrimaries::Srgb,
        },
    )
    .map_err(|e| e.to_string())?;
    std::fs::write(destination, bytes).map_err(|e| e.to_string())
}

/// Reads at its own position over a shared descriptor, so the caller's offset never moves.
struct PositionalReader<'a> {
    file: &'a std::fs::File,
    position: u64,
    length: u64,
}

impl std::io::Read for PositionalReader<'_> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        use std::os::unix::fs::FileExt;
        let count = self.file.read_at(buffer, self.position)?;
        self.position += count as u64;
        Ok(count)
    }
}

impl std::io::Seek for PositionalReader<'_> {
    fn seek(&mut self, target: std::io::SeekFrom) -> std::io::Result<u64> {
        use std::io::SeekFrom;
        let next = match target {
            SeekFrom::Start(offset) => Some(offset),
            SeekFrom::End(delta) => self.length.checked_add_signed(delta),
            SeekFrom::Current(delta) => self.position.checked_add_signed(delta),
        }
        .ok_or_else(|| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
        self.position = next;
        Ok(next)
    }
}

/// A shared-storage document may not be reopenable by path, so this reads through the
/// caller's descriptor. Headers are probed before any payload is buffered.
fn cache_raster(
    fd: i32,
    edge: u32,
    format: &str,
) -> Result<Option<raw_core::raster::RasterImage>, String> {
    use std::io::{BufReader, Read, Seek, SeekFrom};
    use std::os::fd::BorrowedFd;
    const MAX_BYTES: u64 = 32 * 1024 * 1024;
    if fd < 0 {
        return Err("Invalid descriptor".into());
    }
    // SAFETY: the caller keeps `fd` open for the whole call; only a clone is owned here.
    let owned = unsafe { BorrowedFd::borrow_raw(fd) }
        .try_clone_to_owned()
        .map_err(|e| e.to_string())?;
    let file = std::fs::File::from(owned);
    let length = file.metadata().map_err(|e| e.to_string())?.len();
    if length == 0 || length > MAX_BYTES {
        return Ok(None);
    }
    let mut input = BufReader::new(PositionalReader {
        file: &file,
        position: 0,
        length,
    });
    let probe =
        raw_core::raster::probe_raster_metadata_reader(&mut input).map_err(|e| e.to_string())?;
    if probe.format != format
        || probe.width == 0
        || probe.height == 0
        || probe.width.max(probe.height) > edge
    {
        return Ok(None);
    }
    input.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    input
        .take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 != length {
        return Ok(None);
    }
    let decoded =
        raw_core::raster::decode_raster(&bytes, Some(format)).map_err(|e| e.to_string())?;
    Ok((decoded.width == probe.width && decoded.height == probe.height).then_some(decoded))
}

fn needs_develop(xml: &str) -> Result<bool, String> {
    if xml.is_empty() {
        return Ok(false);
    }
    let model = crate::xmp::parse(xml)?;
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
    render_encoded(
        path,
        xml,
        destination,
        edge,
        raw_core::export::ExportFormat::Jpeg,
        95,
    )
}

fn render_encoded(
    path: &str,
    xml: &str,
    destination: &str,
    edge: Option<u32>,
    format: raw_core::export::ExportFormat,
    quality: u8,
) -> Result<(), String> {
    let model = if xml.is_empty() {
        raw_core::types::AdjustmentModel::default()
    } else {
        crate::xmp::parse(xml)?
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
                format,
                quality,
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
            format,
            quality,
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

#[cfg(test)]
#[path = "shared_cache_tests.rs"]
mod shared_cache_tests;
