//! Pipeline-aware bind-group cache guard (#1667).
//!
//! `pool_dispatch` caches a bind group at `(signature, cursor)`. A bind group
//! built from a pipeline's AUTO layout (`get_bind_group_layout(0)`) is EXCLUSIVE
//! to that pipeline — wgpu rejects binding it under any other. If the dispatch
//! sequence ever shifts while the chain signature stays fixed (a signature-
//! completeness gap), cursor `i` would hand back a bind group built for a
//! different pipeline, every `present_chain` would fail validation, and the live
//! canvas freezes mid-edit (#1667). This pins the guard: a same-`(sig, cursor)`
//! hit whose cached entry was built for a DIFFERENT pipeline must REBUILD the
//! bind group, never return the stale cross-pipeline one.

use super::{pool_dispatch, DispatchResources};
use crate::context::GpuContext;

/// A minimal auto-layout compute pipeline: uniform `@binding(0)` + storage
/// `@binding(1)`. `layout: None` makes wgpu derive an EXCLUSIVE layout — exactly
/// like the live chain's real passes — so two of these are distinct,
/// mutually-incompatible pipelines even though their layouts are structurally
/// identical (which is precisely the #1667 trap: a bind group for one is invalid
/// under the other despite matching shape).
fn trivial_pipeline(device: &wgpu::Device, label: &str) -> wgpu::ComputePipeline {
    let source = "@group(0) @binding(0) var<uniform> u: vec4<f32>;\n\
                  @group(0) @binding(1) var<storage, read_write> b: array<f32>;\n\
                  @compute @workgroup_size(1) fn main() { b[0] = u.x; }";
    let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some(label),
        source: wgpu::ShaderSource::Wgsl(source.into()),
    });
    device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some(label),
        layout: None,
        module: &shader,
        entry_point: Some("main"),
        compilation_options: wgpu::PipelineCompilationOptions::default(),
        cache: None,
    })
}

/// Build the per-dispatch resources `pool_dispatch`'s `make` closure produces for
/// `pipeline` — a fresh uniform + a bind group over `pipeline`'s auto layout,
/// mirroring `spatial::encode_simple`.
fn dispatch_res(
    device: &wgpu::Device,
    pipeline: &wgpu::ComputePipeline,
    storage: &wgpu::Buffer,
) -> DispatchResources {
    let layout = pipeline.get_bind_group_layout(0);
    let uniform = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("u"),
        size: 16,
        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("bg"),
        layout: &layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: uniform.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: storage.as_entire_binding(),
            },
        ],
    });
    DispatchResources {
        bind_group,
        uniform,
        data: Vec::new(),
    }
}

/// A cache hit at a `(signature, cursor)` whose entry was built for a different
/// pipeline must REBUILD (2 allocs), not return the stale cross-pipeline bind
/// group — and a subsequent hit on the now-cached pipeline is zero-alloc.
#[test]
fn pipeline_mismatch_at_same_cursor_rebuilds_not_reuses() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let pa = trivial_pipeline(&ctx.device, "pa");
    let pb = trivial_pipeline(&ctx.device, "pb");
    let storage = ctx.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("s"),
        size: 16,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let sig = 0x1667u64;

    // Frame 1 — pipeline A at cursor 0: a miss (uniform + bind group = 2 allocs).
    ctx.frame_pool.borrow_mut().begin_frame(sig);
    let base = ctx.frame_pool.borrow().alloc_count();
    let _ = pool_dispatch(&ctx, &pa, &[0; 16], &[&storage], |d| {
        dispatch_res(d, &pa, &storage)
    });
    ctx.frame_pool.borrow_mut().end_frame();
    let first = ctx.frame_pool.borrow().alloc_count() - base;
    assert_eq!(first, 2, "first dispatch builds a uniform + a bind group");

    // Frame 2 — SAME signature + cursor, DIFFERENT pipeline B. The entry cached
    // at cursor 0 was built for A's exclusive layout, so reusing it would be a
    // wgpu validation error (the #1667 freeze). The guard must rebuild (2 allocs).
    ctx.frame_pool.borrow_mut().begin_frame(sig);
    let pre_mismatch = ctx.frame_pool.borrow().alloc_count();
    let _ = pool_dispatch(&ctx, &pb, &[0; 16], &[&storage], |d| {
        dispatch_res(d, &pb, &storage)
    });
    ctx.frame_pool.borrow_mut().end_frame();
    let mismatch = ctx.frame_pool.borrow().alloc_count() - pre_mismatch;
    assert_eq!(
        mismatch, 2,
        "a pipeline mismatch at the same cursor must REBUILD the bind group, not \
         return the stale cross-pipeline one (#1667)"
    );

    // Frame 3 — SAME signature + cursor + pipeline B again: the rebuild replaced
    // the cursor-0 entry, so this is a zero-alloc hit (caching still works).
    ctx.frame_pool.borrow_mut().begin_frame(sig);
    let pre_hit = ctx.frame_pool.borrow().alloc_count();
    let _ = pool_dispatch(&ctx, &pb, &[0; 16], &[&storage], |d| {
        dispatch_res(d, &pb, &storage)
    });
    ctx.frame_pool.borrow_mut().end_frame();
    let hit = ctx.frame_pool.borrow().alloc_count() - pre_hit;
    assert_eq!(
        hit, 0,
        "the same pipeline at the same cursor must be a zero-alloc cache hit"
    );
}

