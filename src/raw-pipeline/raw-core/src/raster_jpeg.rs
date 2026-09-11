//! JPEG decode with zune-jpeg in NON-strict mode: a file truncated inside the
//! scan data (the common damage on a library file) still yields the rows that
//! were decoded, matching sharp's `failOn: 'none'` behaviour. `image`'s JPEG
//! wrapper cannot turn strict mode off, so JPEG bypasses it.

use crate::error::{Error, Result};
use crate::image::ExifOrientation;
use crate::raster::RasterImage;
use zune_jpeg::zune_core::bytestream::ZCursor;
use zune_jpeg::zune_core::colorspace::ColorSpace;
use zune_jpeg::zune_core::options::DecoderOptions;
use zune_jpeg::JpegDecoder;

pub(crate) fn decode_jpeg_lenient(bytes: &[u8]) -> Result<RasterImage> {
    let options = DecoderOptions::default()
        .set_strict_mode(false)
        .jpeg_set_out_colorspace(ColorSpace::RGB);
    let mut decoder = JpegDecoder::new_with_options(ZCursor::new(bytes), options);
    let pixels = decoder.decode().map_err(|e| Error::Decode {
        path: "<memory>".into(),
        reason: format!("jpeg decode failed: {e}"),
    })?;
    let info = decoder.info().ok_or_else(|| Error::Decode {
        path: "<memory>".into(),
        reason: "jpeg decode produced no image info".into(),
    })?;
    let (width, height) = (info.width as u32, info.height as u32);
    let expected = width as usize * height as usize * 3;
    if pixels.len() != expected {
        return Err(Error::Decode {
            path: "<memory>".into(),
            reason: format!(
                "jpeg decode produced {} bytes, expected {expected}",
                pixels.len()
            ),
        });
    }
    let orientation = super::raster_exif::extract_exif_orientation(bytes)
        .map(ExifOrientation::from_u16)
        .unwrap_or(ExifOrientation::Normal);
    Ok(RasterImage {
        width,
        height,
        channels: 3,
        data: pixels,
        orientation,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn jpeg_fixture() -> Vec<u8> {
        let rgb: Vec<u8> = (0..(64 * 48))
            .flat_map(|i| [(i % 256) as u8, (i / 64) as u8, 90])
            .collect();
        crate::jpeg::encode(64, 48, &rgb, 90).unwrap()
    }

    fn cut_inside_scan(bytes: &[u8]) -> Vec<u8> {
        let sos = bytes
            .windows(2)
            .position(|w| w == [0xFF, 0xDA])
            .expect("SOS marker");
        let cut = sos + (bytes.len() - sos) * 6 / 10;
        bytes[..cut].to_vec()
    }

    #[test]
    fn decodes_an_intact_jpeg() {
        let img = decode_jpeg_lenient(&jpeg_fixture()).unwrap();
        assert_eq!((img.width, img.height, img.channels), (64, 48, 3));
    }

    #[test]
    fn recovers_a_jpeg_truncated_in_scan_data() {
        let cut = cut_inside_scan(&jpeg_fixture());
        let img = decode_jpeg_lenient(&cut).unwrap();
        assert_eq!((img.width, img.height), (64, 48));
        assert_eq!(img.data.len(), 64 * 48 * 3);
    }

    #[test]
    fn still_rejects_garbage() {
        assert!(decode_jpeg_lenient(b"\xFF\xD8garbage").is_err());
    }
}
