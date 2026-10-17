use super::*;
use crate::{pool_data_storage, GpuImage};

#[test]
fn warm_two_pass_denoise_reuses_resources_and_clears_its_accumulators() {
    let ctx = GpuContext::new_blocking().expect("required GPU adapter");
    let values: Vec<f32> = (0..23 * 19)
        .flat_map(|i| [((i * 31) % 127) as f32 / 31., i as f32 / 1000., -0.07, 0.37])
        .collect();
    let source = GpuImage::upload(&ctx, &values, 23, 19);
    let basic = GpuImage::upload(&ctx, &vec![0.; values.len()], 23, 19);
    let output = GpuImage::upload(&ctx, &vec![0.; values.len()], 23, 19);
    let run = |sigma: f32| {
        ctx.frame_pool.borrow_mut().begin_frame(4629);
        let parameters = pool_data_storage(
            &ctx,
            bytemuck::cast_slice(&[f32::INFINITY, sigma, sigma, sigma]),
            "bm3d-parameters",
        );
        let mut encoder = ctx.device.create_command_encoder(&Default::default());
        encode_bm3d_pass(
            &ctx,
            &mut encoder,
            &source.buffer,
            None,
            &parameters,
            &basic.buffer,
            source.dims(),
        );
        encode_bm3d_pass(
            &ctx,
            &mut encoder,
            &source.buffer,
            Some(&basic.buffer),
            &parameters,
            &output.buffer,
            source.dims(),
        );
        ctx.queue.submit(Some(encoder.finish()));
        let result = output.read_back_blocking(&ctx);
        ctx.frame_pool.borrow_mut().end_frame();
        assert!(result
            .chunks_exact(4)
            .all(|p| p[3].to_bits() == 0.37f32.to_bits()));
        result
    };
    let first = run(0.02);
    assert_ne!(first, values);
    let allocations = ctx.frame_pool.borrow().alloc_count();
    assert!(allocations > 0);
    assert_eq!(first, run(0.02));
    assert_ne!(first, run(0.2));
    assert_eq!(first, run(0.02));
    let changed: Vec<f32> = values
        .chunks_exact(4)
        .flat_map(|p| [p[0] * 1.5, p[1], p[2], p[3]])
        .collect();
    ctx.queue
        .write_buffer(&source.buffer, 0, bytemuck::cast_slice(&changed));
    assert_ne!(first, run(0.02));
    ctx.queue
        .write_buffer(&source.buffer, 0, bytemuck::cast_slice(&values));
    assert_eq!(first, run(0.02));
    assert_eq!(ctx.frame_pool.borrow().alloc_count(), allocations);
}
