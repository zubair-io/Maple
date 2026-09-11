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
