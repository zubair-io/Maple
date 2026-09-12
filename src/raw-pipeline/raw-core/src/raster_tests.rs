use super::*;

#[test]
fn test_synthetic_raster_resize() {
    let width = 4;
    let height = 4;
    let mut data = Vec::with_capacity((width * height * 3) as usize);
    for _ in 0..(width * height) {
        data.push(255); // R
        data.push(0); // G
        data.push(0); // B
    }

    let raster = RasterImage::new_rgb(width, height, data);
    let resized = resize_raster(
        &raster,
        &ResizeOptions {
            width: 2,
            height: 2,
            fit: ResizeFit::Inside,
            filter: FilterAlg::Lanczos3,
            without_enlargement: true,
            ..Default::default()
        },
    )
    .expect("resize should succeed");

    assert_eq!(resized.width, 2);
    assert_eq!(resized.height, 2);
    assert_eq!(resized.data.len(), 2 * 2 * 3);
    assert_eq!(resized.data[0], 255); // Red preserved
}

#[test]
fn test_tensor_extraction_insightface() {
    let width = 2;
    let height = 2;
    let data = vec![255u8; (width * height * 3) as usize];
    let raster = RasterImage::new_rgb(width, height, data);

    let tensor = extract_tensor(&raster, TensorLayout::Nchw, TensorNormalize::InsightFace)
        .expect("tensor extraction should succeed");

    assert_eq!(tensor.width, 2);
    assert_eq!(tensor.height, 2);
    assert_eq!(tensor.channels, 3);
    assert_eq!(tensor.data.len(), 12);
    assert!((tensor.data[0] - 0.99609375).abs() < 1e-4);
}

/// `probe_raster_metadata`'s `channels`/`has_alpha` pinned against sharp
/// 0.34.5's own `metadata()` (#3507 controller ruling) — measured with a
/// read-only Bun script against a real Grayscale (colour type 0),
/// GrayscaleAlpha (type 4), RGB (type 2) and RGBA (type 6) PNG file (built
/// with `pngjs` so sharp reads a genuine IHDR colour type, not sharp's own
/// opinion about a raw buffer), plus a JPEG:
///
/// ```text
/// Real Grayscale PNG (colorType 0)      channels: 1, hasAlpha: false
/// Real GrayscaleAlpha PNG (colorType 4) channels: 2, hasAlpha: true
/// Real RGB PNG (colorType 2)            channels: 3, hasAlpha: false
/// Real RGBA PNG (colorType 6)           channels: 4, hasAlpha: true
/// JPEG                                  channels: 3, hasAlpha: false
/// ```
mod probe_channels_and_alpha {
    use super::*;

    fn png_with_color_type(color: image::ExtendedColorType, data: &[u8]) -> Vec<u8> {
        use image::{codecs::png::PngEncoder, ImageEncoder};
        let mut out = Vec::new();
        PngEncoder::new(&mut out)
            .write_image(data, 4, 4, color)
            .unwrap();
        out
    }

    #[test]
    fn probe_reports_three_channels_no_alpha_for_an_rgb_png() {
        let bytes = png_with_color_type(image::ExtendedColorType::Rgb8, &[128u8; 4 * 4 * 3]);
        let meta = probe_raster_metadata(&bytes).unwrap();
        assert_eq!((meta.channels, meta.has_alpha), (3, false));
    }

    #[test]
    fn probe_reports_four_channels_with_alpha_for_an_rgba_png() {
        let bytes = png_with_color_type(image::ExtendedColorType::Rgba8, &[128u8; 4 * 4 * 4]);
        let meta = probe_raster_metadata(&bytes).unwrap();
        assert_eq!((meta.channels, meta.has_alpha), (4, true));
    }

    #[test]
    fn probe_reports_one_channel_no_alpha_for_a_grey_png() {
        let bytes = png_with_color_type(image::ExtendedColorType::L8, &[128u8; 4 * 4]);
        let meta = probe_raster_metadata(&bytes).unwrap();
        assert_eq!((meta.channels, meta.has_alpha), (1, false));
    }

