//! The creative half of the capture-first live chain (#5376), replacing the
//! white-balance pass for a host whose uploaded buffer is a capture result.
//!
//! The capture result is in the fixed as-shot Rec.2020 basis, signed and
//! untouched by the user's white balance. One tick maps it through, in order:
//!
//! 1. [`CreativeDcpPass`]: `T_to_pro` (target camera matrix · white balance
//!    gain · inverse basis), the target HueSatMap and the LookTable in linear
//!    ProPhoto D50, then ProPhoto → Rec.2020 and the soft floor;
//! 2. [`PostDcpHighlightPass`](crate::PostDcpHighlightPass) when the model
//!    opted into Oklab recovery, at the pre-exposure ceiling;
//! 3. [`CreativeGainPass`]: the exposure gain, folded with the post-DCP white
//!    balance of the uncalibrated tiers. Applied last, so the table lookups
//!    and the clip test never see it.
//!
//! The 3×3 matrices and table weights are derived per tick on the CPU
//! (`raw_core::pipeline::CreativeStage::gpu_plan`) and arrive here as data;
//! the tables are borrowed from the profile and pooled by content, so a
//! warm tick uploads nothing.

use crate::chain::Pass;
use crate::context::GpuContext;
use crate::spatial::{encode_simple, pool_data_storage};
use crate::white_balance::WhiteBalancePass;

/// One HueSatMap or LookTable inside [`CreativeInputs::tables`], laid out as
/// `HsmTable::data`. A blended HueSatMap names both endpoint tables and the
/// warm one's weight.
#[derive(Clone, Copy, Debug)]
pub struct CreativeTable {
    /// `[hue_divs, sat_divs, val_divs]`.
    pub dims: [u32; 3],
    /// The value axis is indexed sRGB-encoded.
    pub srgb: bool,
    /// Float offsets into the shared table buffer.
    pub cold_offset: usize,
    pub warm_offset: Option<usize>,
    pub warm_weight: f32,
}

/// The per-tick inputs of the creative stage.
#[derive(Clone, Copy, Debug)]
pub struct CreativeInputs<'a> {
    pub to_pro: [[f32; 3]; 3],
    pub from_pro: [[f32; 3]; 3],
    /// Every table of the profile, one buffer, uploaded once per profile.
    pub tables: &'a [f32],
    pub hsm: Option<CreativeTable>,
    pub look: Option<CreativeTable>,
    pub highlight_recovery: bool,
    /// Exposure gain times the post-DCP white balance.
    pub post: [[f32; 3]; 3],
}

impl CreativeInputs<'_> {
    pub(crate) fn gain_is_identity(&self) -> bool {
        self.post == [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]
    }
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Params {
    to_pro: [[f32; 4]; 3],
    from_pro: [[f32; 4]; 3],
    count: u32,
    hsm_mode: u32,
    look_mode: u32,
    hsm_weight: f32,
    hsm_dims: [u32; 3],
    hsm_srgb: u32,
    hsm_blend: u32,
    look_dims: [u32; 3],
    look_srgb: u32,
    hsm_cold_offset: u32,
    hsm_warm_offset: u32,
    look_offset: u32,
}

const _: () = assert!(
    std::mem::size_of::<Params>() == 160,
    "Params must match creative_dcp.wgsl's Params"
);

fn rows(m: &[[f32; 3]; 3]) -> [[f32; 4]; 3] {
    m.map(|r| [r[0], r[1], r[2], 0.0])
}

fn multiply(a: &[[f32; 3]; 3], b: &[[f32; 3]; 3]) -> [[f32; 3]; 3] {
    std::array::from_fn(|i| {
        std::array::from_fn(|j| a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j])
    })
}

/// A storage binding must exist even for an absent table; it is never read.
const ABSENT_TABLE: [f32; 4] = [0.0; 4];

pub struct CreativeDcpPass<'a> {
    pub inputs: &'a CreativeInputs<'a>,
}

impl Pass for CreativeDcpPass<'_> {
    fn encode(
        &self,
        ctx: &GpuContext,
        encoder: &mut wgpu::CommandEncoder,
        src: &wgpu::Buffer,
        dst: &wgpu::Buffer,
        (width, height): (u32, u32),
    ) {
        let CreativeInputs {
            to_pro,
            from_pro,
            tables,
            hsm,
            look,
            ..
        } = self.inputs;
        let tabled = hsm.is_some() || look.is_some();
        let pixel_count = width * height;
        let params = Params {
            to_pro: rows(&if tabled {
                *to_pro
            } else {
                multiply(from_pro, to_pro)
            }),
            from_pro: rows(from_pro),
            count: pixel_count,
            hsm_mode: hsm.is_some() as u32,
            look_mode: look.is_some() as u32,
            hsm_weight: hsm.map_or(0.0, |t| t.warm_weight),
            hsm_dims: hsm.map_or([1; 3], |t| t.dims),
            hsm_srgb: hsm.is_some_and(|t| t.srgb) as u32,
            hsm_blend: hsm.is_some_and(|t| t.warm_offset.is_some()) as u32,
            look_dims: look.map_or([1; 3], |t| t.dims),
            look_srgb: look.is_some_and(|t| t.srgb) as u32,
            hsm_cold_offset: hsm.map_or(0, |t| t.cold_offset as u32),
            hsm_warm_offset: hsm.and_then(|t| t.warm_offset).unwrap_or(0) as u32,
            look_offset: look.map_or(0, |t| t.cold_offset as u32),
        };
        let floats = if tables.is_empty() {
            &ABSENT_TABLE[..]
        } else {
            tables
        };
        let wire = pool_data_storage(ctx, bytemuck::cast_slice(floats), "creative-tables");
        let pipeline = ctx.creative_dcp_pipeline.get_or_init(|| {
            crate::context_pipelines_helpers::compile_standalone(
                &ctx.device,
                "creative-dcp",
                include_str!("creative_dcp.wgsl"),
            )
        });
        encode_simple(
            ctx,
            encoder,
            pipeline,
            bytemuck::bytes_of(&params),
            &[src, dst, wire.as_ref()],
            pixel_count,
            "creative-dcp",
        );
    }
}

/// The exposure gain and post-DCP white balance as one pointwise 3×3.
pub struct CreativeGainPass {
    pub matrix: [[f32; 3]; 3],
}

impl Pass for CreativeGainPass {
    fn encode(
        &self,
        ctx: &GpuContext,
        encoder: &mut wgpu::CommandEncoder,
        src: &wgpu::Buffer,
        dst: &wgpu::Buffer,
        dims: (u32, u32),
    ) {
        WhiteBalancePass {
            matrix: self.matrix,
            hsm: None,
        }
        .encode(ctx, encoder, src, dst, dims);
    }
}
