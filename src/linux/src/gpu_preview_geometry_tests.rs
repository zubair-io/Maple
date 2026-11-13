//! #5844: a crop over manual geometry presents as the CPU path renders it,
//! perspective first and the crop as its own second resample, on every EXIF
//! orientation. The composed single resample is the divergence it replaces.
use super::*;
use eframe::egui_wgpu::wgpu;
use raw_core::image::{apply_orientation, ColorSpace, Image};
use raw_core::stages::crop::{apply_f32_rgba, CropPresentation};
use raw_core::stages::perspective::{aspect_ratio, warp_f32_rgba, Homography, Perspective};
use raw_core::test_support::synth_chart::{ChartEncoding, SyntheticColorChart};
use raw_core::types::Crop;

fn corrected_model(angle: f32) -> AdjustmentModel {
    AdjustmentModel {
        perspective_vertical: 20.0,
        perspective_horizontal: -12.0,
        perspective_rotate: 2.0,
        perspective_scale: 130.0,
        crop: Crop {
            left: 0.125,
            right: 0.875,
            top: 0.125,
            bottom: 0.875,
            angle,
        },
        ..AdjustmentModel::default()
    }
}

fn oriented_dims(orientation: ExifOrientation, (w, h): (u32, u32)) -> (u32, u32) {
    if orientation.swaps_wh() {
        (h, w)
    } else {
        (w, h)
    }
}

fn map_read(ctx: &GpuContext, buffer: &wgpu::Buffer) -> Vec<u8> {
    let (sender, receiver) = std::sync::mpsc::channel();
    buffer
        .slice(..)
        .map_async(wgpu::MapMode::Read, move |r| sender.send(r).unwrap());
    ctx.device.poll(wgpu::Maintain::Wait);
    receiver.recv().unwrap().unwrap();
    let bytes = buffer.slice(..).get_mapped_range().to_vec();
    buffer.unmap();
    bytes
}

/// The display-encoded chain output the present samples, sensor framed.
fn chain_rgb(ctx: &GpuContext, session: &LiveSession, index: usize) -> Vec<f32> {
    let (w, h) = session.dims();
    let size = u64::from(w) * u64::from(h) * 16;
    let readback = ctx.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("geometry-test-chain-readback"),
        size,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut encoder = ctx.device.create_command_encoder(&Default::default());
    encoder.copy_buffer_to_buffer(session.ping_pong_buffer(index), 0, &readback, 0, size);
    ctx.queue.submit(Some(encoder.finish()));
    map_read(ctx, &readback)
        .as_chunks::<16>()
        .0
        .iter()
        .flat_map(|pixel| {
            pixel[..12]
                .as_chunks::<4>()
                .0
                .iter()
                .map(|c| f32::from_le_bytes(*c))
        })
        .collect()
}

