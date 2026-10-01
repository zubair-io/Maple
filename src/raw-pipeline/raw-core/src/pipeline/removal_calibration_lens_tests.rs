//! Pre-lens placement and optical-order qualification (#3955).
use super::*;
use crate::{
    image::CropRect,
    pipeline::pano::opcodes::{
        ActiveAreaRect, FixVignetteRadialOpcode, GainMapOpcode, OpcodeList3, PanoOpcode,
        WarpPlaneParams, WarpRectilinearOpcode,
    },
    test_support::synth_dng::SyntheticGreyDng,
    xmp::LensProfileEnable,
};

fn source(value: f32) -> RawImage {
    crate::decode_raw(
        &SyntheticGreyDng {
            width: 64,
            height: 64,
            linear_value: value,
            ..Default::default()
        }
        .write_to_bytes(),
        "dng",
    )
    .unwrap()
}

fn optics(raw: &mut RawImage) {
    raw.opcode_list3 = Some((
        OpcodeList3 {
            opcodes: vec![
                PanoOpcode::FixVignetteRadial(FixVignetteRadialOpcode {
                    k: [0.8, 0.2, 0.0, 0.0, 0.0],
                    center_x: 0.43,
                    center_y: 0.51,
                }),
                PanoOpcode::WarpRectilinear(WarpRectilinearOpcode {
                    planes: [1.04, 1.03, 1.02]
                        .map(|scale| WarpPlaneParams {
                            kr: [scale, 0.05, 0.0, 0.0],
                            kt: [0.001, -0.002],
                        })
                        .to_vec(),
                    center_x: 0.43,
                    center_y: 0.51,
                }),
                PanoOpcode::GainMap(GainMapOpcode {
                    top: 0,
                    bottom: raw.height,
                    left: 0,
                    right: raw.width,
                    plane: 0,
                    planes: 3,
                    row_pitch: 1,
                    col_pitch: 1,
                    points_v: 2,
                    points_h: 2,
                    spacing_v: 1.0,
                    spacing_h: 1.0,
                    origin_v: 0.0,
                    origin_h: 0.0,
                    map_planes: 3,
                    gains: vec![1.2, 1.1, 1.0, 1.0, 1.3, 1.1, 1.4, 1.2, 1.0, 1.1, 1.0, 1.3],
                }),
            ],
            skipped_unknown: 0,
        },
        ActiveAreaRect::full(raw.width, raw.height),
    ));
}

fn opaque(plate: Image) -> InpaintPatch {
    InpaintPatch {
        width: plate.width,
        height: plate.height,
        origin: [0.0, 0.0],
        extent: [1.0, 1.0],
        coverage: vec![1.0; plate.pixels.len()],
        pixels: plate.pixels,
    }
}

#[test]
fn replacements_receive_the_same_lens_gain_and_warp_as_sensor_pixels() {
    let mut raw = source(0.18);
    let mut replaced = source(0.32);
    optics(&mut raw);
    optics(&mut replaced);
    let original_samples = raw.raw_data.clone();
    let patch = opaque(render_removal_calibration_plate(&replaced, CancelToken::never()).unwrap());
    for strength in [0.0, 50.0, 100.0] {
        for (temperature, exposure) in [(6500.0, 0.0), (4300.0, 2.0)] {
            let model = AdjustmentModel {
                temperature,
                temperature_seen: true,
                exposure,
                lens_profile_enable: LensProfileEnable::On,
                lens_correction_distortion: strength,
                lens_correction_ca: strength,
                lens_correction_vignetting: strength,
                ..anchor_model()
            };
            let original = develop::develop_with_calibration_patches(
                &raw,
                &model,
                RenderQuality::Amaze,
                CancelToken::never(),
                &[],
            )
            .unwrap()
            .0;
            let expected = develop::develop_with_calibration_patches(
                &replaced,
                &model,
                RenderQuality::Amaze,
                CancelToken::never(),
                &[],
            )
            .unwrap()
            .0;
            let actual = develop_removal_calibration_patches(
                &raw,
                &model,
                std::slice::from_ref(&patch),
                CancelToken::never(),
            )
            .unwrap();
            assert_eq!(actual.whites_anchor_ev, original.whites_anchor_ev);
            assert_eq!(
                (actual.width, actual.height),
                (expected.width, expected.height)
            );
            for (index, (a, b)) in actual.pixels.iter().zip(&expected.pixels).enumerate() {
                for c in 0..3 {
                    assert!((a[c] - b[c]).abs() <= 3e-6 * (1.0 + b[c].abs()),
                        "replacement bypassed or doubled optics: strength {strength}, index {index}, {a:?} != {b:?}");
                }
            }
        }
    }
    assert_eq!(raw.raw_data, original_samples);
}

