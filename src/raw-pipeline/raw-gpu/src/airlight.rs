//! On-GPU atmospheric-light (airlight) reduction (epic #925 P4b / #1033).
//!
//! Removes the per-tick GPU→CPU readback the C5a dehaze-active live path used to
//! measure the dehaze airlight `A`. C5a split the live chain at the dehaze point,
//! read the post-prefix buffer back to the CPU, ran `compute_airlight` (a sort +
//! top-0.1% average) there, then resumed — a round-trip that blows the 16ms
//! slider budget. This module computes `A` **without leaving the device**:
//!
//!   1. [`airlight_hist.wgsl`] — an atomic histogram of the dark channel (already
//!      computed on-GPU by the dehaze min kernel, mode 0).
//!   2. [`airlight_reduce.wgsl`] — a single-workgroup threshold scan (walk the
//!      histogram from the top until the running count reaches `top_n`) + a masked
//!      average of the ORIGINAL rgb over the selected (brightest-dark-channel)
//!      pixels → the airlight `vec4` (rgb = A).
//!
//! The percentile threshold replaces `compute_airlight`'s sort (whose tie-break
//! order can't be matched across GPU threads); the result matches `compute_airlight`
//! to a documented TOLERANCE, not bit-for-bit — gated in `airlight/tests.rs`
//! against the 128×128 `top_n = 16` interior fixture (a genuine top-0.1% average).
//!
//! The output rides a small storage buffer the caller copies (GPU→GPU, no
//! readback) into the dehaze airlight UNIFORM, so the transmission + recovery
//! kernels read `A` from a uniform binding exactly as the CPU path does — see
//! [`crate::dehaze::DehazePass`].
//!
//! Storage budgets (both kernels ≤ the `downlevel_defaults()` 4-storage cap):
//!   - histogram: dc(read) + hist(atomic rw) = 2.
//!   - reduce:    hist(read) + dc(read) + orig(read) + airlight(rw) = 4.

use crate::context::GpuContext;
use crate::frame_pool::pool_scratch;
use crate::spatial::{encode_simple, Plane};

/// Dark-channel histogram bin count. 1024 bins over [0, 1] (~1e-3 wide) makes the
/// percentile-threshold boundary bin narrow enough that the selected count lands
/// within a few pixels of `top_n` on a realistic frame, keeping the airlight delta
/// vs `compute_airlight`'s exact top_n average small (see the module tolerance and
/// `airlight/tests.rs`). A power of two so `floor(dc * BINS)` is exact for the bin
/// edges. Single-sourced into both kernels via the params uniform.
pub const AIRLIGHT_BINS: u32 = 1024;

/// The single-workgroup size of `airlight_reduce.wgsl` (must match `WG` there).
/// The reduce kernel is dispatched as EXACTLY ONE workgroup (the threshold scan is
/// global), so this is the whole thread count striding over the image.
const REDUCE_WG: u32 = 256;

/// `airlight_hist.wgsl` uniform: pixel count + bin count.
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct HistParams {
    count: u32,
    bins: u32,
    _pad0: u32,
    _pad1: u32,
}

/// `airlight_reduce.wgsl` uniform: pixel count + bin count + the top-0.1% size.
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct ReduceParams {
    count: u32,
    bins: u32,
    top_n: u32,
    _pad0: u32,
}

/// The byte length of the airlight output buffer: one `vec4<f32>` (rgb = A).
pub const AIRLIGHT_BYTE_LEN: u64 = 4 * std::mem::size_of::<f32>() as u64;

/// Allocate (or REUSE, on a same-signature re-render) the pooled airlight UNIFORM
/// buffer the dehaze transmission + recovery kernels read (#1033). `UNIFORM |
/// COPY_DST | COPY_SRC`: `COPY_DST` so it can be filled by EITHER a CPU
/// `queue.write_buffer` (the [`crate::dehaze::AirlightSource::Cpu`] path) or a
/// GPU→GPU `copy_buffer_to_buffer` from [`encode_airlight`]'s output (the on-GPU
/// path); `COPY_SRC` keeps it symmetric with the scratch usage. One `vec4<f32>`.
pub fn alloc_airlight_uniform(ctx: &GpuContext) -> Plane {
    pool_scratch(ctx, AIRLIGHT_BYTE_LEN, |device| {
        device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("dehaze-airlight-uniform"),
            size: AIRLIGHT_BYTE_LEN,
            usage: wgpu::BufferUsages::UNIFORM
                | wgpu::BufferUsages::COPY_DST
                | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        })
    })
}

