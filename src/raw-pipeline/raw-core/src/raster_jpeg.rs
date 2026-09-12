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

    /// `.jpeg()`'s DEFAULTS — `optimiseCoding: true` with
    /// `chromaSubsampling: '4:2:0'`, both sharp's own — make `jpeg-encoder`
    /// write a NON-INTERLEAVED file: one `Ns=1` scan per component rather
    /// than a single interleaved scan. zune-jpeg decoded that wrongly, so
    /// Maple could not read its own output (#3596). Every combination has to
    /// round-trip, not just the interleaved ones.
    #[test]
    fn every_default_jpeg_option_combination_round_trips() {
        use crate::raster_encode_jpeg::{encode_jpeg_opts, ChromaSubsampling, JpegOptions};

        let src = photographic_64();
        for optimise_coding in [true, false] {
            for chroma_subsampling in [ChromaSubsampling::Yuv420, ChromaSubsampling::Yuv444] {
                let options = JpegOptions {
                    quality: 80,
                    progressive: false,
                    chroma_subsampling,
                    optimise_coding,
                };
                let bytes = encode_jpeg_opts(&src, &options, None, None, None).unwrap();
                let decoded = decode_jpeg_lenient(&bytes).unwrap();
                assert_eq!((decoded.width, decoded.height), (64, 64));
                assert!(
                    !looks_like_the_3596_green_pattern(&decoded.data),
                    "optimise_coding={optimise_coding} {chroma_subsampling:?}: decoded as the \
                     #3596 green pattern"
                );
                let db = psnr(&decoded.data, &src.data);
                assert!(
                    db >= 30.0,
                    "optimise_coding={optimise_coding} {chroma_subsampling:?}: PSNR {db:.2} dB \
                     against the source"
                );
            }
        }
    }

    /// The two Huffman-table choices must decode to the SAME pixels: they
    /// encode the same coefficients with the same quantisation tables and
    /// differ only in how those coefficients are entropy-coded. Any gap is a
    /// decoder bug, and this needs no external oracle to say so — which is
    /// what makes it the sharpest regression guard for #3596, where the
    /// optimised (non-interleaved) file decoded to garbage while the
    /// non-optimised (interleaved) one was perfect.
    #[test]
    fn optimised_and_unoptimised_huffman_tables_decode_identically() {
        use crate::raster_encode_jpeg::{encode_jpeg_opts, ChromaSubsampling, JpegOptions};

        let src = photographic_64();
        for chroma_subsampling in [ChromaSubsampling::Yuv420, ChromaSubsampling::Yuv444] {
            let encode = |optimise_coding: bool| {
                let options = JpegOptions {
                    quality: 80,
                    progressive: false,
                    chroma_subsampling,
                    optimise_coding,
                };
                decode_jpeg_lenient(&encode_jpeg_opts(&src, &options, None, None, None).unwrap())
                    .unwrap()
            };
            let optimised = encode(true);
            let plain = encode(false);
            assert_eq!(
                optimised.data, plain.data,
                "{chroma_subsampling:?}: optimised and unoptimised Huffman tables decoded to \
                 different pixels"
            );
        }
    }
}
