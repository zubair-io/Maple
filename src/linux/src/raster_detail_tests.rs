use super::*;

fn crop(image: &egui::ColorImage, rect: pipeline::TileRect) -> Vec<egui::Color32> {
    (rect.src_y..rect.src_y + rect.src_h)
        .flat_map(|y| {
            let start = y as usize * image.size[0] + rect.src_x as usize;
            image.pixels[start..start + rect.src_w as usize]
                .iter()
                .copied()
        })
        .collect()
}

#[test]
fn raster_native_patches_match_full_export_and_reuse_source_and_base() {
    let (w, h) = (384, 320);
    let rgb: Vec<u8> = (0..w * h)
        .flat_map(|i| {
            [
                ((i % w) % 200 + 20) as u8,
                ((i / w) % 160 + 30) as u8,
                ((i * 7) % 190 + 15) as u8,
            ]
        })
        .collect();
    let bytes = raw_core::png::encode(w, h, &rgb).unwrap();
    let model = AdjustmentModel {
        exposure: 0.5,
        shadows: 20.0,
        highlights: -20.0,
        clarity: 10.0,
        texture: 10.0,
        nr_luminance: 20.0,
        grain_amount: 20.0,
        ..Default::default()
    };
    let mut renderer = RasterDetailRenderer::default();
    let mut previous = None;
    for (x, y) in [(0, 0), (160, 128)] {
        let rect = pipeline::TileRect {
            src_x: x,
            src_y: y,
            src_w: 64,
            src_h: 64,
            out_w: 64,
            out_h: 64,
        };
        let frame = renderer
            .render(&bytes, &model, rect, CancelToken::never(), || false)
            .unwrap()
            .unwrap();
        assert_eq!(frame.native_size, (w, h));
        let expected = crop(&frame.base, rect);
        let max_error = expected
            .iter()
            .zip(&frame.patch.pixels)
            .flat_map(|(a, b)| {
                a.to_array()
                    .into_iter()
                    .zip(b.to_array())
                    .map(|(a, b)| a.abs_diff(b))
            })
            .max()
            .unwrap();
        assert!(max_error <= 1, "native raster patch differs by {max_error}");
        if let Some(base) = previous {
            assert!(Arc::ptr_eq(&base, &frame.base));
        }
        previous = Some(frame.base);
    }
}

#[test]
fn raster_detail_rejects_invalid_rects_budgets_and_global_dehaze() {
    let bytes = raw_core::png::encode(80, 60, &[90; 80 * 60 * 3]).unwrap();
    let image = pipeline::RasterDetailImage::open(&bytes, CancelToken::never()).unwrap();
    let rect = pipeline::TileRect {
        src_x: 0,
        src_y: 0,
        src_w: 32,
        src_h: 24,
        out_w: 32,
        out_h: 24,
    };
    assert!(image
        .render_tile(
            &AdjustmentModel::default(),
            rect,
            None,
            1,
            CancelToken::never()
        )
        .is_err());
    let invalid = pipeline::TileRect { src_x: 81, ..rect };
    assert!(image
        .render_tile(
            &AdjustmentModel::default(),
            invalid,
            None,
            8_388_608,
            CancelToken::never()
        )
        .is_err());
    let model = AdjustmentModel {
        dehaze: 20.0,
        ..Default::default()
    };
    assert!(image
        .render_tile(&model, rect, None, 8_388_608, CancelToken::never())
        .unwrap_err()
        .to_string()
        .contains("dehaze proxy"));
}

#[test]
fn oriented_tiff_detail_matches_export_and_cancellation_keeps_valid_base() {
    use std::sync::atomic::{AtomicBool, Ordering};
    let bytes = std::fs::read(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../test-fixtures/jpeg-tiff/orientation6.tiff"),
    )
    .unwrap();
    let model = AdjustmentModel::default();
    let (w, h, pixels) = pipeline::render_export_raster(
        &bytes,
        &model,
        None,
        raw_core::view::encode::TargetPrimaries::Srgb,
        pipeline::ExportDepth::Eight,
        None,
    )
    .unwrap();
    let pipeline::ExportPixels::Eight(rgb) = pixels else {
        panic!("eight-bit reference")
    };
    let full = egui::ColorImage::from_rgb([w as usize, h as usize], &rgb);
    let rect = pipeline::TileRect {
        src_x: 0,
        src_y: 0,
        src_w: w / 2,
        src_h: h / 2,
        out_w: w / 2,
        out_h: h / 2,
    };
    let mut renderer = RasterDetailRenderer::default();
    let flag = AtomicBool::new(true);
    assert!(renderer
        .render(&bytes, &model, rect, CancelToken::new(&flag), || false)
        .unwrap()
        .is_none());
    assert!(renderer.image.is_none() && renderer.reference.is_none());
    flag.store(false, Ordering::Release);
    let first = renderer
        .render(&bytes, &model, rect, CancelToken::new(&flag), || false)
        .unwrap()
        .unwrap();
    assert_eq!(first.native_size, (w, h));
    assert_eq!(first.patch.pixels, crop(&full, rect));
    flag.store(true, Ordering::Release);
    assert!(renderer
        .render(&bytes, &model, rect, CancelToken::new(&flag), || false)
        .unwrap()
        .is_none());
    flag.store(false, Ordering::Release);
    let resumed = renderer
        .render(&bytes, &model, rect, CancelToken::new(&flag), || false)
        .unwrap()
        .unwrap();
    assert!(Arc::ptr_eq(&first.base, &resumed.base));
    assert_eq!(first.patch.pixels, resumed.patch.pixels);
}

#[test]
fn orthogonal_crop_raster_patches_match_full_export_at_boundary_and_interior() {
    let (w, h) = (384, 320);
    let pixels: Vec<u8> = (0..w * h)
        .flat_map(|i| {
            [
                ((i % w) % 200 + 20) as u8,
                ((i / w) % 160 + 30) as u8,
                ((i * 7) % 190 + 15) as u8,
            ]
        })
        .collect();
    let bytes = raw_core::png::encode(w, h, &pixels).unwrap();
    for angle in [0.0, 90.0, 180.0, 270.0, 3.5, -12.0, 89.7] {
        let model = AdjustmentModel {
            exposure: 0.5,
            clarity: 10.0,
            texture: 10.0,
            nr_luminance: 20.0,
            grain_amount: 20.0,
            vignette_amount: -20.0,
            crop: raw_core::types::Crop {
                left: 0.13,
                top: 0.17,
                right: 0.87,
                bottom: 0.91,
                angle,
            },
            ..Default::default()
        };
        let mut renderer = RasterDetailRenderer::default();
        for (x, y) in [(0, 0), (64, 96)] {
            let rect = pipeline::TileRect {
                src_x: x,
                src_y: y,
                src_w: 64,
                src_h: 48,
                out_w: 64,
                out_h: 48,
            };
            let frame = renderer
                .render(&bytes, &model, rect, CancelToken::never(), || false)
                .unwrap()
                .unwrap();
            let wanted = crop(&frame.base, rect);
            assert_eq!(frame.patch.size, [64, 48]);
            let error = frame
                .patch
                .pixels
                .iter()
                .zip(&wanted)
                .flat_map(|(a, b)| {
                    a.to_array()
                        .into_iter()
                        .zip(b.to_array())
                        .map(|(a, b)| a.abs_diff(b))
                })
                .max()
                .unwrap();
            assert!(error <= 1, "crop={angle}, origin={x},{y}, error={error}");
        }
    }
}
