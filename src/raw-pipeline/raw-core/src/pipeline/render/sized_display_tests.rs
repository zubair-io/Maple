//! Tests for the sized display-encoded render entry + `native_render_dims`
//! (#1101 — web viewport-sized decode). Sibling file so `tests.rs` stays
//! under the 600-LOC budget (#482).
//!
//! `native_render_dims` tests are pure math (no fixtures). The display
//! parity tests are fixture-gated: `ignore`d without `--features fixtures`,
//! fail-closed on a missing fixture with it (#1082).

#![cfg(test)]

use super::*;
use crate::image::{CfaPattern, CropRect, ExifOrientation};
use crate::test_support::fixtures::require_raw;

fn raw_with(w: u32, h: u32, orientation: ExifOrientation, crop_rect: Option<CropRect>) -> RawImage {
    RawImage {
        width: w,
        height: h,
        cfa: CfaPattern::Rggb,
        black_level: [0, 0, 0, 0],
        white_level: 1023,
        raw_data: vec![0; (w * h) as usize],
        as_shot_neutral: [1.0, 1.0, 1.0],
        as_shot_cct: None,
        camera_make: "Test".into(),
        camera_model: "Test".into(),
        unique_camera_model: None,
        color_matrices: std::collections::HashMap::new(),
        forward_matrices: std::collections::HashMap::new(),
        orientation,
        baseline_exposure: 0.0,
        hsm_data: std::collections::HashMap::new(),
        plt: None,
        profile_tone_curve: None,
        profile_gain_table_map: None,
        crop_rect,
        iso: 100,
        noise_profile: None,
        opcode_list3: None,
        aperture: None,
        focal_length: None,
        lens_metadata: Default::default(),
    }
}

#[test]
fn native_dims_no_crop_normal_orientation_is_sensor_dims() {
    let raw = raw_with(6000, 4000, ExifOrientation::Normal, None);
    assert_eq!(native_render_dims(&raw), (6000, 4000));
}

#[test]
fn native_dims_applies_default_crop() {
    let crop = CropRect {
        x: 8,
        y: 8,
        w: 5984,
        h: 3984,
    };
    let raw = raw_with(6000, 4000, ExifOrientation::Normal, Some(crop));
    assert_eq!(native_render_dims(&raw), (5984, 3984));
}

#[test]
fn native_dims_swaps_on_rotated_orientation() {
    let crop = CropRect {
        x: 8,
        y: 8,
        w: 5984,
        h: 3984,
    };
    let raw = raw_with(6000, 4000, ExifOrientation::Rotate90, Some(crop));
    assert_eq!(native_render_dims(&raw), (3984, 5984));
    let raw = raw_with(6000, 4000, ExifOrientation::Rotate270, Some(crop));
    assert_eq!(native_render_dims(&raw), (3984, 5984));
    // Rotate180 keeps the axes.
    let raw = raw_with(6000, 4000, ExifOrientation::Rotate180, Some(crop));
    assert_eq!(native_render_dims(&raw), (5984, 3984));
}

#[test]
fn native_dims_clamps_overlarge_crop_like_crop_to_default() {
    // Rect reaches past the sensor edge → clamp to the in-frame extent.
    let crop = CropRect {
        x: 5990,
        y: 0,
        w: 100,
        h: 4000,
    };
    let raw = raw_with(6000, 4000, ExifOrientation::Normal, Some(crop));
    assert_eq!(native_render_dims(&raw), (10, 4000));
}

#[test]
fn native_dims_degenerate_crop_falls_back_to_full_frame() {
    // Fully out-of-range rect clamps to zero size → treated as "no crop",
    // matching `crop_to_default`'s defensive no-op.
    let crop = CropRect {
        x: 6000,
        y: 0,
        w: 100,
        h: 4000,
    };
    let raw = raw_with(6000, 4000, ExifOrientation::Normal, Some(crop));
    assert_eq!(native_render_dims(&raw), (6000, 4000));
}

