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
    /// every non-AVIF format; AVIF reads the alpha item relationship from
    /// the container and dimensions from the AV1 sequence header.
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
    container_orientation_source(bytes)
}

pub(super) fn container_orientation_source<S: crate::metadata_source::MetadataSource + ?Sized>(
    bytes: &S,
) -> Option<u16> {
    let header = bytes.get(0..bytes.len().min(32))?;
    if is_avif(&header) {
        return None;
    }
    extract_exif_orientation_source(bytes).or_else(|| {
        crate::raster_meta::read_sidecars_source(bytes)
            .exif
            .as_deref()
            .and_then(exif_orientation_from_block)
    })
}

/// Quick probing of raster image dimensions and format from raw bytes.
/// Shares the seekable parser with file callers through a zero-copy Cursor.
pub fn probe_raster_metadata(bytes: &[u8]) -> Result<RasterMetadata> {
    super::probe_raster_metadata_reader(&mut Cursor::new(bytes))
}

#[cfg(test)]
#[path = "raster_probe_legacy_tests.rs"]
pub(crate) mod legacy;
