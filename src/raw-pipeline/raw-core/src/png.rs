use crate::error::{Error, Result};

/// Encode a sRGB 8-bit PNG into an in-memory buffer.
///
/// Tags the sRGB chunk per IEC 61966-2.1 (matching the reference renderer's output).
/// This is the pure (I/O-free) form — the shell owns any write to disk.
pub fn encode(width: u32, height: u32, rgb: &[u8]) -> Result<Vec<u8>> {
    let expected_len = (width as usize) * (height as usize) * 3;
    if rgb.len() != expected_len {
        return Err(Error::Png(format!(
            "expected {} bytes, got {}",
            expected_len,
            rgb.len()
        )));
    }
    let mut out: Vec<u8> = Vec::with_capacity(expected_len / 4);
    {
        let mut encoder = png::Encoder::new(&mut out, width, height);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_compression(png::Compression::Default);
        encoder.set_source_srgb(png::SrgbRenderingIntent::Perceptual);
        let mut writer = encoder
            .write_header()
            .map_err(|e| Error::Png(e.to_string()))?;
        writer
            .write_image_data(rgb)
            .map_err(|e| Error::Png(e.to_string()))?;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_tiny_png_round_trip() {
        let rgb: Vec<u8> = vec![255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255];
        let bytes = encode(2, 2, &rgb).unwrap();
        let decoder = png::Decoder::new(bytes.as_slice());
        let mut reader = decoder.read_info().unwrap();
        let info = reader.info();
        assert_eq!(info.width, 2);
        assert_eq!(info.height, 2);
        assert_eq!(info.color_type, png::ColorType::Rgb);
        let mut out = vec![0; reader.output_buffer_size()];
        reader.next_frame(&mut out).unwrap();
        assert_eq!(&out[..12], &rgb[..]);
    }

    #[test]
    fn wrong_length_errors() {
        let err = encode(2, 2, &[0u8; 10]).unwrap_err();
        match err {
            Error::Png(_) => {}
            _ => panic!("expected Error::Png"),
        }
    }
}
