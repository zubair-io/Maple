use super::*;
use crate::pool_data_storage;

#[test]
fn warm_matching_reuses_resources_and_observes_luma_threshold_and_row_changes() {
    let ctx = GpuContext::new_blocking().expect("required GPU adapter");
    let constant = vec![0.18f32; 20 * 20];
    let noise: Vec<f32> = (0..400u32)
        .map(|i| {
            let bits = i.wrapping_mul(747796405).wrapping_add(2891336453);
            (bits ^ (bits >> 17)) as f32 / u32::MAX as f32
        })
        .collect();
    let run = |values: &[f32], tau: f32, row: u32| {
        ctx.frame_pool.borrow_mut().begin_frame(4629);
        let luma = pool_data_storage(&ctx, bytemuck::cast_slice(values), "bm3d-test-luma");
        let threshold = pool_data_storage(&ctx, &tau.to_ne_bytes(), "bm3d-test-threshold");
        let mut encoder = ctx.device.create_command_encoder(&Default::default());
        let matches = encode_bm3d_match_row(&ctx, &mut encoder, &luma, &threshold, (20, 20), row);
        ctx.queue.submit(Some(encoder.finish()));
        let result = matches.read_back_blocking(&ctx);
        ctx.frame_pool.borrow_mut().end_frame();
        assert_eq!(result.len(), 3);
        for (column, group) in result.iter().enumerate() {
            assert_eq!(group.positions[0], [column as u32 * STRIDE as u32, row]);
        }
        result
    };
    let first = run(&constant, 0., 0);
    assert!(first.iter().all(|group| group.count == GROUP_MAX as u32));
    let allocations = ctx.frame_pool.borrow().alloc_count();
    assert!(allocations > 0);
    assert_eq!(first, run(&constant, 0., 0));
    assert!(run(&noise, 0., 0).iter().all(|group| group.count == 1));
    assert!(run(&noise, f32::INFINITY, 0)
        .iter()
        .all(|group| group.count == GROUP_MAX as u32));
    run(&noise, f32::INFINITY, 12);
    assert_eq!(first, run(&constant, 0., 0));
    assert_eq!(ctx.frame_pool.borrow().alloc_count(), allocations);
}
