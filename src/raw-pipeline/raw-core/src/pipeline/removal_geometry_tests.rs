use super::*;
use crate::{
    image::{apply_orientation, ColorSpace, Image},
    pipeline::pano::{
        opcode_apply::apply_warp_rectilinear,
        opcodes::{OpcodeList3, WarpPlaneParams, WarpRectilinearOpcode},
    },
};

fn raw() -> RawImage {
    crate::decode_raw(
        include_bytes!("../../../../../test-fixtures/removal/basic/source.dng"),
        "dng",
    )
    .unwrap()
}

#[test]
fn all_exif_orientations_match_the_actual_pixel_permutation() {
    let mut raw = raw();
    let pixels: Vec<u8> = (0..raw.height)
        .flat_map(|y| (0..raw.width).flat_map(move |x| [x as u8, y as u8, 17]))
        .collect();
    for orientation in [
        ExifOrientation::Normal,
        ExifOrientation::HorizontalFlip,
        ExifOrientation::Rotate180,
        ExifOrientation::VerticalFlip,
        ExifOrientation::Transpose,
        ExifOrientation::Rotate90,
        ExifOrientation::Transverse,
        ExifOrientation::Rotate270,
    ] {
        raw.orientation = orientation;
        let map = RemovalGeometry::new(&raw, &AdjustmentModel::default()).unwrap();
        let (w, h, oriented) = apply_orientation(&pixels, raw.width, raw.height, orientation);
        for y in 0..h {
            for x in 0..w {
                let source = map
                    .source([(x as f32 + 0.5) / w as f32, (y as f32 + 0.5) / h as f32])
                    .unwrap();
                let index = (y * w + x) as usize * 3;
                assert_eq!(
                    source,
                    [
                        (oriented[index] as f32 + 0.5) / raw.width as f32,
                        (oriented[index + 1] as f32 + 0.5) / raw.height as f32
                    ],
                    "{orientation:?} {x},{y}"
                );
            }
        }
    }
}

#[test]
fn perspective_and_orientation_follow_the_real_float_render_tail() {
    let mut raw = raw();
    let pixels: Vec<f32> = (0..raw.height)
        .flat_map(|y| {
            (0..raw.width)
                .flat_map(move |x| [(x as f32 + 0.5) / 16.0, (y as f32 + 0.5) / 8.0, 0.5, 1.0])
        })
        .collect();
    let model = AdjustmentModel {
        perspective_vertical: 14.0,
        perspective_horizontal: -9.0,
        perspective_rotate: 3.0,
        perspective_scale: 115.0,
        ..Default::default()
    };
    for orientation in [
        ExifOrientation::Normal,
        ExifOrientation::Rotate90,
        ExifOrientation::Transverse,
    ] {
        raw.orientation = orientation;
        let map = RemovalGeometry::new(&raw, &model).unwrap();
        let (w, h, oriented) = super::super::orient::apply_orientation_f32_rgba(
            &pixels,
            raw.width,
            raw.height,
            orientation,
        );
        let inverse = Perspective::from_model(&model).inverse_matrix(w as f32 / h as f32);
        let rendered = crate::stages::perspective::warp_f32_rgba(&oriented, w, h, &inverse);
        let mut compared = 0;
        for y in 0..h {
            for x in 0..w {
                if let Some(source) =
                    map.source([(x as f32 + 0.5) / w as f32, (y as f32 + 0.5) / h as f32])
                {
                    if source[0] > 0.5 / 16.0
                        && source[0] < 15.5 / 16.0
                        && source[1] > 0.5 / 8.0
                        && source[1] < 7.5 / 8.0
                    {
                        let index = (y * w + x) as usize * 4;
                        for c in 0..2 {
                            assert!((source[c] - rendered[index + c]).abs() < 1e-6);
                        }
                        compared += 1;
                    }
                }
            }
        }
        assert!(compared > 50);
    }
}

fn warp(radial: f64, tangential: f64) -> WarpRectilinearOpcode {
    WarpRectilinearOpcode {
        center_x: 0.4,
        center_y: 0.6,
        planes: vec![
            WarpPlaneParams {
                kr: [1.0, radial, 0.0, 0.0],
                kt: [tangential, -tangential]
            };
            3
        ],
    }
}

