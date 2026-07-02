use crate::error::{Error, Result};
use image::codecs::jpeg::JpegEncoder;
use image::{ImageBuffer, Rgb};

/// Encode a sRGB 8-bit JPEG into an in-memory buffer.
///
/// `quality` is in [1, 100]; the default per spec §04 is 92. This is the pure
/// (I/O-free) form — the shell is responsible for any write to disk. See
/// `docs/spec/12-maple-apps-spec.md` §02: "The core is side-effect-free. It
/// never reads or writes a file."
///
/// Embeds no ICC profile in v1 (color-managed viewers assume sRGB for
/// untagged JPEG).
pub fn encode(width: u32, height: u32, rgb: &[u8], quality: u8) -> Result<Vec<u8>> {
    let expected_len = (width as usize) * (height as usize) * 3;
    if rgb.len() != expected_len {
        return Err(Error::Png(format!(
            "expected {} bytes, got {}",
            expected_len,
            rgb.len()
        )));
    }
    let buf = ImageBuffer::<Rgb<u8>, _>::from_raw(width, height, rgb.to_vec())
        .ok_or_else(|| Error::Png("failed to build ImageBuffer".into()))?;
    let mut out: Vec<u8> = Vec::with_capacity(expected_len / 4);
    let mut encoder = JpegEncoder::new_with_quality(&mut out, quality);
    encoder
        .encode_image(&buf)
        .map_err(|e| Error::Png(e.to_string()))?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_tiny_jpeg_returns_non_empty_buffer() {
        let rgb: Vec<u8> = vec![255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255];
        let bytes = encode(2, 2, &rgb, 92).unwrap();
        assert!(bytes.len() > 0);
        // JPEG SOI marker.
        assert_eq!(&bytes[..2], &[0xFF, 0xD8]);
    }

    #[test]
    fn wrong_length_errors() {
        assert!(encode(2, 2, &[0u8; 10], 92).is_err());
    }
}
