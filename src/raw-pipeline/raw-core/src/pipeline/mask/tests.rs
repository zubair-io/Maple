use super::*;
use crate::image::{CfaPattern, ExifOrientation, RawImage};
use crate::pipeline::{
    develop_scene_linear_from_raw_with_quality_cancellable_with_gain, RenderQuality,
};
use crate::stages::local_adjustments::mask::evaluate;
use crate::types::{AdjustmentModel, PartialAdjustments};
use crate::CancelToken;

#[test]
fn normal_orientation_is_borrowed_identity() {
    let layers = vec![LocalAdjustment::linear(
        Point2::new(0.0, 0.0),
        Point2::new(1.0, 1.0),
        PartialAdjustments::default(),
    )];
    let rasters = vec![Arc::new(MaskRaster::from_u8(1, "test", 2, 2, &[0; 4]))];

    let (out_layers, out_rasters) =
        orient_adjustments_to_sensor(&layers, &rasters, ExifOrientation::Normal);

    assert!(matches!(out_layers, Cow::Borrowed(_)));
    assert!(matches!(out_rasters, Cow::Borrowed(_)));
}

#[test]
fn empty_layers_is_borrowed_identity() {
    let layers: Vec<LocalAdjustment> = Vec::new();
    let rasters = vec![Arc::new(MaskRaster::from_u8(1, "test", 2, 2, &[0; 4]))];

    let (out_layers, out_rasters) =
        orient_adjustments_to_sensor(&layers, &rasters, ExifOrientation::Rotate90);

    assert!(matches!(out_layers, Cow::Borrowed(_)));
    assert!(matches!(out_rasters, Cow::Borrowed(_)));
}

#[test]
fn display_to_sensor_norm_corners_rotate90() {
    let tl = display_to_sensor_norm(Point2::new(0.0, 0.0), ExifOrientation::Rotate90);
    let tr = display_to_sensor_norm(Point2::new(1.0, 0.0), ExifOrientation::Rotate90);
    let br = display_to_sensor_norm(Point2::new(1.0, 1.0), ExifOrientation::Rotate90);
    let bl = display_to_sensor_norm(Point2::new(0.0, 1.0), ExifOrientation::Rotate90);

    // Rotate90: sensor rotated 90° CW to get display.
    // Display TL (0, 0) comes from sensor BL (0, 1).
    assert!((tl.x - 0.0).abs() < 1e-6 && (tl.y - 1.0).abs() < 1e-6);
    // Display TR (1, 0) comes from sensor TL (0, 0).
    assert!((tr.x - 0.0).abs() < 1e-6 && (tr.y - 0.0).abs() < 1e-6);
    // Display BR (1, 1) comes from sensor TR (1, 0).
    assert!((br.x - 1.0).abs() < 1e-6 && (br.y - 0.0).abs() < 1e-6);
    // Display BL (0, 1) comes from sensor BR (1, 1).
    assert!((bl.x - 1.0).abs() < 1e-6 && (bl.y - 1.0).abs() < 1e-6);
}

#[test]
fn all_eight_orientations_raster_roundtrip() {
    // 2x3 raster with distinct values per pixel
    let (dw, dh) = (2, 3);
    let data: Vec<f32> = (0..dw * dh).map(|i| i as f32).collect();
    let original = MaskRaster {
        id: 42,
        digest: "0123456789abcdef".into(),
        width: dw as u32,
        height: dh as u32,
        data,
    };

    for tag in 1..=8 {
        let orient = ExifOrientation::from_u16(tag);
        let sensor_raster = orient_raster_to_sensor(&original, orient);

        // Verify dimensions
        if orient.swaps_wh() {
            assert_eq!(sensor_raster.width, dh as u32);
            assert_eq!(sensor_raster.height, dw as u32);
        } else {
            assert_eq!(sensor_raster.width, dw as u32);
            assert_eq!(sensor_raster.height, dh as u32);
        }

        // Apply display orientation to sensor_raster using image::apply_orientation
        // (with 3-tuple wrapping to simulate RGB/single-channel)
        let sw = sensor_raster.width;
        let sh = sensor_raster.height;
        let triple: Vec<f32> = sensor_raster.data.iter().flat_map(|&v| [v, v, v]).collect();
        let (nw, nh, display_back) = crate::image::apply_orientation(&triple, sw, sh, orient);

        assert_eq!(nw, dw as u32);
        assert_eq!(nh, dh as u32);
        let back_values: Vec<f32> = display_back.chunks_exact(3).map(|c| c[0]).collect();
        assert_eq!(
            back_values, original.data,
            "Orientation tag {tag} failed roundtrip"
        );
    }
}

