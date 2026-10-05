use crate::error::{Error, Result};
use crate::view::encode::TargetPrimaries;

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
/// sRGB uses the implicit default CICP values; P3 uses `encode_tagged`.
pub fn encode(width: u32, height: u32, rgb: &[u8], quality: u8) -> Result<Vec<u8>> {
    encode_with_speed(width, height, rgb, quality, AVIF_SPEED)
}

/// `speed` is rav1e's 1 (slowest, smallest) … 10 (fastest); sharp's `effort`
/// runs the other way (0 fastest … 9 slowest) and the package maps it.
pub fn encode_with_speed(
    width: u32,
    height: u32,
    rgb: &[u8],
    quality: u8,
    speed: u8,
) -> Result<Vec<u8>> {
    let expected_len = (width as usize) * (height as usize) * 3;
    if rgb.len() != expected_len {
        return Err(Error::encode(
            "AVIF",
            format!("expected {expected_len} bytes, got {}", rgb.len()),
        ));
    }
    use image::ImageEncoder;
    let mut out = Vec::new();
    image::codecs::avif::AvifEncoder::new_with_speed_quality(&mut out, speed.clamp(1, 10), quality)
        .write_image(rgb, width, height, image::ExtendedColorType::Rgb8)
        .map_err(|e| Error::encode("AVIF", e.to_string()))?;
    Ok(out)
}

/// The shared RAW/bitmap RGB and RGBA encoder. Samples are already in `primaries`.
pub fn encode_tagged(
    width: u32,
    height: u32,
    pixels: &[u8],
    channels: u8,
    quality: u8,
    speed: u8,
    primaries: TargetPrimaries,
) -> Result<Vec<u8>> {
    // Preserve existing sRGB derivatives byte-for-byte. Their default AV1
    // colour description already identifies sRGB without an ICC payload.
    if primaries == TargetPrimaries::Srgb {
        return if channels == 3 {
            encode_with_speed(width, height, pixels, quality, speed)
        } else {
            crate::export::encode_avif_rgba_with_speed(width, height, pixels, quality, speed)
        };
    }
    let expected_len = (width as usize) * (height as usize) * usize::from(channels);
    if pixels.len() != expected_len {
        return Err(Error::encode(
            "AVIF",
            format!("expected {} bytes, got {}", expected_len, pixels.len()),
        ));
    }
    let raster = crate::raster::RasterImage::from_raw(width, height, channels, pixels.to_vec())?;
    let profile = crate::icc::profile_for(primaries);
    crate::raster_encode_avif::encode_avif_opts(
        &raster,
        &crate::raster_encode_avif::AvifOptions {
            quality,
            effort: 10 - speed.clamp(1, 10),
            ..Default::default()
        },
        &crate::raster_encode::EmbeddedMetadata {
            icc: Some(&profile),
            ..Default::default()
        },
        primaries,
    )
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
        let err = encode(2, 2, &[0u8; 10], 55).unwrap_err();
        assert!(matches!(err, Error::Encode { format: "AVIF", .. }));
        assert_eq!(
            err.to_string(),
            "AVIF write error: expected 12 bytes, got 10"
        );
    }

    #[test]
    fn faster_speed_still_produces_an_avif() {
        let rgb: Vec<u8> = (0..(8 * 8 * 3)).map(|i| (i % 256) as u8).collect();
        let fast = encode_with_speed(8, 8, &rgb, 55, 10).unwrap();
        let slow = encode_with_speed(8, 8, &rgb, 55, 1).unwrap();
        assert_eq!(&fast[4..8], b"ftyp");
        assert_eq!(&slow[4..8], b"ftyp");
    }

    #[test]
    fn speed_is_clamped_to_the_encoder_range() {
        let rgb = vec![0u8; 2 * 2 * 3];
        assert!(encode_with_speed(2, 2, &rgb, 55, 0).is_ok());
        assert!(encode_with_speed(2, 2, &rgb, 55, 99).is_ok());
    }
}
