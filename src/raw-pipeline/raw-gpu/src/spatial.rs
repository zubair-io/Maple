//! Spatial-filter substrate — the reusable multi-pass / scratch-buffer pattern
//! for kernels that read pixel NEIGHBORHOODS (epic #925 P2 wave 3b / #990).
//!
//! The per-pixel [`Pass`](crate::chain::Pass) template (`vibrance.rs`) threads a
//! single `src` → `dst` through the linear [`ChainRunner`](crate::chain::ChainRunner).
//! Spatial stages can't: a guided filter is a small DAG — several box blurs over
//! several intermediate planes, plus per-pixel combines that read 2–4 buffers at
//! once. Rather than turn `ChainRunner` into a DAG executor, a spatial stage stays
//! ONE `Pass` from the chain's point of view and orchestrates its own sub-passes
//! over **scratch buffers it allocates here**, writing only its final result to
//! the chain's `dst`. This module is that substrate; dehaze and the P3 spatial
//! filters reuse it.
//!
//! ## The reusable pieces (signatures dehaze / P3 build on)
//!
//! - [`alloc_plane`] / [`alloc_rgba`] — allocate a scratch storage buffer sized
//!   for a `width × height` scalar f32 plane (one f32 per pixel) or RGBA image
//!   (four). `STORAGE | COPY_SRC | COPY_DST` so a sub-pass can read, write, or
//!   seed it.
//! - [`box_blur_encode`] — THE separable box-blur primitive. Encodes a horizontal
//!   sweep (`input` → an internal scratch) then a vertical sweep (scratch →
//!   `output`) of a scalar plane, matching `raw_core::stages::blur::box_blur_channel`'s
//!   shrinking-window border policy. Any spatial filter that needs a local mean
//!   calls this.
//! - [`encode_simple`] — a tiny helper that records one compute dispatch with an
//!   auto-derived bind group over an arbitrary list of buffers. The guided-filter
//!   sub-kernels (luma-extract, a/b, combine — the MULTI-INPUT pass) use it.
//! - [`guided_filter_self_encode`] — the self-guided (`guide == p`) guided filter
//!   over a luma plane, producing the `mean_a` / `mean_b` reconstruction
//!   coefficients clarity and texture share (only the radius differs).
//!
//! Each sub-step is its OWN `begin_compute_pass` dispatch: storage writes are
//! visible to the next dispatch via wgpu's implicit inter-pass barrier (batching
//! the sub-steps into one compute pass would race). Scratch buffers created here
//! stay alive through submission via the command encoder's references — same
//! lifetime contract as a per-pass uniform.

use crate::context::GpuContext;
use wgpu::util::DeviceExt;

/// Byte length of a `width × height` scalar f32 plane (one f32 per pixel).
#[inline]
pub fn plane_byte_len(width: u32, height: u32) -> u64 {
    (width as u64) * (height as u64) * std::mem::size_of::<f32>() as u64
}

/// Allocate an uninitialised scratch storage buffer for a scalar f32 plane
/// (`width × height` f32). `STORAGE | COPY_SRC | COPY_DST` so it can be a sub-pass
/// src/dst or be seeded by a copy. Reused by every spatial stage for its
/// intermediates (luma, blurred means, guided coefficients, …).
pub fn alloc_plane(ctx: &GpuContext, width: u32, height: u32, label: &str) -> wgpu::Buffer {
    ctx.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some(label),
        size: plane_byte_len(width, height),
        usage: wgpu::BufferUsages::STORAGE
            | wgpu::BufferUsages::COPY_SRC
            | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    })
}

/// Allocate an uninitialised scratch storage buffer for an RGBA f32 image
/// (`width × height × 4` f32). Same usage flags as [`alloc_plane`]; used when a
/// spatial stage needs an extra full-image scratch beyond the chain's ping-pong
/// pair.
pub fn alloc_rgba(ctx: &GpuContext, width: u32, height: u32, label: &str) -> wgpu::Buffer {
    ctx.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some(label),
        size: (width as u64) * (height as u64) * 4 * std::mem::size_of::<f32>() as u64,
        usage: wgpu::BufferUsages::STORAGE
            | wgpu::BufferUsages::COPY_SRC
            | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    })
}

/// `repr(C)` uniform for [`box_blur_encode`]'s `box_blur.wgsl` kernel: plane dims,
/// the blur radius, and the swept axis (0 = horizontal, 1 = vertical).
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct BoxBlurParams {
    width: u32,
    height: u32,
    radius: u32,
    axis: u32,
}

