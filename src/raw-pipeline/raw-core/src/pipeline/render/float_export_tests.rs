use super::*;
use crate::{
    pipeline::{render_export_from_raw, ExportDepth, ExportPixels},
    types::{Crop, Profile},
};

#[test]
fn float_terminal_matches_both_depths_through_orientation_geometry_and_crop() {
    let source = std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../test-fixtures/removal/calibration/source.dng"
    ))
    .unwrap();
    let mut raw = crate::decode_raw(&source, "dng").unwrap();
    for orientation in [
        ExifOrientation::Normal,
        ExifOrientation::Rotate90,
        ExifOrientation::HorizontalFlip,
    ] {
        raw.orientation = orientation;
        for angle in [0.0, 90.0, 2.0] {
            for geometry in [0.0, 10.0] {
                let model = AdjustmentModel {
                    profile: Profile::Neutral,
                    perspective_vertical: geometry,
                    crop: Crop {
                        top: 0.25,
                        left: 0.25,
                        bottom: 0.75,
                        right: 0.75,
                        angle,
                    },
                    ..AdjustmentModel::default()
                };
                for target in [TargetPrimaries::Srgb, TargetPrimaries::P3] {
                    let (w, h, floats) =
                        render_export_f32(&raw, &model, RenderQuality::Amaze, None, target, None)
                            .unwrap();
                    let rgb: Vec<_> = floats
                        .chunks_exact(4)
                        .flat_map(|v| v[..3].iter().copied())
                        .collect();
                    assert_eq!(floats.len(), (w * h * 4) as usize);
                    assert!(floats.iter().all(|v| v.is_finite()));
                    for depth in [ExportDepth::Eight, ExportDepth::Sixteen] {
                        let (rw, rh, pixels) = render_export_from_raw(
                            &raw,
                            &model,
                            RenderQuality::Amaze,
                            None,
                            None,
                            target,
                            depth,
                        )
                        .unwrap();
                        assert_eq!((w, h), (rw, rh));
                        let (scale, reference): (f32, Vec<f32>) = match pixels {
                            ExportPixels::Eight(v) => {
                                (255.0, v.into_iter().map(|v| v as f32).collect())
                            }
                            ExportPixels::Sixteen(v) => {
                                (65535.0, v.into_iter().map(|v| v as f32).collect())
                            }
                        };
                        for (value, reference) in rgb.iter().zip(reference) {
                            assert!((value.clamp(0.0,1.0) * scale - reference).abs() <= 1.1,
                                "orientation={orientation:?} crop={angle} geometry={geometry} target={target:?} depth={depth:?}");
                        }
                    }
                }
            }
        }
    }
}