#[test]
fn default_crop_offset_places_only_the_selected_sensor_pixel() {
    let raw = super::tests::source();
    let crop = raw.crop_rect.unwrap();
    let plate = render_removal_calibration_plate(&raw, CancelToken::never()).unwrap();
    let mut patch = opaque(plate);
    patch.coverage.fill(0.0);
    let (x, y) = (3, 2);
    let selected = (y * crop.w + x) as usize;
    patch.coverage[selected] = 1.0;
    patch.pixels[selected] = patch.pixels[selected].map(|v| v * 0.5);
    let (mut camera, _) = develop::camera::prepare_unwarped(
        &raw,
        &anchor_model(),
        RenderQuality::Amaze,
        CancelToken::never(),
    )
    .unwrap();
    let original = camera.pixels.clone();
    let sensor_selected = ((crop.y + y) * raw.width + crop.x + x) as usize;
    composite_camera(
        &mut camera,
        &[patch],
        &dcp::profile_for(&raw).unwrap(),
        sensor_window(&raw),
    )
    .unwrap();
    for (index, (a, b)) in camera.pixels.iter().zip(original).enumerate() {
        if index == sensor_selected {
            for c in 0..3 {
                assert!((a[c] - 0.5 * b[c]).abs() < 3e-6);
            }
        } else {
            assert_eq!(*a, b, "zero coverage changed sensor index {index}");
        }
    }
}

#[test]
fn cropped_replacement_receives_native_radial_gain_once() {
    let mut raw = source(0.18);
    let mut replaced = source(0.32);
    let crop = CropRect {
        x: 5,
        y: 7,
        w: 50,
        h: 46,
    };
    raw.crop_rect = Some(crop);
    replaced.crop_rect = Some(crop);
    optics(&mut raw);
    optics(&mut replaced);
    // Gain is spatial but does not gather outside the covered DefaultCrop.
    for input in [&mut raw, &mut replaced] {
        input.opcode_list3.as_mut().unwrap().0.opcodes.truncate(1);
    }
    let patch = opaque(render_removal_calibration_plate(&replaced, CancelToken::never()).unwrap());
    let model = AdjustmentModel {
        lens_profile_enable: LensProfileEnable::On,
        ..anchor_model()
    };
    let actual =
        develop_removal_calibration_patches(&raw, &model, &[patch], CancelToken::never()).unwrap();
    let expected = develop::develop_with_calibration_patches(
        &replaced,
        &model,
        RenderQuality::Amaze,
        CancelToken::never(),
        &[],
    )
    .unwrap()
    .0;
    assert_eq!((actual.width, actual.height), (crop.w, crop.h));
    for (a, b) in actual.pixels.iter().zip(expected.pixels) {
        for c in 0..3 {
            assert!((a[c] - b[c]).abs() <= 3e-6 * (1.0 + b[c].abs()));
        }
    }
}

#[test]
fn zero_coverage_is_bit_exact_with_lens_correction_enabled() {
    let mut raw = source(0.18);
    optics(&mut raw);
    let mut patch = opaque(render_removal_calibration_plate(&raw, CancelToken::never()).unwrap());
    patch.coverage.fill(0.0);
    patch.pixels.fill([-0.3, 4.0, 0.5]);
    let model = AdjustmentModel {
        lens_profile_enable: LensProfileEnable::On,
        ..anchor_model()
    };
    let expected =
        develop_removal_calibration_patches(&raw, &model, &[], CancelToken::never()).unwrap();
    let actual =
        develop_removal_calibration_patches(&raw, &model, &[patch], CancelToken::never()).unwrap();
    assert_eq!(actual.pixels, expected.pixels);
    assert_eq!(actual.whites_anchor_ev, expected.whites_anchor_ev);
}