/// Record one compute dispatch: build a `params` uniform from `params_bytes`, an
/// auto-derived bind group binding `[params, buffers...]` at successive bindings
/// (params = 0, then `buffers[k]` = `k + 1`), and dispatch
/// `count.div_ceil(64)` workgroups of the cached `pipeline`.
///
/// The workhorse behind every spatial sub-pass — including the MULTI-INPUT
/// combine that reads the original image plus three derived planes. `label`
/// names the params buffer / bind group / compute pass for capture traces.
pub fn encode_simple(
    ctx: &GpuContext,
    encoder: &mut wgpu::CommandEncoder,
    pipeline: &wgpu::ComputePipeline,
    params_bytes: &[u8],
    buffers: &[&wgpu::Buffer],
    count: u32,
    label: &str,
) {
    let params_buf = ctx
        .device
        .create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some(label),
            contents: params_bytes,
            usage: wgpu::BufferUsages::UNIFORM,
        });
    let mut entries = Vec::with_capacity(buffers.len() + 1);
    entries.push(wgpu::BindGroupEntry {
        binding: 0,
        resource: params_buf.as_entire_binding(),
    });
    for (k, buf) in buffers.iter().enumerate() {
        entries.push(wgpu::BindGroupEntry {
            binding: (k + 1) as u32,
            resource: buf.as_entire_binding(),
        });
    }
    let bind_group = ctx.device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some(label),
        layout: &pipeline.get_bind_group_layout(0),
        entries: &entries,
    });
    let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
        label: Some(label),
        timestamp_writes: None,
    });
    pass.set_pipeline(pipeline);
    pass.set_bind_group(0, &bind_group, &[]);
    pass.dispatch_workgroups(count.div_ceil(64), 1, 1);
}

/// THE separable box-blur primitive (epic #925 P2 wave 3b / #990).
///
/// Encodes a horizontal sweep (`input` → an internal scratch plane) then a
/// vertical sweep (scratch → `output`) over a `width × height` scalar f32 plane,
/// mirroring `raw_core::stages::blur::box_blur_channel` (which does the same two
/// internal sweeps). Border policy is the SHRINKING partial average raw-core uses:
/// the window at coordinate `c` spans `[max(0, c - r) ..= min(dim - 1, c + r)]`
/// and divides by the exact in-bounds count (NOT zero-pad, NOT clamp).
///
/// `input` and `output` are plane buffers (e.g. from [`alloc_plane`]); they may
/// be distinct buffers (a fresh `output` plane is typical). `r == 0` short-circuits
/// to a straight `input` → `output` copy, matching `box_blur_channel`'s `r == 0`
/// early return. Each sweep is its own dispatch, so the vertical sweep sees the
/// completed horizontal output via the implicit inter-pass barrier.
pub fn box_blur_encode(
    ctx: &GpuContext,
    encoder: &mut wgpu::CommandEncoder,
    input: &wgpu::Buffer,
    output: &wgpu::Buffer,
    width: u32,
    height: u32,
    r: u32,
) {
    let count = width * height;
    if r == 0 {
        // box_blur_channel returns the input unchanged at radius 0.
        encoder.copy_buffer_to_buffer(input, 0, output, 0, plane_byte_len(width, height));
        return;
    }
    let scratch = alloc_plane(ctx, width, height, "box-blur-h-scratch");
    let pipeline = ctx.box_blur_pipeline();

    let h_params = BoxBlurParams {
        width,
        height,
        radius: r,
        axis: 0,
    };
    encode_simple(
        ctx,
        encoder,
        pipeline,
        bytemuck::bytes_of(&h_params),
        &[input, &scratch],
        count,
        "box-blur-horizontal",
    );

    let v_params = BoxBlurParams {
        width,
        height,
        radius: r,
        axis: 1,
    };
    encode_simple(
        ctx,
        encoder,
        pipeline,
        bytemuck::bytes_of(&v_params),
        &[&scratch, output],
        count,
        "box-blur-vertical",
    );
}

/// `repr(C)` uniform for the `guided_luma.wgsl` kernel: just the pixel count.
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct CountParams {
    count: u32,
    _pad0: u32,
    _pad1: u32,
    _pad2: u32,
}

/// `repr(C)` uniform for the `guided_ab.wgsl` kernel: pixel count + regularisation.
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct AbParams {
    count: u32,
    eps: f32,
    _pad0: u32,
    _pad1: u32,
}

/// `repr(C)` uniform for the `guided_combine.wgsl` kernel: pixel count + the
/// base/detail boost amount (`clarity / 100` or `texture / 100`).
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct CombineParams {
    count: u32,
    amount: f32,
    _pad0: u32,
    _pad1: u32,
}

