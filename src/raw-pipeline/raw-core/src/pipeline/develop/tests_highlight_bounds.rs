//! Masked sensor samples must not become scene chromaticity witnesses (#3680).

use super::*;
use crate::image::{CfaPattern, CropRect, RawImage};
use crate::pipeline::pano::opcodes::ActiveAreaRect;
use crate::test_support::synth_dng::SyntheticGreyDng;
use crate::xmp::{AutoExposureMode, HighlightRecoveryMode, Profile};

fn sensor_with_masked_border(border: [u16; 3]) -> RawImage {
    let bytes = SyntheticGreyDng {
        width: 24,
        height: 24,
        as_shot_neutral_override: Some([1.0; 3]),
        color_matrix_1_override: Some(crate::color::matrices::M_XYZ_D65_TO_REC2020.0),
        ..Default::default()
    }
    .write_to_bytes();
    let mut raw = crate::decode::decode_bytes(&bytes, "dng").expect("synthetic decode");
    assert!(
        !raw.color_matrices.is_empty(),
        "retain real embedded DCP colorimetry"
    );
    // A high-bit-depth LinearRaw buffer isolates highlight recovery from
    // demosaic boundary interpolation. Preserve the decoded DCP metadata.
    raw.cfa = CfaPattern::LinearRgb;
    raw.white_level = 10_000;
    raw.black_level = [0; 4];
    raw.baseline_exposure = 0.0;
    raw.as_shot_neutral = [1.0; 3];
    raw.crop_rect = Some(CropRect {
        x: 4,
        y: 4,
        w: 16,
        h: 16,
    });
    raw.lens_metadata.active_area = Some(ActiveAreaRect {
        left: 4,
        top: 4,
        width: 16,
        height: 16,
    });
    raw.raw_data = (0..24 * 24)
        .flat_map(|i| {
            let (x, y) = (i % 24, i / 24);
            if x == 4 && y == 12 {
                [10_000, 2_000, 2_000]
            } else if (4..20).contains(&x) && (4..20).contains(&y) {
                [4_000, 2_000, 2_000]
            } else {
                border
            }
        })
        .collect();
    raw
}

fn assert_masked_border_independence(max_edge: Option<u32>) {
    let zero = sensor_with_masked_border([0; 3]);
    // Positive channel-dependent residual after black subtraction. Both
    // buffers have identical active pixels and differ only outside ActiveArea.
    let residual = sensor_with_masked_border([0, 20, 10]);
    for recovery in [
        HighlightRecoveryMode::Off,
        HighlightRecoveryMode::ChromaticAdaptation,
    ] {
        let model = AdjustmentModel {
            auto_exposure: AutoExposureMode::Off,
            profile: Profile::Neutral,
            highlight_recovery: recovery,
            ..Default::default()
        };
        let render = |raw: &RawImage| match max_edge {
            None => develop_scene_linear_from_raw_with_quality(raw, &model, RenderQuality::Full),
            Some(edge) => crate::pipeline::develop_scene_linear_sized_from_raw_with_quality(
                raw,
                &model,
                RenderQuality::Full,
                edge,
            ),
        };
        let a = render(&zero).expect("zero-border scene");
        let b = render(&residual).expect("residual-border scene");
        assert_eq!((a.width, a.height), (b.width, b.height));
        let difference = a
            .pixels
            .iter()
            .zip(&b.pixels)
            .flat_map(|(a, b)| (0..3).map(move |c| (a[c] - b[c]).abs()))
            .fold(0.0_f32, f32::max);
        assert!(difference < 1e-6,
            "masked border changed {recovery:?} output with max_edge={max_edge:?}: max difference={difference}; first active edge {:?} vs {:?}",
            a.pixels[(a.height / 2 * a.width) as usize],
            b.pixels[(b.height / 2 * b.width) as usize]);
    }
}

#[test]
fn full_highlight_recovery_ignores_masked_sensor_border() {
    assert_masked_border_independence(None);
}

#[test]
fn sized_highlight_recovery_ignores_masked_sensor_border() {
    assert_masked_border_independence(Some(8));
}

fn model_for(recovery: HighlightRecoveryMode) -> AdjustmentModel {
    AdjustmentModel {
        auto_exposure: AutoExposureMode::Off,
        profile: Profile::Neutral,
        highlight_recovery: recovery,
        ..Default::default()
    }
}

