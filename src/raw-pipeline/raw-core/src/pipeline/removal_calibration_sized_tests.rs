//! Viewport composition must precede optics and the existing early downsample.
use super::*;
use crate::{image::CropRect, xmp::LensProfileEnable};

#[test]
fn sized_replacement_matches_known_sensor_pixels_before_optics_and_downsample() {
    let mut raw = super::lens_tests::source(0.18);
    let mut replaced = super::lens_tests::source(0.32);
    for input in [&mut raw, &mut replaced] {
        super::lens_tests::optics(input);
    }
    let patch = super::lens_tests::opaque(
        render_removal_calibration_plate(&replaced, CancelToken::never()).unwrap(),
    );
    for cap in [16, 31, 32, 33, 64, 80] {
        for temperature in [4300.0, 9000.0] {
            let model = AdjustmentModel {
                temperature,
                temperature_seen: true,
                exposure: 1.5,
                lens_profile_enable: LensProfileEnable::On,
                ..anchor_model()
            };
            let original = develop_with_gain(
                &raw,
                &model,
                RenderQuality::Amaze,
                Some(cap),
                &[],
                CancelToken::never(),
            )
            .unwrap()
            .0;
            let expected = develop_with_gain(
                &replaced,
                &model,
                RenderQuality::Amaze,
                Some(cap),
                &[],
                CancelToken::never(),
            )
            .unwrap()
            .0;
            let actual = develop_with_gain(
                &raw,
                &model,
                RenderQuality::Amaze,
                Some(cap),
                std::slice::from_ref(&patch),
                CancelToken::never(),
            )
            .unwrap()
            .0;
            assert_eq!(
                (actual.width, actual.height),
                (expected.width, expected.height)
            );
            assert!(actual.width.max(actual.height) <= cap);
            assert_eq!(actual.whites_anchor_ev, original.whites_anchor_ev);
            for (a, b) in actual.pixels.iter().zip(&expected.pixels) {
                for c in 0..3 {
                    assert!(
                        (a[c] - b[c]).abs() < 3e-6 * (1.0 + b[c].abs()),
                        "cap {cap}: {a:?} != {b:?}"
                    );
                }
            }
        }
    }
}

#[test]
fn odd_sensor_dimensions_and_crop_use_actual_half_resolution_footprint() {
    let mut raw = super::lens_tests::source(0.18);
    raw.width = 63;
    raw.height = 61;
    raw.raw_data.truncate((raw.width * raw.height) as usize);
    raw.crop_rect = Some(CropRect {
        x: 5,
        y: 7,
        w: 54,
        h: 50,
    });
    let model = anchor_model();
    let mosaic = crate::linearize::sensor_linearize(&raw);
    let mut camera = crate::demosaic::half_res(&mosaic, raw.cfa);
    crate::stages::white_balance::apply_pre_gain(&mut camera, raw.as_shot_neutral);
    let profile = dcp::profile_for(&raw).unwrap();
    let (to_scene, _) = matrices(&profile).unwrap();
    let index = (10 * camera.width + 11) as usize;
    // A 2×2 native patch centred over exactly this half-resolution sample.
    let native_x = 2 * 11 - 5;
    let native_y = 2 * 10 - 7;
    let patch = InpaintPatch {
        width: 2,
        height: 2,
        origin: [native_x as f32 / 54.0, native_y as f32 / 50.0],
        extent: [2.0 / 54.0, 2.0 / 50.0],
        pixels: vec![to_scene.mul_vec(camera.pixels[index]).map(|v| v * 0.5); 4],
        coverage: vec![1.0; 4],
    };
    let before = camera.pixels.clone();
    let window = sensor_buffer_window(&raw, [camera.width, camera.height], 2);
    composite_camera_sampled(&mut camera, &[patch], &profile, window, 2).unwrap();
    for (i, (a, b)) in camera.pixels.iter().zip(before).enumerate() {
        if i == index {
            for c in 0..3 {
                assert!((a[c] - 0.5 * b[c]).abs() < 3e-6);
            }
        } else {
            assert_eq!(*a, b, "wrong half-resolution placement at {i}");
        }
    }
    // Ordinary preview arithmetic must survive the extracted camera prefix.
    let sized = develop_with_gain(
        &raw,
        &model,
        RenderQuality::Amaze,
        Some(20),
        &[],
        CancelToken::never(),
    )
    .unwrap()
    .0;
    assert!(sized.width.max(sized.height) <= 20);
}

