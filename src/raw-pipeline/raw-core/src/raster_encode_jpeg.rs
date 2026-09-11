//! JPEG encode with the options sharp exposes (#3506): progressive scans,
//! 4:2:0 or 4:4:4 chroma, optimised Huffman tables, and the three metadata
//! segments (APP2 ICC, APP1 EXIF, APP1 XMP).
//!
//! `image`'s built-in JPEG encoder offers none of those, so this path uses the
//! `jpeg-encoder` crate directly. It is NOT mozjpeg: there is no trellis
//! quantisation, so files are larger at matched quality. The gap is measured
//! by `src/maple/scripts/bench-jpeg-size.ts` and quoted in the README rather
//! than papered over — closing it would mean a C dependency, which the Linux
//! zero-dependency audit forbids.
//!
//! JPEG has no alpha channel: a 4-channel raster must be flattened by the
//! caller before it gets here (`raster_encode::encode_raster_opts` does).

use crate::error::{Error, Result};
use crate::raster::RasterImage;
use jpeg_encoder::{ColorType, Encoder, SamplingFactor};

/// sharp's `chromaSubsampling` for JPEG. Only the two values sharp documents
/// for RGB input are offered; the CMYK spellings are out of scope.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum ChromaSubsampling {
    /// sharp's default: half-resolution chroma.
    #[default]
    Yuv420,
    /// `'4:4:4'` — full-resolution chroma.
    Yuv444,
}

impl ChromaSubsampling {
    /// Parse sharp's wire spelling.
    pub fn from_wire(s: &str) -> Option<Self> {
        match s {
            "4:2:0" => Some(Self::Yuv420),
            "4:4:4" => Some(Self::Yuv444),
            _ => None,
        }
    }

    fn sampling_factor(self) -> SamplingFactor {
        match self {
            Self::Yuv420 => SamplingFactor::R_4_2_0,
            Self::Yuv444 => SamplingFactor::R_4_4_4,
        }
    }
}

/// Everything sharp's `jpeg()` exposes that a pure-Rust encoder can honour.
/// `mozjpeg`, `trellisQuantisation`, `overshootDeringing`, `optimiseScans` and
/// `quantisationTable` are NOT implemented and are rejected by name at the
/// recipe layer.
#[derive(Clone, Copy, Debug)]
pub struct JpegOptions {
    pub quality: u8,
    pub progressive: bool,
    pub chroma_subsampling: ChromaSubsampling,
    pub optimise_coding: bool,
}

impl Default for JpegOptions {
    fn default() -> Self {
        Self {
            quality: 80,
            progressive: false,
            chroma_subsampling: ChromaSubsampling::Yuv420,
            optimise_coding: true,
        }
    }
}

/// APP1 introducer for an XMP packet, per the XMP specification part 3.
const XMP_NAMESPACE: &[u8] = b"http://ns.adobe.com/xap/1.0/\0";

fn encode_error(e: impl std::fmt::Display) -> Error {
    Error::Png(format!("jpeg encode failed: {e}"))
}