#[test]
fn half_resolution_bounds_exclude_partial_sensor_cells() {
    let mut raw = sensor_with_masked_border([0; 3]);
    raw.lens_metadata.active_area = Some(ActiveAreaRect {
        left: 3,
        top: 5,
        width: 16,
        height: 14,
    });
    let bounds = highlight_active_area(&raw, 2).unwrap();
    assert_eq!((bounds.x, bounds.y, bounds.w, bounds.h), (2, 3, 7, 6));
    // Display crop must not change the physical sensor region.
    raw.crop_rect = None;
    let uncropped = highlight_active_area(&raw, 2).unwrap();
    assert_eq!(
        (uncropped.x, uncropped.y, uncropped.w, uncropped.h),
        (2, 3, 7, 6)
    );
}

#[test]
fn valid_scene_outside_default_crop_remains_a_witness() {
    let mut a = sensor_with_masked_border([0; 3]);
    a.crop_rect = Some(CropRect {
        x: 6,
        y: 6,
        w: 12,
        h: 12,
    });
    a.raw_data[(12 * 24 + 4) * 3] = 4_000;
    a.raw_data[(12 * 24 + 6) * 3] = 10_000;
    let mut b = a.clone();
    for y in 9..16 {
        for x in 4..6 {
            b.raw_data[(y * 24 + x) * 3] = 8_000;
        }
    }
    for recovery in [
        HighlightRecoveryMode::Off,
        HighlightRecoveryMode::ChromaticAdaptation,
    ] {
        let model = model_for(recovery);
        let render = |raw: &RawImage| {
            develop_scene_linear_from_raw_with_quality(raw, &model, RenderQuality::Full).unwrap()
        };
        let left = render(&a);
        let right = render(&b);
        if recovery == HighlightRecoveryMode::Off {
            assert_eq!(
                left.pixels, right.pixels,
                "display crop must remove changed samples"
            );
        } else {
            let index = 6 * 12;
            assert!(
                (left.pixels[index][0] - right.pixels[index][0]).abs() > 0.01,
                "valid ActiveArea samples outside DefaultCrop were discarded as witnesses"
            );
        }
    }
}

#[test]
fn clipped_targets_outside_physical_bounds_remain_unchanged() {
    let mut image = crate::Image::new(9, 9, crate::image::ColorSpace::CameraNativeLinearRgb);
    image.pixels.fill([0.4, 0.2, 0.2]);
    image.pixels[0] = [1.0, 0.2, 0.2];
    image.pixels[4 * 9 + 4] = [1.0, 0.2, 0.2];
    let original = image.clone();
    highlight_recovery::apply_in_region(
        &mut image,
        HighlightRecoveryMode::ChromaticAdaptation,
        [1.0; 3],
        0.0,
        Some(CropRect {
            x: 3,
            y: 3,
            w: 3,
            h: 3,
        }),
    );
    for y in 0..9 {
        for x in 0..9 {
            if !(3..6).contains(&x) || !(3..6).contains(&y) {
                assert_eq!(image.pixels[y * 9 + x], original.pixels[y * 9 + x]);
            }
        }
    }
    assert!(
        image.pixels[4 * 9 + 4][0] < 1.0,
        "inside target must exercise recovery"
    );
}

#[test]
fn empty_physical_region_preserves_clipped_pixels() {
    let mut raw = sensor_with_masked_border([0; 3]);
    raw.lens_metadata.active_area = Some(ActiveAreaRect {
        left: 3,
        top: 3,
        width: 1,
        height: 1,
    });
    let bounds = highlight_active_area(&raw, 2).unwrap();
    assert_eq!((bounds.w, bounds.h), (0, 0));
    let mut image = crate::Image::new(12, 12, crate::image::ColorSpace::CameraNativeLinearRgb);
    image.pixels.fill([1.0, 0.2, 0.2]);
    let original = image.pixels.clone();
    highlight_recovery::apply_in_region(
        &mut image,
        HighlightRecoveryMode::ChromaticAdaptation,
        [1.0; 3],
        0.0,
        Some(bounds),
    );
    assert_eq!(image.pixels, original);
}
