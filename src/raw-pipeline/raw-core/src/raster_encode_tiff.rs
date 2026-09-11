//! TIFF encode with sharp's compression, predictor and bit-depth options
//! (#3506).
//!
//! `image`'s `TiffEncoder` wrapper hard-codes all three, so this path drives
//! the `tiff` crate directly. TIFF has no alpha channel in Maple's surface:
//! a 4-channel raster is flattened by the caller, matching the JPEG rule.
//!
//! sharp's `compression: 'jpeg' | 'webp' | 'zstd' | 'jp2k' | 'ccittfax4'`
//! and its `tile`/`pyramid`/`bigtiff` options are not implemented and are
//! rejected by name at the recipe layer.

use crate::error::{Error, Result};
use crate::raster::RasterImage;
use tiff::encoder::{colortype, compression::DeflateLevel, Compression, TiffEncoder};
use tiff::tags::{Predictor, Tag};

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
    if raster.channels != 3 {
        return Err(tiff_error(format!(
            "Maple's TIFF encoder writes RGB only; flatten the {}-channel raster first",
            raster.channels
        )));
    }
    if !matches!(options.bitdepth, 8 | 16) {
        return Err(tiff_error(format!(
            "TIFF bitdepth {} is not supported (8 or 16)",
            options.bitdepth
        )));
    }
    let mut out: Vec<u8> = Vec::new();
    {
        let mut encoder = TiffEncoder::new(std::io::Cursor::new(&mut out))
            .map_err(tiff_error)?
            .with_compression(options.compression.to_tiff())
            .with_predictor(if options.predictor {
                Predictor::Horizontal
            } else {
                Predictor::None
            });
        // The ICC tag has to be written into the image's own directory, so the
        // image is built through `new_image` rather than `write_image`.
        if options.bitdepth == 16 {
            let widened: Vec<u16> = raster.data.iter().map(|&v| (v as u16) * 257).collect();
            let mut image = encoder
                .new_image::<colortype::RGB16>(raster.width, raster.height)
                .map_err(tiff_error)?;
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
    fn a_four_channel_raster_is_rejected() {
        let rgba = RasterImage::new_rgba(2, 2, vec![0; 16]);
        assert!(encode_tiff_opts(&rgba, &opts(), None).is_err());
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
