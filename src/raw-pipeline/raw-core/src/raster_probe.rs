//! Header-only metadata probing for a non-RAW raster container (#3507):
//! dimensions, format, channel count, alpha, and the EXIF orientation the
//! container declares — without decoding a single pixel.
//!
//! Split out of `raster.rs` (final fix wave, item 0/4): probing is the half
//! of that file with no dependency on the resampling and decode machinery
//! in the other half, and lifting it out keeps `raster.rs` well inside the
//! file-size budget now that orientation resolution spans five containers.
//! Declared as a `#[path]` submodule of `raster` and re-exported, so
//! `raster::probe_raster_metadata` and `raster::RasterMetadata` still
//! resolve.

use super::*;

/// Metadata probed from a raster image container without decoding full pixels.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RasterMetadata {
    pub width: u32,
    pub height: u32,
    pub format: String,
    pub channels: u8,
    /// The EXIF Orientation the container's metadata declares, or `None`
    /// when it declares nothing a consumer should act on.
    ///
    /// `None` for an AVIF, always: its `irot`/`imir` is applied to the
    /// pixels during decode (see [`crate::avif_boxes`]), and libvips
    /// surfaces no orientation for a HEIF-family file even when its `Exif`
    /// item carries the tag — measured on sharp 0.34.5, `undefined` for all
    /// nine `irot`/`imir`/`Exif`-Orientation combinations, with `.rotate()`
    /// a no-op on every one (#3507 round 3). The tag itself is still
    /// reachable in the `exif` block `read_sidecars` returns.
    pub orientation: Option<u16>,
    /// Whether the container's own colour type carries an alpha channel
    /// (#3507 controller ruling). Derived from the real container header for
    /// every non-AVIF format (see [`channels_and_alpha_from_header`]); AVIF
    /// keeps its box-derived value (Task G2's `ispe`/alpha-item read).
    pub has_alpha: bool,
}

/// The EXIF Orientation a container's metadata declares, wherever it keeps
/// it: a JPEG's APP1 segment, a TIFF's own IFD0, the `eXIf`/`EXIF` chunk of
/// a PNG or WebP, or an AVIF's `Exif` item. `1` when there is none. Cheap
/// stream reads come first — only a PNG, WebP or AVIF pays for the full
/// [`crate::raster_meta::read_sidecars`] walk.
///
/// Single-sourced here for both [`probe_raster_metadata`] and
/// [`decode_raster`] (#3507 final fix wave, item 4). Before this, both read
/// only `extract_exif_orientation`, which handles a bare TIFF header and a
/// JPEG APP1 and nothing else — so `.rotate()`/`autoOrient` was a silent
/// no-op on exactly the containers this PR set out to fix (measured against
/// sharp on a 24×16 source with orientation 6: sharp rotated all four
/// containers to 16×24, Maple only the JPEG).
///
/// `None` means the container declares nothing a consumer should act on: no
/// EXIF block at all, or a block whose IFD0 has no Orientation entry. That
/// is the distinction sharp reports as `undefined` rather than `1` — see
/// [`probe_raster_metadata`]'s TIFF exception (#3507 round 4).
///
/// An AVIF is always `None`, whatever its `Exif` item says. Its
/// `irot`/`imir` is a transform of the pixels, baked in at decode, and
/// libvips surfaces no orientation for a HEIF-family file even when the
/// item carries the tag (#3507 rounds 3-5, measured). Anything that acts on
/// an orientation must see nothing here, or it acts twice: a `.rotate()`
/// would rotate already-rotated pixels, and a `keepMetadata()` into a
/// container that states its own orientation would copy a value sharp
/// writes as 1.
pub fn container_orientation(bytes: &[u8]) -> Option<u16> {
    if is_avif(bytes) {
        return None;
    }
    extract_exif_orientation(bytes).or_else(|| {
        crate::raster_meta::read_sidecars(bytes)
            .exif
            .as_deref()
            .and_then(exif_orientation_from_block)
    })
}

/// Quick probing of raster image dimensions and format from raw bytes.
pub fn probe_raster_metadata(bytes: &[u8]) -> Result<RasterMetadata> {
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
