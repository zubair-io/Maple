//! Frozen pre-#3620 probe: an independent byte-path oracle for the seekable
//! refactor, including historical decoder failures on corrupt input.

use super::*;

/// Quick probing of raster image dimensions and format from raw bytes.
pub(crate) fn legacy_probe(bytes: &[u8]) -> Result<RasterMetadata> {
    if is_avif(bytes) {
        let probe = avif_decode_gate::probe(bytes)?;
        let boxes = crate::avif_boxes::read_avif_boxes(bytes);
        // AVIF is the one container whose reported dimensions are
        // post-transform, because its `irot`/`imir` is applied to the
        // pixels rather than carried as a flag: `ispe` states the coded
        // size, and libheif — so sharp, and so `decode_raster` — reports
        // and hands back the transformed one (measured: sharp says 16×24
        // for a 24×16 AVIF with `irot 3`, where it says 24×16 with
        // `orientation: 6` for the same image as a JPEG). Transform values
        // 5..=8 are the quarter turns, the ones that swap the axes.
        let (width, height) = match boxes.transform {
            5..=8 => (probe.height, probe.width),
            _ => (probe.width, probe.height),
        };
        return Ok(RasterMetadata {
            width,
            height,
            format: "avif".to_string(),
            channels: if probe.has_alpha { 4 } else { 3 },
            // Nothing to report: the container transform is in the pixels
            // already, and libvips does not surface a HEIF-family file's
            // `Exif` Orientation either (#3507 round 3 — measured
            // `undefined` on all nine fixtures, sharp's `.rotate()` a
            // no-op on each). Surfacing the tag here would make Maple's
            // `.rotate()` rotate a second time on any libvips-written
            // AVIF, which carries the orientation in both places.
            orientation: None,
            has_alpha: probe.has_alpha,
        });
    }

    let cursor = Cursor::new(bytes);
    let reader = ImageReader::new(cursor)
        .with_guessed_format()
        .map_err(|e| Error::Decode {
            path: "<memory>".into(),
            reason: format!("failed to probe image format: {e}"),
        })?;

    let format_str = match reader.format() {
        Some(image::ImageFormat::Jpeg) => "jpeg",
        Some(image::ImageFormat::Png) => "png",
        Some(image::ImageFormat::WebP) => "webp",
        Some(image::ImageFormat::Tiff) => "tiff",
        Some(image::ImageFormat::Avif) => "avif",
        Some(other) => return Err(Error::UnsupportedFormat(format!("{other:?}"))),
        None => return Err(Error::UnsupportedFormat("unknown image format".into())),
    };

    let (width, height, final_format) = match reader.into_dimensions() {
        Ok((w, h)) => {
            let fmt = if format_str == "tiff" {
                if let Some((_, _, is_dng)) = parse_tiff_dimensions(bytes) {
                    if is_dng {
                        "dng"
                    } else {
                        "tiff"
                    }
                } else {
                    "tiff"
                }
            } else {
                format_str
            };
            (w, h, fmt)
        }
        Err(_) => {
            if let Some((w, h, is_dng)) = parse_tiff_dimensions(bytes) {
                (w, h, if is_dng { "dng" } else { "tiff" })
            } else {
                return Err(Error::Decode {
                    path: "<memory>".into(),
                    reason: "failed to read image dimensions".into(),
                });
            }
        }
    };

    // Absent unless the container actually declares one — `undefined`, not
    // `1`, is what sharp reports for a JPEG, PNG or WebP that declares
    // nothing (measured on sharp 0.34.5 across all four: no EXIF block, and
    // an EXIF block with the Orientation entry removed, both `undefined`).
    //
    // TIFF is the exception, measured the same way: libvips' TIFF loader
    // always reports an orientation, so a TIFF with no Orientation tag
    // reads back as `1` rather than absent. A DNG is a TIFF container and
    // follows it.
    let declared = container_orientation(bytes);
    let orientation = match final_format {
        "tiff" | "dng" => Some(declared.unwrap_or(1)),
        _ => declared,
    };
    let (channels, has_alpha) = channels_and_alpha_from_header(bytes);

    Ok(RasterMetadata {
        width,
        height,
        format: final_format.into(),
        channels,
        orientation,
        has_alpha,
    })
}

/// Real channel count and alpha presence for a non-AVIF container, read
/// straight from its header (`image::ImageDecoder::color_type()`) rather
/// than assumed. #3507 controller ruling: this replaces a hard-coded
/// `channels: 3` that made `RasterMetadata` unable to ever report a real
/// alpha channel for a JPEG/PNG/TIFF/WebP source, which is a real
/// `metadata()` parity bug against sharp — measured against sharp 0.34.5,
/// see `raster_tests.rs`'s `probe_channels_and_has_alpha_match_sharp_*`
/// cases. Mirrors the header-level probe Task G4's `raster_analyze` used to
/// carry locally (now collapsed onto this field — see that module's doc).
///
/// A decoder-construction failure here — after `probe_raster_metadata`
/// already succeeded at reading dimensions above — shouldn't happen in
/// practice; falls back to `(3, false)` rather than turning an advisory
/// field probe into a hard error.
fn channels_and_alpha_from_header(bytes: &[u8]) -> (u8, bool) {
    match ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .ok()
        .and_then(|reader| reader.into_decoder().ok())
    {
        Some(decoder) => {
            let color = decoder.color_type();
            (color.channel_count(), color.has_alpha())
        }
        None => (3, false),
    }
}