    #[test]
    fn probe_reports_two_channels_with_alpha_for_a_grey_alpha_png() {
        let bytes = png_with_color_type(image::ExtendedColorType::La8, &[128u8; 4 * 4 * 2]);
        let meta = probe_raster_metadata(&bytes).unwrap();
        assert_eq!((meta.channels, meta.has_alpha), (2, true));
    }

    #[test]
    fn probe_reports_three_channels_no_alpha_for_a_jpeg() {
        let bytes = crate::jpeg::encode(4, 4, &[128u8; 4 * 4 * 3], 90).unwrap();
        let meta = probe_raster_metadata(&bytes).unwrap();
        assert_eq!((meta.channels, meta.has_alpha), (3, false));
    }
}

#[cfg(feature = "avif")]
mod avif_dispatch {
    use crate::raster::{decode_raster, probe_raster_metadata};

    fn tiny_avif() -> Vec<u8> {
        let rgb: Vec<u8> = (0..(24 * 16))
            .flat_map(|i| [(i % 256) as u8, 40, 200])
            .collect();
        crate::avif::encode(24, 16, &rgb, 70).unwrap()
    }

    #[test]
    fn decode_raster_accepts_avif_by_sniffing() {
        let img = decode_raster(&tiny_avif(), None).unwrap();
        assert_eq!((img.width, img.height, img.channels), (24, 16, 3));
    }

    #[test]
    fn decode_raster_accepts_avif_by_hint() {
        let img = decode_raster(&tiny_avif(), Some("avif")).unwrap();
        assert_eq!((img.width, img.height), (24, 16));
    }

    #[test]
    fn probe_reports_avif_dimensions_without_decoding() {
        let meta = probe_raster_metadata(&tiny_avif()).unwrap();
        assert_eq!(
            (meta.width, meta.height, meta.format.as_str(), meta.channels),
            (24, 16, "avif", 3)
        );
        // An AVIF never reports an orientation: its transform is applied to
        // the pixels at decode, and libvips surfaces no orientation for a
        // HEIF-family file either (#3507 round 3).
        assert_eq!(meta.orientation, None);
    }

    /// An AVIF carrying a separate alpha item must probe as 4 channels —
    /// the container-level `has_alpha` fact, read without decoding either
    /// item's pixels.
    #[test]
    fn probe_reports_four_channels_for_an_avif_with_an_alpha_item() {
        use image::{codecs::avif::AvifEncoder, ExtendedColorType, ImageEncoder};
        let (w, h) = (16u32, 8u32);
        let rgba: Vec<u8> = (0..(w * h))
            .flat_map(|i| [10u8, 120, 240, if i % 3 == 0 { 255 } else { 0 }])
            .collect();
        let mut bytes = Vec::new();
        AvifEncoder::new_with_speed_quality(&mut bytes, 8, 90)
            .write_image(&rgba, w, h, ExtendedColorType::Rgba8)
            .unwrap();
        let meta = probe_raster_metadata(&bytes).unwrap();
        assert_eq!(
            (meta.width, meta.height, meta.format.as_str(), meta.channels),
            (w, h, "avif", 4)
        );
    }
}

// Only compiles (and is meaningful) without the `avif` feature: verifies the
// feature-off dispatch path in `decode_raster` uses the same brand check as
// the real decoder, rather than a looser "any ftyp box" heuristic that would
// misreport other ISO-BMFF containers (HEIC, MP4, MOV) as needing the `avif`
// feature.
#[cfg(not(feature = "avif"))]
mod avif_feature_off {
    use crate::raster::decode_raster;

