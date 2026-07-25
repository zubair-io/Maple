//! Edited-image export (#943): render an edit to a deliverable file.
//!
//! One entry, [`export_from_raw`], that takes the RAW bytes plus the user's
//! adjustments and returns encoded file bytes ready to be written or handed to
//! a browser download. The render goes through
//! [`crate::pipeline::render_export_from_raw`], which shares its whole colour
//! chain with the on-screen display render, so what lands in the file is what
//! the user approved on the canvas.
//!
//! Every format is tagged with an ICC profile describing the primaries it
//! actually carries ([`crate::icc`]). Untagged files are read as sRGB, so a
//! Display P3 export without a profile would be silently re-stretched by the
//! viewer — the option would look like it worked while being wrong.

use crate::{
    error::{Error, Result},
    icc,
    image::RawImage,
    pipeline::{render_export_from_raw, ExportDepth, ExportPixels, RawInput, RenderQuality},
    view::encode::TargetPrimaries,
    xmp::AdjustmentModel,
};
use image::codecs::{jpeg::JpegEncoder, png::PngEncoder, tiff::TiffEncoder};
use image::{ExtendedColorType, ImageEncoder};

/// Container the export is encoded into.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ExportFormat {
    /// 8-bit lossy — the everyday deliverable. Honours `quality`.
    Jpeg,
    /// 16-bit lossless — the archival/hand-off master.
    Tiff16,
    /// 8-bit lossless.
    Png,
}

impl ExportFormat {
    /// Parse the wire spelling used by the web layer.
    pub fn from_str(value: &str) -> Option<Self> {
        match value {
            "jpeg" => Some(Self::Jpeg),
            "tiff" => Some(Self::Tiff16),
            "png" => Some(Self::Png),
            _ => None,
        }
    }

    /// MIME type for the encoded bytes.
    pub fn mime_type(self) -> &'static str {
        match self {
            Self::Jpeg => "image/jpeg",
            Self::Tiff16 => "image/tiff",
            Self::Png => "image/png",
        }
    }

    /// Filename extension, without the dot.
    pub fn extension(self) -> &'static str {
        match self {
            Self::Jpeg => "jpg",
            Self::Tiff16 => "tif",
            Self::Png => "png",
        }
    }

    /// The channel depth this container is written at.
    fn depth(self) -> ExportDepth {
        match self {
            Self::Tiff16 => ExportDepth::Sixteen,
            Self::Jpeg | Self::Png => ExportDepth::Eight,
        }
    }
}

/// Everything the caller gets to choose about an export.
pub struct ExportOptions {
    pub format: ExportFormat,
    /// JPEG quality in `[1, 100]`; ignored by the lossless formats.
    pub quality: u8,
    /// Output primaries — and the ICC profile the file is tagged with.
    pub target: TargetPrimaries,
    /// Long-edge cap in pixels; `None` renders native full resolution. Never
    /// upscales.
    pub max_long_edge: Option<u32>,
}

/// An encoded export, with the dimensions actually written.
pub struct ExportedImage {
    pub width: u32,
    pub height: u32,
    pub bytes: Vec<u8>,
}

/// Render `raw` under `model` and encode it per `options`.
///
/// `raw_source` is the undecoded RAW, needed by Auto Profile's embedded-JPEG
/// fit — pass it, or `Profile::Auto` silently degrades to plain AgX and the
/// export stops matching the canvas.
pub fn export_from_raw(
    raw: &RawImage,
    model: &AdjustmentModel,
    raw_source: Option<RawInput<'_>>,
    options: &ExportOptions,
) -> Result<ExportedImage> {
    let (width, height, pixels) = render_export_from_raw(
        raw,
        model,
        // Export is always the best demosaic (#940) — nobody keeps a file
        // rendered with the interactive fast-phase kernel.
        RenderQuality::Amaze,
        raw_source,
        options.max_long_edge,
        options.target,
        options.format.depth(),
    )?;

    let profile = icc::profile_for(options.target);
    let bytes = match (options.format, pixels) {
        (ExportFormat::Jpeg, ExportPixels::Eight(rgb)) => {
            encode_jpeg(width, height, &rgb, options.quality, profile)?
        }
        (ExportFormat::Png, ExportPixels::Eight(rgb)) => encode_png(width, height, &rgb, profile)?,
        (ExportFormat::Tiff16, ExportPixels::Sixteen(rgb)) => {
            encode_tiff16(width, height, &rgb, profile)?
        }
        // `ExportFormat::depth` is what chose the buffer, so the pairings above
        // are exhaustive in practice; this keeps that invariant loud rather
        // than letting a future format land on a silently wrong encoder.
        (format, _) => {
            return Err(Error::Png(format!(
                "export: render produced the wrong sample depth for {format:?}"
            )))
        }
    };

    Ok(ExportedImage {
        width,
        height,
        bytes,
    })
}

