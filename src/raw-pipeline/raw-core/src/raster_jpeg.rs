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
use zune_jpeg::ImageInfo;
use zune_jpeg::JpegDecoder;

fn jpeg_error(reason: String) -> Error {
    Error::Decode {
        path: "<memory>".into(),
        reason,
    }
}

/// zune-jpeg's 16384 px per-side default rejects ordinary stitched panoramas
/// (#5474), so the per-side cap is lifted and the decode is bounded by the
/// same pixel ceiling and allocation budget as every other bitmap format.
/// Progressive files, and baseline files whose scans are not interleaved
/// (which the frame header cannot reveal), hold one i16 coefficient per
/// sample for the whole frame. That is charged for every component at full
/// resolution padded to the largest 32 px MCU, the worst case before chroma
/// subsampling, plus a fixed allowance for the per-MCU-row buffers.
fn check_decode_budget(info: &ImageInfo) -> Result<()> {
    const ROW_BUFFER_ALLOWANCE: u64 = 32 * 1024 * 1024;
    let (width, height) = (u64::from(info.width), u64::from(info.height));
    let pixels = width * height;
    if pixels > u64::from(crate::raster::MAX_RASTER_PIXELS) {
        return Err(jpeg_error(format!(
            "jpeg dimensions {width}x{height} exceed the {} pixel limit",
            crate::raster::MAX_RASTER_PIXELS
        )));
    }
    let padded = width.div_ceil(32) * 32 * height.div_ceil(32) * 32;
    let may_hold_coefficients = info.sof.is_progressive() || info.components > 1;
    let coefficients = if may_hold_coefficients {
        padded * u64::from(info.components) * 2
    } else {
        0
    };
    let needed = pixels * 3 + coefficients + ROW_BUFFER_ALLOWANCE;
    if needed > crate::raster::MAX_BITMAP_DECODE_BYTES {
        return Err(jpeg_error(format!(
            "jpeg {width}x{height} needs {needed} bytes to decode, over the {} byte budget",
            crate::raster::MAX_BITMAP_DECODE_BYTES
        )));
    }
    Ok(())
}

pub(crate) fn decode_jpeg_lenient(bytes: &[u8]) -> Result<RasterImage> {
    let options = DecoderOptions::default()
        .set_strict_mode(false)
        .set_max_width(usize::from(u16::MAX))
        .set_max_height(usize::from(u16::MAX))
        .jpeg_set_out_colorspace(ColorSpace::RGB);
    let mut decoder = JpegDecoder::new_with_options(ZCursor::new(bytes), options);
    decoder
        .decode_headers()
        .map_err(|e| jpeg_error(format!("jpeg decode failed: {e}")))?;
    let info = decoder
        .info()
        .ok_or_else(|| jpeg_error("jpeg decode produced no image info".into()))?;
    check_decode_budget(&info)?;
    let pixels = decoder
        .decode()
        .map_err(|e| jpeg_error(format!("jpeg decode failed: {e}")))?;
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

    /// Rewrite the frame header's declared size, leaving the scan untouched.
    fn with_declared_size(mut bytes: Vec<u8>, width: u16, height: u16) -> Vec<u8> {
        let sof = bytes
            .windows(2)
            .position(|w| w[0] == 0xFF && matches!(w[1], 0xC0 | 0xC2))
            .expect("SOF marker");
        bytes[sof + 5..sof + 7].copy_from_slice(&height.to_be_bytes());
        bytes[sof + 7..sof + 9].copy_from_slice(&width.to_be_bytes());
        bytes
    }

    #[test]
    fn decodes_a_panorama_wider_than_the_zune_default_limit() {
        let (width, height) = (19_000u32, 16u32);
        let rgb: Vec<u8> = (0..width * height)
            .flat_map(|i| [((i % width) / 75) as u8, 128, 64])
            .collect();
        let bytes = crate::jpeg::encode(width, height, &rgb, 90).unwrap();
        let img = decode_jpeg_lenient(&bytes).unwrap();
        assert_eq!((img.width, img.height, img.channels), (width, height, 3));
        assert_eq!(img.data.len(), (width * height * 3) as usize);
    }

    #[test]
    fn rejects_a_declared_size_above_the_shared_pixel_ceiling() {
        let bomb = with_declared_size(jpeg_fixture(), u16::MAX, u16::MAX);
        let error = decode_jpeg_lenient(&bomb).unwrap_err().to_string();
        assert!(error.contains("268000000 pixel limit"), "{error}");
    }

    #[test]
    fn rejects_a_progressive_frame_whose_coefficients_exceed_the_byte_budget() {
        use crate::raster_encode::EmbeddedMetadata;
        use crate::raster_encode_jpeg::{encode_jpeg_opts, ChromaSubsampling, JpegOptions};

        let options = JpegOptions {
            quality: 80,
            progressive: true,
            chroma_subsampling: ChromaSubsampling::Yuv444,
            optimise_coding: true,
        };
        let progressive =
            encode_jpeg_opts(&photographic_64(), &options, &EmbeddedMetadata::default()).unwrap();
        // 256 MP is under the pixel ceiling; its RGB output plus three i16
        // coefficient planes is about 2.3 GB, over the 2 GiB budget.
        let bomb = with_declared_size(progressive, 16_000, 16_000);
        let error = decode_jpeg_lenient(&bomb).unwrap_err().to_string();
        assert!(error.contains("byte budget"), "{error}");
    }

    /// A non-interleaved baseline file allocates the same full-frame
    /// coefficient planes as a progressive one, but its frame header says
    /// baseline, so the budget must charge them for it too.
    #[test]
    fn rejects_a_non_interleaved_baseline_frame_over_the_byte_budget() {
        let bomb = with_declared_size(NONINTERLEAVED_FIXTURE.to_vec(), 16_000, 16_000);
        let error = decode_jpeg_lenient(&bomb).unwrap_err().to_string();
        assert!(error.contains("byte budget"), "{error}");
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
        use crate::raster_encode::EmbeddedMetadata;
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
                let bytes = encode_jpeg_opts(&src, &options, &EmbeddedMetadata::default()).unwrap();
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
        use crate::raster_encode::EmbeddedMetadata;
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
                decode_jpeg_lenient(
                    &encode_jpeg_opts(&src, &options, &EmbeddedMetadata::default()).unwrap(),
                )
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
