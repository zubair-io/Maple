//! The recipe's ONE encode path: per-format options (#3506) in, the recipe's
//! resolved metadata (#3507) in, container bytes out.
//!
//! There used to be two. PR-F's `raster_encode::encode_raster_output` took
//! the per-format option structs and an ICC profile derived from the
//! recipe's output primaries; PR-G's `encode_*_with_metadata` functions took
//! a resolved EXIF/ICC/XMP/density set and a bare quality. Two encode paths
//! means two answers to "what did this container actually get written with",
//! so they are one function here: [`encode_raster_output`], which takes
//! both.
//!
//! Container capability matrix — what each underlying encoder crate actually
//! supports, not a policy choice made here:
//!
//! | Container | ICC | EXIF | XMP | Density | Orientation |
//! |-----------|-----|------|-----|---------|-------------|
//! | JPEG      | yes | yes  | yes (APP1)   | yes (JFIF)   | via EXIF |
//! | PNG       | yes | yes  | yes (`iTXt`) | yes (`pHYs`) | via EXIF |
//! | WebP      | yes | yes  | no (`image`'s wrapper has no XMP hook) | no | via EXIF |
//! | TIFF      | yes | no (no EXIF block) | no | no | IFD0 tag 274 |
//! | AVIF      | no (`ravif` 0.13 writes no ICC box) | yes | no | no | via EXIF |
//!
//! A `None` field in [`ResolvedMetadata`] embeds nothing at all — including
//! `icc`: there is no "leave the container's default profile tagging alone"
//! fallback (#3507 fix-round-1, item 2; see that struct's doc for the sharp
//! measurements behind it). A `Some` field the target container's encoder
//! genuinely cannot carry (see the table above) is caught by
//! [`require_supported`] BEFORE the encoder runs and turned into a named
//! error rather than silently not embedded (fix-round-1, item 1).
//! Extending the table itself (WebP/TIFF/AVIF XMP, AVIF ICC via `ravif`
//! directly, TIFF EXIF via a hand-rolled tag) is real follow-up work,
//! tracked under #3507.

use crate::error::Result;
use crate::raster::RasterImage;
use crate::raster_encode::{
    composite_over_background, EmbeddedMetadata, RasterOutput, JPEG_FLATTEN_BACKGROUND,
};
use crate::raster_recipe_meta::ResolvedMetadata;

fn bad(reason: String) -> crate::error::Error {
    crate::error::Error::Decode {
        path: "<recipe>".into(),
        reason,
    }
}

/// What a container's own encoder crate can actually carry — the exhaustive
/// truth the module doc's table states, single-sourced here so
/// [`require_supported`] and [`encode_raster_output`]'s per-format arms
/// agree with each other.
pub(crate) struct Capabilities {
    exif: bool,
    icc: bool,
    xmp: bool,
    density: bool,
}

pub(crate) const JPEG_CAPS: Capabilities = Capabilities {
    exif: true,
    icc: true,
    xmp: true,
    density: true,
};
pub(crate) const PNG_CAPS: Capabilities = Capabilities {
    exif: true,
    icc: true,
    xmp: true,
    density: true,
};
pub(crate) const WEBP_CAPS: Capabilities = Capabilities {
    exif: true,
    icc: true,
    xmp: false,
    density: false,
};
pub(crate) const TIFF_CAPS: Capabilities = Capabilities {
    exif: false,
    icc: true,
    xmp: false,
    density: false,
};
/// Referenced by `capabilities_of` only when the `avif` feature is on — the
/// `RasterOutput::Avif` variant does not exist otherwise — and by this
/// module's own tests either way.
#[cfg_attr(not(feature = "avif"), allow(dead_code))]
pub(crate) const AVIF_CAPS: Capabilities = Capabilities {
    exif: true,
    icc: false,
    xmp: false,
    density: false,
};

/// Reject, by name, any metadata field `format_name`'s own encoder crate
/// cannot carry — fix-round-1, item 1. Before this the encoders simply never
/// read the fields their container can't carry (WebP xmp/density, TIFF
/// exif/xmp/density, AVIF icc/xmp/density), silently producing a file
/// missing what the caller supplied.
pub(crate) fn require_supported(
    meta: &ResolvedMetadata,
    format_name: &str,
    caps: &Capabilities,
) -> Result<()> {
    if meta.exif.is_some() && !caps.exif {
        return Err(bad(format!(
            "{format_name} cannot embed EXIF (requested via metadata.exif / keep)"
        )));
    }
    if meta.icc.is_some() && !caps.icc {
        return Err(bad(format!(
            "{format_name} cannot embed an ICC profile (requested via metadata.icc / keep)"
        )));
    }
    if meta.xmp.is_some() && !caps.xmp {
        return Err(bad(format!(
            "{format_name} cannot embed XMP (requested via metadata.xmp / keep)"
        )));
    }
    if meta.density.is_some() && !caps.density {
        return Err(bad(format!(
            "{format_name} cannot embed a pixel density (requested via metadata.density)"
        )));
    }
    Ok(())
}

