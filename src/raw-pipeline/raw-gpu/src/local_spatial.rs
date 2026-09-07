//! The per-mask SPATIAL control group on the GPU (#3407).
//!
//! `raw_core::stages::local_adjustments::spatial` applies texture, clarity,
//! dehaze, sharpness, luminance noise and defringe INSIDE a mask by running
//! the global stage's own kernel over a scratch copy of the layer's output
//! and lerping the result back by the mask weight. This module is that
//! stage's GPU twin, and it reuses the same two ingredients rather than
//! reimplementing either:
//!
//!  * the spatial kernels are the SHIPPING passes — [`TexturePass`],
//!    [`ClarityPass`], [`DehazePass`], [`SharpenPass`], [`NlmLumaPass`],
//!    [`DefringePass`] — encoded over scratch buffers, so a local Clarity of
//!    +40 runs literally the same WGSL a global Clarity of +40 does; and
//!  * the mask weight comes from `local_adjustments.wgsl`'s existing
//!    scope-target path, which already writes one named layer's per-pixel
//!    weight into alpha for the vectorscope (#3272). There is therefore NO
//!    second WGSL mask evaluator to drift from the first.
//!
//! ## Why the chain splits per layer when this is engaged
//!
//! [`LocalAdjustmentsPass`] normally runs the WHOLE layer stack in one
//! dispatch, looping layers in registers — valid because every point control
//! is purely local. A spatial control is not: it has to see the layer's
//! whole output before the next layer starts. So when some layer engages the
//! group, `live_chain` emits one pass PER LAYER instead — a plain
//! [`LocalAdjustmentsPass`] over that single layer, or a
//! [`LocalSpatialPass`] which does the point group and the spatial group
//! together. Splitting the point dispatch per layer is exactly equivalent to
//! fusing it (that equivalence is why the fused form exists at all), so a
//! model with no spatial control keeps the one-dispatch shape unchanged and
//! every existing pass-count test keeps its number.
//!
//! ## Scratch
//!
//! Two or three pooled RGBA scratch buffers per engaged layer: `base` (the
//! point-applied pixels, with the mask weight in alpha), and one or two
//! ping-pong buffers for the spatial kernels. The second ping-pong is
//! allocated only when two or more kernels are engaged.

use crate::chain::Pass;
use crate::clarity::ClarityPass;
use crate::context::GpuContext;
use crate::defringe::DefringePass;
use crate::dehaze::{AirlightSource, DehazePass};
use crate::local_adjustments::{
    layer_present_bits, GpuMaskRaster, LocalAdjustmentsPass, LAYER_FLAT_LEN, PRESENT_SPATIAL_MASK,
};
use crate::noise_reduction::NlmLumaPass;
use crate::sharpen::SharpenPass;
use crate::spatial::{alloc_rgba, encode_simple};
use crate::texture::TexturePass;

/// Slot index of the first spatial control (`texture`) in a flat layer
/// record. Mirrors `raw_core::types::local_adjustment::flat`'s `SPATIAL_BASE`.
const SPATIAL_BASE_SLOT: usize = 32;

/// Radius / detail / masking the per-mask Sharpness slider drives
/// `SharpenPass` at — the `AdjustmentModel` defaults, mirroring
/// `raw_core::stages::local_adjustments::spatial`'s own constants because
/// Lightroom's local panel exposes a single Sharpness amount.
const LOCAL_SHARPEN_RADIUS: f32 = 1.0;
const LOCAL_SHARPEN_DETAIL: f32 = 25.0;
const LOCAL_SHARPEN_MASKING: f32 = 0.0;

/// The engage threshold every stage in the group uses for its own no-op
/// early return, mirrored from `spatial::ENGAGE_EPS`.
const ENGAGE_EPS: f32 = 1e-3;

/// `repr(C)` params uniform shared with `local_spatial_blend.wgsl`. 16 bytes.
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct BlendParams {
    count: u32,
    keep_weight_in_alpha: u32,
    _pad0: u32,
    _pad1: u32,
}

/// One layer's six spatial slider values, `None` where the control is not
/// set. Read straight off the flat record's `32..38` block.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct SpatialControls {
    pub texture: Option<f32>,
    pub clarity: Option<f32>,
    pub dehaze: Option<f32>,
    pub sharpness: Option<f32>,
    pub luminance_noise: Option<f32>,
    pub defringe: Option<f32>,
}