#[test]
fn embedded_green_lookup_matches_rendered_coordinates_in_the_sensor_active_area() {
    let mut raw = raw();
    let area = ActiveAreaRect {
        left: 1,
        top: 1,
        width: 14,
        height: 6,
    };
    let warp = warp(-0.15, 0.007);
    raw.crop_rect = Some(CropRect {
        x: 2,
        y: 1,
        w: 12,
        h: 6,
    });
    raw.opcode_list3 = Some((
        OpcodeList3 {
            skipped_unknown: 0,
            opcodes: vec![PanoOpcode::WarpRectilinear(warp.clone())],
        },
        area,
    ));
    let model = AdjustmentModel {
        lens_correction_distortion: 70.0,
        lens_correction_ca: 35.0,
        ..Default::default()
    };
    let map = RemovalGeometry::new(&raw, &model).unwrap();
    assert_eq!(map.source_size(), [12, 6]);
    for axis in 0..2 {
        let mut image = Image::new(raw.width, raw.height, ColorSpace::CameraNativeLinearRgb);
        for y in 0..raw.height {
            for x in 0..raw.width {
                image.pixels[(y * raw.width + x) as usize] =
                    [if axis == 0 { x as f32 } else { y as f32 }; 3];
            }
        }
        apply_warp_rectilinear(&mut image, &warp, area, 0.7, 0.35);
        for y in 0..6 {
            for x in 0..12 {
                let source = map
                    .source([(x as f32 + 0.5) / 12.0, (y as f32 + 0.5) / 6.0])
                    .unwrap();
                let mapped = source[axis] * map.source_size()[axis] as f32 - 0.5
                    + if axis == 0 { 2.0 } else { 1.0 };
                let rendered = image.pixels[((y + 1) * raw.width + x + 2) as usize][1];
                // Keys A=-.75 does not reproduce a linear ramp exactly:
                // its first-moment bias is <= sqrt(3)/36 pixels (.048113),
                // plus the renderer's 1/32-pixel phase quantization. Compare
                // only full cubic footprints; sticky borders alter moments.
                let first = if axis == 0 { area.left } else { area.top } as f32;
                let size = if axis == 0 { area.width } else { area.height } as f32;
                if mapped >= first + 1.0 && mapped <= first + size - 2.0 {
                    assert!(
                        (mapped - rendered).abs() <= 3.0_f32.sqrt() / 36.0 + 1.0 / 32.0 + 1e-5,
                        "{axis} {x},{y}: {mapped}/{rendered}"
                    );
                }
            }
        }
    }
}

#[test]
fn multiple_embedded_gathers_follow_reverse_list_order_and_off_skips_them() {
    let mut raw = raw();
    let area = ActiveAreaRect::full(raw.width, raw.height);
    let (a, b) = (warp(-0.15, 0.0), warp(0.08, 0.02));
    raw.opcode_list3 = Some((
        OpcodeList3 {
            skipped_unknown: 0,
            opcodes: vec![
                PanoOpcode::WarpRectilinear(a.clone()),
                PanoOpcode::WarpRectilinear(b.clone()),
            ],
        },
        area,
    ));
    let map = RemovalGeometry::new(&raw, &AdjustmentModel::default()).unwrap();
    let point = [3.0, 2.0];
    let expected = WarpPointMap::new(&a, area, 1.0, 1.0)
        .unwrap()
        .source(WarpPointMap::new(&b, area, 1.0, 1.0).unwrap().source(point));
    let actual = map.source([3.5 / 16.0, 2.5 / 8.0]).unwrap();
    for c in 0..2 {
        assert!((actual[c] - (expected[c] + 0.5) as f32 / [16.0, 8.0][c]).abs() < 1e-7);
    }
    let off = AdjustmentModel {
        lens_profile_enable: crate::xmp::LensProfileEnable::Off,
        ..Default::default()
    };
    assert_eq!(
        RemovalGeometry::new(&raw, &off)
            .unwrap()
            .source([3.5 / 16.0, 2.5 / 8.0]),
        Some([3.5 / 16.0, 2.5 / 8.0])
    );
}

