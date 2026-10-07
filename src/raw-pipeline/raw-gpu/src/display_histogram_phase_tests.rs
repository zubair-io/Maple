//! #4368 phase evidence for #4359; complements the unchanged acceptance tests.
use super::*;
#[test]
fn histogram_4359_host_and_gpu_phase_probe() {
    let mut ctx = GpuContext::new_blocking().expect("GPU adapter");
    assert_eq!(ctx.adapter.get_info().backend, wgpu::Backend::Metal);
    if !ctx
        .adapter
        .features()
        .contains(wgpu::Features::TIMESTAMP_QUERY)
    {
        eprintln!("H4359 kernel_ms=None reason=adapter_timestamp_query_unsupported; original histogram acceptance tests remain required");
        return;
    }
    let (device, queue) = pollster::block_on(ctx.adapter.request_device(
        &wgpu::DeviceDescriptor {
            label: Some("4359-timestamp-diagnostic-only"),
            required_features: wgpu::Features::TIMESTAMP_QUERY,
            required_limits: crate::context::adapter_clamped_limits(&ctx.adapter),
            memory_hints: Default::default(),
        },
        None,
    ))
    .unwrap();
    ctx.device = device.into();
    ctx.queue = queue.into();
    eprintln!(
        "H4359 adapter={:?} timestamp_period_ns={}",
        ctx.adapter.get_info(),
        ctx.queue.get_timestamp_period()
    );
    let size = 2360u32;
    let pixels = vec![0.5f32; (size * size * 4) as usize];
    let sources = [0, 1].map(|_| {
        ctx.device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("4359-original-2360-input"),
                contents: bytemuck::cast_slice(&pixels),
                usage: wgpu::BufferUsages::STORAGE,
            })
    });
    let histogram = DisplayHistogram::new(&ctx, &sources, size, size);
    let queries = ctx.device.create_query_set(&wgpu::QuerySetDescriptor {
        label: Some("4359-kernel-time"),
        ty: wgpu::QueryType::Timestamp,
        count: 2,
    });
    let resolve = ctx.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("4359-query-resolve"),
        size: 16,
        usage: wgpu::BufferUsages::QUERY_RESOLVE | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });
    let query_read = ctx.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("4359-query-read"),
        size: 16,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    for iteration in 0..3 {
        let start = std::time::Instant::now();
        let mut encoder = ctx.device.create_command_encoder(&Default::default());
        encoder.clear_buffer(&histogram.bins, 0, None);
        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("4359-original-histogram-pass"),
                timestamp_writes: Some(wgpu::ComputePassTimestampWrites {
                    query_set: &queries,
                    beginning_of_pass_write_index: Some(0),
                    end_of_pass_write_index: Some(1),
                }),
            });
            pass.set_pipeline(ctx.histogram_pipeline.get().unwrap());
            pass.set_bind_group(0, &histogram.groups[0], &[]);
            pass.dispatch_workgroups(histogram.dispatches, 1, 1);
        }
        let encoded = start.elapsed();
        ctx.queue.submit(Some(encoder.finish()));
        let submitted = start.elapsed();
        let mut copy = ctx.device.create_command_encoder(&Default::default());
        copy.copy_buffer_to_buffer(&histogram.bins, 0, &histogram.readback, 0, BYTE_LEN);
        let copied = start.elapsed();
        ctx.queue.submit(Some(copy.finish()));
        let copy_submitted = start.elapsed();
        let slice = histogram.readback.slice(..);
        let (tx, rx) = futures_channel::oneshot::channel();
        slice.map_async(wgpu::MapMode::Read, move |result| {
            let _ = tx.send((result, start.elapsed()));
        });
        let map_requested = start.elapsed();
        ctx.device.poll(wgpu::Maintain::Wait);
        let polled = start.elapsed();
        let (result, callback_at) = pollster::block_on(rx).unwrap();
        result.unwrap();
        let view = slice.get_mapped_range();
        let bins: Vec<u32> = bytemuck::cast_slice(&view).to_vec();
        drop(view);
        histogram.readback.unmap();
        let total = start.elapsed();
        // Query collection is deliberately AFTER original encode+read timing.
        let mut query_copy = ctx.device.create_command_encoder(&Default::default());
        query_copy.resolve_query_set(&queries, 0..2, &resolve, 0);
        query_copy.copy_buffer_to_buffer(&resolve, 0, &query_read, 0, 16);
        ctx.queue.submit(Some(query_copy.finish()));
        let qs = query_read.slice(..);
        let (tx, rx) = futures_channel::oneshot::channel();
        qs.map_async(wgpu::MapMode::Read, move |r| {
            let _ = tx.send(r);
        });
        ctx.device.poll(wgpu::Maintain::Wait);
        pollster::block_on(rx).unwrap().unwrap();
        let view = qs.get_mapped_range();
        let ticks: &[u64] = bytemuck::cast_slice(&view);
        let gpu_ms =
            ticks[1].wrapping_sub(ticks[0]) as f64 * ctx.queue.get_timestamp_period() as f64 / 1e6;
        drop(view);
        query_read.unmap();
        eprintln!("H4359 iteration={iteration} encode_us={} submit_us={} copy_encode_us={} copy_submit_us={} map_request_us={} poll_return_us={} callback_us={} total_us={} kernel_ms={gpu_ms}", encoded.as_micros(), submitted.as_micros(), copied.as_micros(), copy_submitted.as_micros(), map_requested.as_micros(), polled.as_micros(), callback_at.as_micros(), total.as_micros());
        assert_eq!(bins.len(), 768);
        assert_eq!(bins[..256].iter().sum::<u32>(), 236 * 236);
        assert_eq!(&bins[..256], &bins[256..512]);
        assert_eq!(&bins[..256], &bins[512..]);
        if iteration > 0 {
            assert!(
                total < std::time::Duration::from_millis(50),
                "diagnostic warmed original50ms budget: {total:?}"
            );
        }
    }
}
