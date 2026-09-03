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
//!    A `Mask::Bitmap` layer (#3271) additionally resolves against
//!    [`GpuMaskRaster`]s into a second storage buffer — the concatenated
//!    "mask plane" — since a raster's pixels cannot ride the fixed-stride
//!    layer record itself.
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
/// the two together, and the WGSL `Layer` struct (eight `vec4<f32>`) is the
/// same 128 bytes.
pub const LAYER_FLAT_LEN: usize = 32;

/// Index of the presence-bitmask slot within a layer record. A layer whose mask
/// is zero sets no controls, and both the Rust stage and the kernel skip it.
const PRESENT_SLOT: usize = 8;

/// Index of the `kind` slot within a layer record.
const KIND_SLOT: usize = 6;

/// `kind` slot value for [`Mask::Bitmap`](raw_core doc) records (#3271).
/// Mirrored from `raw_core::types::local_adjustment::flat::KIND_BITMAP`; the
/// parity test pins the two together, the same way [`LAYER_FLAT_LEN`] is
/// pinned against `raw_core`'s constant.
pub const KIND_BITMAP: f32 = 2.0;

/// One registered bitmap-mask raster, in the shape [`LocalAdjustmentsPass`]
/// needs to build its mask-plane buffer.
///
/// Deliberately NOT `raw_core::types::local_adjustment::MaskRaster`: this
/// crate takes `raw-core` only as a dev-dependency (see `Cargo.toml` — the
/// two crates would otherwise form a build cycle through raw-core's `gpu`
/// feature), so its real, non-test API cannot name that type. Every host
/// (raw-ffi, raw-wasm) already resolves an `Arc<raw_core::types::MaskRaster>`
/// from its own registry and borrows the three fields this stage actually
/// samples into this shape — the same boundary `local_adjustments: Vec<f32>`
/// already crosses instead of carrying `Vec<LocalAdjustment>` directly.
pub struct GpuMaskRaster {
    /// Matches the `raster_id` a `Mask::Bitmap` flat record carries in slot 2.
    pub id: u32,
    pub width: u32,
    pub height: u32,
    /// Row-major, `width * height` entries, each `0.0..=1.0`.
    pub data: Vec<f32>,
}

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
/// wire, always a whole number of records — see [`LocalAdjustmentsPass::new`].
///
/// The whole stack runs in ONE dispatch: the kernel loops layers in registers
/// per pixel rather than making a full-image pass per layer, which is exactly
/// equivalent because both the mask weight and the apply are purely local.
/// That keeps the stage at four storage buffers (src, dst, layers, mask
/// plane) — AT the four-per-stage `downlevel_defaults()` ceiling — with no
/// per-layer scratch and no ping-pong.
pub struct LocalAdjustmentsPass {
    /// Flat layer records; see `raw_core::types::local_adjustment::flat`.
    /// Invariant: length is an exact multiple of [`LAYER_FLAT_LEN`], enforced
    /// by [`LocalAdjustmentsPass::new`], which is the only way to build one.
    /// A `KIND_BITMAP` record's slots 0/1/2 are rewritten here from
    /// `width, height, raster_id` to `width, height, plane_offset` — the
    /// CPU wire keeps the id; the GPU copy needs the plane's own addressing.
    layers_flat: Vec<f32>,
    /// Every referenced raster's pixels, concatenated once per resolved
    /// bitmap record (a raster shared by two layers is appended once). Never
    /// empty — a stack with no bitmap layers still needs a bound buffer, so
    /// an unused plane is `vec![0.0]`.
    plane: Vec<f32>,
}

impl LocalAdjustmentsPass {
    /// Build the pass from a flat layer wire, dropping a trailing partial
    /// record, and resolve every `KIND_BITMAP` record's raster against
    /// `rasters` into a single concatenated plane buffer.
    ///
    /// The wire reaches this crate as a raw `(ptr, len)` pair across the FFI /
    /// WASM boundary, so a truncated buffer is a host bug this crate cannot
    /// rule out. `flat::layers_from_flat` documents the contract — "a trailing
    /// partial layer is dropped rather than rejected" — and both it and
    /// [`local_adjustments_are_active`] honour it via `chunks_exact`. Matching
    /// them here keeps the GPU path degrading to the valid prefix, the way the
    /// CPU path already does, instead of panicking the live render thread on a
    /// length that renders fine everywhere else.
    ///
    /// A bitmap record whose `raster_id` has no match in `rasters` (not yet
    /// registered, or released between resolve and encode) is left resolved
    /// to weight 0 — never a silent fallback to a global correction — by
    /// rewriting its plane-offset slot to `-1.0`; see `sample_raster` in
    /// `local_adjustments.wgsl`.
    pub fn new(layers_flat: &[f32], rasters: &[GpuMaskRaster]) -> Self {
        let whole = layers_flat.len() - layers_flat.len() % LAYER_FLAT_LEN;
        let mut layers_flat = layers_flat[..whole].to_vec();
        let mut plane: Vec<f32> = Vec::new();
        for slot in layers_flat.chunks_exact_mut(LAYER_FLAT_LEN) {
            if slot[KIND_SLOT] != KIND_BITMAP {
                continue;
            }
            let raster_id = slot[2] as u32;
            match rasters.iter().find(|r| r.id == raster_id) {
                Some(raster) => {
                    let offset = plane.len() as f32;
                    plane.extend_from_slice(&raster.data);
                    slot[0] = raster.width as f32;
                    slot[1] = raster.height as f32;
                    slot[2] = offset;
                }
                None => slot[2] = -1.0,
            }
        }
        if plane.is_empty() {
            plane.push(0.0);
        }
        Self { layers_flat, plane }
    }
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
        debug_assert_eq!(
            self.layers_flat.len() % LAYER_FLAT_LEN,
            0,
            "constructor invariant: `new` truncates to whole records"
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
        // The mask plane's BYTES are rewritten every call, same as `layers` —
        // during a slider drag the referenced raster's pixels are unchanged,
        // but only its VALUE changed, and there is no cheaper "still the same
        // raster" signal available at this layer than re-uploading it. Pooled
        // by byte length, so the buffer OBJECT survives across ticks while a
        // bitmap mask is active; see `live_chain.rs`'s `chain_signature` for
        // why the pass itself is rebuilt whenever that length changes.
        let plane = pool_data_storage(
            ctx,
            bytemuck::cast_slice(&self.plane),
            "local-adjustment-mask-plane",
        );

        // Pooled 5-binding dispatch: params @0, src @1, dst @2, layers @3,
        // mask plane @4 — AT the four-storage-buffer `downlevel_defaults()`
        // ceiling (#925).
        encode_simple(
            ctx,
            encoder,
            ctx.local_adjustments_pipeline(),
            bytemuck::bytes_of(&params),
            &[src, dst, layers.as_ref(), plane.as_ref()],
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

// Bitmap / Everywhere mask parity tests (#3271) — split out of `tests.rs`
// for the same 600-LOC reason; see that file's own header for the visibility
// contract this split relies on.
#[cfg(all(test, not(target_arch = "wasm32")))]
#[path = "local_adjustments/tests_bitmap.rs"]
mod tests_bitmap;

// The slider-tick timing harness — `#[ignore]`d, not a gate. Sibling file for
// the same file-budget reason as `tests.rs`.
#[cfg(all(test, not(target_arch = "wasm32")))]
#[path = "local_adjustments/bench.rs"]
mod bench;