#[test]
fn zero_coverage_sized_stack_is_bit_exact_and_zero_cap_is_rejected() {
    let mut raw = super::lens_tests::source(0.18);
    super::lens_tests::optics(&mut raw);
    let mut patch = super::lens_tests::opaque(
        render_removal_calibration_plate(&raw, CancelToken::never()).unwrap(),
    );
    patch.coverage.fill(0.0);
    patch.pixels.fill([-0.3, 4.0, 0.5]);
    let model = AdjustmentModel {
        lens_profile_enable: LensProfileEnable::On,
        ..anchor_model()
    };
    for cap in [16, 32, 33, 64] {
        let expected = develop_with_gain(
            &raw,
            &model,
            RenderQuality::Amaze,
            Some(cap),
            &[],
            CancelToken::never(),
        )
        .unwrap();
        let actual = develop_with_gain(
            &raw,
            &model,
            RenderQuality::Amaze,
            Some(cap),
            std::slice::from_ref(&patch),
            CancelToken::never(),
        )
        .unwrap();
        assert_eq!(actual.0.pixels, expected.0.pixels);
        assert_eq!(actual.0.whites_anchor_ev, expected.0.whites_anchor_ev);
        assert_eq!(actual.1, expected.1);
    }
    assert!(develop_with_gain(
        &raw,
        &model,
        RenderQuality::Amaze,
        Some(0),
        &[patch],
        CancelToken::never()
    )
    .is_err());
}

#[test]
fn zero_coverage_preserves_normal_kernel_choice_even_for_high_noise_raw() {
    let mut raw = super::lens_tests::source(0.18);
    raw.iso = 12800;
    raw.noise_profile = None;
    for (i, value) in raw.raw_data.iter_mut().enumerate() {
        *value = value.saturating_add(((i * 31 + i / 7) % 91) as u16);
    }
    let mut patch = super::lens_tests::opaque(
        render_removal_calibration_plate(&raw, CancelToken::never()).unwrap(),
    );
    patch.coverage.fill(0.0);
    patch.pixels.fill([-0.3, 4.0, 0.5]);
    let model = anchor_model();
    for quality in [
        RenderQuality::Preview,
        RenderQuality::Full,
        RenderQuality::Amaze,
        RenderQuality::Auto,
    ] {
        for cap in [None, Some(16), Some(64)] {
            let expected =
                develop_with_gain(&raw, &model, quality, cap, &[], CancelToken::never()).unwrap();
            let actual = develop_with_gain(
                &raw,
                &model,
                quality,
                cap,
                std::slice::from_ref(&patch),
                CancelToken::never(),
            )
            .unwrap();
            assert_eq!(
                (actual.0.width, actual.0.height),
                (expected.0.width, expected.0.height)
            );
            assert_eq!(
                actual.0.pixels, expected.0.pixels,
                "accepted pixels changed the unmasked kernel"
            );
            assert_eq!(actual.0.whites_anchor_ev, expected.0.whites_anchor_ev);
            assert_eq!(actual.1, expected.1);
        }
    }
}

#[test]
fn active_native_patch_keeps_every_unselected_pixel_exact_on_high_noise_auto() {
    let mut raw = super::lens_tests::source(0.18);
    raw.iso = 12800;
    raw.noise_profile = None;
    for (i, value) in raw.raw_data.iter_mut().enumerate() {
        *value = value.saturating_add(((i * 31 + i / 7) % 91) as u16);
    }
    let mut patch = super::lens_tests::opaque(
        render_removal_calibration_plate(&raw, CancelToken::never()).unwrap(),
    );
    let selected = (20 * raw.width + 18) as usize;
    patch.coverage.fill(0.0);
    patch.coverage[selected] = 1.0;
    patch.pixels[selected] = patch.pixels[selected].map(|v| v * 0.5);
    let model = anchor_model();
    let original = develop_with_gain(
        &raw,
        &model,
        RenderQuality::Auto,
        None,
        &[],
        CancelToken::never(),
    )
    .unwrap()
    .0;
    let accepted = develop_with_gain(
        &raw,
        &model,
        RenderQuality::Auto,
        None,
        &[patch],
        CancelToken::never(),
    )
    .unwrap()
    .0;
    assert_eq!(accepted.whites_anchor_ev, original.whites_anchor_ev);
    for (i, (a, b)) in accepted.pixels.iter().zip(original.pixels).enumerate() {
        if i == selected {
            assert_ne!(*a, b);
        } else {
            assert_eq!(*a, b, "accepted edit changed unselected native index {i}");
        }
    }
}
