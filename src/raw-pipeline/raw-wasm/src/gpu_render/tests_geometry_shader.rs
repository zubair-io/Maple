//! End-to-end parity for the live display geometry tail (#3982).
//!
//! The GPU shader must agree with the export order across EXIF orientation,
//! perspective and crop/straighten. Keep this at the raw-wasm boundary so the
//! production `display_geometry` adapter and the actual `raw-gpu` shader are
//! tested together.

use raw_core::{
    image::{apply_orientation, ExifOrientation},
    stages::{crop, perspective},
    types::Crop,
};
use raw_gpu::{dither_and_quantize, present_chain_to_offscreen, GpuContext, LiveSession};

#[test]
fn display_geometry_shader_matches_export_for_all_exif_and_crop_branches() {
    let context = GpuContext::new_blocking().expect("GPU context");
    let (width, height) = (31, 19);
    // An asymmetric high-frequency pattern catches axis swaps and resampling
    // order changes that a grey ramp would hide.
    let rgba: Vec<f32> = (0..width * height)
        .flat_map(|index| {
            [
                (index * 37 % 251) as f32 / 251.0,
                (index * 17 % 239) as f32 / 239.0,
                (index * 11 % 233) as f32 / 233.0,
                1.0,
            ]
        })
        .collect();
    let session = LiveSession::new(&context, &rgba, width, height).expect("session");
    context
        .queue
        .write_buffer(session.ping_pong_buffer(0), 0, bytemuck::cast_slice(&rgba));
    let quantized = dither_and_quantize(&rgba, width as usize, height as usize);

    for exif in 1..=8 {
        let orientation = ExifOrientation::from_u16(exif);
        let (oriented_width, oriented_height, oriented) =
            apply_orientation(&quantized, width, height, orientation);
        for perspective_enabled in [false, true] {
            let perspective_model = raw_core::xmp::AdjustmentModel {
                perspective_vertical: if perspective_enabled { 23.0 } else { 0.0 },
                perspective_horizontal: if perspective_enabled { -17.0 } else { 0.0 },
                perspective_rotate: if perspective_enabled { 3.0 } else { 0.0 },
                ..raw_core::xmp::AdjustmentModel::default()
            };
            let warp = perspective::Perspective::from_model(&perspective_model);
            let warped =
                perspective::apply_int_rgb(&oriented, oriented_width, oriented_height, &warp)
                    .unwrap_or_else(|| oriented.clone());
            for angle in [0.0, 90.0, 180.0, 270.0, -90.0, 90.005, 7.0, -13.0, 360.0] {
                let crop = Crop {
                    left: 0.17,
                    top: 0.21,
                    right: 0.78,
                    bottom: 0.89,
                    angle,
                };
                let model = raw_core::xmp::AdjustmentModel {
                    crop: crop.clone(),
                    ..perspective_model.clone()
                };
                let geometry = super::display_geometry(orientation, (width, height), &model);
                let (crop_width, crop_height, expected) =
                    crop::apply_int_rgb(&warped, oriented_width, oriented_height, &crop);
                assert_eq!(
                    geometry.surface_dimensions((width, height)),
                    (crop_width, crop_height),
                    "EXIF {exif}, perspective {perspective_enabled}, angle {angle}"
                );
                let actual = present_chain_to_offscreen(&context, &session, 0, geometry)
                    .expect("offscreen present");
                let maximum = actual
                    .iter()
                    .zip(&expected)
                    .map(|(actual, expected)| actual.abs_diff(*expected))
                    .max()
                    .unwrap_or(0);
                let resamples = raw_core::stages::crop::CropPresentation::new(
                    &crop,
                    oriented_width,
                    oriented_height,
                )
                .resamples;
                let budget = u8::from(perspective_enabled || resamples);
                assert!(
                    maximum <= budget,
                    "EXIF {exif}, perspective {perspective_enabled}, angle {angle}: \
                     {maximum} > {budget}; actual {:?}, expected {:?}, geometry {geometry:?}",
                    &actual[..actual.len().min(9)],
                    &expected[..expected.len().min(9)],
                );
            }
        }
    }
}