#[test]
fn radial_gradient_evaluation_matches_across_rotate90() {
    // A radial mask centered at (0.3, 0.7) with radii (0.2, 0.1) and angle 0.4 rad
    let display_mask = Mask::Radial {
        center: Point2::new(0.3, 0.7),
        radii: Point2::new(0.2, 0.1),
        angle: 0.4,
        feather: 0.5,
        invert: false,
    };
    let sensor_mask = orient_mask_to_sensor(&display_mask, ExifOrientation::Rotate90);

    // For any display test point, its mapped sensor point must evaluate to the same weight
    let test_points = [
        Point2::new(0.3, 0.7), // center
        Point2::new(0.5, 0.7), // along major axis
        Point2::new(0.3, 0.8), // along minor axis
        Point2::new(0.0, 0.0), // outside
        Point2::new(0.8, 0.2), // arbitrary
    ];

    for dp in test_points {
        let sp = display_to_sensor_norm(dp, ExifOrientation::Rotate90);
        let w_display = evaluate(&display_mask, None, dp.x, dp.y);
        let w_sensor = evaluate(&sensor_mask, None, sp.x, sp.y);
        assert!(
            (w_display - w_sensor).abs() < 1e-5,
            "Mismatch at display {dp:?} / sensor {sp:?}: display={w_display}, sensor={w_sensor}"
        );
    }
}

