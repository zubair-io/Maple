use super::*;

#[test]
fn every_exif_box_returns_to_the_same_non_square_native_edges() {
    let displayed = [
        [8.0, 20.0, 28.0, 40.0],
        [72.0, 20.0, 92.0, 40.0],
        [72.0, 40.0, 92.0, 60.0],
        [8.0, 40.0, 28.0, 60.0],
        [20.0, 8.0, 40.0, 28.0],
        [40.0, 8.0, 60.0, 28.0],
        [40.0, 72.0, 60.0, 92.0],
        [20.0, 72.0, 40.0, 92.0],
    ];
    for (index, bounds) in displayed.into_iter().enumerate() {
        let code = index as u16 + 1;
        let result = source_box(bounds, [100, 80], code).unwrap();
        for (actual, expected) in result.into_iter().zip([8.0, 20.0, 28.0, 40.0]) {
            assert!(
                (actual - expected).abs() < 0.00002,
                "EXIF {code}: {result:?}"
            );
        }
        assert_eq!(
            upright_size([100, 80], code).unwrap(),
            if code >= 5 { [80, 100] } else { [100, 80] }
        );
    }
}

#[test]
fn planar_channels_and_pixel_bits_survive_all_orientation_roundtrips() {
    let input: Vec<_> = (0..3 * SIDE * SIDE)
        .map(|index| (index as f32 + 0.25) / (3 * SIDE * SIDE) as f32)
        .collect();
    for code in 1..=8 {
        let upright = upright_rgb(&input, code).unwrap();
        let inverse = match code {
            6 => 8,
            8 => 6,
            other => other,
        };
        assert_eq!(upright_rgb(&upright, inverse).unwrap(), input);
        let channel = SIDE * SIDE;
        assert!(upright[..channel].iter().all(|v| *v < 1.0 / 3.0));
        assert!(upright[channel..2 * channel]
            .iter()
            .all(|v| (1.0 / 3.0..2.0 / 3.0).contains(v)));
        assert!(upright[2 * channel..].iter().all(|v| *v >= 2.0 / 3.0));
    }
}

#[test]
fn normal_boxes_keep_bits_and_outside_edges_are_not_silently_clipped() {
    let bounds = [-0.125, 1.25, 100.125, 79.75];
    assert_eq!(
        source_box(bounds, [100, 80], 1).unwrap().map(f32::to_bits),
        bounds.map(f32::to_bits)
    );
    let mapped = source_box([-1.0, -2.0, 81.0, 102.0], [100, 80], 8).unwrap();
    assert!(mapped[0] < 0.0 && mapped[1] < 0.0 && mapped[2] > 100.0 && mapped[3] > 80.0);
}

#[test]
fn malformed_geometry_and_pixels_refuse_before_detection() {
    assert!(upright_size([0, 80], 1).is_err());
    assert!(upright_size([100, 80], 0).is_err());
    assert!(upright_size([100, 80], 9).is_err());
    assert!(source_box([f32::NAN, 0.0, 10.0, 20.0], [100, 80], 1).is_err());
    assert!(source_box([10.0, 0.0, 1.0, 20.0], [100, 80], 1).is_err());
    assert!(upright_rgb(&[0.0; 3], 1).is_err());
    let mut input = vec![0.0; 3 * SIDE * SIDE];
    input[0] = f32::INFINITY;
    assert!(upright_rgb(&input, 1).is_err());
}
