use super::*;
use crate::{
    color::{
        hsm::{HsmEncoding, HsmTable},
        illuminant::Illuminant,
        matrices::M_PRO_TO_XYZ_D50,
    },
    image::{CropRect, ExifOrientation},
    stages::wb_camera,
    types::DemosaicChoice,
};
use std::sync::atomic::AtomicBool;

pub(super) fn source() -> RawImage {
    let mut raw = crate::decode_raw(
        include_bytes!("../../../../../test-fixtures/removal/basic/source.dng"),
        "dng",
    )
    .unwrap();
    for (index, value) in raw.raw_data.iter_mut().enumerate() {
        *value = (1000 + index * 17) as u16;
    }
    raw.crop_rect = Some(CropRect {
        x: 2,
        y: 2,
        w: 12,
        h: 6,
    });
    raw
}

fn patch(plate: &Image) -> InpaintPatch {
    InpaintPatch {
        width: plate.width,
        height: plate.height,
        origin: [0.0, 0.0],
        extent: [1.0, 1.0],
        pixels: plate.pixels.clone(),
        coverage: (0..plate.pixels.len())
            .map(|i| match i % 3 {
                0 => 0.0,
                1 => 0.5,
                _ => 1.0,
            })
            .collect(),
    }
}

fn close(a: [f32; 3], b: [f32; 3]) {
    for c in 0..3 {
        assert!(
            (a[c] - b[c]).abs() <= 3e-6 * (1.0 + b[c].abs()),
            "{a:?} != {b:?}"
        );
    }
}

#[test]
fn empty_stack_is_exact_for_existing_settings() {
    let raw = source();
    let mut model = AdjustmentModel::default();
    model.exposure = 1.25;
    model.temperature = 4300.0;
    model.tint = 17.0;
    model.demosaic = DemosaicChoice::Rcd;
    let ordinary = super::super::develop_scene_linear_from_raw_with_quality(
        &raw,
        &model,
        RenderQuality::Amaze,
    )
    .unwrap();
    let actual =
        develop_removal_calibration_patches(&raw, &model, &[], CancelToken::never()).unwrap();
    assert_eq!(actual.pixels, ordinary.pixels);
    assert_eq!(actual.whites_anchor_ev, ordinary.whites_anchor_ev);
}

#[test]
fn identity_patch_regrades_in_actual_camera_wb_chain() {
    let raw = source();
    let original = raw.raw_data.clone();
    let plate = render_removal_calibration_plate(&raw, CancelToken::never()).unwrap();
    assert_eq!((plate.width, plate.height), (12, 6));
    let patch = patch(&plate);
    for (temperature, tint) in [(6500.0, 0.0), (3500.0, -20.0), (10000.0, 30.0)] {
        for exposure in [-3.0, 0.0, 3.0] {
            let model = AdjustmentModel {
                temperature,
                tint,
                exposure,
                ..anchor_model()
            };
            let ordinary = super::super::develop_scene_linear_from_raw_with_quality(
                &raw,
                &model,
                RenderQuality::Amaze,
            )
            .unwrap();
            let actual = develop_removal_calibration_patches(
                &raw,
                &model,
                std::slice::from_ref(&patch),
                CancelToken::never(),
            )
            .unwrap();
            assert_eq!(actual.whites_anchor_ev, ordinary.whites_anchor_ev);
            for (i, (a, b)) in actual.pixels.iter().zip(&ordinary.pixels).enumerate() {
                if patch.coverage[i] == 0.0 {
                    assert_eq!(a, b);
                } else {
                    close(*a, *b);
                }
            }
        }
    }
    assert_eq!(raw.raw_data, original);
}