#[test]
fn unchanged_uniforms_skip_uploads_and_changed_values_reach_the_gpu() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let pipeline = trivial_pipeline(&ctx.device, "uniform-cache");
    let output = ctx.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("uniform-cache-output"),
        size: 16,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });
    let values = [1.0f32, 1.0, 1.0, -2.0, -2.0, 3.0, 3.0];
    for (index, value) in values.into_iter().enumerate() {
        ctx.frame_pool.borrow_mut().begin_frame(99);
        let params = [value, 0.0, 0.0, 0.0];
        let resources = pool_dispatch(
            &ctx,
            &pipeline,
            bytemuck::bytes_of(&params),
            &[&output],
            |device| dispatch_res(device, &pipeline, &output),
        );
        let mut encoder = ctx.device.create_command_encoder(&Default::default());
        {
            let mut pass = encoder.begin_compute_pass(&Default::default());
            pass.set_pipeline(&pipeline);
            pass.set_bind_group(0, resources.bind_group.as_ref(), &[]);
            pass.dispatch_workgroups(1, 1, 1);
        }
        ctx.queue.submit(Some(encoder.finish()));
        let pixels =
            pollster::block_on(crate::chain::read_buffer_async(&ctx, &output, 16)).unwrap();
        assert_eq!(pixels[0], value);
        let pool = ctx.frame_pool.borrow();
        assert_eq!(
            pool.alloc_count(),
            2,
            "stable dispatch must reuse resources"
        );
        assert_eq!(
            pool.uniform_upload_count.get(),
            [1, 1, 1, 2, 2, 3, 3][index]
        );
        drop(pool);
        ctx.frame_pool.borrow_mut().end_frame();
    }
}

#[test]
fn two_recent_signatures_reuse_resources_and_eviction_rebinds_correct_output() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let pipeline = trivial_pipeline(&ctx.device, "bounded-signatures");
    let outputs = [0, 1, 2].map(|_| {
        ctx.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("signature-output"),
            size: 16,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        })
    });
    let run = |sig: u64| {
        let output = &outputs[sig as usize - 1];
        let params = [sig as f32, 0.0, 0.0, 0.0];
        ctx.frame_pool.borrow_mut().begin_frame(sig);
        let resources = pool_dispatch(
            &ctx,
            &pipeline,
            bytemuck::bytes_of(&params),
            &[output],
            |device| dispatch_res(device, &pipeline, output),
        );
        let mut encoder = ctx.device.create_command_encoder(&Default::default());
        {
            let mut pass = encoder.begin_compute_pass(&Default::default());
            pass.set_pipeline(&pipeline);
            pass.set_bind_group(0, resources.bind_group.as_ref(), &[]);
            pass.dispatch_workgroups(1, 1, 1);
        }
        ctx.queue.submit(Some(encoder.finish()));
        let pixels = pollster::block_on(crate::chain::read_buffer_async(&ctx, output, 16)).unwrap();
        assert_eq!(
            pixels[0], sig as f32,
            "eviction must not reuse another image's bindings"
        );
        ctx.frame_pool.borrow_mut().end_frame();
        assert!(ctx.frame_pool.borrow().buckets.len() <= 2);
    };
    for tick in 0..40 {
        run(1 + tick % 2);
    }
    assert_eq!(
        ctx.frame_pool.borrow().alloc_count(),
        4,
        "A/B crossing stays warm"
    );
    run(3);
    assert!(!ctx.frame_pool.borrow().buckets.contains_key(&1));
    assert!(ctx.frame_pool.borrow().buckets.contains_key(&2));
    run(1);
    assert_eq!(
        ctx.frame_pool.borrow().alloc_count(),
        8,
        "evicted entries rebuild once"
    );
    assert!(!ctx.frame_pool.borrow().buckets.contains_key(&2));
}

#[test]
fn replaced_storage_at_same_cursor_rebinds_without_stale_output() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let pipeline = trivial_pipeline(&ctx.device, "replaced-storage");
    let outputs = [16, 32].map(|size| {
        ctx.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("resized-storage"),
            size,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        })
    });
    // Same signature, cursor, pipeline and uniform; only the actual buffer
    // changes. A resized lattice has this shape even without stage changes.
    for index in [0, 1, 1] {
        let output = &outputs[index];
        ctx.frame_pool.borrow_mut().begin_frame(3363);
        let params = [7.0f32, 0.0, 0.0, 0.0];
        let resources = pool_dispatch(
            &ctx,
            &pipeline,
            bytemuck::bytes_of(&params),
            &[output],
            |device| dispatch_res(device, &pipeline, output),
        );
        let mut encoder = ctx.device.create_command_encoder(&Default::default());
        {
            let mut pass = encoder.begin_compute_pass(&Default::default());
            pass.set_pipeline(&pipeline);
            pass.set_bind_group(0, resources.bind_group.as_ref(), &[]);
            pass.dispatch_workgroups(1, 1, 1);
        }
        ctx.queue.submit(Some(encoder.finish()));
        let pixels = pollster::block_on(crate::chain::read_buffer_async(&ctx, output, 16)).unwrap();
        assert_eq!(
            pixels[0], 7.0,
            "replacement must receive the dispatched output"
        );
        ctx.frame_pool.borrow_mut().end_frame();
        assert_eq!(ctx.frame_pool.borrow().alloc_count(), 2 + 2 * index as u64);
    }
}