fn present_rgb(
    ctx: &GpuContext,
    session: &LiveSession,
    index: usize,
    dims: (u32, u32),
    geometry: PresentGeometry,
) -> Vec<u8> {
    let target = PresentTexture::new(ctx, dims).unwrap();
    target.present(ctx, session, index, geometry).unwrap();
    let (w, h) = dims;
    let row_bytes = (w * 4).div_ceil(256) * 256;
    let readback = ctx.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("geometry-test-present-readback"),
        size: u64::from(row_bytes * h),
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut encoder = ctx.device.create_command_encoder(&Default::default());
    encoder.copy_texture_to_buffer(
        target.texture().as_image_copy(),
        wgpu::ImageCopyBuffer {
            buffer: &readback,
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
    map_read(ctx, &readback)
        .chunks_exact(row_bytes as usize)
        .flat_map(|row| row[..(w * 4) as usize].as_chunks::<4>().0.to_vec())
        .flat_map(|pixel| [pixel[0], pixel[1], pixel[2]])
        .collect()
}

/// The CPU path's geometry over the same chain output: orient, perspective
/// warp, then the crop's own resample, quantized with the present's dither.
fn cpu_rgb(
    chain: &[f32],
    sensor: (u32, u32),
    orientation: ExifOrientation,
    model: &AdjustmentModel,
) -> ((u32, u32), Vec<u8>) {
    let (dw, dh, oriented) = apply_orientation(chain, sensor.0, sensor.1, orientation);
    let rgba: Vec<f32> = oriented
        .as_chunks::<3>()
        .0
        .iter()
        .flat_map(|&[r, g, b]| [r, g, b, 1.0])
        .collect();
    let inverse = Perspective::from_model(model).inverse_matrix(aspect_ratio(dw, dh));
    let warped = warp_f32_rgba(&rgba, dw, dh, &inverse);
    let (cw, ch, cropped) = apply_f32_rgba(&warped, dw, dh, &model.crop);
    let mut image = Image::new(cw, ch, ColorSpace::DisplayEncodedSrgb);
    image.pixels = cropped
        .as_chunks::<4>()
        .0
        .iter()
        .map(|&[r, g, b, _]| [r, g, b])
        .collect();
    let rgb = raw_core::view::encode::dither_and_quantize(&mut image);
    ((cw, ch), rgb)
}

fn max_delta(a: &[u8], b: &[u8]) -> u8 {
    assert_eq!(a.len(), b.len());
    a.iter()
        .zip(b)
        .map(|(a, b)| a.abs_diff(*b))
        .max()
        .unwrap_or(0)
}

#[test]
fn crop_over_perspective_presents_as_the_cpu_path_on_every_orientation() {
    let bytes = SyntheticColorChart {
        patch_size: 16,
        guard: 2,
        encoding: ChartEncoding::Camera,
        ..Default::default()
    }
    .write_to_bytes();
    let raw = raw_core::decode::decode_bytes(&bytes, "dng").unwrap();
    let ctx = GpuContext::new_blocking().unwrap();
    let token = CancelToken::new();
    let mut preview =
        GpuPreview::open(&ctx, &raw, &bytes, "dng", &corrected_model(3.5), 2048).unwrap();
    let sensor = preview.session.dims();
    let mut composed_worst = 0;
    for angle in [3.5, -12.0] {
        let model = corrected_model(angle);
        assert!(preview
            .render(&ctx, &raw, &bytes, "dng", &model, &token)
            .unwrap());
        let index = preview
            .session
            .render_chain_to_f32(&ctx, &preview.profile.inputs, &token)
            .unwrap()
            .unwrap();
        let session = &preview.session;
        let chain = chain_rgb(&ctx, session, index);
        for tag in 1..=8 {
            let orientation = ExifOrientation::from_u16(tag);
            let (dw, dh) = oriented_dims(orientation, sensor);
            let crop = CropPresentation::new(&model.crop, dw, dh);
            assert!(crop.resamples, "EXIF {tag}, angle {angle}");
            let (dims, want) = cpu_rgb(&chain, sensor, orientation, &model);
            assert_eq!(crop.dims, dims, "EXIF {tag}, angle {angle}");
            let geometry = present_geometry(orientation, sensor, &model);
            let staged = max_delta(&present_rgb(&ctx, session, index, dims, geometry), &want);
            let composed = Homography(orientation.display_to_sensor_matrix())
                .mul(&Perspective::from_model(&model).inverse_matrix(aspect_ratio(dw, dh)))
                .mul(&crop.inverse);
            let single = PresentGeometry::from_inverse(composed.0);
            let composed = max_delta(&present_rgb(&ctx, session, index, dims, single), &want);
            eprintln!("EXIF {tag}, crop {angle}°: two-stage {staged}, composed {composed} levels");
            assert!(staged <= 1, "EXIF {tag}, angle {angle}: {staged} levels");
            composed_worst = composed_worst.max(composed);
        }
    }
    assert!(
        composed_worst > 1,
        "the composed resample no longer differs; the gate lost its signal"
    );
}

#[test]
fn single_stage_geometry_is_kept_without_a_resampling_crop_over_perspective() {
    let (w, h) = (64, 48);
    assert_eq!(
        present_geometry(ExifOrientation::Normal, (w, h), &AdjustmentModel::default()),
        PresentGeometry::IDENTITY
    );
    let perspective_only = AdjustmentModel {
        perspective_rotate: 2.0,
        ..AdjustmentModel::default()
    };
    let expected = Homography(ExifOrientation::Rotate90.display_to_sensor_matrix())
        .mul(&Perspective::from_model(&perspective_only).inverse_matrix(aspect_ratio(w, h)));
    assert_eq!(
        present_geometry(ExifOrientation::Rotate90, (h, w), &perspective_only),
        PresentGeometry::from_inverse(expected.0)
    );
    let crop_only = AdjustmentModel {
        crop: corrected_model(3.5).crop,
        ..AdjustmentModel::default()
    };
    let crop = CropPresentation::new(&crop_only.crop, w, h);
    assert_eq!(
        present_geometry(ExifOrientation::Normal, (w, h), &crop_only),
        PresentGeometry::from_inverse(crop.inverse.0)
    );
}

#[test]
fn a_crop_over_perspective_is_drawn_on_the_gpu() {
    assert!(GpuPreview::validate(&corrected_model(-12.0)).is_ok());
}
