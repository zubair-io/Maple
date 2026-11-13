use super::*;
use wgpu::util::DeviceExt;

#[test]
fn android_negotiates_float_wide_color_only_when_both_sides_support_it() {
    use wgpu::TextureFormat::*;
    let mut caps = wgpu::SurfaceCapabilities::default();
    caps.formats = vec![Rgba16Float, Rgba8Unorm];
    assert_eq!(
        pick_android_surface_format(&caps, true).unwrap(),
        Rgba16Float
    );
    assert_eq!(
        pick_android_surface_format(&caps, false).unwrap(),
        Rgba8Unorm
    );
    caps.formats = vec![Rgba8Unorm];
    assert_eq!(
        pick_android_surface_format(&caps, true).unwrap(),
        Rgba8Unorm
    );
    caps.formats = vec![Rgba8UnormSrgb];
    assert!(pick_android_surface_format(&caps, true).is_err());
}

#[test]
fn p3_present_matches_core_in_unclipped_linear_scrgb() {
    let ctx = GpuContext::new_blocking().expect("GPU context");
    // Exact 8-bit codes survive the shared dither/quantize path unchanged.
    let pixels = [
        [1.0f32, 0.0, 0.0, 1.0],
        [0.0, 1.0, 0.0, 1.0],
        [0.0, 0.0, 1.0, 1.0],
        [10.0 / 255.0, 11.0 / 255.0, 128.0 / 255.0, 1.0],
        [1.0, 1.0, 1.0, 1.0],
    ];
    let source = ctx
        .device
        .create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("P3 transport samples"),
            contents: bytemuck::cast_slice(&pixels),
            usage: wgpu::BufferUsages::STORAGE,
        });
    let format = wgpu::TextureFormat::Rgba16Float;
    let extent = wgpu::Extent3d {
        width: pixels.len() as u32,
        height: 1,
        depth_or_array_layers: 1,
    };
    let target = ctx.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("Android scRGB transport"),
        size: extent,
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let readback = ctx.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("scRGB readback"),
        size: 256,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let (pipeline, layout) = build_present_pipeline(&ctx, format);
    let dispatch = build_present_dispatch(
        &ctx,
        &layout,
        &source,
        (extent.width, 1),
        PresentGeometry::IDENTITY,
    );
    let mut encoder = ctx.device.create_command_encoder(&Default::default());
    encode_present_pass(
        &mut encoder,
        &pipeline,
        &dispatch.bind_group,
        &target.create_view(&Default::default()),
    );
    encoder.copy_texture_to_buffer(
        target.as_image_copy(),
        wgpu::ImageCopyBuffer {
            buffer: &readback,
            layout: wgpu::ImageDataLayout {
                offset: 0,
                bytes_per_row: Some(256),
                rows_per_image: Some(1),
            },
        },
        extent,
    );
    ctx.queue.submit(Some(encoder.finish()));
    let slice = readback.slice(..);
    let (send, receive) = std::sync::mpsc::channel();
    slice.map_async(wgpu::MapMode::Read, move |result| {
        send.send(result).unwrap()
    });
    ctx.device.poll(wgpu::Maintain::Wait);
    receive.recv().unwrap().unwrap();
    let mapped = slice.get_mapped_range();
    let actual: Vec<f32> = mapped[..pixels.len() * 8]
        .chunks_exact(2)
        .map(|pair| half::f16::from_bits(u16::from_le_bytes([pair[0], pair[1]])).to_f32())
        .collect();
    let matrix = raw_core::color::matrices::M_SRGB_TO_P3.inverse().unwrap();
    for (index, pixel) in pixels.iter().enumerate() {
        let expected =
            matrix.mul_vec([pixel[0], pixel[1], pixel[2]].map(raw_core::view::gamma::srgb_degamma));
        for channel in 0..3 {
            assert!(
                (actual[index * 4 + channel] - expected[channel]).abs() < 0.0015,
                "pixel {index}, channel {channel}: {} vs {}",
                actual[index * 4 + channel],
                expected[channel]
            );
        }
        assert_eq!(actual[index * 4 + 3], 1.0);
    }
    assert!(
        actual[0] > 1.0 && actual[1] < 0.0,
        "P3 red must retain its out-of-sRGB components"
    );
}
