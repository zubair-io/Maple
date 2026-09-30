//! File-backed counterpart of raster_probe. Use the same decoders and TIFF
//! fallback, with direct seekable JPEG/AVIF header readers where image's
//! wrappers would otherwise buffer encoded pixels (#3620).

use super::*;
use crate::metadata_source::SeekableSource;
use std::io::{BufRead, Read, Seek, SeekFrom};

fn io_error(source: std::io::Error) -> Error {
    Error::Io {
        path: "<metadata>".into(),
        source,
    }
}

/// Probe from the start of a seekable stream without buffering encoded pixels.
/// Wrap a File in BufReader; the stream's final position is unspecified.
pub fn probe_raster_metadata_reader<R: BufRead + Seek>(reader: &mut R) -> Result<RasterMetadata> {
    reader.seek(SeekFrom::Start(0)).map_err(io_error)?;
    let mut header = Vec::new();
    reader
        .by_ref()
        .take(32)
        .read_to_end(&mut header)
        .map_err(io_error)?;
    reader.seek(SeekFrom::Start(0)).map_err(io_error)?;
    if is_avif(&header) {
        let probe = avif_decode_gate::probe_reader(reader)?;
        let source = SeekableSource::new(reader).map_err(io_error)?;
        let transform = crate::avif_boxes::read_avif_boxes_source(&source).transform;
        source.finish(()).map_err(io_error)?;
        let (width, height) = match transform {
            5..=8 => (probe.height, probe.width),
            _ => (probe.width, probe.height),
        };
        return Ok(RasterMetadata {
            width,
            height,
            format: "avif".into(),
            channels: if probe.has_alpha { 4 } else { 3 },
            orientation: None,
            has_alpha: probe.has_alpha,
        });
    }
    let image_reader = ImageReader::new(&mut *reader)
        .with_guessed_format()
        .map_err(|e| Error::Decode {
            path: "<memory>".into(),
            reason: format!("failed to probe image format: {e}"),
        })?;
    let format = match image_reader.format() {
        Some(image::ImageFormat::Jpeg) => "jpeg",
        Some(image::ImageFormat::Png) => "png",
        Some(image::ImageFormat::WebP) => "webp",
        Some(image::ImageFormat::Tiff) => "tiff",
        Some(image::ImageFormat::Avif) => "avif",
        Some(other) => return Err(Error::UnsupportedFormat(format!("{other:?}"))),
        None => return Err(Error::UnsupportedFormat("unknown image format".into())),
    };
    let facts = if format == "jpeg" {
        drop(image_reader);
        raster_probe_jpeg::headers(&mut *reader).map_err(io_error)?
    } else {
        let decoder = match image_reader.into_decoder() {
            Ok(decoder) => Some(decoder),
            Err(image::ImageError::IoError(error))
                if error.kind() != std::io::ErrorKind::UnexpectedEof =>
            {
                return Err(io_error(error))
            }
            Err(_) => None,
        };
        decoder.map(|decoder| {
            let (width, height) = decoder.dimensions();
            let color = decoder.color_type();
            (width, height, color.channel_count(), color.has_alpha())
        })
    };
    let source = SeekableSource::new(reader).map_err(io_error)?;
    let tiff = if format == "tiff" || facts.is_none() {
        parse_tiff_dimensions(&source)
    } else {
        None
    };
    let declared = raster_probe::container_orientation_source(&source);
    source.finish(()).map_err(io_error)?;
    let (width, height, channels, has_alpha) = match facts {
        Some(facts) => facts,
        None => {
            let (width, height, _) = tiff.ok_or_else(|| Error::Decode {
                path: "<memory>".into(),
                reason: "failed to read image dimensions".into(),
            })?;
            (width, height, 3, false)
        }
    };
    let final_format = if format == "tiff" || facts.is_none() {
        if tiff.is_some_and(|(_, _, dng)| dng) {
            "dng"
        } else {
            "tiff"
        }
    } else {
        format
    };
    let orientation = match final_format {
        "tiff" | "dng" => Some(declared.unwrap_or(1)),
        _ => declared,
    };
    Ok(RasterMetadata {
        width,
        height,
        format: final_format.into(),
        channels,
        orientation,
        has_alpha,
    })
}
