use super::*;
use crate::image::ColorSpace;

#[test]
fn projected_points_return_to_original_mask_coordinates() {
    let geometry = Geometry {
        perspective_h: 0.3,
        perspective_v: -0.2,
        rotation: 17.0,
        aspect: 1.3,
        scale: 1.2,
    };
    let forward = geometry.forward(6000, 4000).unwrap();
    let inverse = forward.inverse().unwrap();
    for p in [[0.0, 0.0], [1.0, 1.0], [0.25, 0.75], [0.5, 0.5]] {
        let q = forward.point(p[0], p[1]).unwrap();
        let actual = inverse.point(q[0], q[1]).unwrap();
        assert!((actual[0] - p[0]).abs() < 1e-6 && (actual[1] - p[1]).abs() < 1e-6);
    }
}

#[test]
fn identity_retains_allocation_and_samples() {
    let mut image = Image::new(2, 2, ColorSpace::DisplayEncodedSrgb);
    image.pixels[0] = [0.2, 0.4, 0.8];
    let ptr = image.pixels.as_ptr();
    let mut scratch = vec![];
    apply(
        &mut image,
        Geometry::default().forward(2, 2).unwrap(),
        &mut scratch,
    );
    assert_eq!(image.pixels.as_ptr(), ptr);
    assert_eq!(image.pixels[0], [0.2, 0.4, 0.8]);
    assert!(scratch.is_empty());
}

#[test]
fn half_turn_moves_all_channels_together() {
    let mut image = Image::new(2, 2, ColorSpace::DisplayEncodedSrgb);
    image.pixels = vec![[0.1; 3], [0.2; 3], [0.3; 3], [0.4; 3]];
    let inverse = Geometry {
        rotation: 180.0,
        ..Geometry::default()
    }
    .forward(2, 2)
    .unwrap()
    .inverse()
    .unwrap();
    apply(&mut image, inverse, &mut vec![]);
    for (p, e) in image.pixels.iter().zip([0.4, 0.3, 0.2, 0.1]) {
        assert!((p[0] - e).abs() < 1e-6);
        assert_eq!(p[0], p[1]);
        assert_eq!(p[1], p[2]);
    }
}

#[test]
fn invalid_geometry_is_rejected() {
    for invalid in [f32::NAN, f32::INFINITY, 0.0, -1.0, 5.0] {
        assert!(Geometry {
            scale: invalid,
            ..Geometry::default()
        }
        .forward(2, 2)
        .is_err());
    }
    assert!(Geometry::default().forward(0, 2).is_err());
}

#[test]
fn xmp_roundtrip_preserves_all_manual_controls_and_omits_defaults() {
    use crate::{types::AdjustmentModel, xmp};
    assert!(!xmp::serialize(&AdjustmentModel::default()).contains("papp:Geo"));
    let model = AdjustmentModel {
        geo_perspective_h: 0.2,
        geo_perspective_v: -0.15,
        geo_rotation: 8.5,
        geo_aspect: 1.2,
        geo_scale: 0.75,
        ..AdjustmentModel::default()
    };
    let xml = format!(
        r#"<x><rdf:Description xmlns:rdf="x" xmlns:papp="x"{}/></x>"#,
        xmp::serialize(&model)
    );
    let parsed = xmp::parse(&xml).unwrap();
    assert_eq!(Geometry::from(&parsed), Geometry::from(&model));
}

#[test]
fn display_controls_have_same_meaning_for_every_exif_orientation() {
    let controls = Geometry {
        rotation: 12.0,
        perspective_h: 0.2,
        ..Geometry::default()
    };
    for tag in 1..=8 {
        let orientation = ExifOrientation::from_u16(tag);
        let inverse_sensor = controls.inverse_sensor(6000, 4000, orientation).unwrap();
        let orient = orientation_transform(orientation);
        let (w, h) = if orientation.swaps_wh() {
            (4000, 6000)
        } else {
            (6000, 4000)
        };
        let inverse_display = controls.forward(w, h).unwrap().inverse().unwrap();
        let p = [0.35, 0.65];
        let sampled = inverse_sensor.point(p[0], p[1]).unwrap();
        let actual = orient.point(sampled[0], sampled[1]).unwrap();
        let display = orient.point(p[0], p[1]).unwrap();
        let expected = inverse_display.point(display[0], display[1]).unwrap();
        assert!((actual[0] - expected[0]).abs() < 1e-6 && (actual[1] - expected[1]).abs() < 1e-6);
    }
}