#[test]
fn batch_preserves_unmapped_surround_without_clamping_and_validates_requests() {
    let raw = raw();
    let model = AdjustmentModel {
        perspective_x: 100.0,
        ..Default::default()
    };
    let result: serde_json::Value = serde_json::from_str(
        &map_removal_display_points(
            &raw,
            &model,
            r#"{"schema":1,"points":[[0.0,0.5],[0.8,0.5],[1.1,0.5]]}"#,
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(result["source_size"], serde_json::json!([16, 8]));
    assert!(result["points"][0].is_null());
    assert!(result["points"][1].is_array());
    assert!(result["points"][2].is_null());
    for request in [
        r#"{"schema":2,"points":[]}"#,
        r#"{"schema":1,"points":[[1]]}"#,
        r#"{"schema":1,"points":[],"unexpected":1}"#,
    ] {
        assert!(map_removal_display_points(&raw, &model, request).is_err());
    }
    assert!(RemovalGeometry::new(&raw, &AdjustmentModel::default())
        .unwrap()
        .source([f32::NAN, 0.5])
        .is_none());
}

#[test]
fn missing_imported_lens_profile_is_not_silently_treated_as_identity() {
    let model = AdjustmentModel {
        lens_profile: format!("lcp1:{}", "f".repeat(64)),
        ..Default::default()
    };
    assert!(RemovalGeometry::new(&raw(), &model).is_err());
}

#[test]
fn imported_lcp_mapping_matches_the_actual_registered_render_and_off_bypasses_it() {
    let mut raw = raw();
    raw.camera_make = "Maple Geometry".into();
    raw.camera_model = "Synthetic".into();
    raw.unique_camera_model = Some("Synthetic".into());
    raw.focal_length = Some(35.0);
    raw.aperture = Some(4.0);
    raw.lens_metadata.lens_model = Some("Prime".into());
    raw.lens_metadata.camera_make = Some(raw.camera_make.clone());
    raw.lens_metadata.camera_model = Some(raw.camera_model.clone());
    raw.lens_metadata.focus_m = Some(4.0);
    let xml = r#"<x:xmpmeta xmlns:x="adobe:ns:meta/" xmlns:r="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:p="http://ns.adobe.com/photoshop/1.0/" xmlns:c="http://ns.adobe.com/photoshop/1.0/camera-profile">
        <r:RDF><r:Description><p:CameraProfiles><r:Seq><r:li c:Make="Maple Geometry" c:Model="Synthetic" c:Lens="Prime" c:CameraRawProfile="True" c:SensorFormatFactor="1" c:FocalLength="35" c:ApertureValue="4" c:FocusDistance="4" c:ImageWidth="16" c:ImageLength="8">
        <c:PerspectiveModel c:Version="2" c:RadialDistortParam1="-0.15"/></r:li></r:Seq></p:CameraProfiles></r:Description></r:RDF></x:xmpmeta>"#;
    let reference = lens_profile::register(xml).unwrap()["reference"]
        .as_str()
        .unwrap()
        .to_owned();
    let model = AdjustmentModel {
        lens_profile: reference,
        lens_correction_distortion: 75.0,
        lens_correction_vignetting: 0.0,
        ..Default::default()
    };
    let calibration = lens_profile::resolve_for_model(&raw, &model)
        .unwrap()
        .unwrap()
        .calibration;
    let map = RemovalGeometry::new(&raw, &model).unwrap();
    let mut image = Image::new(raw.width, raw.height, ColorSpace::CameraNativeLinearRgb);
    for y in 0..raw.height {
        for x in 0..raw.width {
            image.pixels[(y * raw.width + x) as usize] = [x as f32, y as f32, 0.0];
        }
    }
    lens_profile::apply(
        &mut image,
        &calibration,
        ActiveAreaRect::full(raw.width, raw.height),
        LensCorrectionScales::from_model(&model),
    )
    .unwrap();
    let mut changed = false;
    for y in 1..raw.height - 1 {
        for x in 1..raw.width - 1 {
            let input = [
                (x as f32 + 0.5) / raw.width as f32,
                (y as f32 + 0.5) / raw.height as f32,
            ];
            let mapped = map.source(input).unwrap();
            let rendered = image.pixels[(y * raw.width + x) as usize];
            for axis in 0..2 {
                let size = [raw.width, raw.height][axis] as f32;
                assert!((mapped[axis] * size - 0.5 - rendered[axis]).abs() < 1e-5);
            }
            changed |= mapped != input;
        }
    }
    assert!(changed);
    let off = AdjustmentModel {
        lens_profile_enable: crate::xmp::LensProfileEnable::Off,
        ..model
    };
    assert_eq!(
        RemovalGeometry::new(&raw, &off)
            .unwrap()
            .source([0.25, 0.5]),
        Some([0.25, 0.5])
    );
}
