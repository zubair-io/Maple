use super::*;
use std::collections::HashMap;

fn raw() -> RawImage {
    crate::decode_raw(
        include_bytes!("../../../../../test-fixtures/removal/basic/source.dng"),
        "dng",
    )
    .unwrap()
}

#[test]
fn source_anchor_uses_original_and_unoriented_geometry_without_rgb_work() {
    let mut raw = raw();
    let original = ContentDigest::for_bytes(b"immutable source bytes");
    let anchor = removal_calibration_source_anchor(&raw, &original).unwrap();
    assert_eq!((anchor.width, anchor.height), (16, 8));
    assert_eq!(anchor.original, original);
    for orientation in 1..=8 {
        raw.orientation = crate::image::ExifOrientation::from_u16(orientation);
        raw.iso = 12800;
        assert_eq!(
            removal_calibration_source_anchor(&raw, &original).unwrap(),
            anchor
        );
    }
    // The constructor has no AdjustmentModel argument: exposure, WB, profile,
    // presentation crop and display transform cannot enter this fixed recipe.
    raw.raw_data.clear();
    assert_eq!(
        removal_calibration_source_anchor(&raw, &original).unwrap(),
        anchor
    );
    let changed =
        removal_calibration_source_anchor(&raw, &ContentDigest::for_bytes(b"other bytes")).unwrap();
    assert_ne!(changed.original, anchor.original);
    assert_eq!(changed.decode, anchor.decode);
}

#[test]
fn source_anchor_changes_for_prefix_and_crop_inputs() {
    let original = ContentDigest::for_bytes(b"source");
    let source = raw();
    let anchor = removal_calibration_source_anchor(&source, &original).unwrap();
    let mut variants = vec![source.clone(); 7];
    variants[0].crop_rect = Some(CropRect {
        x: 2,
        y: 1,
        w: 12,
        h: 6,
    });
    variants[1].as_shot_neutral = [0.5, 1.0, 0.8];
    variants[2].baseline_exposure = 1.0;
    variants[3].black_level = [2, 3, 4, 5];
    variants[4].white_level -= 1;
    variants[5].cfa = CfaPattern::Bggr;
    variants[6].lens_metadata.active_area = Some(crate::pipeline::pano::opcodes::ActiveAreaRect {
        left: 2,
        top: 2,
        width: 12,
        height: 4,
    });
    for variant in variants {
        let changed = removal_calibration_source_anchor(&variant, &original).unwrap();
        assert_ne!(changed.decode, anchor.decode);
        assert_eq!(changed.original, anchor.original);
    }
}

#[test]
fn matrix_input_order_is_canonical_and_calibration_failure_is_explicit() {
    let original = ContentDigest::for_bytes(b"source");
    let mut source = raw();
    let a = Matrix3([[0.9, 0.01, 0.02], [0.03, 1.0, 0.04], [0.01, 0.02, 0.8]]);
    let b = Matrix3([[0.8, 0.02, 0.03], [0.01, 0.9, 0.02], [0.04, 0.01, 1.0]]);
    source.color_matrices = HashMap::from([(Illuminant::StdA, a), (Illuminant::D65, b)]);
    let anchor = removal_calibration_source_anchor(&source, &original).unwrap();
    source.color_matrices = HashMap::from([(Illuminant::D65, b), (Illuminant::StdA, a)]);
    assert_eq!(
        removal_calibration_source_anchor(&source, &original).unwrap(),
        anchor
    );
    source.color_matrices.insert(Illuminant::D65, a);
    assert_ne!(
        removal_calibration_source_anchor(&source, &original)
            .unwrap()
            .decode,
        anchor.decode
    );
    source.width = 0;
    assert!(removal_calibration_source_anchor(&source, &original).is_err());
    source = raw();
    source.as_shot_neutral[0] = f32::NAN;
    assert!(removal_calibration_source_anchor(&source, &original).is_err());
    source = raw();
    source.baseline_exposure = f32::INFINITY;
    assert!(removal_calibration_source_anchor(&source, &original).is_err());
}
