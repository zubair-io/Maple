//! Shared chain-present pipeline + pass encoding (epic #925, P4b — #1028 Apple,
//! #1029 web).
//!
//! The device-agnostic core of the chain-output present: build the
//! fullscreen-triangle render pipeline that samples the [`crate::LiveSession`]'s
//! final f32-RGBA chain buffer and runs the `dither_and_quantize` math in its FS
//! (`present_chain.wgsl`), and record that pass into a command encoder. NO surface
//! or platform handle is named here — the Apple (`CAMetalLayer`) and web
//! (`OffscreenCanvas`) entry points create/configure their own surface, then call
//! these helpers so the dither/quantize draw + the bind-group layout are
//! single-sourced across both platforms (and the host offscreen parity gate).
//!
//! Compiles on every target (it only touches `wgpu`, no platform deps), so the
//! native present (`present_chain.rs`) and the wasm present (`present_chain_web.rs`)
//! share it without duplicating the pipeline construction.

use crate::context::GpuContext;
use std::cell::{Cell, RefCell};
use std::sync::Arc;

/// `repr(C)` uniform for `present_chain.wgsl`: the surface/image width (the
/// row-major stride for the `(x, y)`→index recovery) + height (bounds guard).
/// `_pad*` round to 16 bytes (WGSL uniform alignment).
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
pub(crate) struct PresentParams {
    pub width: u32,
    pub height: u32,
    pub _pad0: u32,
    pub _pad1: u32,
}

/// Pick the surface format: the first *non-sRGB* BGRA/RGBA 8-bit the surface
/// lists. The FS emits the canonical unorm value `dither_and_quantize` quantizes
/// to, so a NON-sRGB surface round-trips it exactly — an `*Srgb` surface would
/// apply a second OETF on store and corrupt the already-gamma-encoded pixels.
/// Mirrors [`crate::present`]'s `pick_surface_format` rationale.
pub(crate) fn pick_surface_format(caps: &wgpu::SurfaceCapabilities) -> wgpu::TextureFormat {
    use wgpu::TextureFormat::*;
    caps.formats
        .iter()
        .copied()
        .find(|f| matches!(f, Bgra8Unorm | Rgba8Unorm))
        .unwrap_or_else(|| caps.formats[0])
}

/// Build the chain-present render pipeline on `ctx.device` for `format`. Lays out
/// a 2-binding group (params uniform @0, f32 chain buffer @1) and a fullscreen
/// vertex+fragment from `present_chain.wgsl`. Not cached on [`GpuContext`] — the
/// present runs once per frame and the surface FORMAT can differ from the cached
/// compute pipelines' (it's render, not compute); a per-present compile of one
/// tiny shader is negligible against the chain it follows.
pub(crate) fn build_present_pipeline(
    ctx: &GpuContext,
    format: wgpu::TextureFormat,
) -> (wgpu::RenderPipeline, wgpu::BindGroupLayout) {
    let shader = ctx
        .device
        .create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("present-chain"),
            source: wgpu::ShaderSource::Wgsl(include_str!("present_chain.wgsl").into()),
        });
    let bind_group_layout = ctx
        .device
        .create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("present-chain-bgl"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Storage { read_only: true },
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
            ],
        });
    let layout = ctx
        .device
        .create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("present-chain-layout"),
            bind_group_layouts: &[&bind_group_layout],
            push_constant_ranges: &[],
        });
    let pipeline = ctx
        .device
        .create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("present-chain-pipeline"),
            layout: Some(&layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs_main"),
                buffers: &[],
                compilation_options: wgpu::PipelineCompilationOptions::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fs_main"),
                targets: &[Some(wgpu::ColorTargetState {
                    format,
                    blend: None,
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: wgpu::PipelineCompilationOptions::default(),
            }),
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview: None,
            cache: None,
        });
    (pipeline, bind_group_layout)
}

/// What one present dispatch needs: the uniform buffer bound at binding 0 (kept
/// alive by the bind group anyway, but returned separately so a future caller
/// could rewrite it) and the bind group binding it + the sampled `chain_buf` at
/// binding 1.
pub(crate) struct PresentDispatch {
    #[allow(dead_code)] // Kept alive via the bind group; not read directly today.
    pub uniform: wgpu::Buffer,
    pub bind_group: wgpu::BindGroup,
}

