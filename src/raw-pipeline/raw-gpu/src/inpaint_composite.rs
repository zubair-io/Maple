//! WGSL accepted-patch compositor (#3935, epic #1472). Hosts compose when
//! source/stack changes and retain the base for live grading. Pure GPU math.
use crate::spatial::{encode_simple, pool_data_storage};
use crate::{GpuContext, Pass};

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Params {
    window: [f32; 4],
    region: [f32; 4],
    image_size: [u32; 2],
    patch_size: [u32; 2],
}

pub struct InpaintCompositePass {
    width: u32,
    height: u32,
    region: [f32; 4],
    window: [f32; 4],
    pixels: Vec<[f32; 4]>,
}

impl InpaintCompositePass {
    /// Scene-linear RGB+coverage validated once before immutable GPU publication.
    pub fn new(
        width: u32,
        height: u32,
        region: [f32; 4],
        window: [f32; 4],
        pixels: Vec<[f32; 4]>,
    ) -> Result<Self, String> {
        let n = (width as usize)
            .checked_mul(height as usize)
            .ok_or_else(|| "GPU inpaint patch: dimension overflow".to_string())?;
        let valid = |r: [f32; 4]| {
            r.iter().all(|v| v.is_finite())
                && r[0] >= 0.0
                && r[1] >= 0.0
                && r[2] > 0.0
                && r[3] > 0.0
                && r[0] + r[2] <= 1.0
                && r[1] + r[3] <= 1.0
        };
        if width == 0
            || height == 0
            || pixels.len() != n
            || !valid(region)
            || !valid(window)
            || pixels
                .iter()
                .any(|p| p.iter().any(|v| !v.is_finite()) || !(0.0..=1.0).contains(&p[3]))
        {
            return Err("GPU inpaint patch: invalid geometry, RGB or coverage".into());
        }
        Ok(Self {
            width,
            height,
            region,
            window,
            pixels,
        })
    }
}

impl Pass for InpaintCompositePass {
    fn encode(
        &self,
        ctx: &GpuContext,
        encoder: &mut wgpu::CommandEncoder,
        src: &wgpu::Buffer,
        dst: &wgpu::Buffer,
        dims: (u32, u32),
    ) {
        let params = Params {
            window: self.window,
            region: self.region,
            image_size: [dims.0, dims.1],
            patch_size: [self.width, self.height],
        };
        let patch = pool_data_storage(ctx, bytemuck::cast_slice(&self.pixels), "inpaint-patch");
        encode_simple(
            ctx,
            encoder,
            ctx.inpaint_composite_pipeline(),
            bytemuck::bytes_of(&params),
            &[src, dst, patch.as_ref()],
            dims.0 * dims.1,
            "inpaint-composite",
        );
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
#[path = "inpaint_composite_tests.rs"]
mod tests;
