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
    // Order matters, and it is EXIF, then XMP, then ICC. `jpeg-encoder`
    // writes these segments in call order, the Exif specification wants its
    // APP1 first in the file, and sharp writes exactly this order
    // (measured: `APP1(Exif), APP1(XMP), APP2(ICC_PROFILE), SOF0`). Adding
    // ICC first — as this did — produced `APP0(JFIF), APP2(ICC_PROFILE),
    // APP1(Exif), APP1(XMP), SOF0`, which sharp still reads but a strict
    // Exif reader is entitled not to.
    if let Some(block) = exif {
        encoder.add_exif_metadata(block).map_err(encode_error)?;
    }
    if let Some(packet) = xmp {
        let segment = [XMP_NAMESPACE, packet].concat();
        encoder.add_app_segment(1, segment).map_err(encode_error)?;
    }
    if let Some(profile) = icc {
        encoder.add_icc_profile(profile).map_err(encode_error)?;
    }
    encoder
        .encode(&raster.data, width, height, ColorType::Rgb)
        .map_err(encode_error)?;
    Ok(out)
}

#[cfg(test)]
#[path = "raster_encode_jpeg_tests.rs"]
mod tests;