    /// Minimal ISO-BMFF `ftyp` box: 4-byte size, "ftyp", 4-byte major brand,
    /// 4-byte minor version, then compatible brands, zero-padded to 32 bytes
    /// total (the window `is_avif` scans).
    fn ftyp_box(major_brand: &[u8; 4], compatible_brands: &[&[u8; 4]]) -> Vec<u8> {
        let mut bytes = vec![0u8; 32];
        bytes[0..4].copy_from_slice(&[0, 0, 0, 24]);
        bytes[4..8].copy_from_slice(b"ftyp");
        bytes[8..12].copy_from_slice(major_brand);
        // bytes[12..16] left zeroed: the minor_version field.
        let mut offset = 16;
        for brand in compatible_brands {
            assert!(
                offset + 4 <= 32,
                "test fixture has too many compatible brands for a 32-byte box"
            );
            bytes[offset..offset + 4].copy_from_slice(*brand);
            offset += 4;
        }
        bytes
    }

    #[test]
    fn non_avif_isobmff_container_is_not_misreported_as_needing_the_avif_feature() {
        // A real single-image HEIC ftyp box: major brand "heic", and no
        // avif/avis/mif1 brand anywhere in the compatible-brands list. Checks
        // for the exact reason text the feature-off gate emits (backticks
        // included) — a looser substring like "avif feature" (no backticks)
        // never appears in that reason at all, so it can't tell a fixed
        // build apart from the pre-fix "any ftyp box is AVIF" bug.
        let bytes = ftyp_box(b"heic", &[b"heic", b"hevc", b"heix"]);
        let err = decode_raster(&bytes, None).unwrap_err().to_string();
        assert!(
            !err.contains("requires the `avif` feature"),
            "a non-AVIF ISO-BMFF container must not be misreported as needing the avif feature: {err}"
        );
    }

    #[test]
    fn avif_isobmff_container_reports_the_missing_feature() {
        let bytes = ftyp_box(b"avif", &[b"mif1", b"miaf"]);
        let err = decode_raster(&bytes, None).unwrap_err().to_string();
        assert!(
            err.contains("requires the `avif` feature"),
            "an AVIF container should report the missing feature, got: {err}"
        );
    }
}

mod raw_input {
    use crate::raster::RasterImage;

    #[test]
    fn from_raw_accepts_rgb_and_rgba() {
        let rgb = RasterImage::from_raw(2, 1, 3, vec![1, 2, 3, 4, 5, 6]).unwrap();
        assert_eq!((rgb.channels, rgb.data.len()), (3, 6));
        let rgba = RasterImage::from_raw(1, 1, 4, vec![9, 9, 9, 255]).unwrap();
        assert_eq!(rgba.channels, 4);
    }

    #[test]
    fn from_raw_expands_grey_to_rgb() {
        let img = RasterImage::from_raw(2, 1, 1, vec![10, 200]).unwrap();
        assert_eq!(img.channels, 3);
        assert_eq!(img.data, vec![10, 10, 10, 200, 200, 200]);
    }

    #[test]
    fn from_raw_rejects_bad_lengths_and_channels() {
        assert!(RasterImage::from_raw(2, 2, 3, vec![0; 11]).is_err());
        assert!(RasterImage::from_raw(1, 1, 2, vec![0; 2]).is_err());
        assert!(RasterImage::from_raw(0, 1, 3, vec![]).is_err());
        assert!(RasterImage::from_raw(u32::MAX, u32::MAX, 3, vec![0; 3]).is_err());
    }

    #[test]
    fn into_rgb8_drops_alpha() {
        let img = RasterImage::from_raw(1, 1, 4, vec![7, 8, 9, 0])
            .unwrap()
            .into_rgb8();
        assert_eq!((img.channels, img.data), (3, vec![7, 8, 9]));
    }
}

mod cover_fit {
    use crate::raster::{resize_raster, FilterAlg, RasterImage, ResizeFit, ResizeOptions};

    fn img(w: u32, h: u32) -> RasterImage {
        RasterImage::new_rgb(w, h, vec![128; (w * h * 3) as usize])
    }

