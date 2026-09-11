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