impl SpatialControls {
    /// Decode the six controls from one flat layer record, honouring the
    /// presence bitmask exactly as `raw_core`'s reader does: a clear bit is
    /// `None`, which is NOT the same as `Some(0.0)`.
    pub fn from_flat(layer: &[f32]) -> Self {
        let present = layer_present_bits(layer);
        let field = |i: usize| {
            if present & (1 << (11 + i)) != 0 {
                Some(layer[SPATIAL_BASE_SLOT + i])
            } else {
                None
            }
        };
        Self {
            texture: field(0),
            clarity: field(1),
            dehaze: field(2),
            sharpness: field(3),
            luminance_noise: field(4),
            defringe: field(5),
        }
    }

    /// `true` when at least one control would do something — the same
    /// predicate `spatial::engaged` applies on the CPU.
    pub fn engaged(&self) -> bool {
        self.stage_values().iter().any(|v| on(*v))
    }

    /// The six values in Lightroom's panel order, which is the order the
    /// kernels run in on both sides.
    fn stage_values(&self) -> [Option<f32>; 6] {
        [
            self.texture,
            self.clarity,
            self.dehaze,
            self.sharpness,
            self.luminance_noise,
            self.defringe,
        ]
    }
}

#[inline]
fn on(value: Option<f32>) -> bool {
    value.is_some_and(|v| v.abs() >= ENGAGE_EPS)
}

/// `true` when this flat layer record sets one of the six spatial controls.
pub fn layer_needs_spatial(layer: &[f32]) -> bool {
    layer_present_bits(layer) & PRESENT_SPATIAL_MASK != 0
}

/// Everything about one layer that changes the CHAIN'S SHAPE — how many
/// passes it contributes and how many pooled scratch buffers they draw — so
/// `live_chain::chain_signature` can fold it in.
///
/// The low 17 bits are the presence bitmask (which decides whether the layer
/// gets a [`LocalSpatialPass`] at all); the next six say which spatial
/// kernels are ENGAGED past the 1e-3 threshold, which is what decides how
/// many sub-passes and ping-pong buffers that pass encodes. Slider VALUES
/// deliberately do not participate: dragging Clarity from 30 to 40 rewrites
/// a same-sized buffer through a same-shaped chain, which is exactly the
/// case the pool exists to make free.
pub fn layer_shape_key(layer: &[f32]) -> u32 {
    let engaged = SpatialControls::from_flat(layer)
        .stage_values()
        .iter()
        .enumerate()
        .filter(|(_, v)| on(**v))
        .fold(0u32, |acc, (i, _)| acc | (1 << i));
    layer_present_bits(layer) | (engaged << 17)
}

/// One layer's point group AND spatial group, as a single chain [`Pass`].
///
/// Build one per layer that [`layer_needs_spatial`] reports on; the
/// live-chain builder emits a plain [`LocalAdjustmentsPass`] for the others.
pub struct LocalSpatialPass {
    /// The single-layer point pass, always built with scope layer 0 so the
    /// kernel writes THIS layer's mask weight into the scratch alpha.
    point: LocalAdjustmentsPass,
    controls: SpatialControls,
    /// Whether this layer is the chain's real vectorscope scope target
    /// (#3272). When it is, the weight stays in alpha past the blend;
    /// otherwise the blend restores the alpha the stage was handed.
    is_scope_target: bool,
    /// How the per-mask dehaze sub-pass sources its atmospheric light. The
    /// live chain passes [`AirlightSource::OnGpu`] because the buffer it
    /// measures — this layer's point-applied output — only exists on the
    /// device; the headless parity gate passes the CPU value of that same
    /// buffer.
    airlight: AirlightSource,
}

impl LocalSpatialPass {
    /// Build the pass for ONE flat layer record. `layer_flat` must be
    /// exactly [`LAYER_FLAT_LEN`] floats; `rasters` resolves a bitmap mask
    /// exactly as [`LocalAdjustmentsPass::new`] does.
    pub fn new(layer_flat: &[f32], rasters: &[GpuMaskRaster], is_scope_target: bool) -> Self {
        assert_eq!(
            layer_flat.len(),
            LAYER_FLAT_LEN,
            "LocalSpatialPass takes exactly one flat layer record"
        );
        Self {
            point: LocalAdjustmentsPass::new(layer_flat, rasters).with_scope_layer(0),
            controls: SpatialControls::from_flat(layer_flat),
            is_scope_target,
            airlight: AirlightSource::OnGpu,
        }
    }

    /// Override the dehaze sub-pass's airlight source. Only the headless
    /// parity gate needs this; the live chain keeps the default on-GPU
    /// reduction, which costs no readback.
    pub fn with_airlight(mut self, airlight: AirlightSource) -> Self {
        self.airlight = airlight;
        self
    }

