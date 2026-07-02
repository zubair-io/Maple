use crate::error::{Error, Result};
use bytemuck::cast_slice;
use image::codecs::tiff::TiffEncoder;
use image::ImageEncoder;

/// Encode a sRGB 16-bit TIFF into an in-memory buffer.
///
/// Expects u16 RGB input. To go from our 8-bit u8 pipeline output, callers
/// should promote first: `rgb_u16 = rgb_u8 * 257` (so 0→0, 255→65535).
///
/// Pure (I/O-free): the shell owns any write to disk.
pub fn encode_u16(width: u32, height: u32, rgb: &[u16]) -> Result<Vec<u8>> {
    let expected_len = (width as usize) * (height as usize) * 3;
    if rgb.len() != expected_len {
        return Err(Error::Png(format!(
            "expected {} u16 values, got {}",
            expected_len,
            rgb.len()
        )));
    }
    let mut out: Vec<u8> = Vec::with_capacity(expected_len * 2);
    {
        let encoder = TiffEncoder::new(std::io::Cursor::new(&mut out));
        let bytes = cast_slice::<u16, u8>(rgb);
        encoder
            .write_image(bytes, width, height, image::ExtendedColorType::Rgb16)
            .map_err(|e| Error::Png(e.to_string()))?;
    }
    Ok(out)
}

/// Convenience: promote our u8 pipeline output to u16 and encode TIFF 16.
pub fn encode_from_u8(width: u32, height: u32, rgb_u8: &[u8]) -> Result<Vec<u8>> {
    let rgb_u16: Vec<u16> = rgb_u8.iter().map(|&b| (b as u16) * 257).collect();
    encode_u16(width, height, &rgb_u16)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_tiny_tiff_from_u8_produces_bytes() {
        let rgb: Vec<u8> = vec![255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255];
        let bytes = encode_from_u8(2, 2, &rgb).unwrap();
        assert!(bytes.len() > 0);
        // TIFF little-endian magic "II*\0" or big-endian "MM\0*".
        let magic_le = &bytes[..4] == b"II*\0";
        let magic_be = &bytes[..4] == b"MM\0*";
        assert!(magic_le || magic_be, "not a TIFF file: {:?}", &bytes[..4]);
    }

    #[test]
    fn wrong_length_errors() {
        assert!(encode_u16(2, 2, &[0u16; 10]).is_err());
    }
}
