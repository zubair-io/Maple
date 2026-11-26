use super::*;

#[test]
fn aligned_training_samples_corresponding_pixels_without_changing_identity_observations() {
    let image = image::RgbImage::from_fn(64, 64, |x, y| {
        image::Rgb([(x * 3) as u8, (y * 3) as u8, 64])
    });
    let pixels: Vec<_> = image.as_raw().iter().map(|v| *v as f32 / 255.).collect();
    let target = image::RgbImage::from_fn(64, 64, |x, y| *image.get_pixel((x + 3).min(63), y));
    let preview = ExtractedPreview {
        image: image::DynamicImage::ImageRgb8(target),
        color_space: preview::JpegColorSpace::SRgb,
    };
    let prior = ColorLut::identity(33);
    let plain = build(&pixels, 64, 64, ExifOrientation::Normal, &preview, &prior).unwrap();
    let identity = build_aligned(
        &pixels,
        64,
        64,
        ExifOrientation::Normal,
        &preview,
        &prior,
        Warp::IDENTITY,
    )
    .unwrap();
    for (a, b) in plain.rows.iter().zip(&identity.rows) {
        assert_eq!(a.weights, b.weights);
        assert_eq!(a.artifact_weights, b.artifact_weights);
        assert_eq!(a.baseline, b.baseline);
        assert_eq!(a.target, b.target);
    }
    let aligned = build_aligned(
        &pixels,
        64,
        64,
        ExifOrientation::Normal,
        &preview,
        &prior,
        Warp {
            coefficients: [1., 0., 3. / 64., 0., 1., 0.],
            ..Warp::IDENTITY
        },
    )
    .unwrap();
    assert_eq!(aligned.rows.len(), 61 * 64);
    for row in aligned.rows {
        for c in 0..3 {
            assert!((row.source[c] - row.target[c]).abs() < 1e-6);
        }
    }
}

#[test]
fn legacy_bias_window_uses_exact_native_pixel_bounds_and_ties_even() {
    for (width, height, bx, by) in [(1616, 1080, 162, 108), (25, 35, 2, 4), (35, 25, 4, 2)] {
        assert!(in_bias_region(bx, by, width, height));
        assert!(in_bias_region(
            width - bx - 1,
            height - by - 1,
            width,
            height
        ));
        assert!(!in_bias_region(bx - 1, by, width, height));
        assert!(!in_bias_region(width - bx, by, width, height));
        assert!(!in_bias_region(bx, by - 1, width, height));
        assert!(!in_bias_region(bx, height - by, width, height));
    }
}

#[test]
fn display_target_matches_pillow_box_after_srgb_quantization() {
    let examples: [(usize, usize, usize, &[u8]); 3] = [
        (
            128,
            64,
            32,
            include_bytes!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../../test-fixtures/auto-jpeg-quality/box-target-32x16.png"
            )),
        ),
        (
            128,
            64,
            57,
            include_bytes!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../../test-fixtures/auto-jpeg-quality/box-target-57x28.png"
            )),
        ),
        (
            384,
            192,
            32,
            include_bytes!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../../test-fixtures/auto-jpeg-quality/box-target-32x16-factor12.png"
            )),
        ),
    ];
    for (width, height, edge, png) in examples {
        let image = image::RgbImage::from_fn(width as u32, height as u32, |x, y| {
            image::Rgb([
                ((13 * x + 11 * y) % 256) as u8,
                ((7 * x + 5 * y) % 256) as u8,
                ((x * x + 3 * y) % 256) as u8,
            ])
        });
        let preview = ExtractedPreview {
            image: image::DynamicImage::ImageRgb8(image),
            color_space: preview::JpegColorSpace::SRgb,
        };
        let pixels = vec![0.5; width * height * 3];
        let expected = image::load_from_memory(png).unwrap().to_rgb8();
        let rows = build_at_scale(
            &pixels,
            width,
            height,
            ExifOrientation::Normal,
            &preview,
            &ColorLut::identity(33),
            Some(edge),
            Sampling::Jittered,
        )
        .unwrap()
        .rows;
        assert_eq!(rows.len(), (expected.width() * expected.height()) as usize);
        for (row, pixel) in rows.iter().zip(expected.pixels()) {
            for c in 0..3 {
                assert_eq!(row.target[c], f64::from(pixel.0[c]) / 255.);
            }
        }
    }
}
#[test]
fn aspect_crop_rounds_half_to_even_like_the_comparator() {
    let image = image::RgbImage::from_fn(17, 16, |x, y| image::Rgb([x as u8, y as u8, 0]));
    let preview = ExtractedPreview {
        image: image::DynamicImage::ImageRgb8(image),
        color_space: preview::JpegColorSpace::SRgb,
    };
    let mut pixels = vec![0.; 44 * 40 * 3];
    for y in 0..40 {
        for x in 0..44 {
            pixels[(y * 44 + x) * 3] = x as f32 / 43.;
        }
    }
    let rows = build(
        &pixels,
        44,
        40,
        ExifOrientation::Normal,
        &preview,
        &ColorLut::identity(33),
    )
    .unwrap()
    .rows;
    let bounds = spans(42, 17);
    for row in rows {
        let x = (row.target[0] * 255.).round() as usize;
        let (lo, hi) = bounds[x];
        let expected = (1. + (lo + hi - 1) as f64 * 0.5) / 43.;
        assert!((row.source[0] - expected).abs() < 1e-6);
    }
}
#[test]
fn sample_coordinates_do_not_depend_on_pointer_width() {
    assert_eq!(within(0xfedcba9876543210, 10, 58), 10);
    assert_eq!(within(0xfedcba9876543210u64 as u32 as u64, 10, 58), 26);
}
#[test]
fn box_spans_follow_pixel_centers_for_resize_in_both_directions() {
    assert_eq!(spans(5, 3), vec![(0, 2), (2, 3), (3, 5)]);
    assert_eq!(spans(3, 5), vec![(0, 1), (0, 1), (1, 2), (2, 3), (2, 3)]);
}
