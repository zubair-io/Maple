//! Camera-native WB → DCP colorimetry in one GPU dispatch (#4629).
//!
//! This complete stage is a prerequisite for replacing the post-DCP live
//! upload boundary. The live callers still need the camera prefix, AE and
//! upstream spatial operations moved together; this pass is not yet enabled
//! in those callers. Derivation of gains and matrices remains in raw-core.

use crate::chain::Pass;
use crate::context::GpuContext;
use crate::spatial::{encode_simple, pool_data_storage};
use crate::HueSatMapPass;

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Params {
    dims: [u32; 3],
    count: u32,
    srgb: u32,
    has_hsm: u32,
    _pad: [u32; 2],
    gain: [f32; 4],
    entry: [[f32; 4]; 3],
    exit: [[f32; 4]; 3],
}

/// Input is camera-native RGBA after as-shot pre-gain and highlight recovery.
/// Output is scene-linear Rec.2020 D65, with the CPU's uniform negative-channel
/// lift and unbounded highlights. Alpha is retained exactly.
pub struct DcpColorimetryPass<'a> {
    /// User WB gain in camera space, applied before either matrix or table.
    pub camera_gain: [f32; 3],
    /// Row-major camera→ProPhoto matrix when HSM exists; otherwise the already
    /// folded camera→Rec.2020 matrix. Folding matches the CPU fast path.
    pub entry: [[f32; 3]; 3],
    /// Row-major ProPhoto→Rec.2020 matrix; unused when HSM is absent.
    pub exit: [[f32; 3]; 3],
    /// Borrow the resident, as-shot-interpolated calibration table.
    pub hsm: Option<HueSatMapPass<'a>>,
}

impl Pass for DcpColorimetryPass<'_> {
    fn encode(
        &self,
        ctx: &GpuContext,
        encoder: &mut wgpu::CommandEncoder,
        src: &wgpu::Buffer,
        dst: &wgpu::Buffer,
        dims: (u32, u32),
    ) {
        let (table_dims, srgb, data) = match &self.hsm {
            Some(table) => {
                table.validate();
                (table.dims, u32::from(table.srgb), table.data)
            }
            // A valid storage binding is required even on the no-table branch.
            // The shader never samples this entry when has_hsm is false.
            None => ([1, 1, 1], 0, &[0.0, 1.0, 1.0][..]),
        };
        let count = dims.0 * dims.1;
        let rows = |matrix: [[f32; 3]; 3]| matrix.map(|r| [r[0], r[1], r[2], 0.0]);
        let params = Params {
            dims: table_dims,
            count,
            srgb,
            has_hsm: u32::from(self.hsm.is_some()),
            _pad: [0; 2],
            gain: [
                self.camera_gain[0],
                self.camera_gain[1],
                self.camera_gain[2],
                0.0,
            ],
            entry: rows(self.entry),
            exit: rows(self.exit),
        };
        let table = pool_data_storage(ctx, bytemuck::cast_slice(data), "dcp-hsm-data");
        encode_simple(
            ctx,
            encoder,
            ctx.dcp_colorimetry_pipeline(),
            bytemuck::bytes_of(&params),
            &[src, dst, table.as_ref()],
            count,
            "dcp-colorimetry",
        );
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
#[path = "dcp_colorimetry/tests.rs"]
mod tests;