#[test]
fn signed_hdr_transport_has_no_hsm_or_soft_floor_loss() {
    let raw = source();
    let mut profile = dcp::profile_for(&raw).unwrap();
    profile.hsm = HsmTable::new(
        [1, 2, 1],
        vec![0.0, 1.0, 1.0, 37.0, 0.5, 1.8],
        HsmEncoding::Linear,
    );
    for forward in [None, Some(M_PRO_TO_XYZ_D50)] {
        profile.forward_matrix = forward;
        let (to_scene, _) = matrices(&profile).unwrap();
        let value = [-0.25, 4.0, 0.125];
        let mut camera = Image::new(1, 1, ColorSpace::CameraNativeLinearRgb);
        camera.pixels[0] = [1.0; 3];
        let mut p = patch(&camera);
        p.pixels[0] = to_scene.mul_vec(value);
        p.coverage[0] = 1.0;
        composite_camera(&mut camera, &[p], &profile).unwrap();
        close(camera.pixels[0], value);
        assert!(camera.pixels[0][0] < 0.0);
        assert!(camera.pixels[0][1] > 1.0);
    }
}

#[test]
fn replacement_runs_through_nonlinear_profile_after_camera_wb() {
    let raw = source();
    let mut profile = dcp::profile_for(&raw).unwrap();
    profile.forward_matrix = Some(M_PRO_TO_XYZ_D50);
    profile.hsm = HsmTable::new(
        [1, 2, 1],
        vec![0.0, 1.0, 1.0, 30.0, 0.6, 1.3],
        HsmEncoding::Linear,
    );
    let (to_scene, _) = matrices(&profile).unwrap();
    let replacement = [0.15, 0.3, 0.07];
    let mut camera = Image::new(2, 1, ColorSpace::CameraNativeLinearRgb);
    camera.pixels = vec![[0.7, 0.9, 0.1]; 2];
    let untouched = camera.pixels[0];
    let p = InpaintPatch {
        width: 2,
        height: 1,
        origin: [0.0; 2],
        extent: [1.0; 2],
        pixels: vec![to_scene.mul_vec(replacement); 2],
        coverage: vec![0.0, 1.0],
    };
    composite_camera(&mut camera, &[p], &profile).unwrap();
    assert_eq!(camera.pixels[0], untouched);
    let frame = wb_camera::SliderFrame::resolve(&raw, &profile);
    for (temperature, tint) in [(4000.0, -10.0), (9500.0, 25.0)] {
        let mut actual = camera.clone();
        let mut expected = camera.clone();
        expected.pixels[1] = replacement;
        for image in [&mut actual, &mut expected] {
            wb_camera::apply(image, &frame, raw.as_shot_neutral, temperature, tint);
        }
        let target =
            wb_camera::retargeted_render_profile(&frame, profile.clone(), temperature, tint);
        let a = dcp::apply_colorimetry(&actual, &target).unwrap();
        let b = dcp::apply_colorimetry(&expected, &target).unwrap();
        assert_eq!(a.pixels[0], b.pixels[0]);
        close(a.pixels[1], b.pixels[1]);
        let mut without_hsm = target.clone();
        without_hsm.hsm = None;
        let linear = dcp::apply_colorimetry(&expected, &without_hsm).unwrap();
        assert_ne!(
            b.pixels[1], linear.pixels[1],
            "nonlinear correction must actually run"
        );
    }
}

#[test]
fn invalid_later_patch_or_singular_calibration_never_partially_mutates() {
    let raw = source();
    let profile = dcp::profile_for(&raw).unwrap();
    let mut camera = Image::new(2, 1, ColorSpace::CameraNativeLinearRgb);
    camera.pixels = vec![[0.2, 0.3, 0.4]; 2];
    let before = camera.pixels.clone();
    let mut valid = patch(&camera);
    valid.coverage = vec![1.0; 2];
    let mut invalid = valid.clone();
    invalid.pixels[1][0] = f32::NAN;
    assert!(composite_camera(&mut camera, &[valid.clone(), invalid], &profile).is_err());
    assert_eq!(camera.pixels, before);
    let mut singular = profile.clone();
    singular.forward_matrix = Some(Matrix3([[0.0; 3]; 3]));
    singular.wb_already_baked = true;
    assert!(composite_camera(&mut camera, &[valid], &singular).is_err());
    assert_eq!(camera.pixels, before);
    singular.forward_matrix = Some(Matrix3([[f32::INFINITY; 3]; 3]));
    assert!(matrices(&singular).is_err());
    let mut overflowing = patch(&camera);
    overflowing.coverage = vec![1.0; 2];
    overflowing.pixels[0][0] = f32::MAX;
    assert!(composite_camera(&mut camera, &[overflowing], &profile).is_err());
    assert_eq!(camera.pixels, before);
}

