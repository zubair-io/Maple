use raw_core::types::{adjustment::AutoExposureMode, AdjustmentModel, Crop};

#[test]
fn stripped_prefix_changes_for_crop_and_perspective_geometry() {
    let base = AdjustmentModel::default();
    let geometry = AdjustmentModel {
        crop: Crop {
            top: 0.1,
            left: 0.2,
            bottom: 0.9,
            right: 0.8,
            angle: 7.0,
        },
        perspective_vertical: 23.0,
        perspective_horizontal: -17.0,
        perspective_rotate: 3.0,
        perspective_scale: 120.0,
        perspective_aspect: 11.0,
        perspective_x: 4.0,
        perspective_y: -3.0,
        ..base.clone()
    };
    assert_ne!(
        super::super::stripped_prefix_model(&base, AutoExposureMode::Off),
        super::super::stripped_prefix_model(&geometry, AutoExposureMode::Off)
    );
}
