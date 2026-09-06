//! A data-buffer cache hit must avoid staging allocation without freezing edits.
use super::{pool_data, pool_scratch};
use crate::GpuContext;

fn storage(device: &wgpu::Device, bytes: u64) -> wgpu::Buffer {
    device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("cached-data-test"),
        size: bytes,
        usage: wgpu::BufferUsages::STORAGE
            | wgpu::BufferUsages::COPY_SRC
            | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    })
}

#[test]
fn unchanged_large_data_skips_staging_and_changed_data_reaches_gpu() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let mut values = vec![0.25f32; 49 * 49 * 49 * 3];
    let byte_len = values.len() as u64 * 4;
    let mut snapshot = None;
    for tick in 0..40 {
        if tick == 20 {
            values[7] = 0.75;
        }
        ctx.frame_pool.borrow_mut().begin_frame(123);
        let data = pool_data(&ctx, bytemuck::cast_slice(&values), |device| {
            storage(device, byte_len)
        });
        let pixels =
            pollster::block_on(crate::chain::read_buffer_async(&ctx, &data, byte_len)).unwrap();
        assert_eq!(pixels, values);
        let pool = ctx.frame_pool.borrow();
        assert_eq!(
            pool.alloc_count(),
            1,
            "unchanged dimensions reuse the GPU buffer"
        );
        assert_eq!(pool.data_upload_count.get(), if tick < 20 { 1 } else { 2 });
        let cached = pool.buckets[&123].scratch[0]
            .contents
            .as_ref()
            .unwrap()
            .as_ptr();
        if let Some(previous) = snapshot {
            assert_eq!(cached, previous, "snapshot updates in place");
        }
        snapshot = Some(cached);
        drop(pool);
        ctx.frame_pool.borrow_mut().end_frame();
    }
}

#[test]
fn writable_scratch_invalidates_a_prior_data_snapshot() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let expected = [1.0f32, 2.0, 3.0, 4.0];
    ctx.frame_pool.borrow_mut().begin_frame(124);
    let _ = pool_data(&ctx, bytemuck::bytes_of(&expected), |device| {
        storage(device, 16)
    });
    ctx.frame_pool.borrow_mut().end_frame();
    ctx.frame_pool.borrow_mut().begin_frame(124);
    let writable = pool_scratch(&ctx, 16, |device| storage(device, 16));
    ctx.queue
        .write_buffer(&writable, 0, bytemuck::bytes_of(&[9.0f32; 4]));
    ctx.frame_pool.borrow_mut().end_frame();
    ctx.frame_pool.borrow_mut().begin_frame(124);
    let restored = pool_data(&ctx, bytemuck::bytes_of(&expected), |device| {
        storage(device, 16)
    });
    let pixels = pollster::block_on(crate::chain::read_buffer_async(&ctx, &restored, 16)).unwrap();
    assert_eq!(
        pixels, expected,
        "a writable lease must not leave a stale content hit"
    );
    assert_eq!(ctx.frame_pool.borrow().data_upload_count.get(), 2);
    ctx.frame_pool.borrow_mut().end_frame();
}
