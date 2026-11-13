//! Repair spots land where they were authored on an EXIF-rotated RAW (#4473).
//!
//! Spots are authored over the upright frame, like masks. The same scene is
//! rendered twice through the export tail: once as a sensor-framed RAW
//! carrying an orientation tag, once with the pixels already upright and a
//! `Normal` tag. A spot evaluated in the wrong frame makes the two differ.

use super::mask_orientation_tests::{export, max_code_delta, sensor_raw, upright_twin};
use super::*;
use crate::image::ExifOrientation;
use crate::types::retouch::{RetouchKind, RetouchSpot};
use crate::types::{Crop, Point2};
use crate::xmp::{AutoExposureMode, HighlightRecoveryMode};

fn model_with_spots(spots: Vec<RetouchSpot>) -> AdjustmentModel {
    AdjustmentModel {
        profile: Profile::Neutral,
        auto_exposure: AutoExposureMode::Off,
        highlight_recovery: HighlightRecoveryMode::Off,
        sharpen_amount: 0.0,
        nr_color: 0.0,
        crop: Crop {
            left: 0.1,
            top: 0.05,
            right: 0.85,
            bottom: 0.9,
            angle: 0.0,
        },
        retouch_spots: spots,
        ..Default::default()
    }
}

fn clone_spots() -> Vec<RetouchSpot> {
    vec![
        RetouchSpot {
            kind: RetouchKind::Clone,
            center: Point2::new(0.31, 0.32),
            source: Point2::new(0.74, 0.65),
            radius: 0.12,
            feather: 0.0,
            opacity: 1.0,
        },
        RetouchSpot {
            kind: RetouchKind::Clone,
            center: Point2::new(0.72, 0.28),
            source: Point2::new(0.25, 0.68),
            radius: 0.1,
            feather: 0.0,
            opacity: 1.0,
        },
    ]
}

#[test]
fn clone_spots_land_in_the_upright_frame_on_a_rotated_raw() {
    let model = model_with_spots(clone_spots());
    let unrepaired = model_with_spots(Vec::new());
    for orientation in [
        ExifOrientation::Rotate90,
        ExifOrientation::Rotate270,
        ExifOrientation::Rotate180,
        ExifOrientation::Transverse,
        ExifOrientation::HorizontalFlip,
        ExifOrientation::VerticalFlip,
        ExifOrientation::Transpose,
    ] {
        let rotated = sensor_raw(orientation);
        let upright = upright_twin(&rotated);
        for max_long_edge in [None, Some(24)] {
            let (w, h, expected) = export(&upright, &model, max_long_edge);
            let (rw, rh, actual) = export(&rotated, &model, max_long_edge);
            assert_eq!((rw, rh), (w, h), "{orientation:?} dims");
            let (_, _, plain) = export(&upright, &unrepaired, max_long_edge);
            assert!(
                max_code_delta(&expected, &plain) > 20,
                "the spots must visibly engage for this test to mean anything"
            );
            let delta = max_code_delta(&expected, &actual);
            assert!(
                delta <= 2,
                "{orientation:?} long edge {max_long_edge:?}: rotated RAW differs from its \
                 upright twin by {delta} codes"
            );
        }
    }
}

#[test]
fn a_sensor_stamped_list_renders_exactly_where_its_upright_equivalent_does() {
    let upright_spots = clone_spots();
    let upright_model = model_with_spots(upright_spots.clone());
    for orientation in [ExifOrientation::Rotate90, ExifOrientation::Transverse] {
        let rotated = sensor_raw(orientation);
        let sensor_spots = crate::stages::retouch::orient_spots_to_sensor(
            &upright_spots,
            crate::types::retouch::RetouchFrame::Upright,
            orientation,
            (rotated.width, rotated.height),
        )
        .into_owned();
        let legacy = AdjustmentModel {
            retouch_frame: crate::types::retouch::RetouchFrame::Sensor,
            ..model_with_spots(sensor_spots)
        };
        let (_, _, expected) = export(&rotated, &upright_model, None);
        let (_, _, actual) = export(&rotated, &legacy, None);
        assert_eq!(max_code_delta(&expected, &actual), 0, "{orientation:?}");
    }
}
