use super::*;
use wgpu::util::DeviceExt;

#[test]
fn counts_match_present_quantization_and_reset_between_frames() {
    let ctx = GpuContext::new_blocking().expect("GPU adapter");
    let (width, height) = (64u32, 32u32);
    let pixels: Vec<f32> = (0..width * height)
        .flat_map(|i| {
            let value = (i % width) as f32 / width as f32;
            [value, 0.25, 0.75, 1.0]
        })
        .collect();
    let sources = [0, 1].map(|_| {
        ctx.device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: None,
                contents: bytemuck::cast_slice(&pixels),
                usage: wgpu::BufferUsages::STORAGE,
            })
    });
    let histogram = DisplayHistogram::new(&ctx, &sources, width, height);
    assert!(histogram.read(&ctx).unwrap().is_none());
    // The existing CPU dither oracle uses the same display blue-noise table.
    let rgb = crate::dither::dither_and_quantize(&pixels, width as usize, height as usize);
    let mut expected = vec![0u32; 768];
    for pixel in rgb.chunks_exact(3) {
        for c in 0..3 {
            expected[c * 256 + pixel[c] as usize] += 1;
        }
    }
    for index in [0, 1, 0] {
        let mut encoder = ctx.device.create_command_encoder(&Default::default());
        histogram.encode(&ctx, &mut encoder, index);
        ctx.queue.submit(Some(encoder.finish()));
        let bins = histogram.read(&ctx).unwrap().unwrap();
        assert_eq!(bins, expected);
    }
}

#[test]
fn large_preview_has_bounded_sample_count_and_fast_readback() {
    let ctx = GpuContext::new_blocking().expect("GPU adapter");
    let size = 2360u32;
    let pixels = vec![0.5f32; (size * size * 4) as usize];
    let sources = [0, 1].map(|_| {
        ctx.device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: None,
                contents: bytemuck::cast_slice(&pixels),
                usage: wgpu::BufferUsages::STORAGE,
            })
    });
    let histogram = DisplayHistogram::new(&ctx, &sources, size, size);
    for iteration in 0..3 {
        let start = std::time::Instant::now();
        let mut encoder = ctx.device.create_command_encoder(&Default::default());
        histogram.encode(&ctx, &mut encoder, 0);
        ctx.queue.submit(Some(encoder.finish()));
        let bins = histogram.read(&ctx).unwrap().unwrap();
        eprintln!("GPU-HISTOGRAM 2360x2360 encode+read: {:?}", start.elapsed());
        if iteration > 0 && ctx.adapter.get_info().backend == wgpu::Backend::Metal {
            assert!(start.elapsed() < std::time::Duration::from_millis(50));
        }
        assert_eq!(bins.len(), 768);
        assert_eq!(bins[..256].iter().sum::<u32>(), 236 * 236);
        assert_eq!(&bins[..256], &bins[256..512]);
        assert_eq!(&bins[..256], &bins[512..]);
    }
}