/// Fixture-gated: a sized display render capped AT the native long edge is
/// byte-identical to the unsized display render (the downsample no-ops and
/// the two entries share the develop chain + view tail), and its dims match
/// `native_render_dims`.
#[test]
#[cfg_attr(not(feature = "fixtures"), ignore)]
fn sized_display_at_native_cap_matches_unsized_render() {
    let path = require_raw("test_0002.dng");
    let bytes = std::fs::read(&path).expect("read fixture");
    let raw = crate::decode::decode_bytes(&bytes, "dng").expect("decode");
    let model = AdjustmentModel::default();

    let (nw, nh) = native_render_dims(&raw);
    let (uw, uh, unsized_rgb) =
        render_from_raw_with_quality_and_source(&raw, &model, RenderQuality::Full, None)
            .expect("unsized render");
    assert_eq!(
        (uw, uh),
        (nw, nh),
        "native_render_dims must predict the Full render dims"
    );

    let cap = uw.max(uh);
    let (sw, sh, sized_rgb) =
        render_sized_from_raw_with_quality_and_source(&raw, &model, RenderQuality::Full, None, cap)
            .expect("sized render");
    assert_eq!(
        (sw, sh),
        (uw, uh),
        "cap at native long edge must not resize"
    );
    assert_eq!(
        sized_rgb, unsized_rgb,
        "sized@native-cap must be byte-identical to unsized"
    );
}

/// Fixture-gated: a sized display render below native respects the long-edge
/// cap, preserves aspect, and produces plausible display bytes.
#[test]
#[cfg_attr(not(feature = "fixtures"), ignore)]
fn sized_display_below_native_caps_long_edge() {
    let path = require_raw("test_0002.dng");
    let bytes = std::fs::read(&path).expect("read fixture");
    let raw = crate::decode::decode_bytes(&bytes, "dng").expect("decode");
    let model = AdjustmentModel::default();

    let cap = 1024u32;
    let (w, h, rgb) =
        render_sized_from_raw_with_quality_and_source(&raw, &model, RenderQuality::Full, None, cap)
            .expect("sized render");
    assert!(
        w.max(h) <= cap,
        "long edge {} exceeds cap {}",
        w.max(h),
        cap
    );
    assert_eq!(rgb.len() as u32, w * h * 3);
    let (nw, nh) = native_render_dims(&raw);
    let native_aspect = nw as f64 / nh as f64;
    let sized_aspect = w as f64 / h as f64;
    assert!(
        (native_aspect - sized_aspect).abs() / native_aspect < 0.02,
        "aspect drifted: native {:.4} vs sized {:.4}",
        native_aspect,
        sized_aspect
    );
    let zero_ratio = rgb.iter().filter(|b| **b == 0).count() as f32 / rgb.len() as f32;
    assert!(
        zero_ratio < 0.5,
        "too many zeros ({:.1}%)",
        zero_ratio * 100.0
    );
}

// The UI must invert the crop rounded on the actual viewport, not native dims.
#[test]
fn crop_input_metadata_measures_odd_default_crop_at_each_render_size() {
    let crop_rect = Some(CropRect {
        x: 1,
        y: 1,
        w: 29,
        h: 17,
    });
    for orientation in 1..=8 {
        let raw = raw_with(32, 20, ExifOrientation::from_u16(orientation), crop_rect);
        for cap in [9, 16, 64] {
            for quality in [RenderQuality::Preview, RenderQuality::Amaze] {
                let base = AdjustmentModel {
                    profile: Profile::Neutral,
                    sharpen_amount: 0.0,
                    nr_color: 0.0,
                    ..Default::default()
                };
                let uncropped =
                    render_display_with_geometry(&raw, &base, quality, None, Some(cap), None)
                        .unwrap();
                let expected = [uncropped.pixels.0, uncropped.pixels.1];
                assert_eq!(uncropped.crop_input_size, expected);
                for angle in [0.0, 90.0, 7.0] {
                    let model = AdjustmentModel {
                        crop: crate::types::Crop {
                            left: 0.13,
                            top: 0.17,
                            right: 0.81,
                            bottom: 0.89,
                            angle,
                        },
                        perspective_horizontal: 20.0,
                        ..base.clone()
                    };
                    let rendered =
                        render_display_with_geometry(&raw, &model, quality, None, Some(cap), None)
                            .unwrap();
                    assert_eq!(rendered.crop_input_size, expected);
                    let legacy = render_sized_from_raw_with_quality_and_source(
                        &raw, &model, quality, None, cap,
                    )
                    .unwrap();
                    assert_eq!(rendered.pixels, legacy);
                }
            }
        }
    }
}
