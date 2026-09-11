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
        assert_eq!(meta.orientation, 1);
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
            },
        )
        .unwrap();
        assert_eq!((out.width, out.height), (50, 40));
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