/// Reject a buffer whose length disagrees with the dimensions before handing it
/// to an encoder, so the failure names the real problem.
fn check_len(width: u32, height: u32, actual: usize) -> Result<()> {
    let expected = (width as usize) * (height as usize) * 3;
    if actual != expected {
        return Err(Error::Png(format!(
            "export: expected {expected} samples for {width}x{height}, got {actual}"
        )));
    }
    Ok(())
}

fn encode_jpeg(
    width: u32,
    height: u32,
    rgb: &[u8],
    quality: u8,
    profile: Vec<u8>,
) -> Result<Vec<u8>> {
    check_len(width, height, rgb.len())?;
    let mut out: Vec<u8> = Vec::new();
    let mut encoder = JpegEncoder::new_with_quality(&mut out, quality.clamp(1, 100));
    encoder
        .set_icc_profile(profile)
        .map_err(|e| Error::Png(e.to_string()))?;
    encoder
        .write_image(rgb, width, height, ExtendedColorType::Rgb8)
        .map_err(|e| Error::Png(e.to_string()))?;
    Ok(out)
}

fn encode_png(width: u32, height: u32, rgb: &[u8], profile: Vec<u8>) -> Result<Vec<u8>> {
    check_len(width, height, rgb.len())?;
    let mut out: Vec<u8> = Vec::new();
    let mut encoder = PngEncoder::new(&mut out);
    encoder
        .set_icc_profile(profile)
        .map_err(|e| Error::Png(e.to_string()))?;
    encoder
        .write_image(rgb, width, height, ExtendedColorType::Rgb8)
        .map_err(|e| Error::Png(e.to_string()))?;
    Ok(out)
}

