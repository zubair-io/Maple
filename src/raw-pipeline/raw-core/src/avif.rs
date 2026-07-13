use crate::error::{Error, Result};
use image::codecs::avif::AvifEncoder;
use image::{ExtendedColorType, ImageEncoder};

/// rav1e speed preset: 1 = slowest/best compression, 10 = fastest/worst.
/// 6 favors encode throughput — this runs across the whole indexer backlog
/// at limited concurrency — since the preset has no effect on decode cost,
/// and decode (every grid scroll) matters more than encode (once per thumb).
const AVIF_SPEED: u8 = 6;

/// Encode a sRGB 8-bit AVIF into an in-memory buffer.
///
/// `quality` is in [1, 100] on AVIF's own scale, which is NOT equivalent to
/// JPEG's — a JPEG-82-equivalent AVIF quality is typically much lower. This
/// is the pure (I/O-free) form — the shell is responsible for any write to
/// disk. See `docs/spec/12-maple-apps-spec.md` §02: "The core is
/// side-effect-free. It never reads or writes a file."
///
/// Embeds no ICC profile (color-managed viewers assume sRGB for untagged
/// AVIF, matching `jpeg::encode`'s convention).
pub fn encode(width: u32, height: u32, rgb: &[u8], quality: u8) -> Result<Vec<u8>> {
    let expected_len = (width as usize) * (height as usize) * 3;
    if rgb.len() != expected_len {
        return Err(Error::Png(format!(
            "expected {} bytes, got {}",
            expected_len,
            rgb.len()
        )));
    }
    let mut out: Vec<u8> = Vec::new();
    // `write_image` asserts `data.len() == expected_buffer_len` internally —
    // the length check above guards the FFI boundary before that assert.
    AvifEncoder::new_with_speed_quality(&mut out, AVIF_SPEED, quality)
        .write_image(rgb, width, height, ExtendedColorType::Rgb8)
        .map_err(|e| Error::Png(e.to_string()))?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_tiny_avif_returns_non_empty_buffer() {
        let rgb: Vec<u8> = vec![255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255];
        let bytes = encode(2, 2, &rgb, 55).unwrap();
        assert!(bytes.len() > 8);
        // AVIF is an ISOBMFF container: bytes 4..8 are the `ftyp` box tag.
        assert_eq!(&bytes[4..8], b"ftyp", "missing AVIF ftyp box");
    }

    #[test]
    fn wrong_length_errors() {
        assert!(encode(2, 2, &[0u8; 10], 55).is_err());
    }
}