/// Self-guided (`guide == p == luma`) guided filter (epic #925 P2 wave 3b / #990).
///
/// Given a `luma` plane already on the GPU, encodes the four-box-blur self-guided
/// guided filter and writes the reconstruction coefficients into `mean_a` /
/// `mean_b` (caller-provided plane buffers). The combine that turns these into a
/// base/detail boost is the stage's own kernel (`guided_combine.wgsl`), since
/// `base = mean_a * luma + mean_b`.
///
/// Mirrors `raw_core::stages::blur::guided_filter`'s self-guided path: because
/// `guide` and `p` are the same buffer, `mean_i == mean_p` and `mean_ip == mean_ii`
/// bit-identically, so only `blur(luma)` and `blur(luma²)` are needed (not six
/// blurs). `r` is the guided-filter radius (20 = clarity structure scale, 2 =
/// texture fine-detail scale); `eps` the regularisation (1e-3 for both).
///
/// Scratch planes (`luma2`, `mean_i`, `mean_ii`, `a`, `b`) are allocated here.
#[allow(clippy::too_many_arguments)]
pub fn guided_filter_self_encode(
    ctx: &GpuContext,
    encoder: &mut wgpu::CommandEncoder,
    luma: &wgpu::Buffer,
    luma2: &wgpu::Buffer,
    mean_a: &wgpu::Buffer,
    mean_b: &wgpu::Buffer,
    width: u32,
    height: u32,
    r: u32,
    eps: f32,
) {
    let count = width * height;

    // blur(luma) and blur(luma²) — the only two means the self-guided case needs.
    let mean_i = alloc_plane(ctx, width, height, "guided-mean-i");
    let mean_ii = alloc_plane(ctx, width, height, "guided-mean-ii");
    box_blur_encode(ctx, encoder, luma, &mean_i, width, height, r);
    box_blur_encode(ctx, encoder, luma2, &mean_ii, width, height, r);

    // a, b from the means (self-guided: cov_ip == var_i == mean_ii - mean_i²).
    let a = alloc_plane(ctx, width, height, "guided-a");
    let b = alloc_plane(ctx, width, height, "guided-b");
    let ab_params = AbParams {
        count,
        eps,
        _pad0: 0,
        _pad1: 0,
    };
    encode_simple(
        ctx,
        encoder,
        ctx.guided_ab_pipeline(),
        bytemuck::bytes_of(&ab_params),
        &[&mean_i, &mean_ii, &a, &b],
        count,
        "guided-ab",
    );

    // mean_a = blur(a), mean_b = blur(b) — the reconstruction coefficients.
    box_blur_encode(ctx, encoder, &a, mean_a, width, height, r);
    box_blur_encode(ctx, encoder, &b, mean_b, width, height, r);
}

/// Encode the guided-filter luma-extract sub-pass: RGBA `src` → (`luma`, `luma2`)
/// scalar planes. The entry point clarity / texture share before
/// [`guided_filter_self_encode`].
pub fn luma_extract_encode(
    ctx: &GpuContext,
    encoder: &mut wgpu::CommandEncoder,
    src: &wgpu::Buffer,
    luma: &wgpu::Buffer,
    luma2: &wgpu::Buffer,
    count: u32,
) {
    let params = CountParams {
        count,
        _pad0: 0,
        _pad1: 0,
        _pad2: 0,
    };
    encode_simple(
        ctx,
        encoder,
        ctx.guided_luma_pipeline(),
        bytemuck::bytes_of(&params),
        &[src, luma, luma2],
        count,
        "guided-luma",
    );
}

/// The full clarity / texture spatial pipeline, shared by both stages (epic #925
/// P2 wave 3b / #990). The ONLY difference between clarity and texture is the
/// guided-filter `r` (20 vs 2); everything else — luma extract, self-guided
/// guided filter, base/detail recombine — is identical, so it lives here once.
///
/// Encodes, reading `src` (RGBA) and writing `dst` (RGBA):
///   1. luma-extract: src → (luma, luma²)
///   2. self-guided guided filter at radius `r`, eps 1e-3 → (mean_a, mean_b)
///   3. combine (MULTI-INPUT): orig=src + luma + mean_a + mean_b → dst
///
/// Mirrors `raw_core::stages::{clarity,texture}::apply` exactly. `amount` is the
/// slider / 100. The caller is responsible for the `|slider| < 1e-3` early-return
/// (a straight src→dst copy) — this function always runs the full pipeline.
#[allow(clippy::too_many_arguments)] // GPU encode plumbing: ctx/encoder/src/dst/dims/r/amount.
pub fn clarity_texture_encode(
    ctx: &GpuContext,
    encoder: &mut wgpu::CommandEncoder,
    src: &wgpu::Buffer,
    dst: &wgpu::Buffer,
    width: u32,
    height: u32,
    r: u32,
    amount: f32,
) {
    let count = width * height;
    const EPS: f32 = 1e-3; // CLARITY_EPS == TEXTURE_EPS in raw-core.

    let luma = alloc_plane(ctx, width, height, "clarity-luma");
    let luma2 = alloc_plane(ctx, width, height, "clarity-luma2");
    luma_extract_encode(ctx, encoder, src, &luma, &luma2, count);

    let mean_a = alloc_plane(ctx, width, height, "clarity-mean-a");
    let mean_b = alloc_plane(ctx, width, height, "clarity-mean-b");
    guided_filter_self_encode(
        ctx, encoder, &luma, &luma2, &mean_a, &mean_b, width, height, r, EPS,
    );

    let params = CombineParams {
        count,
        amount,
        _pad0: 0,
        _pad1: 0,
    };
    // 4 storage buffers (orig + mean_a + mean_b + out): the combine recomputes
    // luma from `orig.rgb` rather than reading the `luma` plane, to stay within
    // `downlevel_defaults()`'s 4-storage-buffer cap. `luma` is still consumed
    // upstream as the guided-filter self-guide.
    encode_simple(
        ctx,
        encoder,
        ctx.guided_combine_pipeline(),
        bytemuck::bytes_of(&params),
        &[src, &mean_a, &mean_b, dst],
        count,
        "guided-combine",
    );
}
