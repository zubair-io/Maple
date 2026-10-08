//! A headless develop renders a brush from its dabs alone (#360): no host
//! registered a raster, so the develop entry must rasterize it.

use super::{BrushDab, Mask, Point2};
use crate::image::{CfaPattern, ExifOrientation, RawImage};
use crate::pipeline::{
    develop_scene_linear_from_raw_with_quality_cancellable_with_gain, RenderQuality,
};
use crate::types::AdjustmentModel;
use crate::types::{LocalAdjustment, PartialAdjustments};
use crate::CancelToken;

fn grey_raw(width: u32, height: u32) -> RawImage {
    RawImage {
        width,
        height,
        cfa: CfaPattern::Rggb,
        black_level: [0, 0, 0, 0],
        white_level: 1023,
        raw_data: vec![300u16; (width as usize) * (height as usize)],
        as_shot_neutral: [1.0, 1.0, 1.0],
        as_shot_cct: None,
        camera_make: "Test".into(),
        camera_model: "Test".into(),
        unique_camera_model: None,
        color_matrices: std::collections::HashMap::new(),
        forward_matrices: std::collections::HashMap::new(),
        orientation: ExifOrientation::Normal,
        baseline_exposure: 0.0,
        hsm_data: std::collections::HashMap::new(),
        plt: None,
        profile_tone_curve: None,
        profile_gain_table_map: None,
        crop_rect: None,
        iso: 100,
        noise_profile: None,
        opcode_list3: None,
        aperture: None,
        focal_length: None,
        lens_metadata: Default::default(),
    }
}

fn develop(model: &AdjustmentModel) -> crate::image::Image {
    develop_scene_linear_from_raw_with_quality_cancellable_with_gain(
        &grey_raw(256, 128),
        model,
        RenderQuality::Preview,
        CancelToken::never(),
    )
    .expect("develop")
    .0
}

#[test]
fn unregistered_brush_brightens_only_where_it_was_painted() {
    let brushed = AdjustmentModel {
        local_adjustments: vec![LocalAdjustment {
            mask: Mask::Brush {
                dabs: vec![BrushDab::new(Point2::new(0.1, 0.5), 0.15, 0.0, 1.0, false)],
                digest: String::new(),
                raster_id: 0,
            },
            range: None,
            adjustments: PartialAdjustments {
                exposure: Some(1.0),
                ..Default::default()
            },
        }],
        ..Default::default()
    };
    let base = develop(&AdjustmentModel::default());
    let out = develop(&brushed);
    let at = |img: &crate::image::Image, nx: f32| {
        let x = (nx * (img.width - 1) as f32).round() as usize;
        img.pixels[(img.height as usize / 2) * img.width as usize + x][1]
    };
    assert!((at(&out, 0.9) - at(&base, 0.9)).abs() < 1e-6);
    assert!(
        at(&out, 0.1) > at(&base, 0.1) * 1.9,
        "painted {} vs base {}",
        at(&out, 0.1),
        at(&base, 0.1)
    );
}