/// Encode the on-GPU airlight reduction over `orig` (the RGBA image dehaze sees as
/// `src`) and its dark channel `dc` (the scalar plane the dehaze min kernel already
/// produced), returning the airlight output buffer (one `vec4<f32>`, rgb = A).
///
/// The returned [`Plane`] is `STORAGE | COPY_SRC | COPY_DST` so the caller can copy
/// it (GPU→GPU) into the dehaze airlight uniform — no CPU readback. Both the
/// histogram scratch and the output are drawn from the live pool, so a
/// same-signature re-render reuses them (zero allocation).
///
/// `count` = `width * height` (must equal `orig.len() / 4` and `dc.len()`).
pub fn encode_airlight(
    ctx: &GpuContext,
    encoder: &mut wgpu::CommandEncoder,
    orig: &wgpu::Buffer,
    dc: &wgpu::Buffer,
    count: u32,
) -> Plane {
    // top_n = max(count / 1000, 1) — raw-core's `(n / 1000).max(1)`.
    let top_n = (count / 1000).max(1);

    // Pooled histogram (BINS u32) + airlight output (1 vec4). Both are tiny and
    // fixed-size per signature, so the pool reuses them after the first render.
    let hist_byte_len = (AIRLIGHT_BINS as u64) * std::mem::size_of::<u32>() as u64;
    let hist = pool_scratch(ctx, hist_byte_len, |device| {
        device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("airlight-histogram"),
            size: hist_byte_len,
            usage: wgpu::BufferUsages::STORAGE
                | wgpu::BufferUsages::COPY_SRC
                | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        })
    });
    let airlight = pool_scratch(ctx, AIRLIGHT_BYTE_LEN, |device| {
        device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("airlight-out"),
            size: AIRLIGHT_BYTE_LEN,
            usage: wgpu::BufferUsages::STORAGE
                | wgpu::BufferUsages::COPY_SRC
                | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        })
    });

    // Zero the histogram before accumulating (it's pooled — last render's counts
    // are still in it). `clear_buffer` needs COPY_DST (the scratch usage has it).
    encoder.clear_buffer(&hist, 0, None);

    // Stage 1: atomic histogram of the dark channel. One dispatch over all pixels.
    let hist_params = HistParams {
        count,
        bins: AIRLIGHT_BINS,
        _pad0: 0,
        _pad1: 0,
    };
    encode_simple(
        ctx,
        encoder,
        ctx.airlight_hist_pipeline(),
        bytemuck::bytes_of(&hist_params),
        &[dc, &hist],
        count,
        "airlight-histogram",
    );

    // Stage 2: threshold scan + masked average, EXACTLY ONE workgroup. The dispatch
    // count passed to `encode_simple` is `REDUCE_WG` so `count.div_ceil(64)` ... no:
    // the reduce kernel uses @workgroup_size(256) and must run as a SINGLE group, so
    // it is dispatched directly here (not via encode_simple's count.div_ceil(64)).
    let reduce_params = ReduceParams {
        count,
        bins: AIRLIGHT_BINS,
        top_n,
        _pad0: 0,
    };
    encode_reduce_single_wg(
        ctx,
        encoder,
        bytemuck::bytes_of(&reduce_params),
        &[&hist, dc, orig, &airlight],
        "airlight-reduce",
    );

    airlight
}

/// Encode the reduce kernel as EXACTLY ONE workgroup (its threshold scan is
/// global). A trimmed-down sibling of [`encode_simple`] that dispatches `(1,1,1)`
/// instead of `count.div_ceil(64)` groups, but reuses the same pooled
/// uniform + bind-group machinery (so it's zero-alloc on a same-signature
/// re-render). `_wg` in the name flags the single-group dispatch.
fn encode_reduce_single_wg(
    ctx: &GpuContext,
    encoder: &mut wgpu::CommandEncoder,
    params_bytes: &[u8],
    buffers: &[&wgpu::Buffer],
    label: &str,
) {
    use crate::frame_pool::{pool_dispatch, DispatchResources};
    let params_len = params_bytes.len() as u64;
    let pipeline = ctx.airlight_reduce_pipeline();
    let layout = pipeline.get_bind_group_layout(0);

    let pooled = pool_dispatch(ctx, pipeline, |device| {
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
            data: Vec::new(),
        }
    });
    ctx.queue.write_buffer(&pooled.uniform, 0, params_bytes);

    let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
        label: Some(label),
        timestamp_writes: None,
    });
    pass.set_pipeline(pipeline);
    pass.set_bind_group(0, pooled.bind_group.as_ref(), &[]);
    // ONE workgroup — the threshold scan + global mean are inherently a single
    // reduction; the 256 threads stride over the whole image internally.
    let _ = REDUCE_WG; // documents the matched @workgroup_size; dispatch is (1,1,1).
    pass.dispatch_workgroups(1, 1, 1);
}

// Parity tests live in a sibling file (600-LOC budget; mirrors dehaze's split).
// Native test builds only — the GPU device + the raw-core oracle have no wasm path.
#[cfg(all(test, not(target_arch = "wasm32")))]
#[path = "airlight/tests.rs"]
mod tests;
