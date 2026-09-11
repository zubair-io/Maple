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

/// TIFF tag 34675, `InterColorProfile`, where an ICC profile lives.
const TAG_ICC_PROFILE: u16 = 34675;

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
                    .write_tag(Tag::Unknown(TAG_ICC_PROFILE), profile)
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
                    .write_tag(Tag::Unknown(TAG_ICC_PROFILE), profile)
                    .map_err(tiff_error)?;
            }
            image.write_data(&raster.data).map_err(tiff_error)?;
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ramp(w: u32, h: u32) -> RasterImage {
        RasterImage::new_rgb(
            w,
            h,
            (0..(w as usize * h as usize * 3))
                .map(|i| (i % 251) as u8)
                .collect(),
        )
    }

    fn opts() -> TiffOptions {
        TiffOptions {
            compression: TiffCompression::Lzw,
            bitdepth: 8,
            predictor: true,
        }
    }

    fn is_tiff(bytes: &[u8]) -> bool {
        &bytes[..4] == b"II*\0" || &bytes[..4] == b"MM\0*"
    }

    #[test]
    fn encodes_an_eight_bit_tiff_that_round_trips() {
        let src = ramp(16, 16);
        let bytes = encode_tiff_opts(&src, &opts(), None).unwrap();
        assert!(is_tiff(&bytes));
        let decoded = crate::raster::decode_raster(&bytes, Some("tiff")).unwrap();
        assert_eq!(decoded.data, src.data, "LZW TIFF must be lossless");
    }

    #[test]
    fn sixteen_bit_widens_the_samples() {
        let src = ramp(16, 16);
        let bytes = encode_tiff_opts(
            &src,
            &TiffOptions {
                bitdepth: 16,
                compression: TiffCompression::None,
                ..opts()
            },
            None,
        )
        .unwrap();
        // 16x16 RGB16 is 1536 bytes of pixel data alone.
        assert!(
            bytes.len() > 1536,
            "too small to hold 16-bit samples: {}",
            bytes.len()
        );
        let decoded = crate::raster::decode_raster(&bytes, Some("tiff")).unwrap();
        assert_eq!((decoded.width, decoded.height), (16, 16));
    }

    #[test]
    fn compression_actually_shrinks_the_file() {
        let src = ramp(64, 64);
        let plain = encode_tiff_opts(
            &src,
            &TiffOptions {
                compression: TiffCompression::None,
                ..opts()
            },
            None,
        )
        .unwrap();
        for compression in [
            TiffCompression::Lzw,
            TiffCompression::Deflate,
            TiffCompression::Packbits,
        ] {
            let packed = encode_tiff_opts(
                &src,
                &TiffOptions {
                    compression,
                    ..opts()
                },
                None,
            )
            .unwrap();
            assert!(
                packed.len() < plain.len(),
                "{compression:?} ({}) did not beat uncompressed ({})",
                packed.len(),
                plain.len()
            );
        }
    }

    #[test]
    fn the_icc_profile_is_written_as_tag_34675() {
        let icc = crate::icc::profile_for(crate::view::encode::TargetPrimaries::P3);
        let bytes = encode_tiff_opts(&ramp(8, 8), &opts(), Some(&icc)).unwrap();
        // The profile's own 'acsp' signature lives at byte 36 of any ICC blob.
        assert!(
            bytes.windows(4).any(|w| w == b"acsp"),
            "no ICC payload in the TIFF"
        );
    }

    #[test]
    fn an_unsupported_channel_count_is_rejected() {
        // Neither grayscale (1) nor gray+alpha (2) are wired up — only RGB
        // (3) and RGBA (4) are.
        let gray = RasterImage {
            width: 2,
            height: 2,
            channels: 1,
            data: vec![0; 4],
            orientation: crate::image::ExifOrientation::Normal,
        };
        assert!(encode_tiff_opts(&gray, &opts(), None).is_err());
    }

    /// RGBA input: an interleaved `[R, G, B, A, ...]` buffer with a
    /// distinct, non-zero value per color channel and a transparent (0)
    /// alpha, so a channel swap or a corrupted 4th sample would be caught.
    fn rgba_ramp(w: u32, h: u32) -> RasterImage {
        let mut data = Vec::with_capacity((w * h * 4) as usize);
        for i in 0..(w * h) {
            let base = (i % 60) as u8;
            data.push(base + 1); // R
            data.push(base + 2); // G
            data.push(base + 3); // B
            data.push(0); // straight alpha: fully transparent
        }
        RasterImage::new_rgba(w, h, data)
    }

    #[test]
    fn rgba_eight_bit_round_trips_with_extra_samples_tag() {
        let src = rgba_ramp(8, 8);
        let bytes = encode_tiff_opts(&src, &opts(), None).unwrap();

        let mut decoder = tiff::decoder::Decoder::new(std::io::Cursor::new(&bytes)).unwrap();
        assert_eq!(
            decoder.colortype().unwrap(),
            tiff::ColorType::RGBA(8),
            "the decoder must recognize the extra sample as alpha"
        );
        let extra_samples = decoder.get_tag_u16_vec(Tag::ExtraSamples).unwrap();
        assert_eq!(
            extra_samples,
            vec![2],
            "tag 338 must declare unassociated (straight) alpha"
        );
        match decoder.read_image().unwrap() {
            tiff::decoder::DecodingResult::U8(decoded) => {
                assert_eq!(decoded, src.data, "RGBA8 must round-trip losslessly");
                assert!(
                    decoded.iter().skip(3).step_by(4).all(|&a| a == 0),
                    "every alpha byte must survive as 0"
                );
            }
            other => panic!("expected an 8-bit decode result, got {other:?}"),
        }
    }

    #[test]
    fn rgba_sixteen_bit_round_trips_with_extra_samples_tag() {
        let src = rgba_ramp(8, 8);
        let bytes = encode_tiff_opts(
            &src,
            &TiffOptions {
                bitdepth: 16,
                compression: TiffCompression::Lzw,
                ..opts()
            },
            None,
        )
        .unwrap();

        let mut decoder = tiff::decoder::Decoder::new(std::io::Cursor::new(&bytes)).unwrap();
        assert_eq!(decoder.colortype().unwrap(), tiff::ColorType::RGBA(16));
        let extra_samples = decoder.get_tag_u16_vec(Tag::ExtraSamples).unwrap();
        assert_eq!(extra_samples, vec![2]);
        match decoder.read_image().unwrap() {
            tiff::decoder::DecodingResult::U16(decoded) => {
                assert_eq!(decoded.len(), src.data.len(), "same sample count, widened");
                assert!(
                    decoded.iter().skip(3).step_by(4).all(|&a| a == 0),
                    "the widened alpha sample must still be 0"
                );
                // A widened non-zero channel byte must not collapse to 0.
                assert!(decoded[0] > 0, "widened red sample must stay non-zero");
            }
            other => panic!("expected a 16-bit decode result, got {other:?}"),
        }
    }

    #[test]
    fn an_unsupported_bit_depth_is_rejected() {
        assert!(encode_tiff_opts(
            &ramp(4, 4),
            &TiffOptions {
                bitdepth: 12,
                ..opts()
            },
            None
        )
        .is_err());
    }
}
