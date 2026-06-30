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
use crate::frame_pool::{pool_dispatch, pool_scratch, DispatchResources};
use std::rc::Rc;

/// A pooled GPU scratch buffer handle. `Rc<wgpu::Buffer>` so the live-render pool
/// ([`crate::frame_pool`]) can own the buffer and hand out cheap refcount-bump
/// clones (NOT GPU allocations) on a same-signature re-render. Derefs to
/// `&wgpu::Buffer` at function-arg / `as_entire_binding` positions; pass `&*plane`
/// (or `plane.as_ref()`) where a `&wgpu::Buffer` slice element is needed.
pub type Plane = Rc<wgpu::Buffer>;

/// The standard scratch usage: `STORAGE | COPY_SRC | COPY_DST` (sub-pass src/dst,
/// seeded by a copy, or read back).
const SCRATCH_USAGE: wgpu::BufferUsages = wgpu::BufferUsages::STORAGE
    .union(wgpu::BufferUsages::COPY_SRC)
    .union(wgpu::BufferUsages::COPY_DST);

/// Byte length of a `width × height` scalar f32 plane (one f32 per pixel).
#[inline]
pub fn plane_byte_len(width: u32, height: u32) -> u64 {
    (width as u64) * (height as u64) * std::mem::size_of::<f32>() as u64
}

/// Allocate (or REUSE, on a same-signature re-render) a scratch storage buffer
/// for a scalar f32 plane (`width × height` f32). `STORAGE | COPY_SRC | COPY_DST`
/// so it can be a sub-pass src/dst or be seeded by a copy. Drawn from the live
/// pool ([`crate::frame_pool`]) — the first render of a chain shape creates it,
/// subsequent same-shape renders reuse the same `Rc<Buffer>` (zero allocation).
/// Outside a render window (stage unit tests) the pool is dormant and this is a
/// plain create. Returns an [`Plane`] (`Rc<Buffer>`); deref for `&Buffer`.
pub fn alloc_plane(ctx: &GpuContext, width: u32, height: u32, label: &str) -> Plane {
    let byte_len = plane_byte_len(width, height);
    let label = label.to_string();
    pool_scratch(ctx, byte_len, move |device| {
        device.create_buffer(&wgpu::BufferDescriptor {
            label: Some(&label),
            size: byte_len,
            usage: SCRATCH_USAGE,
            mapped_at_creation: false,
        })
    })
}

/// Pooled READ-ONLY STORAGE buffer for a per-image / per-edit data array (the
/// Auto Profile curve / residual-LUT grid / AgX LUT / prepared tone curves). The
/// buffer OBJECT is pooled — created once per chain shape, reused every tick (a
/// same-signature re-render does NOT reallocate it) — but `contents` are written
/// EVERY call via `queue.write_buffer` (a copy, not an allocation), so the data
/// is always fresh. `STORAGE | COPY_SRC | COPY_DST`; the kernel binds it
/// read-only. Returns an [`Plane`] (`Rc<Buffer>`); pass `data.as_ref()` to
/// [`encode_simple`].
///
/// PARITY-CRITICAL: the contents MUST be rewritten unconditionally, mirroring the
/// uniform-on-hit path in [`encode_simple`]. The chain signature keys the pool on
/// the active-stage SET, not data VALUES — so a tone-curve edit (a moved curve
/// point / parametric slider) keeps the same signature and hits the cached
/// buffer; without the unconditional write it would bind STALE curve data and the
/// live preview would freeze on a tone-curve edit. The AgX LUT / residual grid /
/// fitted curve are session-constant so the write is a redundant-but-harmless
/// copy for them; tone-curves genuinely needs it.
pub fn pool_data_storage(ctx: &GpuContext, contents: &[u8], label: &str) -> Plane {
    let byte_len = contents.len() as u64;
    let owned_label = label.to_string();
    // Pool the (uninitialised) buffer OBJECT — created only on a miss.
    let buf = pool_scratch(ctx, byte_len, move |device| {
        device.create_buffer(&wgpu::BufferDescriptor {
            label: Some(&owned_label),
            size: byte_len,
            usage: SCRATCH_USAGE,
            mapped_at_creation: false,
        })
    });
    // Write the CURRENT contents every call (hit OR miss) — a copy, not an alloc,
    // so the zero-alloc invariant holds while the data stays fresh.
    ctx.queue.write_buffer(&buf, 0, contents);
    buf
}