/// WebP encode/rejection. Delegates to `raster_encode_avif::encode_webp_opts`
/// when the `avif` feature is on (that module bundles WebP alongside AVIF);
/// otherwise fails by name rather than silently dropping the request, same
/// as `export::encode_avif_rgba_with_speed`'s feature-gated pair.
#[cfg(feature = "avif")]
fn encode_webp_lossless(
    raster: &RasterImage,
    lossless: bool,
    meta: &EmbeddedMetadata<'_>,
) -> Result<Vec<u8>> {
    crate::raster_encode_avif::encode_webp_opts(raster, lossless, meta)
}
#[cfg(not(feature = "avif"))]
fn encode_webp_lossless(
    _raster: &RasterImage,
    _lossless: bool,
    _meta: &EmbeddedMetadata<'_>,
) -> Result<Vec<u8>> {
    Err(crate::error::Error::UnsupportedFormat(
        "WebP output requires raw-core's 'avif' feature (WebP and AVIF share \
         an encoder module)"
            .into(),
    ))
}

/// The container's display name and capability set, keyed on the same
/// `RasterOutput` the encode dispatches on, so the gate and the encoder can
/// never disagree about which container is being written.
fn capabilities_of(output: &RasterOutput) -> (&'static str, &'static Capabilities) {
    match output {
        RasterOutput::Jpeg(_) => ("JPEG", &JPEG_CAPS),
        RasterOutput::Png(_) => ("PNG", &PNG_CAPS),
        RasterOutput::Webp { .. } => ("WebP", &WEBP_CAPS),
        #[cfg(feature = "avif")]
        RasterOutput::Avif(_) => ("AVIF", &AVIF_CAPS),
        RasterOutput::Tiff(_) => ("TIFF", &TIFF_CAPS),
        // Checked by the caller before this is ever reached.
        RasterOutput::Raw => ("raw", &JPEG_CAPS),
    }
}

/// The borrowed, encoder-facing view of a recipe's resolved metadata. One
/// conversion, in one place, so the encoders never each grow their own idea
/// of what a metadata set is.
fn embedded(meta: &ResolvedMetadata) -> EmbeddedMetadata<'_> {
    EmbeddedMetadata {
        icc: meta.icc.as_deref(),
        exif: meta.exif.as_deref(),
        xmp: meta.xmp.as_deref(),
        density: meta.density,
    }
}

/// Encode `raster` per the per-format `output`, embedding whatever `meta`
/// resolved to. The recipe executor's `run_recipe` is the only caller.
pub fn encode_raster_output(
    raster: &RasterImage,
    output: &RasterOutput,
    resolved: &ResolvedMetadata,
) -> Result<Vec<u8>> {
    // `Raw` is the one output with nothing to check: it is a pixel dump
    // with no header of any kind, not a container that dropped a field it
    // could otherwise have carried, and sharp's raw output carries no
    // metadata either.
    if !matches!(output, RasterOutput::Raw) {
        let (name, caps) = capabilities_of(output);
        require_supported(resolved, name, caps)?;
    }
    let meta = &embedded(resolved);
    match output {
        RasterOutput::Raw => Ok(raster.data.clone()),
        RasterOutput::Jpeg(o) => crate::raster_encode_jpeg::encode_jpeg_opts(
            &composite_over_background(raster, JPEG_FLATTEN_BACKGROUND),
            o,
            meta,
        ),
        RasterOutput::Png(o) => crate::raster_encode_png::encode_png_opts(raster, o, meta),
        RasterOutput::Webp { lossless } => encode_webp_lossless(raster, *lossless, meta),
        #[cfg(feature = "avif")]
        RasterOutput::Avif(o) => crate::raster_encode_avif::encode_avif_opts(raster, o, meta),
        // NOT flattened: `encode_tiff_opts` writes a 4-channel raster as RGB
        // plus one unassociated alpha sample (`ExtraSamples` = 2), which is
        // byte-for-byte the declaration `sharp().tiff()` writes for an RGBA
        // input. Compositing here instead would make `.tiff()` the one
        // options-path container that silently loses alpha — and it did,
        // until this call site caught up with the encoder (#3545).
        RasterOutput::Tiff(o) => crate::raster_encode_tiff::encode_tiff_opts(raster, o, meta),
    }
}

#[cfg(test)]
#[path = "raster_recipe_encode_tests.rs"]
mod tests;
