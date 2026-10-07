use crate::full_chain::oracle::{
    cpu_oracle, nonidentity_curve, nonidentity_lut, scene_linear_rgba, Case,
};
use crate::{present_chain_to_offscreen, CancelToken, GpuContext, LiveSession, PresentGeometry};
use raw_core::types::{
    adjustment::{AdjustmentModel, AutoExposureMode},
    WbMethod,
};
/// Native UI texture output must match the existing present oracle exactly.
#[test]
fn native_texture_matches_present_and_reuses_dispatch() {
    let ctx = GpuContext::new_blocking().unwrap();
    let (w, h) = (64_u32, 8_u32);
    let pixels = scene_linear_rgba(w as usize, h as usize);
    let session = LiveSession::new(&ctx, &pixels, w, h).unwrap();
    let case = Case {
        model: AdjustmentModel {
            sharpen_amount: 0.0,
            nr_color: 0.0,
            auto_exposure: AutoExposureMode::Off,
            ..Default::default()
        },
        capture: None,
        curve: nonidentity_curve(),
        lut: nonidentity_lut(9),
        wb_method: WbMethod::Cat16,
        film_lut: None,
        film_strength: 0.0,
    };
    let inputs = case.gpu_inputs();
    let cpu_float = cpu_oracle(&pixels, w, h, &case);
    let cpu_rgb: Vec<f32> = cpu_float
        .chunks_exact(4)
        .flat_map(|p| p[..3].iter().copied())
        .collect();
    let idx = session
        .render_chain_to_f32(&ctx, &inputs, &CancelToken::new())
        .unwrap()
        .unwrap();
    let expected =
        present_chain_to_offscreen(&ctx, &session, idx, PresentGeometry::IDENTITY).unwrap();
    let target = crate::PresentTexture::new(&ctx, (w, h)).unwrap();
    target
        .present(&ctx, &session, idx, PresentGeometry::IDENTITY)
        .unwrap();
    let count = target.dispatch_alloc_count();
    let sampled_view = target.srgb_view_handle();
    for _ in 0..3 {
        target
            .present(&ctx, &session, idx, PresentGeometry::IDENTITY)
            .unwrap();
        assert!(std::sync::Arc::ptr_eq(
            &sampled_view,
            &target.srgb_view_handle()
        ));
    }
    assert_eq!(target.dispatch_alloc_count(), count);
    assert!(target
        .present(&ctx, &session, 2, PresentGeometry::IDENTITY)
        .is_err());
    assert!(crate::PresentTexture::new(&ctx, (0, h)).is_err());
    assert_eq!(read_rgb(&ctx, &target), expected);
    // Orientation is a pixel permutation; destination dither can differ by one
    // quantisation level from an already-quantised CPU permutation.
    let mut orientation_targets = std::collections::BTreeMap::new();
    let mut crop_targets = std::collections::BTreeMap::new();
    for tag in 1..=8 {
        let orientation = raw_core::image::ExifOrientation::from_u16(tag);
        let (dw, dh, oriented) = raw_core::image::apply_orientation(&expected, w, h, orientation);
        let rotated = orientation_targets
            .entry((dw, dh))
            .or_insert_with(|| crate::PresentTexture::new(&ctx, (dw, dh)).unwrap());
        let geometry = PresentGeometry::from_inverse(orientation.display_to_sensor_matrix());
        rotated.present(&ctx, &session, idx, geometry).unwrap();
        let allocations = rotated.dispatch_alloc_count();
        rotated.present(&ctx, &session, idx, geometry).unwrap();
        assert_eq!(rotated.dispatch_alloc_count(), allocations);
        let actual = read_rgb(&ctx, &rotated);
        assert_eq!(actual.len(), oriented.len());
        for (i, (actual, expected)) in actual.iter().zip(&oriented).enumerate() {
            assert!(
                actual.abs_diff(*expected) <= 1,
                "EXIF {tag}, channel {i}: {actual} != {expected}"
            );
        }
        let (_, _, float_rgb) = raw_core::image::apply_orientation(&cpu_rgb, w, h, orientation);
        let float_rgba: Vec<f32> = float_rgb
            .chunks_exact(3)
            .flat_map(|p| [p[0], p[1], p[2], 1.0])
            .collect();
        let identity = raw_core::stages::perspective::Perspective::IDENTITY;
        let corrected = raw_core::stages::perspective::Perspective {
            vertical: 20.0,
            horizontal: -12.0,
            rotate: 2.0,
            scale: 130.0,
            aspect: 8.0,
            ..identity
        };
        for (angle, perspective) in [
            (0.0, identity),
            (90.0, identity),
            (180.0, identity),
            (270.0, identity),
            (3.5, identity),
            (-12.0, identity),
            (0.0, corrected),
            (90.0, corrected),
        ] {
            let crop = raw_core::types::Crop {
                left: 0.125,
                right: 0.875,
                top: 0.125,
                bottom: 0.875,
                angle,
            };
            let mapping = raw_core::stages::crop::CropPresentation::new(&crop, dw, dh);
            // Match the established GPU geometry gate: warp float pixels,
            // then quantize in destination coordinates. The legacy CPU RGB
            // tail quantizes before resampling and is a separate oracle.
            let geometry_inverse =
                perspective.inverse_matrix(raw_core::stages::perspective::aspect_ratio(dw, dh));
            let warped = raw_core::stages::perspective::warp_f32_rgba(
                &float_rgba,
                dw,
                dh,
                &geometry_inverse,
            );
            let (cw, ch, float_crop) =
                raw_core::stages::crop::apply_f32_rgba(&warped, dw, dh, &crop);
            let expected_crop =
                crate::dither::dither_and_quantize(&float_crop, cw as usize, ch as usize);
            assert_eq!(mapping.dims, (cw, ch));
            let cropped = crop_targets
                .entry(mapping.dims)
                .or_insert_with(|| crate::PresentTexture::new(&ctx, mapping.dims).unwrap());
            let inverse =
                raw_core::stages::perspective::Homography(orientation.display_to_sensor_matrix())
                    .mul(&geometry_inverse)
                    .mul(&mapping.inverse);
            cropped
                .present(
                    &ctx,
                    &session,
                    idx,
                    PresentGeometry::from_inverse(inverse.0),
                )
                .unwrap();
            let actual_crop = read_rgb(&ctx, &cropped);
            for (i, (actual, expected)) in actual_crop.iter().zip(&expected_crop).enumerate() {
                assert!(
                    actual.abs_diff(*expected) <= 1,
                    "EXIF {tag}, crop angle {angle}, channel {i}: {actual} != {expected}"
                );
            }
        }
    }
}

