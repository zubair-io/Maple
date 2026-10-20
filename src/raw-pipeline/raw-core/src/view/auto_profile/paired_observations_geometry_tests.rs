use super::*;

#[test]
fn registration_geometry_samples_every_cell_at_its_centre() {
    let (width, height) = (512u32, 512u32);
    let image = image::RgbImage::from_fn(width, height, |x, y| {
        image::Rgb([(x % 256) as u8, (y % 256) as u8, 96])
    });
    let pixels: Vec<_> = image.as_raw().iter().map(|v| *v as f32 / 255.).collect();
    let preview = ExtractedPreview {
        image: image::DynamicImage::ImageRgb8(image.clone()),
        color_space: preview::JpegColorSpace::SRgb,
    };
    let set = build_geometry(
        &pixels,
        width as usize,
        height as usize,
        ExifOrientation::Normal,
        &preview,
        &ColorLut::identity(33),
    )
    .unwrap();
    assert_eq!((set.grid_width, set.grid_height), (256, 256));
    assert_eq!(set.rows.len(), 256 * 256);
    for (i, row) in set.rows.iter().enumerate() {
        let (gx, gy) = ((i % 256) as u32, (i / 256) as u32);
        let centre = image.get_pixel(2 * gx + 1, 2 * gy + 1).0;
        for c in 0..3 {
            let expected = f64::from(centre[c]) / 255.;
            assert!((row.baseline[c] - expected).abs() < 1e-6, "{i} {c}");
            assert!((row.target[c] - expected).abs() < 1e-9, "{i} {c}");
        }
    }
}
