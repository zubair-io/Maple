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

    // ---- #3596: Maple's own default JPEG must decode ----

    /// 64x64 photographic-shaped fixture: a per-channel gradient plus
    /// deterministic +/-8 noise.
    ///
    /// Both halves matter. The NOISE is what makes each data unit carry real
    /// high-frequency coefficients, so the entropy decoder does real work and
    /// a desynchronised scan shows up — the existing round-trips used flat or
    /// uniform fixtures, which is exactly why they missed #3596. The
    /// GRADIENTS are what make the chroma smooth, so 4:2:0 subsampling is
    /// nearly lossless and the round-trip can be held to a real PSNR floor;
    /// full-range random RGB noise cannot clear 11 dB through 4:2:0 in ANY
    /// encoder, libjpeg-turbo included, so it would say nothing.
    fn photographic_64() -> crate::raster::RasterImage {
        let jitter = |i: usize| -> i32 {
            let x = (i as u32).wrapping_mul(2_654_435_761);
            let x = x.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            i32::from((x >> 13) as u8) % 17 - 8
        };
        let data = (0..(64usize * 64))
            .flat_map(|p| {
                let (x, y) = ((p % 64) as i32, (p / 64) as i32);
                let base = [40 + 3 * x, 60 + 2 * y, 200 - x - y];
                [0usize, 1, 2].map(|c| (base[c] + jitter(p * 3 + c)).clamp(0, 255) as u8)
            })
            .collect();
        crate::raster::RasterImage::new_rgb(64, 64, data)
    }

    fn psnr(a: &[u8], b: &[u8]) -> f64 {
        let n = a.len().min(b.len());
        let sse: f64 = (0..n)
            .map(|i| {
                let d = f64::from(a[i]) - f64::from(b[i]);
                d * d
            })
            .sum();
        let mse = sse / n as f64;
        if mse == 0.0 {
            f64::INFINITY
        } else {
            10.0 * (255.0f64 * 255.0 / mse).log10()
        }
    }

    /// The green-screen signature of the #3596 mis-decode: the luma plane
    /// half-read and the chroma planes left at zero, which `YCbCr -> RGB`
    /// turns into a repeating `(0, 255, 0)`.
    fn looks_like_the_3596_green_pattern(rgb: &[u8]) -> bool {
        rgb.chunks_exact(3)
            .filter(|px| px[1] == 255 && px[0] == 0 && px[2] == 0)
            .count()
            * 4
            > rgb.len() / 3
    }

    /// A real non-interleaved, optimised-Huffman baseline JPEG — one `Ns=1`
    /// scan per component, exactly the structure `jpeg-encoder` writes for
    /// its (and sharp's) default `optimiseCoding: true` + 4:2:0 options.
    ///
    /// Encoded once with `cjpeg -optimize -sample 2x2,1x1,1x1 -scans <script
    /// listing components 0;1;2 as separate scans>` against the same
    /// `photographic_64()` pixel pattern reproduced below, so this crate
    /// never needs its own encoder to hit the bug: main's `raw-core` has no
    /// JPEG encoder capable of writing a non-interleaved multi-scan file
    /// (`crate::jpeg::encode` always emits a single interleaved scan), so the
    /// fixture is committed instead of generated at test time.
    const NONINTERLEAVED_FIXTURE: &[u8] = include_bytes!(
        "../../../../test-fixtures/jpeg-regressions/noninterleaved_420_optimized.jpg"
    );

    /// #3596: zune-jpeg decoded a non-interleaved multi-scan baseline JPEG
    /// wrong — the luma plane half-read and the chroma planes left at zero,
    /// producing the green-screen `(0, 255, 0)` pattern instead of the real
    /// image. This is one of the 58/224 libjpeg-turbo corpus files that
    /// tripped over the bug, pinned down to a single tiny fixture so the
    /// regression is caught without the full corpus checked in.
    #[test]
    fn decodes_non_interleaved_multi_scan_jpeg_correctly() {
        let decoded = decode_jpeg_lenient(NONINTERLEAVED_FIXTURE).unwrap();
        assert_eq!((decoded.width, decoded.height), (64, 64));
        assert!(
            !looks_like_the_3596_green_pattern(&decoded.data),
            "decoded as the #3596 green pattern"
        );

        let src = photographic_64();
        let db = psnr(&decoded.data, &src.data);
        assert!(db >= 30.0, "PSNR {db:.2} dB against the source pattern");
    }
}