/// Build a present dispatch: the `(width, height)` params uniform + the bind
/// group binding it and `chain_buf`. ALLOCATES (one buffer + one bind group) —
/// this is the ONLY place in the present path that does. A caller driving this
/// every render-loop tick (the live present path) MUST cache the result via
/// [`PresentDispatchCache`] instead of calling this per tick; only the true
/// one-shot host oracle ([`crate::present_chain::present_chain_to_offscreen`])
/// calls it directly.
pub(crate) fn build_present_dispatch(
    ctx: &GpuContext,
    bind_group_layout: &wgpu::BindGroupLayout,
    chain_buf: &wgpu::Buffer,
    dims: (u32, u32),
) -> PresentDispatch {
    let (width, height) = dims;
    let params = PresentParams {
        width,
        height,
        _pad0: 0,
        _pad1: 0,
    };
    let uniform = ctx.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("present-chain-uniform"),
        size: std::mem::size_of::<PresentParams>() as u64,
        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    ctx.queue
        .write_buffer(&uniform, 0, bytemuck::bytes_of(&params));
    let bind_group = ctx.device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("present-chain-bind-group"),
        layout: bind_group_layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: uniform.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: chain_buf.as_entire_binding(),
            },
        ],
    });
    PresentDispatch { uniform, bind_group }
}

/// Record the chain-present render pass into `encoder`: bind `bind_group`, draw
/// the fullscreen triangle into `target`. Takes an ALREADY-BUILT bind group (see
/// [`build_present_dispatch`] / [`PresentDispatchCache`]) — this function itself
/// allocates NOTHING, so a caller driving it every render-loop tick with a
/// cached bind group stays zero-alloc (#1930). Shared by the surface (Apple
/// `CAMetalLayer`, web `OffscreenCanvas`) and offscreen entry points so the
/// dither/quantize draw is single-sourced.
pub(crate) fn encode_present_pass(
    encoder: &mut wgpu::CommandEncoder,
    pipeline: &wgpu::RenderPipeline,
    bind_group: &wgpu::BindGroup,
    target: &wgpu::TextureView,
) {
    let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
        label: Some("present-chain-pass"),
        color_attachments: &[Some(wgpu::RenderPassColorAttachment {
            view: target,
            resolve_target: None,
            ops: wgpu::Operations {
                // Distinct mid-grey so a failure to draw the triangle is visible
                // (the surface would be this grey, not the image).
                load: wgpu::LoadOp::Clear(wgpu::Color {
                    r: 0.5,
                    g: 0.5,
                    b: 0.5,
                    a: 1.0,
                }),
                store: wgpu::StoreOp::Store,
            },
        })],
        depth_stencil_attachment: None,
        timestamp_writes: None,
        occlusion_query_set: None,
    });
    pass.set_pipeline(pipeline);
    pass.set_bind_group(0, bind_group, &[]);
    pass.draw(0..3, 0..1); // one fullscreen triangle, no buffers
}

/// One cached present dispatch, tagged with the buffer identity it was built
/// against (see [`PresentDispatchCache`]).
struct CachedPresentEntry {
    /// Identity of the `chain_buf` this entry's bind group is bound to — an
    /// address token (`&wgpu::Buffer` pointer, never dereferenced), mirroring
    /// `frame_pool::DispatchEntry::pipeline_id`'s identity-guard shape. A
    /// `wgpu::Buffer` doesn't move once created (owned by the session's
    /// `ping_pong` array or a similar stable place), so its address is a valid,
    /// stable per-buffer identity for the cache's lifetime.
    buf_identity: usize,
    uniform: Arc<wgpu::Buffer>,
    bind_group: Arc<wgpu::BindGroup>,
}

/// A per-surface present-dispatch cache keyed on the sampled `chain_buf`'s
/// identity (epic #925, P4b — #1930).
///
/// `encode_present_pass`'s uniform only carries `(width, height)`, fixed for a
/// surface's lifetime, yet the pre-#1930 present path called
/// `create_buffer`/`create_bind_group` on EVERY tick — a literal violation of
/// CLAUDE.md's "no allocation inside the render loop" invariant. The obvious
/// fix (build once at surface `create`, reuse thereafter) doesn't quite work
/// as-is: the bind group's OTHER binding is `chain_buf` —
/// [`crate::LiveSession::ping_pong_buffer`] at the chain's final ping-pong
/// index, which ALTERNATES between the session's two persistent buffers
/// depending on the chain's pass-count parity for that tick's active-stage set.
/// A single always-reused bind group would go stale (bound to the wrong
/// physical buffer) the moment parity flips.
///
/// So this caches by IDENTITY instead of unconditionally: a present against the
/// SAME `chain_buf` as last time (the steady state while dragging one slider,
/// where the active-stage set — and so the pass count — doesn't change) is a
/// zero-alloc hit; a present against a DIFFERENT `chain_buf` (a pass-count
/// parity flip, or a brand-new session's freshly-allocated buffers after a
/// re-open) is a bounded miss that rebuilds and re-caches. This mirrors
/// `frame_pool::pool_dispatch`'s pipeline-identity mismatch guard — same shape,
/// applied to the present pass's single dispatch instead of a whole chain.
pub(crate) struct PresentDispatchCache {
    entry: RefCell<Option<CachedPresentEntry>>,
    /// Count of actual `create_buffer` + `create_bind_group` builds (misses) —
    /// the allocation-accounting hook, mirroring `FramePool::alloc_count`. Never
    /// bumped on a cache hit.
    alloc_count: Cell<u64>,
}

