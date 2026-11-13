//! #4359 evidence: is the histogram read's wall-clock tail the histogram's
//! own cost, or the GPU round trip on the machine running the suite?
//! Interleaves the shipped read path with a control that makes the same
//! submission, map and wait without the histogram kernel, alternating which
//! goes first, and splits every sample into host time before the GPU wait
//! (encode, submit, map request), time blocked on the GPU, and host time
//! after the GPU finished. If the control carries the same tail, the
//! latency belongs to the runner. Diagnostic only — it asserts counts, never
//! a time; the unchanged acceptance tests keep the 50 ms gate.
use super::*;
use std::time::{Duration, Instant};

fn assert_uniform_grey_bins(bins: &[u32]) {
    assert_eq!(bins.len(), 768);
    assert_eq!(bins[..256].iter().sum::<u32>(), 236 * 236);
    assert_eq!(&bins[..256], &bins[256..512]);
    assert_eq!(&bins[..256], &bins[512..]);
}

struct Sample {
    host_before: Duration,
    gpu_wait: Duration,
    host_after: Duration,
    total: Duration,
}

/// Copy the bins out and wait for them, timing the GPU wait apart from the
/// host work that follows it. Mirrors `DisplayHistogram::read`.
fn copy_map_and_wait(
    ctx: &GpuContext,
    histogram: &DisplayHistogram,
    start: Instant,
) -> (Vec<u32>, Sample) {
    let mut copy = ctx.device.create_command_encoder(&Default::default());
    copy.copy_buffer_to_buffer(&histogram.bins, 0, &histogram.readback, 0, BYTE_LEN);
    ctx.queue.submit(Some(copy.finish()));
    let slice = histogram.readback.slice(..);
    let (tx, rx) = futures_channel::oneshot::channel();
    slice.map_async(wgpu::MapMode::Read, move |result| {
        let _ = tx.send(result);
    });
    let waiting = start.elapsed();
    ctx.device.poll(wgpu::Maintain::Wait);
    let woke = start.elapsed();
    pollster::block_on(rx).unwrap().unwrap();
    let view = slice.get_mapped_range();
    let bins = bytemuck::cast_slice(&view).to_vec();
    drop(view);
    histogram.readback.unmap();
    let total = start.elapsed();
    let sample = Sample {
        host_before: waiting,
        gpu_wait: woke - waiting,
        host_after: total - woke,
        total,
    };
    (bins, sample)
}

/// The shipped path: the present's `encode`, then the read's copy and map.
fn histogram_read(ctx: &GpuContext, histogram: &DisplayHistogram) -> Sample {
    let start = Instant::now();
    let mut encoder = ctx.device.create_command_encoder(&Default::default());
    histogram.encode(ctx, &mut encoder, 0);
    ctx.queue.submit(Some(encoder.finish()));
    let (bins, sample) = copy_map_and_wait(ctx, histogram, start);
    assert_uniform_grey_bins(&bins);
    sample
}

/// The same submissions, map and wait with no histogram kernel: an empty
/// command buffer stands in for the present.
fn control_round_trip(ctx: &GpuContext, histogram: &DisplayHistogram) -> Sample {
    let start = Instant::now();
    let encoder = ctx.device.create_command_encoder(&Default::default());
    ctx.queue.submit(Some(encoder.finish()));
    let (bins, sample) = copy_map_and_wait(ctx, histogram, start);
    assert_uniform_grey_bins(&bins);
    sample
}

fn summary(path: &str, samples: &[Sample]) {
    let stats = |pick: fn(&Sample) -> Duration| {
        let mut ms: Vec<f64> = samples
            .iter()
            .map(|s| pick(s).as_secs_f64() * 1e3)
            .collect();
        ms.sort_by(f64::total_cmp);
        let at = |p: f64| ms[((ms.len() - 1) as f64 * p).round() as usize];
        format!("p50={:.3} p90={:.3} max={:.3}", at(0.5), at(0.9), at(1.0))
    };
    eprintln!(
        "H4359 path={path} n={} total_ms[{}] host_before_ms[{}] gpu_wait_ms[{}] host_after_ms[{}]",
        samples.len(),
        stats(|s| s.total),
        stats(|s| s.host_before),
        stats(|s| s.gpu_wait),
        stats(|s| s.host_after)
    );
}

#[test]
fn histogram_4359_read_vs_kernel_free_control() {
    let ctx = GpuContext::new_blocking().expect("GPU adapter");
    eprintln!("H4359 adapter={:?}", ctx.adapter.get_info());
    let pixels = vec![0.5f32; (2360 * 2360 * 4) as usize];
    let sources = [0, 1].map(|_| {
        ctx.device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("4359-round-trip-input"),
                contents: bytemuck::cast_slice(&pixels),
                usage: wgpu::BufferUsages::STORAGE,
            })
    });
    let histogram = DisplayHistogram::new(&ctx, &sources, 2360, 2360);
    histogram_read(&ctx, &histogram);
    control_round_trip(&ctx, &histogram);
    let (mut reads, mut controls) = (Vec::new(), Vec::new());
    for iteration in 0..100 {
        let pair = if iteration % 2 == 0 {
            (
                histogram_read(&ctx, &histogram),
                control_round_trip(&ctx, &histogram),
            )
        } else {
            let control = control_round_trip(&ctx, &histogram);
            (histogram_read(&ctx, &histogram), control)
        };
        for (path, sample) in [("histogram", &pair.0), ("control", &pair.1)] {
            if sample.total >= Duration::from_millis(20) {
                eprintln!(
                    "H4359 slow iteration={iteration} path={path} total_ms={:.3} host_before_ms={:.3} gpu_wait_ms={:.3} host_after_ms={:.3}",
                    sample.total.as_secs_f64() * 1e3,
                    sample.host_before.as_secs_f64() * 1e3,
                    sample.gpu_wait.as_secs_f64() * 1e3,
                    sample.host_after.as_secs_f64() * 1e3
                );
            }
        }
        reads.push(pair.0);
        controls.push(pair.1);
    }
    summary("histogram", &reads);
    summary("control", &controls);
}
