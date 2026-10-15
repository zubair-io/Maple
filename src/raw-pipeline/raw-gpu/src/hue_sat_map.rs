//! Camera-profile HueSatMap in ProPhoto-D50, matching raw-core's HSM stage.
//!
//! Prerequisite for the pre-DCP GPU white-balance repair in #4629. This pass
//! implements the complete existing trilinear HSM operation; the live chain
//! still needs its camera-RGB upload boundary, DCP matrices, and pre-AE stages
//! moved together before it can use this pass. A post-DCP matrix cannot undo
//! HSM or the DCP negative-channel lift.

use crate::chain::Pass;
use crate::context::GpuContext;
use crate::spatial::{encode_simple, pool_data_storage};

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Params {
    dims: [u32; 3],
    count: u32,
    srgb: u32,
    _pad: [u32; 3],
}

/// The already-interpolated DCP HueSatMap. Input and output are ProPhoto-D50
/// RGBA f32, including negative and HDR values; alpha passes through unchanged.
/// This is the trilinear colorimetry table, not the tetrahedral ProfileLookTable.
pub struct HueSatMapPass<'a> {
    /// Hue, saturation, value lattice dimensions; every dimension is nonzero.
    pub dims: [u32; 3],
    /// The table's encoding is sRGB rather than linear.
    pub srgb: bool,
    /// Hue delta (degrees), saturation scale, value scale at each node, in
    /// `((h * sat_divs + s) * val_divs + v) * 3` order. Borrowed from the
    /// resident profile; the frame pool uploads it only when contents change.
    pub data: &'a [f32],
}

impl HueSatMapPass<'_> {
    pub(crate) fn validate(&self) {
        assert!(self.dims.iter().all(|&n| n > 0), "empty HueSatMap axis");
        let expected = self.dims.iter().try_fold(3_u32, |n, &d| n.checked_mul(d));
        assert_eq!(
            expected.map(|n| n as usize),
            Some(self.data.len()),
            "invalid HueSatMap table length"
        );
    }
}

impl Pass for HueSatMapPass<'_> {
    fn encode(
        &self,
        ctx: &GpuContext,
        encoder: &mut wgpu::CommandEncoder,
        src: &wgpu::Buffer,
        dst: &wgpu::Buffer,
        dims: (u32, u32),
    ) {
        self.validate();
        let count = dims.0 * dims.1;
        let params = Params {
            dims: self.dims,
            count,
            srgb: u32::from(self.srgb),
            _pad: [0; 3],
        };
        let table = pool_data_storage(ctx, bytemuck::cast_slice(self.data), "hue-sat-map-data");
        encode_simple(
            ctx,
            encoder,
            ctx.hue_sat_map_pipeline(),
            bytemuck::bytes_of(&params),
            &[src, dst, table.as_ref()],
            count,
            "hue-sat-map",
        );
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
#[path = "hue_sat_map/tests.rs"]
mod tests;
