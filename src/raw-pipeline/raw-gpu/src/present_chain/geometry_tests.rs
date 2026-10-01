//! Exercise the actual present shader against the integer export tail (#3982).
use super::*;
use crate::{dither::dither_and_quantize, QuantizedDisplayTail};
use raw_core::{
    image::{apply_orientation, ExifOrientation},
    stages::{
        crop::{self, CropPresentation},
        perspective,
    },
    types::Crop,
    xmp::AdjustmentModel,
};

#[test]
fn quantized_geometry_matches_export_for_all_exif_and_crop_branches() {
    let ctx = GpuContext::new_blocking().expect("GPU context");
    let (w, h) = (31, 19);
    // High-frequency asymmetric texture catches axis swaps, fill and a changed
    // quantizer/bilinear order; a smooth grey ramp would hide those failures.
    let rgba: Vec<f32> = (0..w * h)
        .flat_map(|i| {
            [
                (i * 37 % 251) as f32 / 251.,
                (i * 17 % 239) as f32 / 239.,
                (i * 11 % 233) as f32 / 233.,
                1.,
            ]
        })
        .collect();
    let session = LiveSession::new(&ctx, &rgba, w, h).unwrap();
    ctx.queue
        .write_buffer(session.ping_pong_buffer(0), 0, bytemuck::cast_slice(&rgba));
    let quantized = dither_and_quantize(&rgba, w as usize, h as usize);
    for exif in 1..=8 {
        let orientation = ExifOrientation::from_u16(exif);
        let (ow, oh, oriented) = apply_orientation(&quantized, w, h, orientation);
        for perspective_enabled in [false, true] {
            let model = AdjustmentModel {
                perspective_vertical: if perspective_enabled { 23. } else { 0. },
                perspective_horizontal: if perspective_enabled { -17. } else { 0. },
                perspective_rotate: if perspective_enabled { 3. } else { 0. },
                ..AdjustmentModel::default()
            };
            let warp = perspective::Perspective::from_model(&model);
            let warped = perspective::apply_int_rgb(&oriented, ow, oh, &warp)
                .unwrap_or_else(|| oriented.clone());
            for angle in [0., 90., 180., 270., -90., 90.005, 7., -13., 360.] {
                let crop = Crop {
                    left: 0.17,
                    top: 0.21,
                    right: 0.78,
                    bottom: 0.89,
                    angle,
                };
                let mapping = CropPresentation::new(&crop, ow, oh);
                let geometry = if warp.is_identity() {
                    PresentGeometry::IDENTITY
                } else {
                    PresentGeometry::from_inverse(
                        warp.inverse_matrix(perspective::aspect_ratio(ow, oh)).0,
                    )
                }
                .with_quantized_tail(QuantizedDisplayTail {
                    orientation_rows: orientation.display_pixel_rows(w, h),
                    crop_rows: mapping.rows,
                    crop_rotation: mapping.rotation,
                    dimensions: [ow, oh, 1, u32::from(mapping.bilinear)],
                    output_size: mapping.output_size,
                });
                let (cw, ch, want) = crop::apply_int_rgb(&warped, ow, oh, &crop);
                assert_eq!(geometry.surface_dimensions((w, h)), (cw, ch));
                let got = present_chain_to_offscreen(&ctx, &session, 0, geometry).unwrap();
                let maximum = got
                    .iter()
                    .zip(&want)
                    .map(|(a, b)| a.abs_diff(*b))
                    .max()
                    .unwrap();
                let budget = u8::from(perspective_enabled || mapping.bilinear);
                assert!(maximum <= budget, "EXIF {exif}, perspective {perspective_enabled}, angle {angle}: {maximum} > {budget}");
            }
        }
    }
}
