use crate::error::{Error, Result};
use image::codecs::tiff::TiffEncoder;
use image::ImageEncoder;
use std::path::Path;
use bytemuck::cast_slice;

/// Write a sRGB 16-bit TIFF. Expects u16 RGB input (2 bytes per channel,
/// big-endian as stored in the Vec<u16>). To go from our 8-bit u8 pipeline
/// output, callers should promote first: `rgb_u16 = rgb_u8 * 257` (so 0→0,
/// 255→65535).
pub fn write_u16(path: &Path, width: u32, height: u32, rgb: &[u16]) -> Result<()> {
    let expected_len = (width as usize) * (height as usize) * 3;
    if rgb.len() != expected_len {
        return Err(Error::Png(format!(
            "expected {} u16 values, got {}", expected_len, rgb.len()
        )));
    }
    let file = std::fs::File::create(path).map_err(|e| Error::Io {
        path: path.to_path_buf(), source: e,
    })?;
    let w = std::io::BufWriter::new(file);
    let encoder = TiffEncoder::new(w);
    let bytes = cast_slice::<u16, u8>(rgb);
    encoder
        .write_image(bytes, width, height, image::ExtendedColorType::Rgb16)
        .map_err(|e| Error::Png(e.to_string()))?;
    Ok(())
}

/// Convenience: promote our u8 pipeline output to u16 and write TIFF 16.
pub fn write_from_u8(path: &Path, width: u32, height: u32, rgb_u8: &[u8]) -> Result<()> {
    let rgb_u16: Vec<u16> = rgb_u8.iter().map(|&b| (b as u16) * 257).collect();
    write_u16(path, width, height, &rgb_u16)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_tiny_tiff_from_u8() {
        let tmp_dir = tempfile::TempDir::new().unwrap();
        let path = tmp_dir.path().join("test.tif");
        let rgb: Vec<u8> = vec![255, 0, 0,  0, 255, 0,  0, 0, 255,  255, 255, 255];
        write_from_u8(&path, 2, 2, &rgb).unwrap();
        // Verify the file was created and has content.
        let metadata = std::fs::metadata(&path).unwrap();
        assert!(metadata.len() > 0);
    }

    #[test]
    fn wrong_length_errors() {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        assert!(write_u16(tmp.path(), 2, 2, &[0u16; 10]).is_err());
    }
}
