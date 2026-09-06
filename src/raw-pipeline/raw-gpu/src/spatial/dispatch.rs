use crate::context::GpuContext;
use crate::frame_pool::{pool_dispatch, DispatchResources, PooledDispatch};

/// Record one compute dispatch: a `params` uniform from `params_bytes` + an
/// auto-derived bind group binding `[params, buffers...]` at successive bindings
/// (params = 0, then `buffers[k]` = `k + 1`), dispatching `count.div_ceil(64)`
/// workgroups of the cached `pipeline`.
///
/// The workhorse behind EVERY GPU dispatch (P4b-core C3 unification): the spatial
/// sub-passes AND, now, every per-pixel `Pass` route through here, so the live
/// pool ([`crate::frame_pool`]) has ONE allocation boundary to cache + count. On
/// the first render of a chain shape the uniform + bind group are created; on a
/// same-signature re-render the cached pair is reused and `params_bytes` is
/// uploaded only when their bytes change. This avoids backend staging
/// allocations for unchanged uniforms. The storage `buffers`
/// (src/dst ping-pong, pooled scratch, pooled per-image data) keep stable
/// identity per signature — they're owned by the session / the pool — so the
/// cached bind group's internal references never dangle.
///
/// `label` names the resources / compute pass for capture traces.
pub fn encode_simple(
    ctx: &GpuContext,
    encoder: &mut wgpu::CommandEncoder,
    pipeline: &wgpu::ComputePipeline,
    params_bytes: &[u8],
    buffers: &[&wgpu::Buffer],
    count: u32,
    label: &str,
) {
    let pooled = prepare_simple_dispatch(ctx, pipeline, params_bytes, buffers, label);

    let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
        label: Some(label),
        timestamp_writes: None,
    });
    pass.set_pipeline(pipeline);
    pass.set_bind_group(0, pooled.bind_group.as_ref(), &[]);
    let groups = count.div_ceil(64);
    let gx = groups.min(65535);
    // Guard the empty dispatch: count==0 -> gx==0, and div_ceil(0) panics.
    // (0,0,1) is a safe no-op (the original 1-D (0,1,1) was likewise). #1623
    let gy = if gx == 0 { 0 } else { groups.div_ceil(gx) };
    pass.dispatch_workgroups(gx, gy, 1);
}

/// Prepare one pooled dispatch for either a standalone kernel or NLM's 2D tile.
/// Each call owns a distinct uniform and checks the bound storage identities.
pub(crate) fn prepare_simple_dispatch(
    ctx: &GpuContext,
    pipeline: &wgpu::ComputePipeline,
    params_bytes: &[u8],
    buffers: &[&wgpu::Buffer],
    label: &str,
) -> PooledDispatch {
    let params_len = params_bytes.len() as u64;
    let layout = pipeline.get_bind_group_layout(0);

    // Get-or-create the pooled uniform + bind group. `make` runs ONLY on a cache
    // miss (so a hit allocates nothing); it builds the uniform + the bind group
    // referencing it + the passed storage buffers.
    pool_dispatch(ctx, pipeline, params_bytes, buffers, |device| {
        let uniform = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some(label),
            size: params_len,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let mut entries = Vec::with_capacity(buffers.len() + 1);
        entries.push(wgpu::BindGroupEntry {
            binding: 0,
            resource: uniform.as_entire_binding(),
        });
        for (k, buf) in buffers.iter().enumerate() {
            entries.push(wgpu::BindGroupEntry {
                binding: (k + 1) as u32,
                resource: buf.as_entire_binding(),
            });
        }
        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some(label),
            layout: &layout,
            entries: &entries,
        });
        DispatchResources {
            bind_group,
            uniform,
            // The storage buffers are kept alive by the session (ping-pong) and
            // the pool (scratch / data) — not by the dispatch entry — so `data`
            // is empty (no double-ownership). See `frame_pool` docs.
            data: Vec::new(),
        }
    })
}