    /// The engaged kernels, in the order both sides run them.
    fn stage_passes(&self) -> Vec<Box<dyn Pass>> {
        let c = &self.controls;
        let mut passes: Vec<Box<dyn Pass>> = Vec::new();
        if let Some(v) = c.texture.filter(|v| v.abs() >= ENGAGE_EPS) {
            passes.push(Box::new(TexturePass { texture: v }));
        }
        if let Some(v) = c.clarity.filter(|v| v.abs() >= ENGAGE_EPS) {
            passes.push(Box::new(ClarityPass { clarity: v }));
        }
        if let Some(v) = c.dehaze.filter(|v| v.abs() >= ENGAGE_EPS) {
            passes.push(Box::new(DehazePass {
                dehaze: v,
                airlight: self.airlight.clone(),
            }));
        }
        if let Some(v) = c.sharpness.filter(|v| v.abs() >= ENGAGE_EPS) {
            passes.push(Box::new(SharpenPass {
                amount: v,
                radius: LOCAL_SHARPEN_RADIUS,
                detail: LOCAL_SHARPEN_DETAIL,
                masking: LOCAL_SHARPEN_MASKING,
            }));
        }
        if let Some(v) = c.luminance_noise.filter(|v| v.abs() >= ENGAGE_EPS) {
            // No noise profile and no ISO — the per-mask control is an
            // explicit artistic amount, matching the CPU stage's
            // `apply_luminance(_, v, None, 0)`.
            passes.push(Box::new(NlmLumaPass {
                nr_luminance: v,
                noise_profile: Vec::new(),
                iso: 0,
            }));
        }
        if let Some(v) = c.defringe.filter(|v| v.abs() >= ENGAGE_EPS) {
            passes.push(Box::new(DefringePass { amount: v }));
        }
        passes
    }
}

impl Pass for LocalSpatialPass {
    fn encode(
        &self,
        ctx: &GpuContext,
        encoder: &mut wgpu::CommandEncoder,
        src: &wgpu::Buffer,
        dst: &wgpu::Buffer,
        dims: (u32, u32),
    ) {
        let (width, height) = dims;
        let count = width * height;
        // The point group, into a scratch whose alpha the kernel fills with
        // this layer's mask weight.
        let base = alloc_rgba(ctx, width, height, "local-spatial-base");
        self.point.encode(ctx, encoder, src, &base, dims);

        let stages = self.stage_passes();
        if stages.is_empty() {
            // Nothing engaged after the threshold — the blend below would be
            // an identity lerp, so copy the point result straight out and
            // put the alpha back the way the blend would have.
            self.blend(ctx, encoder, src, &base, &base, dst, count);
            return;
        }
        // One extra buffer for a single kernel, two to ping-pong more.
        let ping = alloc_rgba(ctx, width, height, "local-spatial-ping");
        let pong = if stages.len() > 1 {
            Some(alloc_rgba(ctx, width, height, "local-spatial-pong"))
        } else {
            None
        };
        let mut read: &wgpu::Buffer = &base;
        let mut to_ping = true;
        for stage in &stages {
            let write: &wgpu::Buffer = match (to_ping, pong.as_deref()) {
                (true, _) => &ping,
                (false, Some(pong)) => pong,
                // Unreachable: `pong` is Some whenever more than one stage
                // runs, and a single stage never flips `to_ping`.
                (false, None) => &ping,
            };
            stage.encode(ctx, encoder, read, write, dims);
            read = write;
            to_ping = !to_ping;
        }
        self.blend(ctx, encoder, src, &base, read, dst, count);
    }
}

impl LocalSpatialPass {
    /// `dst = base + weight · (filtered − base)`, alpha restored (or the
    /// weight kept, for the scope target).
    #[allow(clippy::too_many_arguments)]
    fn blend(
        &self,
        ctx: &GpuContext,
        encoder: &mut wgpu::CommandEncoder,
        original: &wgpu::Buffer,
        base: &wgpu::Buffer,
        filtered: &wgpu::Buffer,
        dst: &wgpu::Buffer,
        count: u32,
    ) {
        let params = BlendParams {
            count,
            keep_weight_in_alpha: u32::from(self.is_scope_target),
            _pad0: 0,
            _pad1: 0,
        };
        encode_simple(
            ctx,
            encoder,
            ctx.local_spatial_blend_pipeline(),
            bytemuck::bytes_of(&params),
            &[original, base, filtered, dst],
            count,
            "local-spatial-blend",
        );
    }
}

// Parity tests live in a sibling file to keep this module under the 600-LOC
// budget. Native test builds only — the headless GPU harness has no wasm path.
#[cfg(all(test, not(target_arch = "wasm32")))]
#[path = "local_spatial/tests.rs"]
mod tests;