#[test]
fn plate_is_native_and_exif_independent_and_cancellation_is_explicit() {
    let mut raw = source();
    let reference = render_removal_calibration_plate(&raw, CancelToken::never()).unwrap();
    for value in 1..=8 {
        raw.orientation = ExifOrientation::from_u16(value);
        let plate = render_removal_calibration_plate(&raw, CancelToken::never()).unwrap();
        assert_eq!(plate.pixels, reference.pixels);
    }
    let flag = AtomicBool::new(true);
    assert!(matches!(
        render_removal_calibration_plate(&raw, CancelToken::new(&flag)),
        Err(Error::Cancelled)
    ));
    assert!(matches!(
        develop_removal_calibration_patches(
            &raw,
            &anchor_model(),
            &[patch(&reference)],
            CancelToken::new(&flag)
        ),
        Err(Error::Cancelled)
    ));
}

#[test]
fn mismatched_upstream_settings_are_refused_before_rendering() {
    let raw = source();
    let plate = render_removal_calibration_plate(&raw, CancelToken::never()).unwrap();
    let patch = patch(&plate);
    let retouch = crate::types::retouch::RetouchSpot::new(
        crate::types::retouch::RetouchKind::Clone,
        crate::types::Point2 { x: 0.5, y: 0.5 },
        crate::types::Point2 { x: 0.2, y: 0.2 },
        0.1,
    );
    let models = [
        AdjustmentModel {
            demosaic: DemosaicChoice::Rcd,
            ..anchor_model()
        },
        AdjustmentModel {
            auto_lateral_ca: crate::xmp::AutoLateralCa::On,
            ..anchor_model()
        },
        AdjustmentModel {
            lens_profile_enable: LensProfileEnable::On,
            ..anchor_model()
        },
        AdjustmentModel {
            hot_pixel_suppression: crate::xmp::HotPixelSuppressionMode::On,
            ..anchor_model()
        },
        AdjustmentModel {
            highlight_recovery: crate::types::HighlightRecoveryMode::Off,
            ..anchor_model()
        },
        AdjustmentModel {
            retouch_spots: vec![retouch],
            ..anchor_model()
        },
    ];
    for model in models {
        assert!(develop_removal_calibration_patches(
            &raw,
            &model,
            std::slice::from_ref(&patch),
            CancelToken::never()
        )
        .unwrap_err()
        .to_string()
        .contains("upstream settings"));
    }
}

#[test]
fn fallback_camera_uses_its_existing_post_dcp_wb_path() {
    let mut raw = source();
    raw.camera_model = "unregistered calibration fixture".into();
    raw.camera_make = "Maple qualification".into();
    raw.unique_camera_model = None;
    raw.color_matrices.clear();
    raw.forward_matrices.clear();
    raw.hsm_data.clear();
    assert!(matches!(
        dcp::profile_for_with_source(&raw).unwrap().1,
        dcp::ProfileSource::RawlerFallback
    ));
    let plate = render_removal_calibration_plate(&raw, CancelToken::never()).unwrap();
    let patch = patch(&plate);
    for (temperature, tint) in [(4000.0, -10.0), (9000.0, 20.0)] {
        let model = AdjustmentModel {
            temperature,
            tint,
            ..anchor_model()
        };
        let ordinary = super::super::develop_scene_linear_from_raw_with_quality(
            &raw,
            &model,
            RenderQuality::Amaze,
        )
        .unwrap();
        let actual = develop_removal_calibration_patches(
            &raw,
            &model,
            std::slice::from_ref(&patch),
            CancelToken::never(),
        )
        .unwrap();
        for (i, (a, b)) in actual.pixels.iter().zip(&ordinary.pixels).enumerate() {
            if patch.coverage[i] == 0.0 {
                assert_eq!(a, b);
            } else {
                close(*a, *b);
            }
        }
    }
}
