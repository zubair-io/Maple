use std::borrow::Cow;
use std::path::Path;

use crate::error::PanoError;
use crate::render::PngMetadata;

pub fn write_owner_png(
    path: &Path,
    width: u32,
    height: u32,
    owner: &[u16],
) -> Result<(), PanoError> {
    debug_assert_eq!(owner.len(), width as usize * height as usize);
    let file = std::fs::File::create(path).map_err(|e| PanoError::io(path, e))?;
    let mut info = png::Info::with_size(width, height);
    info.color_type = png::ColorType::Grayscale;
    info.bit_depth = png::BitDepth::Sixteen;
    let enc = png::Encoder::with_info(std::io::BufWriter::new(file), info)?;
    let mut writer = enc.write_header()?;
    let mut bytes = Vec::with_capacity(owner.len() * 2);
    for &v in owner {
        bytes.extend_from_slice(&v.to_be_bytes());
    }
    writer.write_image_data(&bytes)?;
    Ok(())
}

pub fn write_frame_png(
    path: &Path,
    width: u32,
    height: u32,
    data: &[u16],
    meta: &PngMetadata,
) -> Result<(), PanoError> {
    debug_assert_eq!(data.len(), width as usize * height as usize * 3);
    let file = std::fs::File::create(path).map_err(|e| PanoError::io(path, e))?;

    let mut info = png::Info::with_size(width, height);
    info.color_type = png::ColorType::Rgb;
    info.bit_depth = png::BitDepth::Sixteen;

    if meta.tag_srgb {
        // `srgb` is a public field on `Info`; the `png` encoder writes an
        // `sRGB` chunk for it (PNG spec §11.3.2.5).  The companion `gAMA` and
        // `cHRM` chunks are written automatically by the encoder when
        // `source_gamma` / `source_chromaticities` are also set, but the
        // `sRGB` chunk alone is sufficient for Apple ImageIO / CGImageSource
        // to identify the color space as sRGB.
        info.srgb = Some(png::SrgbRenderingIntent::Perceptual);
    }

    if let Some(blob) = &meta.exif_blob {
        info.exif_metadata = Some(Cow::Borrowed(blob.as_slice()));
    }

    let enc = png::Encoder::with_info(std::io::BufWriter::new(file), info)?;
    let mut writer = enc.write_header()?;

    // PNG 16-bit samples are big-endian.
    let mut bytes = Vec::with_capacity(data.len() * 2);
    for &v in data {
        bytes.extend_from_slice(&v.to_be_bytes());
    }
    writer.write_image_data(&bytes)?;
    Ok(())
}