pub fn encode_jpeg_opts(
    raster: &RasterImage,
    options: &JpegOptions,
    icc: Option<&[u8]>,
    exif: Option<&[u8]>,
    xmp: Option<&[u8]>,
) -> Result<Vec<u8>> {
    if raster.channels != 3 {
        return Err(encode_error(format!(
            "JPEG has no alpha channel; flatten the {}-channel raster first",
            raster.channels
        )));
    }
    let width = u16::try_from(raster.width)
        .map_err(|_| encode_error(format!("width {} exceeds JPEG's 65535 limit", raster.width)))?;
    let height = u16::try_from(raster.height).map_err(|_| {
        encode_error(format!(
            "height {} exceeds JPEG's 65535 limit",
            raster.height
        ))
    })?;

    let mut out: Vec<u8> = Vec::new();
    let mut encoder = Encoder::new(&mut out, options.quality.clamp(1, 100));
    encoder.set_sampling_factor(options.chroma_subsampling.sampling_factor());
    encoder.set_progressive(options.progressive);
    encoder.set_optimized_huffman_tables(options.optimise_coding);
    if let Some(profile) = icc {
        encoder.add_icc_profile(profile).map_err(encode_error)?;
    }
    if let Some(block) = exif {
        encoder.add_exif_metadata(block).map_err(encode_error)?;
    }
    if let Some(packet) = xmp {
        let segment = [XMP_NAMESPACE, packet].concat();
        encoder.add_app_segment(1, segment).map_err(encode_error)?;
    }
    encoder
        .encode(&raster.data, width, height, ColorType::Rgb)
        .map_err(encode_error)?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn noise(w: u32, h: u32) -> RasterImage {
        // Structured noise: a flat ramp can quantise identically at
        // neighbouring settings and hide a real difference.
        let data = (0..(w as usize * h as usize * 3))
            .map(|i| ((i * 2_654_435_761usize) >> 13) as u8)
            .collect();
        RasterImage::new_rgb(w, h, data)
    }

    fn opts() -> JpegOptions {
        JpegOptions {
            quality: 80,
            progressive: false,
            chroma_subsampling: ChromaSubsampling::Yuv420,
            optimise_coding: true,
        }
    }

    /// Scan for a JPEG marker byte in the header area.
    fn has_marker(bytes: &[u8], marker: u8) -> bool {
        bytes.windows(2).any(|w| w[0] == 0xFF && w[1] == marker)
    }

    #[test]
    fn encodes_a_baseline_jpeg_that_decodes_back() {
        let src = noise(32, 32);
        let bytes = encode_jpeg_opts(&src, &opts(), None, None, None).unwrap();
        assert_eq!(&bytes[..2], &[0xFF, 0xD8]);
        assert!(has_marker(&bytes, 0xC0), "expected a baseline SOF0");
        let decoded = crate::raster::decode_raster(&bytes, Some("jpeg")).unwrap();
        assert_eq!((decoded.width, decoded.height), (32, 32));
    }

    #[test]
    fn progressive_writes_sof2_and_still_decodes() {
        let bytes = encode_jpeg_opts(
            &noise(32, 32),
            &JpegOptions {
                progressive: true,
                ..opts()
            },
            None,
            None,
            None,
        )
        .unwrap();
        assert!(has_marker(&bytes, 0xC2), "expected a progressive SOF2");
        let decoded = crate::raster::decode_raster(&bytes, Some("jpeg")).unwrap();
        assert_eq!((decoded.width, decoded.height), (32, 32));
    }

    #[test]
    fn four_four_four_is_larger_than_four_two_zero_at_the_same_quality() {
        let src = noise(64, 64);
        let subsampled = encode_jpeg_opts(&src, &opts(), None, None, None).unwrap();
        let full = encode_jpeg_opts(
            &src,
            &JpegOptions {
                chroma_subsampling: ChromaSubsampling::Yuv444,
                ..opts()
            },
            None,
            None,
            None,
        )
        .unwrap();
        assert!(
            full.len() > subsampled.len(),
            "4:4:4 ({}) should be larger than 4:2:0 ({})",
            full.len(),
            subsampled.len()
        );
    }

    #[test]
    fn optimised_huffman_tables_shrink_the_file() {
        let src = noise(64, 64);
        let plain = encode_jpeg_opts(
            &src,
            &JpegOptions {
                optimise_coding: false,
                ..opts()
            },
            None,
            None,
            None,
        )
        .unwrap();
        let optimised = encode_jpeg_opts(&src, &opts(), None, None, None).unwrap();
        assert!(
            optimised.len() < plain.len(),
            "optimised ({}) should beat default tables ({})",
            optimised.len(),
            plain.len()
        );
    }

    #[test]
    fn lower_quality_produces_a_smaller_file() {
        let src = noise(64, 64);
        let high = encode_jpeg_opts(
            &src,
            &JpegOptions {
                quality: 95,
                ..opts()
            },
            None,
            None,
            None,
        )
        .unwrap();
        let low = encode_jpeg_opts(
            &src,
            &JpegOptions {
                quality: 40,
                ..opts()
            },
            None,
            None,
            None,
        )
        .unwrap();
        assert!(low.len() < high.len());
    }

    #[test]
    fn the_three_metadata_segments_are_embedded() {
        let icc = crate::icc::profile_for(crate::view::encode::TargetPrimaries::P3);
        let exif = b"II\x2a\x00\x08\x00\x00\x00\x00\x00".to_vec();
        let xmp = br#"<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta/>"#.to_vec();
        let bytes =
            encode_jpeg_opts(&noise(16, 16), &opts(), Some(&icc), Some(&exif), Some(&xmp)).unwrap();
        assert!(
            bytes.windows(12).any(|w| w == b"ICC_PROFILE\0"),
            "no ICC APP2"
        );
        assert!(bytes.windows(6).any(|w| w == b"Exif\0\0"), "no EXIF APP1");
        assert!(
            bytes
                .windows(29)
                .any(|w| w == b"http://ns.adobe.com/xap/1.0/\0"),
            "no XMP APP1"
        );
    }

    #[test]
    fn a_four_channel_raster_is_rejected_rather_than_silently_flattened() {
        let rgba = RasterImage::new_rgba(2, 2, vec![0; 16]);
        assert!(encode_jpeg_opts(&rgba, &opts(), None, None, None).is_err());
    }

    #[test]
    fn dimensions_beyond_the_jpeg_limit_are_rejected() {
        // JPEG's SOF carries 16-bit dimensions; 65536 does not fit.
        let wide = RasterImage {
            width: 65_536,
            height: 1,
            channels: 3,
            data: vec![0; 65_536 * 3],
            orientation: crate::image::ExifOrientation::Normal,
        };
        assert!(encode_jpeg_opts(&wide, &opts(), None, None, None).is_err());
    }
}