fn make_grey_raw(width: u32, height: u32, orientation: ExifOrientation) -> RawImage {
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
        orientation,
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

/// Helper that develops a RAW and applies orientation to obtain the oriented display Image.
fn develop_display(raw: &RawImage, model: &AdjustmentModel) -> crate::image::Image {
    let (sensor_img, _) = develop_scene_linear_from_raw_with_quality_cancellable_with_gain(
        raw,
        model,
        RenderQuality::Full,
        CancelToken::never(),
    )
    .expect("develop");

    if raw.orientation == ExifOrientation::Normal {
        sensor_img
    } else {
        let flat: Vec<f32> = sensor_img.pixels.iter().flat_map(|p| *p).collect();
        let (dw, dh, oriented_flat) = crate::image::apply_orientation(
            &flat,
            sensor_img.width,
            sensor_img.height,
            raw.orientation,
        );
        let oriented_pixels: Vec<[f32; 3]> = oriented_flat
            .chunks_exact(3)
            .map(|c| [c[0], c[1], c[2]])
            .collect();
        crate::image::Image {
            width: dw,
            height: dh,
            space: sensor_img.space,
            pixels: oriented_pixels,
            whites_anchor_ev: sensor_img.whites_anchor_ev,
            nr_sampling_scale: sensor_img.nr_sampling_scale,
        }
    }
}

#[test]
fn develop_linear_gradient_parity_on_rotate90() {
    // Sensor: 256x128. Rotate90 -> Display: 128x256.
    let raw_rot = make_grey_raw(256, 128, ExifOrientation::Rotate90);
    // Compare with sensor: 128x256, Normal orientation (already upright).
    let raw_normal = make_grey_raw(128, 256, ExifOrientation::Normal);

    // Linear gradient in display space: vertical gradient, brightens bottom half (y in 0.5..1.0)
    let model = AdjustmentModel {
        local_adjustments: vec![LocalAdjustment {
            mask: Mask::Linear {
                start: Point2::new(0.5, 0.0),
                end: Point2::new(0.5, 1.0),
                feather: 0.0, // hard step at midpoint
            },
            range: None,
            adjustments: PartialAdjustments {
                exposure: Some(1.0), // +1 EV
                ..Default::default()
            },
        }],
        ..Default::default()
    };

    let out_rot = develop_display(&raw_rot, &model);
    let out_norm = develop_display(&raw_normal, &model);

    assert_eq!((out_rot.width, out_rot.height), (128, 256));
    assert_eq!((out_norm.width, out_norm.height), (128, 256));

    // Sample top (unaffected) and bottom (brightened) in display space
    let top_y = 64;
    let bottom_y = 192;
    let x = 64;

    let p_top_rot = out_rot.pixels[top_y * 128 + x][1];
    let p_bottom_rot = out_rot.pixels[bottom_y * 128 + x][1];
    let p_top_norm = out_norm.pixels[top_y * 128 + x][1];
    let p_bottom_norm = out_norm.pixels[bottom_y * 128 + x][1];

    assert!(
        (p_top_rot - p_top_norm).abs() < 1e-4,
        "Top pixel mismatch: rot={p_top_rot}, norm={p_top_norm}"
    );
    assert!(
        (p_bottom_rot - p_bottom_norm).abs() < 1e-4,
        "Bottom pixel mismatch: rot={p_bottom_rot}, norm={p_bottom_norm}"
    );
    assert!(
        p_bottom_rot > p_top_rot * 1.9,
        "Bottom should be brightened vs top"
    );
}

#[test]
fn develop_radial_gradient_parity_on_rotate90() {
    let raw_rot = make_grey_raw(256, 128, ExifOrientation::Rotate90);
    let raw_normal = make_grey_raw(128, 256, ExifOrientation::Normal);

    // Radial mask centered at display (0.25, 0.75)
    let model = AdjustmentModel {
        local_adjustments: vec![LocalAdjustment {
            mask: Mask::Radial {
                center: Point2::new(0.25, 0.75),
                radii: Point2::new(0.15, 0.10),
                angle: 0.0,
                feather: 0.0,
                invert: false,
            },
            range: None,
            adjustments: PartialAdjustments {
                exposure: Some(1.0),
                ..Default::default()
            },
        }],
        ..Default::default()
    };

    let out_rot = develop_display(&raw_rot, &model);
    let out_norm = develop_display(&raw_normal, &model);

    // Sample center of radial mask: display x = 32, y = 192
    let cx = (0.25f32 * 127.0).round() as usize;
    let cy = (0.75f32 * 255.0).round() as usize;

    let p_center_rot = out_rot.pixels[cy * 128 + cx][1];
    let p_center_norm = out_norm.pixels[cy * 128 + cx][1];

    // Sample outside point: display x = 96, y = 64
    let ox = (0.75f32 * 127.0).round() as usize;
    let oy = (0.25f32 * 255.0).round() as usize;

    let p_out_rot = out_rot.pixels[oy * 128 + ox][1];
    let p_out_norm = out_norm.pixels[oy * 128 + ox][1];

    assert!(
        (p_center_rot - p_center_norm).abs() < 1e-4,
        "Center pixel mismatch: rot={p_center_rot}, norm={p_center_norm}"
    );
    assert!(
        (p_out_rot - p_out_norm).abs() < 1e-4,
        "Outside pixel mismatch: rot={p_out_rot}, norm={p_out_norm}"
    );
    assert!(
        p_center_rot > p_out_rot * 1.9,
        "Center should be brightened"
    );
}

#[test]
fn develop_brush_mask_parity_on_rotate90() {
    let raw_rot = make_grey_raw(256, 128, ExifOrientation::Rotate90);
    let raw_normal = make_grey_raw(128, 256, ExifOrientation::Normal);

    // Brush stamp centered at display (0.25, 0.75)
    let model = AdjustmentModel {
        local_adjustments: vec![LocalAdjustment {
            mask: Mask::Brush {
                dabs: vec![BrushDab::new(
                    Point2::new(0.25, 0.75),
                    0.12,
                    0.0,
                    1.0,
                    false,
                )],
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

    let out_rot = develop_display(&raw_rot, &model);
    let out_norm = develop_display(&raw_normal, &model);

    let cx = (0.25f32 * 127.0).round() as usize;
    let cy = (0.75f32 * 255.0).round() as usize;
    let ox = (0.75f32 * 127.0).round() as usize;
    let oy = (0.25f32 * 255.0).round() as usize;

    let p_center_rot = out_rot.pixels[cy * 128 + cx][1];
    let p_center_norm = out_norm.pixels[cy * 128 + cx][1];
    let p_out_rot = out_rot.pixels[oy * 128 + ox][1];
    let p_out_norm = out_norm.pixels[oy * 128 + ox][1];

    assert!(
        (p_center_rot - p_center_norm).abs() < 1e-2,
        "Brush center mismatch: rot={p_center_rot}, norm={p_center_norm}"
    );
    assert!(
        (p_out_rot - p_out_norm).abs() < 1e-4,
        "Brush outside mismatch: rot={p_out_rot}, norm={p_out_norm}"
    );
    assert!(
        p_center_rot > p_out_rot * 1.8,
        "Brush center should be brightened"
    );
}

#[test]
fn develop_bitmap_mask_parity_on_rotate90() {
    let raw_rot = make_grey_raw(256, 128, ExifOrientation::Rotate90);
    let raw_normal = make_grey_raw(128, 256, ExifOrientation::Normal);

    // 2x2 bitmap raster in display orientation:
    // (0,0)=0, (1,0)=1 (top-right brightened)
    // (0,1)=0, (1,1)=0
    let raster = Arc::new(MaskRaster::from_u8(
        100,
        "bitmap_test",
        2,
        2,
        &[0, 255, 0, 0],
    ));

    let model = AdjustmentModel {
        local_adjustments: vec![LocalAdjustment {
            mask: Mask::Bitmap {
                recipe: crate::types::BitmapRecipe {
                    digest: "bitmap_test".into(),
                    ..Default::default()
                },
                raster_id: 100,
            },
            range: None,
            adjustments: PartialAdjustments {
                exposure: Some(1.0),
                ..Default::default()
            },
        }],
        mask_rasters: vec![raster],
        ..Default::default()
    };

    let out_rot = develop_display(&raw_rot, &model);
    let out_norm = develop_display(&raw_normal, &model);

    // Display top-right: x = 127, y = 0
    let p_tr_rot = out_rot.pixels[0 * 128 + 127][1];
    let p_tr_norm = out_norm.pixels[0 * 128 + 127][1];

    // Display top-left: x = 0, y = 0 (weight 0)
    let p_tl_rot = out_rot.pixels[0 * 128 + 0][1];
    let p_tl_norm = out_norm.pixels[0 * 128 + 0][1];

    assert!(
        (p_tr_rot - p_tr_norm).abs() < 1e-4,
        "Bitmap TR mismatch: rot={p_tr_rot}, norm={p_tr_norm}"
    );
    assert!(
        (p_tl_rot - p_tl_norm).abs() < 1e-4,
        "Bitmap TL mismatch: rot={p_tl_rot}, norm={p_tl_norm}"
    );
    assert!(p_tr_rot > p_tl_rot * 1.9, "TR should be brightened");
}