/// Pooled scratch storage buffer for an RGBA f32 image (`width × height × 4` f32).
/// Same usage + pooling as [`alloc_plane`]; used when a spatial stage needs an
/// extra full-image scratch beyond the chain's ping-pong pair.
pub fn alloc_rgba(ctx: &GpuContext, width: u32, height: u32, label: &str) -> Plane {
    let byte_len = (width as u64) * (height as u64) * 4 * std::mem::size_of::<f32>() as u64;
    let label = label.to_string();
    pool_scratch(ctx, byte_len, move |device| {
        device.create_buffer(&wgpu::BufferDescriptor {
            label: Some(&label),
            size: byte_len,
            usage: SCRATCH_USAGE,
            mapped_at_creation: false,
        })
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
/// rewritten into the SAME uniform via `queue.write_buffer` (cheap — NOT a
/// counted allocation), so a slider drag stays zero-alloc. The storage `buffers`
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
    let params_len = params_bytes.len() as u64;
    let layout = pipeline.get_bind_group_layout(0);

    // Get-or-create the pooled uniform + bind group. `make` runs ONLY on a cache
    // miss (so a hit allocates nothing); it builds the uniform + the bind group
    // referencing it + the passed storage buffers.
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
            // The storage buffers are kept alive by the session (ping-pong) and
            // the pool (scratch / data) — not by the dispatch entry — so `data`
            // is empty (no double-ownership). See `frame_pool` docs.
            data: Vec::new(),
        }
    });

    // Write the CURRENT params into the (possibly reused) uniform every call —
    // param values change per tick, the buffer object does not.
    ctx.queue.write_buffer(&pooled.uniform, 0, params_bytes);

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

/// Byte length of a `width × height` vec2 f32 plane (two f32 per pixel).
#[inline]
pub fn plane_vec2_byte_len(width: u32, height: u32) -> u64 {
    (width as u64) * (height as u64) * 2 * std::mem::size_of::<f32>() as u64
}

/// Pooled scratch storage buffer for a vec2 f32 plane (`width × height × 2` f32).
/// Same usage + pooling as [`alloc_plane`]; used by dehaze's general guided
/// filter to hold its PACKED mean-planes (two scalar quantities blurred together
/// — see [`box_blur_vec2_encode`]). Returns an [`Plane`] (`Rc<Buffer>`).
pub fn alloc_plane_vec2(ctx: &GpuContext, width: u32, height: u32, label: &str) -> Plane {
    let byte_len = plane_vec2_byte_len(width, height);
    let label = label.to_string();
    pool_scratch(ctx, byte_len, move |device| {
        device.create_buffer(&wgpu::BufferDescriptor {
            label: Some(&label),
            size: byte_len,
            usage: SCRATCH_USAGE,
            mapped_at_creation: false,
        })
    })
}

/// The vec2 sibling of [`box_blur_encode`] (epic #925 P2 wave 3b / #990). Encodes
/// a horizontal then a vertical sweep of a `width × height` vec2 f32 plane via the
/// `box_blur_vec2.wgsl` kernel, identical border policy to the scalar primitive
/// (shrinking partial average, exact in-bounds count). The two lanes blur
/// independently, so each lane is bit-for-bit a scalar [`box_blur_encode`] of that
/// lane — letting dehaze blur its packed (i,p)/(ip,ii) mean-planes in half the
/// dispatches. `r == 0` short-circuits to a straight copy, like the scalar form.
pub fn box_blur_vec2_encode(
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
        encoder.copy_buffer_to_buffer(input, 0, output, 0, plane_vec2_byte_len(width, height));
        return;
    }
    let scratch = alloc_plane_vec2(ctx, width, height, "box-blur-vec2-h-scratch");
    let pipeline = ctx.box_blur_vec2_pipeline();

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
        "box-blur-vec2-horizontal",
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
        "box-blur-vec2-vertical",
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

#[derive(Clone, Copy)]
pub struct GuidedFilterArgs {
    pub width: u32,
    pub height: u32,
    pub r: u32,
    pub eps: f32,
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
pub fn guided_filter_self_encode(
    ctx: &GpuContext,
    encoder: &mut wgpu::CommandEncoder,
    luma: &wgpu::Buffer,
    luma2: &wgpu::Buffer,
    mean_a: &wgpu::Buffer,
    mean_b: &wgpu::Buffer,
    args: GuidedFilterArgs,
) {
    let GuidedFilterArgs {
        width,
        height,
        r,
        eps,
    } = args;
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

#[derive(Clone, Copy)]
pub struct ClarityTextureArgs {
    pub width: u32,
    pub height: u32,
    pub r: u32,
    pub amount: f32,
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
pub fn clarity_texture_encode(
    ctx: &GpuContext,
    encoder: &mut wgpu::CommandEncoder,
    src: &wgpu::Buffer,
    dst: &wgpu::Buffer,
    args: ClarityTextureArgs,
) {
    let ClarityTextureArgs {
        width,
        height,
        r,
        amount,
    } = args;
    let count = width * height;
    const EPS: f32 = 1e-3; // CLARITY_EPS == TEXTURE_EPS in raw-core.

    let luma = alloc_plane(ctx, width, height, "clarity-luma");
    let luma2 = alloc_plane(ctx, width, height, "clarity-luma2");
    luma_extract_encode(ctx, encoder, src, &luma, &luma2, count);

    let mean_a = alloc_plane(ctx, width, height, "clarity-mean-a");
    let mean_b = alloc_plane(ctx, width, height, "clarity-mean-b");
    guided_filter_self_encode(
        ctx,
        encoder,
        &luma,
        &luma2,
        &mean_a,
        &mean_b,
        GuidedFilterArgs {
            width,
            height,
            r,
            eps: EPS,
        },
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
