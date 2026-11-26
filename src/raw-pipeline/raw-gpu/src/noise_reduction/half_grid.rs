//! Native-density half-resolution chroma grid (#6018), the GPU twin of
//! raw-core's `noise_reduction_half_res.rs` at origin `(0, 0)`.

use crate::context::GpuContext;
use crate::spatial::{alloc_plane, encode_simple, Plane};

/// Mirror of raw-core's `DESPECKLE_FULL_AMOUNT` (the default `nr_color`).
const DESPECKLE_FULL_AMOUNT: f32 = 25.0;

/// Mirror of raw-core's `DESPECKLE_MARGIN`.
const DESPECKLE_MARGIN: f32 = 0.005;

/// Mirror of `raw_core::stages::noise_reduction::is_native_density`.
pub(super) fn is_native_density(scale: f32) -> bool {
    !scale.is_finite() || scale <= 0.0 || scale >= 1.0
}

/// `box_down` / `upsample_residual` uniform (#6018). 32 bytes.
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
pub(super) struct HalfParams {
    pub(super) width: u32,
    pub(super) height: u32,
    pub(super) half_width: u32,
    pub(super) half_height: u32,
    pub(super) residual_weight: f32,
    pub(super) despeckle_strength: f32,
    pub(super) despeckle_margin: f32,
    _pad: u32,
}

/// The 2×2 block grid of a whole frame, mirroring raw-core's
/// `noise_reduction_half_res.rs` at origin `(0, 0)`.
pub(super) struct HalfGrid {
    pub(super) params: HalfParams,
}

impl HalfGrid {
    pub(super) fn new(width: u32, height: u32, amount: f32) -> Self {
        Self {
            params: HalfParams {
                width,
                height,
                half_width: width.div_ceil(2),
                half_height: height.div_ceil(2),
                residual_weight: 1.0 - (amount / 100.0).clamp(0.0, 1.0),
                despeckle_strength: (amount / DESPECKLE_FULL_AMOUNT).clamp(0.0, 1.0),
                despeckle_margin: DESPECKLE_MARGIN,
                _pad: 0,
            },
        }
    }

    pub(super) fn box_down(
        &self,
        ctx: &GpuContext,
        encoder: &mut wgpu::CommandEncoder,
        plane: &Plane,
    ) -> Plane {
        let HalfParams {
            half_width,
            half_height,
            ..
        } = self.params;
        let half = alloc_plane(ctx, half_width, half_height, "nr-half");
        encode_simple(
            ctx,
            encoder,
            ctx.nr_box_down_pipeline(),
            bytemuck::bytes_of(&self.params),
            &[plane.as_ref(), &half],
            half_width * half_height,
            "nr-box-down",
        );
        half
    }

    pub(super) fn upsample_residual(
        &self,
        ctx: &GpuContext,
        encoder: &mut wgpu::CommandEncoder,
        native: &Plane,
        noisy: &Plane,
        denoised: &Plane,
    ) -> Plane {
        let (width, height) = (self.params.width, self.params.height);
        let output = alloc_plane(ctx, width, height, "nr-upsampled");
        encode_simple(
            ctx,
            encoder,
            ctx.nr_upsample_residual_pipeline(),
            bytemuck::bytes_of(&self.params),
            &[native.as_ref(), noisy.as_ref(), denoised.as_ref(), &output],
            width * height,
            "nr-upsample-residual",
        );
        output
    }
}