fn encode_tiff16(width: u32, height: u32, rgb: &[u16], profile: Vec<u8>) -> Result<Vec<u8>> {
    check_len(width, height, rgb.len())?;
    let mut out: Vec<u8> = Vec::new();
    let mut encoder = TiffEncoder::new(std::io::Cursor::new(&mut out));
    encoder
        .set_icc_profile(profile)
        .map_err(|e| Error::Png(e.to_string()))?;
    encoder
        .write_image(
            bytemuck::cast_slice::<u16, u8>(rgb),
            width,
            height,
            ExtendedColorType::Rgb16,
        )
        .map_err(|e| Error::Png(e.to_string()))?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ramp_u8(width: u32, height: u32) -> Vec<u8> {
        (0..(width as usize * height as usize * 3))
            .map(|i| (i % 256) as u8)
            .collect()
    }

    #[test]
    fn format_wire_spellings_round_trip() {
        assert_eq!(ExportFormat::from_str("jpeg"), Some(ExportFormat::Jpeg));
        assert_eq!(ExportFormat::from_str("tiff"), Some(ExportFormat::Tiff16));
        assert_eq!(ExportFormat::from_str("png"), Some(ExportFormat::Png));
        assert_eq!(ExportFormat::from_str("heic"), None);
        assert_eq!(ExportFormat::from_str(""), None);
    }

    #[test]
    fn tiff_is_the_only_sixteen_bit_container() {
        assert_eq!(ExportFormat::Tiff16.depth(), ExportDepth::Sixteen);
        assert_eq!(ExportFormat::Jpeg.depth(), ExportDepth::Eight);
        assert_eq!(ExportFormat::Png.depth(), ExportDepth::Eight);
    }

    #[test]
    fn jpeg_encodes_with_a_soi_marker_and_embeds_the_profile() {
        let rgb = ramp_u8(8, 8);
        let profile = icc::profile_for(TargetPrimaries::P3);
        let bytes = encode_jpeg(8, 8, &rgb, 92, profile).unwrap();
        assert_eq!(&bytes[..2], &[0xFF, 0xD8], "not a JPEG");
        // The ICC APP2 payload is introduced by this exact identifier.
        assert!(
            bytes.windows(12).any(|w| w == b"ICC_PROFILE\0"),
            "no ICC profile embedded in the JPEG"
        );
    }

    #[test]
    fn png_encodes_with_a_signature_and_an_iccp_chunk() {
        let rgb = ramp_u8(8, 8);
        let profile = icc::profile_for(TargetPrimaries::P3);
        let bytes = encode_png(8, 8, &rgb, profile).unwrap();
        assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n", "not a PNG");
        assert!(
            bytes.windows(4).any(|w| w == b"iCCP"),
            "no ICC profile chunk in the PNG"
        );
    }

    #[test]
    fn tiff16_encodes_with_a_tiff_magic_and_full_width_samples() {
        let rgb: Vec<u16> = (0..8 * 8 * 3).map(|i| (i * 257) as u16).collect();
        let profile = icc::profile_for(TargetPrimaries::Srgb);
        let bytes = encode_tiff16(8, 8, &rgb, profile).unwrap();
        let little_endian = &bytes[..4] == b"II*\0";
        let big_endian = &bytes[..4] == b"MM\0*";
        assert!(little_endian || big_endian, "not a TIFF");
        // 16-bit RGB for 64 pixels is 384 bytes of pixel data alone; a buffer
        // anywhere near 192 would mean the samples were narrowed to 8-bit.
        assert!(bytes.len() > 384, "TIFF too small to hold 16-bit samples");
    }

    #[test]
    fn quality_outside_the_valid_range_is_clamped_not_rejected() {
        let rgb = ramp_u8(4, 4);
        let profile = icc::profile_for(TargetPrimaries::Srgb);
        assert!(encode_jpeg(4, 4, &rgb, 0, profile.clone()).is_ok());
        assert!(encode_jpeg(4, 4, &rgb, 200, profile).is_ok());
    }

    #[test]
    fn a_buffer_that_disagrees_with_the_dimensions_is_rejected() {
        let profile = icc::profile_for(TargetPrimaries::Srgb);
        assert!(encode_jpeg(8, 8, &[0u8; 10], 92, profile.clone()).is_err());
        assert!(encode_png(8, 8, &[0u8; 10], profile.clone()).is_err());
        assert!(encode_tiff16(8, 8, &[0u16; 10], profile).is_err());
    }

    /// Lower JPEG quality must actually produce a smaller file — otherwise the
    /// quality control in the UI is inert.
    #[test]
    fn lower_jpeg_quality_produces_a_smaller_file() {
        // Noise compresses differently at different quality settings; a flat
        // ramp can quantize to the same size at neighbouring qualities.
        let rgb: Vec<u8> = (0..64 * 64 * 3)
            .map(|i| ((i * 2654435761usize) >> 13) as u8)
            .collect();
        let profile = icc::profile_for(TargetPrimaries::Srgb);
        let high = encode_jpeg(64, 64, &rgb, 95, profile.clone()).unwrap();
        let low = encode_jpeg(64, 64, &rgb, 40, profile).unwrap();
        assert!(
            low.len() < high.len(),
            "quality 40 ({} bytes) should be smaller than quality 95 ({} bytes)",
            low.len(),
            high.len()
        );
    }

    /// The two colour-space options must produce different bytes; if the
    /// primaries choice were dropped somewhere the files would be identical.
    #[test]
    fn the_two_colour_spaces_tag_differently() {
        let rgb = ramp_u8(8, 8);
        let srgb = encode_jpeg(8, 8, &rgb, 92, icc::profile_for(TargetPrimaries::Srgb)).unwrap();
        let p3 = encode_jpeg(8, 8, &rgb, 92, icc::profile_for(TargetPrimaries::P3)).unwrap();
        assert_ne!(srgb, p3);
    }
}
