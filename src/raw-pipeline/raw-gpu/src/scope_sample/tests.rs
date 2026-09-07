use super::*;
use raw_core::image::{ColorSpace, Image};

fn fixture(width: u32, height: u32) -> Vec<f32> {
    (0..width * height)
        .flat_map(|index| {
            let red = (index % 259) as f32 / 255.0 - 0.005;
            let green = ((index * 7) % 256) as f32 / 255.0;
            [red, green, 0.5, (index % 5) as f32 / 4.0]
        })
        .collect()
}

fn seed(ctx: &GpuContext, session: &LiveSession, index: usize, pixels: &[f32]) {
    ctx.queue.write_buffer(
        session.ping_pong_buffer(index),
        0,
        bytemuck::cast_slice(pixels),
    );
}

fn finish(ctx: &GpuContext, pending: ScopeReadback) -> ScopePixels {
    // Test-only wait. Production WebGPU maps are driven by the browser and do
    // not hold either a render borrow or the session queue while pending.
    ctx.device.poll(wgpu::Maintain::Wait);
    pollster::block_on(pending.read()).expect("scope map")
}

fn expected(pixels: &[f32], width: u32, height: u32) -> Vec<u8> {
    let mut image = Image::new(width, height, ColorSpace::DisplayEncodedSrgb);
    for (dest, source) in image.pixels.iter_mut().zip(pixels.chunks_exact(4)) {
        *dest = [source[0], source[1], source[2]];
    }
    let rgb = raw_core::view::encode::dither_and_quantize(&mut image);
    let (sample_width, sample_height) = sample_dims(width, height);
    (0..sample_width * sample_height)
        .flat_map(|index| {
            // Integer pixel-center oracle, independent of the WGSL float math.
            let x = (u64::from(2 * (index % sample_width) + 1) * u64::from(width)
                / u64::from(2 * sample_width)) as usize;
            let y = (u64::from(2 * (index / sample_width) + 1) * u64::from(height)
                / u64::from(2 * sample_height)) as usize;
            let offset = (y * width as usize + x) * 3;
            [rgb[offset], rgb[offset + 1], rgb[offset + 2], 255]
        })
        .collect()
}

#[test]
fn dimensions_are_bounded_without_upscaling_or_empty_rows() {
    assert_eq!(sample_dims(7, 3), (7, 3));
    assert_eq!(sample_dims(2048, 1536), (512, 384));
    assert_eq!(sample_dims(513, 771), (341, 512));
    assert_eq!(sample_dims(32768, 1), (512, 1));
}

#[test]
fn samples_match_actual_display_quantization_and_leave_source_unchanged() {
    let ctx = GpuContext::new_blocking().expect("GPU");
    for (width, height) in [(64, 64), (1025, 3), (3, 1025), (513, 771)] {
        let pixels = fixture(width, height);
        let session = LiveSession::new(&ctx, &pixels, width, height).expect("session");
        seed(&ctx, &session, 0, &pixels);
        let sampler = ScopeSampler::new(&ctx, &session);
        let sample = finish(&ctx, sampler.sample(&ctx, 0).expect("sample"));
        assert_eq!((sample.width, sample.height), sample_dims(width, height));
        assert_eq!(sample.rgba, expected(&pixels, width, height));

        // Read the exact chain source back: sampling must never modify any RGB
        // or alpha lane that presentation and other consumers still use.
        let byte_len = (pixels.len() * std::mem::size_of::<f32>()) as u64;
        let staging = ctx.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("scope-source-oracle"),
            size: byte_len,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut encoder = ctx.device.create_command_encoder(&Default::default());
        encoder.copy_buffer_to_buffer(session.ping_pong_buffer(0), 0, &staging, 0, byte_len);
        ctx.queue.submit(Some(encoder.finish()));
        let (sender, receiver) = oneshot::channel();
        staging
            .slice(..)
            .map_async(wgpu::MapMode::Read, move |result| {
                let _ = sender.send(result);
            });
        ctx.device.poll(wgpu::Maintain::Wait);
        pollster::block_on(receiver).unwrap().unwrap();
        assert_eq!(
            &*staging.slice(..).get_mapped_range(),
            bytemuck::cast_slice::<f32, u8>(&pixels)
        );
        staging.unmap();
    }
}

#[test]
fn pending_sample_is_frozen_while_later_frames_continue_and_latest_can_be_sampled() {
    let ctx = GpuContext::new_blocking().expect("GPU");
    let pixels = fixture(32, 24);
    let session = LiveSession::new(&ctx, &pixels, 32, 24).expect("session");
    let sampler = ScopeSampler::new(&ctx, &session);
    seed(&ctx, &session, 0, &pixels);
    let pending = sampler.sample(&ctx, 0).expect("sample");
    assert!(
        sampler.sample(&ctx, 1).is_err(),
        "cannot copy into mapped/pending staging"
    );
    let changed: Vec<f32> = pixels.iter().map(|value| 1.0 - value).collect();
    seed(&ctx, &session, 0, &changed);
    seed(&ctx, &session, 1, &changed);
    assert_eq!(finish(&ctx, pending).rgba, expected(&pixels, 32, 24));
    assert_eq!(
        finish(&ctx, sampler.sample(&ctx, 1).unwrap()).rgba,
        expected(&changed, 32, 24)
    );
}

#[test]
fn cancelled_and_completed_maps_release_the_slot_before_reuse() {
    let ctx = GpuContext::new_blocking().expect("GPU");
    let pixels = fixture(16, 8);
    let session = LiveSession::new(&ctx, &pixels, 16, 8).expect("session");
    seed(&ctx, &session, 0, &pixels);
    let sampler = ScopeSampler::new(&ctx, &session);
    assert!(sampler.sample(&ctx, 2).is_err());
    for complete in [false, true, false, true] {
        let pending = sampler.sample(&ctx, 0).unwrap();
        if complete {
            ctx.device.poll(wgpu::Maintain::Wait);
        }
        drop(pending);
        assert_eq!(
            finish(&ctx, sampler.sample(&ctx, 0).unwrap()).rgba,
            expected(&pixels, 16, 8)
        );
    }
    // A map rejected by the backend must not be unmapped twice or reused.
    // Explicitly abort while retaining the receiver to exercise Err.
    let pending = sampler.sample(&ctx, 0).unwrap();
    sampler.staging.buffer.unmap();
    ctx.device.poll(wgpu::Maintain::Wait);
    assert!(pollster::block_on(pending.read()).is_err());
    assert!(
        sampler.sample(&ctx, 0).is_err(),
        "failed sampler is retired"
    );
    let fresh = ScopeSampler::new(&ctx, &session);
    assert_eq!(
        finish(&ctx, fresh.sample(&ctx, 0).unwrap()).rgba,
        expected(&pixels, 16, 8)
    );
}

#[test]
fn pending_map_survives_freeing_the_sampler_and_source_session() {
    let ctx = GpuContext::new_blocking().expect("GPU");
    let pixels = fixture(16, 8);
    let session = LiveSession::new(&ctx, &pixels, 16, 8).expect("session");
    seed(&ctx, &session, 0, &pixels);
    let sampler = ScopeSampler::new(&ctx, &session);
    let pending = sampler.sample(&ctx, 0).unwrap();
    drop(sampler);
    drop(session);
    assert_eq!(finish(&ctx, pending).rgba, expected(&pixels, 16, 8));
}