    #[test]
    fn cover_fills_the_box_and_centre_crops() {
        let out = resize_raster(
            &img(400, 200),
            &ResizeOptions {
                width: 100,
                height: 100,
                fit: ResizeFit::Cover,
                filter: FilterAlg::Bilinear,
                without_enlargement: true,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!((out.width, out.height), (100, 100));
    }

    #[test]
    fn cover_without_enlargement_never_upscales() {
        let out = resize_raster(
            &img(50, 40),
            &ResizeOptions {
                width: 100,
                height: 100,
                fit: ResizeFit::Cover,
                filter: FilterAlg::Bilinear,
                without_enlargement: true,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!((out.width, out.height), (50, 40));
    }

    /// A single-axis `cover` scales BOTH axes by the requested axis's factor
    /// and crops nothing — sharp's `ResolveShrink` copies the fixed axis's
    /// shrink onto the free one for every canvas but `fill`, and the free
    /// axis is then resolved against the RESIZED size, so there is no box
    /// left to crop to. Measured against sharp 0.34.5 / libvips 8.17.3 on a
    /// 400x200 source: `{ width: 100 }` -> 100x50, `{ height: 100 }` ->
    /// 200x100, with or without `withoutEnlargement`.
    ///
    /// This is the opposite of what the box-is-the-source reading gave
    /// (100x200 and 400x100, a full-height/full-width centre crop). The
    /// package never passes a zero axis together with `cover` — it is the
    /// C ABI's "keep this axis" encoding — but the FFI accepts it, so the
    /// behaviour is pinned to sharp's rather than to our own invention.
    #[test]
    fn a_single_axis_cover_scales_both_axes_and_crops_nothing() {
        let cover = |w, h| {
            resize_raster(
                &img(400, 200),
                &ResizeOptions {
                    width: w,
                    height: h,
                    fit: ResizeFit::Cover,
                    filter: FilterAlg::Bilinear,
                    without_enlargement: true,
                    ..Default::default()
                },
            )
            .unwrap()
        };
        let by_width = cover(100, 0);
        assert_eq!((by_width.width, by_width.height), (100, 50));
        let by_height = cover(0, 100);
        assert_eq!((by_height.width, by_height.height), (200, 100));
    }

    #[test]
    fn crop_extracts_the_window() {
        let src = RasterImage::new_rgb(3, 2, (0..18).collect());
        let c = src.crop(1, 0, 2, 2).unwrap();
        assert_eq!((c.width, c.height), (2, 2));
        assert_eq!(c.data, vec![3, 4, 5, 6, 7, 8, 12, 13, 14, 15, 16, 17]);
        assert!(src.crop(2, 0, 2, 2).is_err());
        assert!(src.crop(u32::MAX, 0, 2, 2).is_err());
    }
}

/// The EXIF orientation a PNG or WebP declares in its own metadata chunk
/// reaches both the probe and the decoded image (#3507 final fix wave,
/// item 4). Before this, `extract_exif_orientation` only understood a bare
/// TIFF header and a JPEG APP1, so `.rotate()`/`autoOrient` was a silent
/// no-op on both containers — measured against sharp on a 24×16 source
/// with orientation 6: sharp gave 16×24, Maple 24×16.
mod container_orientation {
    use super::*;

    /// A little-endian EXIF block whose IFD0 says Orientation = `value`.
    fn exif_block(value: u16) -> Vec<u8> {
        crate::raster_meta::set_exif_orientation(&[], value)
    }

    /// An 8×4 RGB PNG carrying an `eXIf` chunk (the bare TIFF header form
    /// PNG stores, and what libvips writes).
    fn png_with_exif(orientation: u16) -> Vec<u8> {
        let data = vec![90u8; 8 * 4 * 3];
        let mut out: Vec<u8> = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut out, 8, 4);
            encoder.set_color(png::ColorType::Rgb);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder.write_header().unwrap();
            writer
                .write_chunk(png::chunk::eXIf, &exif_block(orientation))
                .unwrap();
            writer.write_image_data(&data).unwrap();
        }
        out
    }

    /// An 8×4 RGB WebP carrying an `EXIF` RIFF chunk.
    fn webp_with_exif(orientation: u16) -> Vec<u8> {
        use image::ImageEncoder;
        let data = vec![90u8; 8 * 4 * 3];
        let mut out: Vec<u8> = Vec::new();
        let mut encoder = image::codecs::webp::WebPEncoder::new_lossless(&mut out);
        encoder.set_exif_metadata(exif_block(orientation)).unwrap();
        encoder
            .write_image(&data, 8, 4, image::ExtendedColorType::Rgb8)
            .unwrap();
        out
    }

    #[test]
    fn a_tiff_with_no_orientation_tag_still_reports_one() {
        // libvips' TIFF loader always reports an orientation — measured:
        // sharp says `1` for a plain TIFF and for one whose Orientation
        // entry was removed, where the same treatment of a JPEG, PNG or
        // WebP gives `undefined` (#3507 round 4).
        let mut bytes = b"II\x2a\x00".to_vec();
        bytes.extend_from_slice(&8u32.to_le_bytes());
        let entries: [(u16, u16, u32, u32); 4] = [
            (0x0100, 3, 1, 4),  // ImageWidth
            (0x0101, 3, 1, 2),  // ImageLength
            (0x0102, 3, 1, 8),  // BitsPerSample
            (0x0111, 4, 1, 62), // StripOffsets — where the pixels start
        ];
        bytes.extend_from_slice(&(entries.len() as u16).to_le_bytes());
        for (tag, kind, count, value) in entries {
            bytes.extend_from_slice(&tag.to_le_bytes());
            bytes.extend_from_slice(&kind.to_le_bytes());
            bytes.extend_from_slice(&count.to_le_bytes());
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        bytes.extend_from_slice(&0u32.to_le_bytes()); // no next IFD
        bytes.extend_from_slice(&[128u8; 4 * 2]); // 4x2 greyscale pixels
        let meta = probe_raster_metadata(&bytes).unwrap();
        assert_eq!(meta.format, "tiff");
        assert_eq!(meta.orientation, Some(1));
    }

    #[test]
    fn a_png_exif_chunk_orientation_reaches_the_probe_and_the_decode() {
        let bytes = png_with_exif(6);
        assert_eq!(probe_raster_metadata(&bytes).unwrap().orientation, Some(6));
        let mut decoded = decode_raster(&bytes, None).unwrap();
        assert_eq!(decoded.orientation, crate::image::ExifOrientation::Rotate90);
        decoded.auto_orient();
        assert_eq!((decoded.width, decoded.height), (4, 8));
    }

    #[test]
    fn a_webp_exif_chunk_orientation_reaches_the_probe_and_the_decode() {
        let bytes = webp_with_exif(3);
        assert_eq!(probe_raster_metadata(&bytes).unwrap().orientation, Some(3));
        let decoded = decode_raster(&bytes, None).unwrap();
        assert_eq!(
            decoded.orientation,
            crate::image::ExifOrientation::Rotate180
        );
    }

    #[test]
    fn a_container_that_declares_no_orientation_reports_none() {
        let data = vec![10u8; 8 * 4 * 3];
        let mut out: Vec<u8> = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut out, 8, 4);
            encoder.set_color(png::ColorType::Rgb);
            encoder.set_depth(png::BitDepth::Eight);
            encoder
                .write_header()
                .unwrap()
                .write_image_data(&data)
                .unwrap();
        }
        // `undefined`, not `1`, is what sharp reports for a JPEG, PNG or
        // WebP that declares no orientation — measured on sharp 0.34.5 for
        // a container with no EXIF block and for one whose Orientation
        // entry was removed (#3507 round 4). Decoding still treats it as
        // the identity.
        assert_eq!(probe_raster_metadata(&out).unwrap().orientation, None);
        assert_eq!(
            decode_raster(&out, None).unwrap().orientation,
            crate::image::ExifOrientation::Normal
        );
    }
}
