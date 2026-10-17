//! Ordered clone/heal stage for the pre-DCP resident migration (#4629).
//! All spots share one frame copy and bounded patch scratch. Shipping hosts
//! remain on their existing prefix until the complete migration lands.

use crate::{
    chain::Pass,
    context::GpuContext,
    context_pipelines_helpers::compile_source_entry,
    spatial::{alloc_rgba, encode_simple, pool_data_storage},
};
use std::cell::OnceCell;

pub struct GpuRetouchSpot {
    pub center: [i32; 2],
    pub source: [i32; 2],
    pub offset: [i32; 2],
    pub size: [u32; 2],
    pub radius: f32,
    pub feather: f32,
    pub opacity: f32,
    /// CPU-prepared normalized Gaussian weights; absent for Clone.
    pub heal_kernel: Option<Vec<f32>>,
}

pub struct RetouchPass<'a> {
    pub spots: &'a [GpuRetouchSpot],
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Params {
    frame: [u32; 2],
    patch_size: [u32; 2],
    center: [i32; 2],
    source: [i32; 2],
    offset: [i32; 2],
    kernel_len: u32,
    pad: u32,
    radius: f32,
    feather: f32,
    opacity: f32,
    pad_float: f32,
}

#[derive(Default)]
pub(crate) struct Pipelines {
    entries: [OnceCell<wgpu::ComputePipeline>; 5],
}

impl Pipelines {
    fn get(&self, ctx: &GpuContext, index: usize) -> &wgpu::ComputePipeline {
        self.entries[index].get_or_init(|| {
            let (body, entry) = match index {
                0 => (include_str!("retouch/patch.wgsl"), "gather"),
                1 => (include_str!("retouch/patch.wgsl"), "composite"),
                2 => (include_str!("retouch/blur.wgsl"), "horizontal"),
                3 => (include_str!("retouch/blur.wgsl"), "vertical"),
                4 => (include_str!("retouch/heal.wgsl"), "replacement"),
                _ => unreachable!(),
            };
            let source = format!("{}\n{}", include_str!("retouch/common.wgsl"), body);
            compile_source_entry(&ctx.device, entry, &source, entry)
        })
    }
}

impl GpuRetouchSpot {
    fn validate(&self, dims: (u32, u32)) {
        assert!(self.size.into_iter().all(|v| v > 0));
        assert!(self.radius.is_finite() && self.radius >= 0.5);
        assert!(self.feather.is_finite() && (0.0..=1.0).contains(&self.feather));
        assert!(self.opacity.is_finite() && (0.0..=1.0).contains(&self.opacity));
        for center in [self.center, self.source] {
            for axis in 0..2 {
                let start = center[axis] as i64 + self.offset[axis] as i64;
                let end = start + self.size[axis] as i64;
                assert!(
                    start >= 0 && end <= [dims.0, dims.1][axis] as i64,
                    "retouch patch outside frame"
                );
            }
        }
        if let Some(kernel) = &self.heal_kernel {
            assert!(
                !kernel.is_empty() && kernel.len() % 2 == 1,
                "invalid retouch kernel"
            );
        }
    }

    fn params(&self, dims: (u32, u32)) -> Params {
        Params {
            frame: [dims.0, dims.1],
            patch_size: self.size,
            center: self.center,
            source: self.source,
            offset: self.offset,
            kernel_len: self.heal_kernel.as_ref().map_or(0, |k| k.len() as u32),
            pad: 0,
            radius: self.radius,
            feather: self.feather,
            opacity: self.opacity,
            pad_float: 0.0,
        }
    }
}

impl Pass for RetouchPass<'_> {
    fn encode(
        &self,
        ctx: &GpuContext,
        encoder: &mut wgpu::CommandEncoder,
        src: &wgpu::Buffer,
        dst: &wgpu::Buffer,
        dims: (u32, u32),
    ) {
        for spot in self.spots {
            spot.validate(dims);
        }
        encoder.copy_buffer_to_buffer(src, 0, dst, 0, dims.0 as u64 * dims.1 as u64 * 16);
        let Some(count) = self.spots.iter().map(|s| s.size[0] * s.size[1]).max() else {
            return;
        };
        let source_patch = alloc_rgba(ctx, count, 1, "retouch-source-patch");
        let destination_patch = alloc_rgba(ctx, count, 1, "retouch-destination-patch");
        let heal_buffers = self.spots.iter().any(|s| s.heal_kernel.is_some()).then(|| {
            (
                alloc_rgba(ctx, count, 1, "retouch-horizontal"),
                alloc_rgba(ctx, count, 1, "retouch-source-low"),
                alloc_rgba(ctx, count, 1, "retouch-destination-low"),
            )
        });
        for spot in self.spots {
            let params = spot.params(dims);
            let count = spot.size[0] * spot.size[1];
            encode_simple(
                ctx,
                encoder,
                ctx.retouch_pipelines.get(ctx, 0),
                bytemuck::bytes_of(&params),
                &[dst, &source_patch, &destination_patch],
                count,
                "retouch-gather",
            );
            let replacement = if let Some(weights) = &spot.heal_kernel {
                let (scratch, source_low, destination_low) = heal_buffers.as_ref().unwrap();
                let kernel =
                    pool_data_storage(ctx, bytemuck::cast_slice(weights), "retouch-kernel");
                for (input, output) in [
                    (&source_patch, source_low),
                    (&destination_patch, destination_low),
                ] {
                    encode_simple(
                        ctx,
                        encoder,
                        ctx.retouch_pipelines.get(ctx, 2),
                        bytemuck::bytes_of(&params),
                        &[input, scratch, &kernel],
                        count,
                        "retouch-horizontal",
                    );
                    encode_simple(
                        ctx,
                        encoder,
                        ctx.retouch_pipelines.get(ctx, 3),
                        bytemuck::bytes_of(&params),
                        &[scratch, output, &kernel],
                        count,
                        "retouch-vertical",
                    );
                }
                encode_simple(
                    ctx,
                    encoder,
                    ctx.retouch_pipelines.get(ctx, 4),
                    bytemuck::bytes_of(&params),
                    &[&source_patch, destination_low, source_low],
                    count,
                    "retouch-replacement",
                );
                source_low
            } else {
                &source_patch
            };
            encode_simple(
                ctx,
                encoder,
                ctx.retouch_pipelines.get(ctx, 1),
                bytemuck::bytes_of(&params),
                &[replacement, dst, &destination_patch],
                count,
                "retouch-composite",
            );
        }
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
#[path = "retouch/tests.rs"]
mod tests;
