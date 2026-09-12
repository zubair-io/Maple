//! TIFF encode with sharp's compression, predictor and bit-depth options
//! (#3506), plus RGBA alpha via `ExtraSamples` on this options path (#3545).
//!
//! `image`'s `TiffEncoder` wrapper hard-codes compression, predictor and bit
//! depth, so this path drives the `tiff` crate directly. A 3-channel raster
//! writes plain RGB. A 4-channel raster writes RGB plus one *unassociated*
//! (straight, not premultiplied) alpha sample via `ImageEncoder::extra_samples`
//! — `RasterImage` always carries straight alpha (see `raster_alpha.rs`), so
//! `ExtraSamples::UnassociatedAlpha` (tag 338 = `[2]`) is the correct
//! declaration, never `AssociatedAlpha`.
//!
//! The horizontal predictor is skipped on the alpha path. tiff 0.11.3's
//! `ImageEncoder::write_strip` differences each row at a stride equal to the
//! base colortype's own component count (`RGB8`/`RGB16` → 3), unaware of any
//! samples added afterward by `extra_samples()`; with the file's real
//! `SamplesPerPixel` at 4, that misaligns the diff across channel boundaries
//! and corrupts the data (confirmed empirically: an `[R,G,B,A]` buffer
//! written with the horizontal predictor decodes back as garbage past the
//! first pixel). So `options.predictor` is honored on the 3-channel path
//! only; the 4-channel path always encodes with no predictor.
//!
//! The legacy `crate::tiff::encode_u16`/`encode_from_u8` (export.rs's
//! `Tiff16` path, `container_supports_alpha`) is untouched by this change —
//! it keeps flattening 4-channel input over black, matching the JPEG rule.
//! F5 routes the recipe's TIFF output through `encode_tiff_opts` when
//! options are present, at which point that call site can carry alpha
//! straight through; only this module gained it.
//!
//! sharp's `compression: 'jpeg' | 'webp' | 'zstd' | 'jp2k' | 'ccittfax4'`
//! and its `tile`/`pyramid`/`bigtiff` options are not implemented and are
//! rejected by name at the recipe layer.

use crate::error::{Error, Result};
use crate::raster::RasterImage;
use tiff::encoder::{colortype, compression::DeflateLevel, Compression, TiffEncoder};
use tiff::tags::{ExtraSamples, Predictor, Tag};

/// The four compressors the `tiff` crate's encoder ships, which are the four
/// sharp values Maple implements.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum TiffCompression {
    None,
    #[default]
    Lzw,
    Deflate,
    Packbits,
}

impl TiffCompression {
    pub fn from_wire(s: &str) -> Option<Self> {
        match s {
            "none" => Some(Self::None),
            "lzw" => Some(Self::Lzw),
            "deflate" => Some(Self::Deflate),
            "packbits" => Some(Self::Packbits),
            _ => None,
        }
    }

    fn to_tiff(self) -> Compression {
        match self {
            Self::None => Compression::Uncompressed,
            Self::Lzw => Compression::Lzw,
            // Balanced is zlib level 6, the same default sharp's PNG uses.
            Self::Deflate => Compression::Deflate(DeflateLevel::Balanced),
            Self::Packbits => Compression::Packbits,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct TiffOptions {
    pub compression: TiffCompression,
    /// 8 or 16.
    pub bitdepth: u8,
    /// Horizontal differencing predictor — a big win for LZW on photographs.
    /// Ignored (always off) when the raster carries alpha; see the module
    /// doc for why the crate's predictor can't be trusted with the extra
    /// alpha sample.
    pub predictor: bool,
}

impl Default for TiffOptions {
    fn default() -> Self {
        Self {
            compression: TiffCompression::Lzw,
            bitdepth: 8,
            predictor: true,
        }
    }
}

fn tiff_error(e: impl std::fmt::Display) -> Error {
    Error::Png(format!("tiff encode failed: {e}"))
}

pub fn encode_tiff_opts(
    raster: &RasterImage,
    options: &TiffOptions,
    icc: Option<&[u8]>,
) -> Result<Vec<u8>> {
    if !matches!(raster.channels, 3 | 4) {
        return Err(tiff_error(format!(
            "Maple's TIFF encoder writes RGB or RGBA only; flatten the {}-channel raster first",
            raster.channels
        )));
    }
    if !matches!(options.bitdepth, 8 | 16) {
        return Err(tiff_error(format!(
            "TIFF bitdepth {} is not supported (8 or 16)",
            options.bitdepth
        )));
    }
    let has_alpha = raster.channels == 4;
    // See the module doc: the crate's horizontal predictor corrupts data
    // once an extra (alpha) sample is present, so the alpha path never uses
    // it regardless of what the caller asked for.
    let predictor = if !has_alpha && options.predictor {
        Predictor::Horizontal
    } else {
        Predictor::None
    };
    let mut out: Vec<u8> = Vec::new();
    {
        let mut encoder = TiffEncoder::new(std::io::Cursor::new(&mut out))
            .map_err(tiff_error)?
            .with_compression(options.compression.to_tiff())
            .with_predictor(predictor);
        // The ICC tag has to be written into the image's own directory, so the
        // image is built through `new_image` rather than `write_image`. Alpha
        // rides as an `extra_samples` addition on top of the plain RGB
        // colortype (writing `colortype::RGBA8`/`RGBA16` directly would
        // double-count the alpha sample against the extra one — see the
        // module doc for the `tiff` crate's expected pattern).
        if options.bitdepth == 16 {
            let widened: Vec<u16> = raster.data.iter().map(|&v| (v as u16) * 257).collect();
            let mut image = encoder
                .new_image::<colortype::RGB16>(raster.width, raster.height)
                .map_err(tiff_error)?;
            if has_alpha {
                image
                    .extra_samples(&[ExtraSamples::UnassociatedAlpha])
                    .map_err(tiff_error)?;
            }
            if let Some(profile) = icc {
                image
                    .encoder()
                    .write_tag(Tag::IccProfile, profile)
                    .map_err(tiff_error)?;
            }
            image.write_data(&widened).map_err(tiff_error)?;
        } else {
            let mut image = encoder
                .new_image::<colortype::RGB8>(raster.width, raster.height)
                .map_err(tiff_error)?;
            if has_alpha {
                image
                    .extra_samples(&[ExtraSamples::UnassociatedAlpha])
                    .map_err(tiff_error)?;
            }
            if let Some(profile) = icc {
                image
                    .encoder()
                    .write_tag(Tag::IccProfile, profile)
                    .map_err(tiff_error)?;
            }
            image.write_data(&raster.data).map_err(tiff_error)?;
        }
    }
    Ok(out)
}

#[cfg(test)]
#[path = "raster_encode_tiff_tests.rs"]
mod tests;
