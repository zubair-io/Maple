//! Explicit local diagnostics: GPU timestamps separate kernel cost from waits.
use crate::{context::GpuContext, spatial};
use std::cell::RefCell;

struct Profile {
    queries: wgpu::QuerySet,
    resolve: wgpu::Buffer,
    labels: Vec<&'static str>,
}
thread_local! { static PROFILE:RefCell<Option<Profile>>=const {RefCell::new(None)}; }

pub(super) fn begin(ctx: &GpuContext) {
    assert!(ctx
        .device
        .features()
        .contains(wgpu::Features::TIMESTAMP_QUERY));
    PROFILE.with_borrow_mut(|state| {
        *state = Some(Profile {
            queries: ctx.device.create_query_set(&wgpu::QuerySetDescriptor {
                label: Some("BM3D diagnostic timestamps"),
                ty: wgpu::QueryType::Timestamp,
                count: 2048,
            }),
            resolve: ctx.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("BM3D diagnostic timestamps"),
                size: 2048 * 8,
                usage: wgpu::BufferUsages::QUERY_RESOLVE | wgpu::BufferUsages::COPY_SRC,
                mapped_at_creation: false,
            }),
            labels: Vec::with_capacity(1024),
        })
    });
}

#[allow(clippy::too_many_arguments)]
fn record(
    ctx: &GpuContext,
    encoder: &mut wgpu::CommandEncoder,
    pipeline: &wgpu::ComputePipeline,
    params: &[u8],
    buffers: &[&wgpu::Buffer],
    count: u32,
    indirect: Option<&wgpu::Buffer>,
    label: &'static str,
) -> bool {
    PROFILE.with_borrow_mut(|state| {
        let Some(profile) = state else {
            return false;
        };
        assert!(
            profile.labels.len() < 1024,
            "BM3D diagnostic timestamp capacity"
        );
        let first = profile.labels.len() as u32 * 2;
        let pooled = spatial::prepare_simple_dispatch(ctx, pipeline, params, buffers, label);
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
            label: Some(label),
            timestamp_writes: Some(wgpu::ComputePassTimestampWrites {
                query_set: &profile.queries,
                beginning_of_pass_write_index: Some(first),
                end_of_pass_write_index: Some(first + 1),
            }),
        });
        pass.set_pipeline(pipeline);
        pass.set_bind_group(0, pooled.bind_group.as_ref(), &[]);
        let groups = count.div_ceil(64);
        let x = groups.min(65535);
        if let Some(buffer) = indirect {
            pass.dispatch_workgroups_indirect(buffer, 0);
        } else {
            pass.dispatch_workgroups(x, if x == 0 { 0 } else { groups.div_ceil(x) }, 1);
        }
        profile.labels.push(label);
        true
    })
}

pub(super) fn flush(ctx: &GpuContext) {
    PROFILE.with_borrow_mut(|state| {
        let Some(profile) = state.take() else {
            return;
        };
        let count = profile.labels.len() as u32 * 2;
        let mut encoder = ctx
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
        encoder.resolve_query_set(&profile.queries, 0..count, &profile.resolve, 0);
        ctx.queue.submit(Some(encoder.finish()));
        let values = pollster::block_on(crate::chain::read_buffer_async(
            ctx,
            &profile.resolve,
            u64::from(count) * 8,
        ))
        .unwrap();
        let stamps: Vec<u64> = values
            .chunks_exact(2)
            .map(|p| u64::from(p[0].to_bits()) | (u64::from(p[1].to_bits()) << 32))
            .collect();
        let mut totals = std::collections::BTreeMap::<&str, (usize, f64)>::new();
        for (i, label) in profile.labels.iter().enumerate() {
            let elapsed = stamps[2 * i + 1]
                .checked_sub(stamps[2 * i])
                .expect("monotonic GPU timestamps") as f64
                * f64::from(ctx.queue.get_timestamp_period())
                / 1e6;
            let entry = totals.entry(label).or_default();
            entry.0 += 1;
            entry.1 += elapsed;
        }
        for (label, (count, total)) in totals {
            eprintln!("BM3D GPU {label}: {count} dispatches, {total:.3}ms");
        }
    });
}

#[allow(clippy::too_many_arguments)]
pub(super) fn dispatch(
    ctx: &GpuContext,
    encoder: &mut wgpu::CommandEncoder,
    pipeline: &wgpu::ComputePipeline,
    params: &[u8],
    buffers: &[&wgpu::Buffer],
    count: u32,
    label: &'static str,
) -> bool {
    record(ctx, encoder, pipeline, params, buffers, count, None, label)
}
#[allow(clippy::too_many_arguments)]
pub(super) fn dispatch_indirect(
    ctx: &GpuContext,
    encoder: &mut wgpu::CommandEncoder,
    pipeline: &wgpu::ComputePipeline,
    params: &[u8],
    buffers: &[&wgpu::Buffer],
    indirect: &wgpu::Buffer,
    label: &'static str,
) -> bool {
    record(
        ctx,
        encoder,
        pipeline,
        params,
        buffers,
        0,
        Some(indirect),
        label,
    )
}

pub(super) fn active() -> bool {
    PROFILE.with_borrow(|state| state.is_some())
}
