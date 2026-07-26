//! Local adjustments — the GPU vector-mask rasterizer (#1698).
//!
//! Ports `raw_core::stages::local_adjustments::apply` (and the mask evaluator
//! under it) to WGSL. Until this landed, `local_adjustments` was the only
//! scene-linear stage with no GPU implementation at all, which mattered more
//! than a missing kernel usually does: the wgpu chain has been the shipping
//! default on Apple and on WebGPU browsers since #925, so a linear or radial
//! mask contributed nothing to the live canvas and only appeared once the
//! debounced CPU refine pass finished.
//!
//! Three pieces, the per-stage template:
//!
//! 1. [`LocalAdjustmentsPass`] — the GPU-resident [`Pass`]. It carries the
//!    layer stack in the flat wire `raw_core::types::local_adjustment::flat`
//!    defines, which is simultaneously the WGSL `array<Layer>` storage layout,
//!    so no re-packing happens between the FFI boundary and the bind group.
//! 2. [`local_adjustments_are_active`] — the inclusion predicate, single-sourced
//!    here so `build_live_split` and its stage-mask bit cannot disagree about
//!    whether the pass was pushed.
//! 3. The headless parity test (`local_adjustments/tests.rs`) — the GPU output
//!    against the REAL `raw_core::stages::local_adjustments::apply` via the
//!    test-only dev-dep, so there is no transcribed CPU twin that could drift.
//!
//! ## Window awareness, and what parity is claimed over
//!
//! The kernel derives each invocation's absolute pixel coordinate from the
//! buffer index plus a tile origin, like `vignette.wgsl`, and normalizes with
//! host-hoisted `1 / (dim - 1)` factors anchored to the FULL image. The live
//! chain renders whole frames, so `encode` passes origin `(0, 0)`. Parity is
//! claimed for that fit-zoom path only: `raw_core::pipeline::tile` REJECTS a
//! render whose model carries active local adjustments outright
//! (`pipeline/tile/mod.rs`), because a padded crop cannot reproduce
//! full-image-normalized mask coordinates without offset plumbing this ticket
//! does not add. The uniform already carries the origin, so the kernel is ready
//! for that path when it opens; nothing today drives it.

use crate::chain::Pass;
use crate::context::GpuContext;
use crate::spatial::{encode_simple, pool_data_storage};

/// Floats per serialized layer. MUST equal
/// `raw_core::types::local_adjustment::LAYER_FLAT_LEN`; the parity test pins
/// the two together, and the WGSL `Layer` struct (six `vec4<f32>`) is the same
/// 96 bytes.
pub const LAYER_FLAT_LEN: usize = 24;

/// Index of the presence-bitmask slot within a layer record. A layer whose mask
/// is zero sets no controls, and both the Rust stage and the kernel skip it.
const PRESENT_SLOT: usize = 8;

/// Whether the stage does anything for this flat layer stack — the predicate
/// that decides pass inclusion.
///
/// This mirrors `raw_core::stages::local_adjustments::apply`'s two guards
/// together: the whole-stage `layers.is_empty()` early return, and the
/// per-layer `layer.adjustments.is_empty()` skip. A stack of layers that all
/// carry empty `PartialAdjustments` is a true no-op, so the pass is omitted
/// rather than dispatched to copy the buffer.
pub fn local_adjustments_are_active(layers_flat: &[f32]) -> bool {
    layers_flat
        .chunks_exact(LAYER_FLAT_LEN)
        .any(|layer| layer[PRESENT_SLOT] != 0.0)
}

/// `repr(C)` params uniform shared with `local_adjustments.wgsl`. 32 bytes
/// (8 x 4, a multiple of the 16-byte uniform-struct requirement).
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Params {
    count: u32,
    layer_count: u32,
    buf_width: u32,
    origin_x: u32,
    origin_y: u32,
    _pad0: u32,
    inv_w: f32,
    inv_h: f32,
}

/// Normalized-coordinate denominator for one axis, reproducing the Rust
/// stage's rule exactly: `1 / (dim - 1)` so the first pixel maps to 0.0 and the
/// last to 1.0 (mask endpoints sit on image corners), and 0.0 for the
/// degenerate single-pixel axis where the denominator is undefined.
#[inline]
fn inv_extent(dim: u32) -> f32 {
    if dim > 1 {
        1.0 / (dim as f32 - 1.0)
    } else {
        0.0
    }
}

/// A GPU-resident local-adjustments stage. Carries the layer stack in the flat
/// wire (`layers_flat.len()` must be a multiple of [`LAYER_FLAT_LEN`]).
///
/// The whole stack runs in ONE dispatch: the kernel loops layers in registers
/// per pixel rather than making a full-image pass per layer, which is exactly
/// equivalent because both the mask weight and the apply are purely local. That
/// keeps the stage at three storage buffers (src, dst, layers) — inside the
/// four-per-stage `downlevel_defaults()` ceiling — with no per-layer scratch
/// and no ping-pong.
pub struct LocalAdjustmentsPass {
    /// Flat layer records; see `raw_core::types::local_adjustment::flat`.
    pub layers_flat: Vec<f32>,
}

impl Pass for LocalAdjustmentsPass {
    fn encode(
        &self,
        ctx: &GpuContext,
        encoder: &mut wgpu::CommandEncoder,
        src: &wgpu::Buffer,
        dst: &wgpu::Buffer,
        dims: (u32, u32),
    ) {
        assert!(
            self.layers_flat.len() % LAYER_FLAT_LEN == 0,
            "local-adjustment wire length must be a multiple of {LAYER_FLAT_LEN}, got {}",
            self.layers_flat.len()
        );
        assert!(
            !self.layers_flat.is_empty(),
            "LocalAdjustmentsPass encoded with an empty layer stack; the chain \
             builder must omit the pass instead (local_adjustments_are_active)"
        );
        let (width, height) = dims;
        let pixel_count = width * height;

        let params = Params {
            count: pixel_count,
            layer_count: (self.layers_flat.len() / LAYER_FLAT_LEN) as u32,
            buf_width: width,
            origin_x: 0,
            origin_y: 0,
            _pad0: 0,
            inv_w: inv_extent(width),
            inv_h: inv_extent(height),
        };
        // The layer stack rides a READ-ONLY STORAGE buffer, not a uniform: a
        // uniform `array` would get a 16-byte per-element stride and silently
        // misalign the record, the same trap the residual-LUT grid dodges.
        // Pooled, so a same-signature re-render reuses the buffer and only
        // rewrites its contents — the slider-drag case, where the mask geometry
        // changes every tick but its byte length does not.
        let layers = pool_data_storage(
            ctx,
            bytemuck::cast_slice(&self.layers_flat),
            "local-adjustment-layers",
        );

        // Pooled 4-binding dispatch: params @0, src @1, dst @2, layers @3.
        encode_simple(
            ctx,
            encoder,
            ctx.local_adjustments_pipeline(),
            bytemuck::bytes_of(&params),
            &[src, dst, layers.as_ref()],
            pixel_count,
            "local-adjustments",
        );
    }
}

// Parity tests live in a sibling file to keep this module under the 600-LOC
// budget. Native test builds only — the headless GPU harness has no wasm path.
#[cfg(all(test, not(target_arch = "wasm32")))]
#[path = "local_adjustments/tests.rs"]
mod tests;

// The slider-tick timing harness — `#[ignore]`d, not a gate. Sibling file for
// the same file-budget reason as `tests.rs`.
#[cfg(all(test, not(target_arch = "wasm32")))]
#[path = "local_adjustments/bench.rs"]
mod bench;