fn read_rgb(ctx: &GpuContext, target: &crate::PresentTexture) -> Vec<u8> {
    // Diagnostic readback only: production exposes the resident texture view.
    let (w, h) = target.dims();
    let row_bytes = (w * 4).div_ceil(256) * 256;
    let bytes = ctx.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("native-texture-test-readback"),
        size: (row_bytes * h) as u64,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut encoder = ctx.device.create_command_encoder(&Default::default());
    encoder.copy_texture_to_buffer(
        wgpu::ImageCopyTexture {
            texture: target.texture(),
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        wgpu::ImageCopyBuffer {
            buffer: &bytes,
            layout: wgpu::ImageDataLayout {
                offset: 0,
                bytes_per_row: Some(row_bytes),
                rows_per_image: Some(h),
            },
        },
        wgpu::Extent3d {
            width: w,
            height: h,
            depth_or_array_layers: 1,
        },
    );
    ctx.queue.submit(Some(encoder.finish()));
    let (sender, receiver) = std::sync::mpsc::channel();
    bytes
        .slice(..)
        .map_async(wgpu::MapMode::Read, move |r| sender.send(r).unwrap());
    ctx.device.poll(wgpu::Maintain::Wait);
    receiver.recv().unwrap().unwrap();
    let mapped = bytes.slice(..).get_mapped_range();
    let rgb = mapped
        .chunks_exact(row_bytes as usize)
        .flat_map(|row| row[..(w * 4) as usize].chunks_exact(4))
        .flat_map(|pixel| pixel[..3].iter().copied())
        .collect();
    drop(mapped);
    bytes.unmap();
    rgb
}