impl PresentDispatchCache {
    /// A fresh, empty cache (the first present is always a miss).
    pub fn new() -> Self {
        Self {
            entry: RefCell::new(None),
            alloc_count: Cell::new(0),
        }
    }

    /// Total cache builds (misses) so far — the honest zero-alloc hook. A
    /// same-buffer-identity re-present leaves this UNCHANGED. `pub(crate)`
    /// today only for the `tests.rs` zero-alloc gate (#1930) — no production
    /// caller yet, mirroring `FramePool::alloc_count`'s role as the same kind
    /// of accounting hook a future perf-diagnostics surface could read.
    #[allow(dead_code)]
    pub fn alloc_count(&self) -> u64 {
        self.alloc_count.get()
    }

    /// Get-or-build the `(uniform, bind_group)` pair for presenting `chain_buf`
    /// through `bind_group_layout` at `dims`. Builds (2 allocations: the
    /// uniform buffer + the bind group) ONLY when the cached entry's buffer
    /// identity differs from `chain_buf`'s; a same-identity call is a
    /// zero-alloc hit returning `Arc` clones (a refcount bump, not a GPU
    /// allocation) of the cached pair.
    pub fn get_or_build(
        &self,
        ctx: &GpuContext,
        bind_group_layout: &wgpu::BindGroupLayout,
        chain_buf: &wgpu::Buffer,
        dims: (u32, u32),
    ) -> (Arc<wgpu::Buffer>, Arc<wgpu::BindGroup>) {
        let buf_identity = std::ptr::from_ref(chain_buf) as usize;
        if let Some(existing) = self.entry.borrow().as_ref() {
            if existing.buf_identity == buf_identity {
                return (
                    Arc::clone(&existing.uniform),
                    Arc::clone(&existing.bind_group),
                );
            }
        }
        // Miss: build fresh, count it, cache it (replacing any stale entry).
        let dispatch = build_present_dispatch(ctx, bind_group_layout, chain_buf, dims);
        self.alloc_count.set(self.alloc_count.get() + 2);
        let uniform = Arc::new(dispatch.uniform);
        let bind_group = Arc::new(dispatch.bind_group);
        *self.entry.borrow_mut() = Some(CachedPresentEntry {
            buf_identity,
            uniform: Arc::clone(&uniform),
            bind_group: Arc::clone(&bind_group),
        });
        (uniform, bind_group)
    }

    /// Drop the cached entry. Call this whenever the surface reconfigures (a
    /// format / bind-group-layout change makes any cached bind group invalid
    /// for the new pipeline — a `wgpu` bind group is exclusive to the layout it
    /// was built against) so the NEXT present is forced to rebuild against the
    /// current layout instead of reusing a bind group for a stale one. Only
    /// `PersistentPresentSurface::reconfigure` (Apple, native-only) calls this
    /// today — `WebPresentSurface` has no reconfigure path (a dims change is a
    /// whole new surface), so this is legitimately unused on `wasm32`.
    #[cfg_attr(target_arch = "wasm32", allow(dead_code))]
    pub fn invalidate(&self) {
        *self.entry.borrow_mut() = None;
    }
}

impl Default for PresentDispatchCache {
    fn default() -> Self {
        Self::new()
    }
}

// Native-only: exercises `GpuContext::new_blocking` (pollster-backed), like the
// rest of the crate's device-backed unit tests. No canvas / CAMetalLayer needed
// — the cache only touches `ctx.device` + a plain storage buffer standing in
// for `chain_buf`, so this proves the SHARED logic both platform present
// surfaces delegate to, independent of their platform-specific surface wiring.
#[cfg(all(test, not(target_arch = "wasm32")))]
#[path = "present_chain_pipeline/tests.rs"]
mod tests;
