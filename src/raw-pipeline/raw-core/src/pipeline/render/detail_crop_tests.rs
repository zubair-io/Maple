use super::*;

#[test]
fn crop_detail_matches_full_auto_render_with_exif_and_sensor_crop() {
    let (mut raw, bytes) = chart();
    raw.crop_rect = Some(crate::image::CropRect {
        x: 12,
        y: 16,
        w: raw.width - 32,
        h: raw.height - 40,
    });
    for orientation in [ExifOrientation::Normal, ExifOrientation::Rotate90] {
        raw.orientation = orientation;
        for angle in [0.0, 90.0, 180.0, 270.0, 3.5, -12.0, 89.7, 135.0, 270.2] {
            let model = AdjustmentModel {
                profile: Profile::Neutral,
                exposure: 0.2,
                grain_amount: 30.0,
                vignette_amount: -20.0,
                nr_luminance: 15.0,
                crop: crate::types::Crop {
                    left: 0.13,
                    top: 0.17,
                    right: 0.87,
                    bottom: 0.91,
                    angle,
                },
                ..Default::default()
            };
            let (w, h, expected, context) = render_detail_base(
                &raw,
                &model,
                RawInput::Bytes {
                    bytes: &bytes,
                    ext: "dng",
                },
                DetailRenderOptions {
                    quality: RenderQuality::Auto,
                    max_long_edge: 1024,
                    film_lut: None,
                },
            )
            .unwrap();
            for (x, y) in [(0, 0), (w / 3, h / 3)] {
                let rect = TileRect {
                    src_x: x,
                    src_y: y,
                    src_w: w / 3,
                    src_h: h / 3,
                    out_w: w / 3,
                    out_h: h / 3,
                };
                let (pw, ph, actual) =
                    render_detail_tile(&raw, &context, rect, None, 8_388_608).unwrap();
                assert_eq!((pw, ph), (rect.out_w, rect.out_h));
                let wanted: Vec<u8> = (y..y + ph)
                    .flat_map(|row| {
                        let start = (row * w + x) as usize * 3;
                        expected[start..start + pw as usize * 3].iter().copied()
                    })
                    .collect();
                let error = actual
                    .iter()
                    .zip(&wanted)
                    .map(|(a, b)| a.abs_diff(*b))
                    .max()
                    .unwrap();
                assert!(
                    error <= 1,
                    "Exif={orientation:?}, crop={angle}, origin={x},{y}, error={error}"
                );
            }
        }
    }
}

#[test]
fn edge_tiles_match_full_render_inside_sensor_default_crop() {
    let (mut raw, bytes) = chart();
    raw.crop_rect = Some(crate::image::CropRect {
        x: 12,
        y: 16,
        w: raw.width - 32,
        h: raw.height - 40,
    });
    let model = AdjustmentModel {
        profile: Profile::Neutral,
        nr_luminance: 15.0,
        ..Default::default()
    };
    let (w, h, expected, context) = render_detail_base(
        &raw,
        &model,
        RawInput::Bytes {
            bytes: &bytes,
            ext: "dng",
        },
        DetailRenderOptions {
            quality: RenderQuality::Auto,
            max_long_edge: 1024,
            film_lut: None,
        },
    )
    .unwrap();
    for (x, y, tw, th) in [(0, 0, w / 3, h / 3), (w - w / 3, h - h / 3, w / 3, h / 3)] {
        let rect = TileRect {
            src_x: x,
            src_y: y,
            src_w: tw,
            src_h: th,
            out_w: tw,
            out_h: th,
        };
        let (pw, ph, actual) = render_detail_tile(&raw, &context, rect, None, 8_388_608).unwrap();
        let wanted: Vec<u8> = (y..y + ph)
            .flat_map(|row| {
                let start = (row * w + x) as usize * 3;
                expected[start..start + pw as usize * 3].iter().copied()
            })
            .collect();
        let error = actual
            .iter()
            .zip(&wanted)
            .map(|(a, b)| a.abs_diff(*b))
            .max()
            .unwrap();
        assert!(error <= 1, "tile at {x},{y} differs by {error}");
    }
}
