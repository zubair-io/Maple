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
//! measurements behind it). Extending the table itself (WebP/TIFF/AVIF XMP,
//! AVIF ICC via `ravif` directly, TIFF EXIF via a hand-rolled tag) is real
//! follow-up work, tracked under #3507.

use crate::error::Result;
use crate::raster::RasterImage;
use crate::raster_encode::{
    composite_over_background, EmbeddedMetadata, RasterOutput, JPEG_FLATTEN_BACKGROUND,
};
use crate::raster_recipe_meta::ResolvedMetadata;

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
    meta: &ResolvedMetadata,
) -> Result<Vec<u8>> {
    let meta = &embedded(meta);
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
