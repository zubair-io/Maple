//! GPU twin of the optional post-DCP Oklab recovery stage (#5217).
use crate::{chain::Pass, context::GpuContext};

#[path = "../../raw-core/src/stages/highlight_recovery_oklab_params.rs"]
mod parameters;

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Params {
    count: u32,
    ceiling: f32,
    iterations: u32,
    pad: u32,
}

/// Run only for the OklabChromaReduction mode, after the DCP and before the
/// auto-exposure gain (#5213 amendment 1), at the pre-AE clip ceiling.
pub struct PostDcpHighlightPass;

impl Pass for PostDcpHighlightPass {
    fn encode(
        &self,
        ctx: &GpuContext,
        encoder: &mut wgpu::CommandEncoder,
        src: &wgpu::Buffer,
        dst: &wgpu::Buffer,
        (width, height): (u32, u32),
    ) {
        let pipeline = ctx.post_dcp_highlight_pipeline.get_or_init(|| {
            crate::context_pipelines_helpers::compile_with_matrices(
                &ctx.device,
                "post-dcp-highlight",
                include_str!("highlight_recovery.wgsl"),
            )
        });
        let params = Params {
            count: width * height,
            ceiling: 1.0 + parameters::CEILING_EPSILON,
            iterations: parameters::BISECTION_ITERS,
            pad: 0,
        };
        crate::spatial::encode_simple(
            ctx,
            encoder,
            pipeline,
            bytemuck::bytes_of(&params),
            &[src, dst],
            width * height,
            "post-dcp-highlight",
        );
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;
    use crate::{chain::ChainRunner, image::GpuImage};
    use raw_core::{
        image::{ColorSpace, Image},
        xmp::HighlightRecoveryMode,
    };

    #[test]
    fn post_dcp_recovery_matches_cpu_hdr_signed_edges_and_alpha() {
        let ctx = GpuContext::new_blocking().expect("GPU parity requires an adapter");
        let input: Vec<f32> = (0..257u32)
            .flat_map(|i| {
                let r = (i % 17) as f32 * 0.23 - 0.2;
                let g = ((i * 31) % 23) as f32 * 0.17;
                let b = ((i * 13) % 29) as f32 * 0.11;
                [r, g, b, (i % 7) as f32 / 7.0]
            })
            .collect();
        let mut cpu = Image::new(257, 1, ColorSpace::SceneLinearRec2020);
        for (p, q) in cpu.pixels.iter_mut().zip(input.chunks_exact(4)) {
            *p = [q[0], q[1], q[2]];
        }
        raw_core::stages::highlight_recovery_oklab::apply_post_dcp(
            &mut cpu,
            HighlightRecoveryMode::OklabChromaReduction,
        );
        let image = GpuImage::upload(&ctx, &input, 257, 1);
        let gpu = ChainRunner::new(&ctx, &image).run_blocking(&[&PostDcpHighlightPass]);
        let mut moved = 0.0_f32;
        for (i, (p, q)) in cpu.pixels.iter().zip(gpu.chunks_exact(4)).enumerate() {
            for c in 0..3 {
                assert!(
                    (p[c] - q[c]).abs() / p[c].abs().max(1.0) < 1e-4,
                    "pixel {i} lane {c}: {} != {}",
                    p[c],
                    q[c]
                );
                moved = moved.max((p[c] - input[i * 4 + c]).abs());
            }
            assert_eq!(q[3], input[i * 4 + 3]);
            if input[i * 4..i * 4 + 3]
                .iter()
                .all(|v| *v <= 1.0 + parameters::CEILING_EPSILON)
            {
                assert_eq!(q, &input[i * 4..i * 4 + 4]);
            }
        }
        assert!(moved > 0.01);
    }
}
