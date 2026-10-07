//! #3875: sampling support parity, independent of pending binding plumbing.
use super::*;
use crate::{chain::ChainRunner, image::GpuImage};
use raw_core::{
    cancel::CancelToken,
    image::{ColorSpace, Image},
    stages::noise_reduction,
};

#[test]
fn sampled_chroma_matches_cpu_and_keeps_native_behavior() {
    let ctx = GpuContext::new_blocking().expect("GPU required");
    let (w, h) = (48, 48);
    let input = super::tests::modest_image(w, h);
    let uploaded = GpuImage::upload(&ctx, &input, w as u32, h as u32);
    let runner = ChainRunner::new(&ctx, &uploaded);
    for profile in [vec![], vec![0.00008, 0.00000003]] {
        let noise = (!profile.is_empty()).then_some(profile.as_slice());
        let mut native = Image::new(w as u32, h as u32, ColorSpace::SceneLinearRec2020);
        native.pixels = input.chunks_exact(4).map(|p| [p[0], p[1], p[2]]).collect();
        let source = native.clone();
        noise_reduction::apply_color(&mut native, 75.0, noise, 200);
        for scale in [1.0, 0.5, 0.25, 0.0, -1.0, f32::NAN, f32::INFINITY, 2.0] {
            let mut cpu = source.clone();
            noise_reduction::apply_color_sampled_cancellable(
                &mut cpu,
                75.0,
                CancelToken::never(),
                noise,
                200,
                scale,
            );
            if !scale.is_finite() || scale <= 0.0 || scale >= 1.0 {
                assert_eq!(cpu.pixels, native.pixels, "native identity scale={scale}");
            } else {
                let delta = cpu
                    .pixels
                    .iter()
                    .zip(&native.pixels)
                    .flat_map(|(a, b)| (0..3).map(move |c| (a[c] - b[c]).abs()))
                    .fold(0.0_f32, f32::max);
                assert!(delta > 1e-5, "scale did not change search support: {scale}");
            }
            let gpu = runner.run_blocking(&[&NlmColorPass {
                nr_color: 75.0,
                sampling_scale: scale,
                noise_profile: profile.as_slice().into(),
                iso: 200,
            }]);
            let max_error = cpu
                .pixels
                .iter()
                .zip(gpu.chunks_exact(4))
                .flat_map(|(a, b)| (0..3).map(move |c| (a[c] - b[c]).abs()))
                .fold(0.0_f32, f32::max);
            assert!(max_error < 1e-4, "scale={scale}: error={max_error}");
        }
    }
}
