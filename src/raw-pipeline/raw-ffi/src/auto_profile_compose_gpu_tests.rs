use super::*;
use raw_gpu::{ChainRunner, GpuContext, GpuImage, ResidualLutPass};
use std::ptr;

#[test]
fn residual_only_composition_matches_isolated_gpu_residual_kernel() {
    // This pins composition against ResidualLutPass, not the production chain.
    // Absence propagation through the live/full chain is covered by #4216.
    let context = GpuContext::new_blocking().expect("GPU context");
    let grid = ColorLut::identity(9).data;
    let input: Vec<f32> = grid
        .chunks_exact(3)
        .flat_map(|rgb| [rgb[0], rgb[1], rgb[2], 1.0])
        .collect();
    let image = GpuImage::upload(&context, &input, (grid.len() / 3) as u32, 1);
    let runner = ChainRunner::new(&context, &image);
    for residual in [ColorLut::identity(5), super::tests::artifacts().1] {
        let mut composed = vec![-7.; grid.len()];
        assert_eq!(
            unsafe {
                maple_compose_auto_profile_lut(
                    ptr::null(),
                    0,
                    residual.data.as_ptr(),
                    residual.data.len(),
                    residual.size as u32,
                    9,
                    composed.as_mut_ptr(),
                    composed.len(),
                )
            },
            0
        );
        let gpu = runner.run_blocking(&[&ResidualLutPass {
            size: residual.size,
            data: residual.data.as_slice().into(),
        }]);
        assert_eq!(gpu.len(), input.len());
        assert!(gpu.iter().chain(&composed).all(|value| value.is_finite()));
        let maximum = composed
            .chunks_exact(3)
            .zip(gpu.chunks_exact(4))
            .flat_map(|(cpu, gpu)| cpu.iter().zip(&gpu[..3]))
            .map(|(cpu, gpu)| (cpu - gpu).abs())
            .fold(0_f32, f32::max);
        assert!(maximum < 1e-4, "residual-only GPU delta {maximum}");
    }
}
