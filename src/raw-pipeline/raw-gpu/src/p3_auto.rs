//! Gamut-preserving Auto for Display P3 on the GPU (#4741), the WGSL twin of
//! `raw_core::view::encode::rec2020_to_p3_auto_encoded`.
//!
//! The Auto tail only ever sees sRGB-encoded values, so the P3 target replaces
//! the single `display_encode` pass with a pair around it:
//! `P3AutoSplitPass` (Rec.2020 → the sRGB render's linear pixel, plus the
//! headroom ratio in a pooled side plane) and, after `srgb_gamma`, the unchanged
//! curve and residual LUT, `P3AutoRestorePass` (re-adds the ratio in Oklab and
//! encodes to P3). It is engaged only for a P3 target with fitted Auto artifacts;
//! every other chain keeps its existing passes.

use std::sync::{Arc, Mutex};

use crate::auto_profile_curve::profile_curve_is_active;
use crate::chain::Pass;
use crate::context::GpuContext;
use crate::full_chain::{FullChainInputs, InputShape};
use crate::residual_lut::residual_lut_is_active;
use crate::spatial::{alloc_plane, encode_simple, Plane};

const P3_TARGET: u32 = 1;

/// Whether the chain for `inputs` takes the split / restore pair. Single-sourced
/// for both composers, the live pool's active mask and the pass count.
pub(crate) fn p3_auto_is_active(inputs: &FullChainInputs) -> bool {
    inputs.target_primaries == P3_TARGET
        && inputs.input_shape == InputShape::PostDcpRec2020Fp16
        && (profile_curve_is_active(&inputs.profile_curve_flat)
            || residual_lut_is_active(inputs.residual_lut_size, &inputs.residual_lut_data))
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Params {
    count: u32,
    target_primaries: u32,
    _pad1: u32,
    _pad2: u32,
}

/// The split pass's headroom plane, handed to the restore pass, which takes it
/// so the holder never outlives the tick's plane. A live session keeps one
/// holder for its lifetime so a slider tick clones an `Arc` instead of
/// allocating a fresh holder; the boxed fallback builds one per chain.
#[derive(Clone, Default)]
pub(crate) struct HeadroomPlane(Arc<Mutex<Option<Plane>>>);

impl HeadroomPlane {
    #[cfg(test)]
    pub(crate) fn same_holder(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }

    #[cfg(test)]
    pub(crate) fn is_empty(&self) -> bool {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .is_none()
    }
}

/// The two passes of one P3 Auto chain, sharing `headroom`.
pub(crate) fn p3_auto_passes(headroom: HeadroomPlane) -> (P3AutoSplitPass, P3AutoRestorePass) {
    (
        P3AutoSplitPass {
            headroom: headroom.clone(),
        },
        P3AutoRestorePass { headroom },
    )
}

#[derive(Clone)]
pub(crate) struct P3AutoSplitPass {
    headroom: HeadroomPlane,
}

#[derive(Clone)]
pub(crate) struct P3AutoRestorePass {
    headroom: HeadroomPlane,
}

fn params(dims: (u32, u32)) -> Params {
    Params {
        count: dims.0 * dims.1,
        target_primaries: P3_TARGET,
        _pad1: 0,
        _pad2: 0,
    }
}

impl GpuContext {
    fn p3_auto_split_pipeline(&self) -> &wgpu::ComputePipeline {
        self.p3_auto_split_pipeline.get_or_init(|| {
            crate::context_pipelines_helpers::compile_with_matrices_entry(
                &self.device,
                "p3-auto-split",
                include_str!("display_encode.wgsl"),
                "main_p3_split",
            )
        })
    }

    fn p3_auto_restore_pipeline(&self) -> &wgpu::ComputePipeline {
        self.p3_auto_restore_pipeline.get_or_init(|| {
            crate::context_pipelines_helpers::compile_with_matrices_entry(
                &self.device,
                "p3-auto-restore",
                include_str!("display_encode.wgsl"),
                "main_p3_restore",
            )
        })
    }
}

impl Pass for P3AutoSplitPass {
    fn encode(
        &self,
        ctx: &GpuContext,
        encoder: &mut wgpu::CommandEncoder,
        src: &wgpu::Buffer,
        dst: &wgpu::Buffer,
        dims: (u32, u32),
    ) {
        let plane = alloc_plane(ctx, dims.0, dims.1, "p3-auto-headroom");
        encode_simple(
            ctx,
            encoder,
            ctx.p3_auto_split_pipeline(),
            bytemuck::bytes_of(&params(dims)),
            &[src, dst, &plane],
            dims.0 * dims.1,
            "p3-auto-split",
        );
        *self
            .headroom
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(plane);
    }
}

impl Pass for P3AutoRestorePass {
    fn encode(
        &self,
        ctx: &GpuContext,
        encoder: &mut wgpu::CommandEncoder,
        src: &wgpu::Buffer,
        dst: &wgpu::Buffer,
        dims: (u32, u32),
    ) {
        let plane = self
            .headroom
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        let Some(plane) = plane else {
            debug_assert!(false, "P3AutoRestorePass encoded before P3AutoSplitPass");
            return;
        };
        encode_simple(
            ctx,
            encoder,
            ctx.p3_auto_restore_pipeline(),
            bytemuck::bytes_of(&params(dims)),
            &[src, dst, &plane],
            dims.0 * dims.1,
            "p3-auto-restore",
        );
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
#[path = "p3_auto/tests.rs"]
mod tests;
