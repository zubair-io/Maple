//! GPU parity for the half-res chroma despeckle clamp (#6018): images whose
//! specks sit far outside their neighbourhood's range, at amounts on the
//! ramp, at the default and past it, so the clamp provably fires.
use super::tests::{color_pass, max_diff_at};
use super::*;
use crate::{chain::ChainRunner, image::GpuImage};
use raw_core::{
    image::{ColorSpace, Image},
    stages::noise_reduction,
};

const SPECKS: [(usize, usize); 3] = [(23, 17), (30, 26), (8, 33)];

fn speckled(w: usize, h: usize, speck: [f32; 3]) -> Vec<f32> {
    (0..w * h)
        .flat_map(|i| {
            let p = if SPECKS.contains(&(i % w, i / w)) {
                speck
            } else {
                [0.18, 0.17, 0.19]
            };
            [p[0], p[1], p[2], 1.0]
        })
        .collect()
}

fn cpu(input: &[f32], w: usize, h: usize, despeckle: bool, amount: f32) -> Vec<f32> {
    let mut img = Image::new(w as u32, h as u32, ColorSpace::SceneLinearRec2020);
    img.pixels = input.chunks_exact(4).map(|p| [p[0], p[1], p[2]]).collect();
    if despeckle {
        noise_reduction::apply_color(&mut img, amount, None, 100);
    } else {
        noise_reduction::apply_color_without_despeckle(&mut img, amount, None, 100);
    }
    img.pixels
        .iter()
        .flat_map(|p| [p[0], p[1], p[2], 1.0])
        .collect()
}

fn gpu(ctx: &GpuContext, input: &[f32], w: usize, h: usize, amount: f32) -> Vec<f32> {
    let img = GpuImage::upload(ctx, input, w as u32, h as u32);
    ChainRunner::new(ctx, &img).run_blocking(&[&color_pass(amount)])
}

#[test]
fn gpu_despeckles_a_hot_pixel_like_the_cpu_across_the_ramp() {
    let ctx = GpuContext::new_blocking().expect("GPU required");
    let (w, h) = (48usize, 40usize);
    let input = speckled(w, h, [0.05, 0.004, 0.07]);
    for amount in [10.0_f32, 25.0, 50.0] {
        let reference = cpu(&input, w, h, true, amount);
        let (moved, _) = max_diff_at(&reference, &cpu(&input, w, h, false, amount));
        assert!(
            moved > 1e-2,
            "amount={amount}: the clamp moved the specks by only {moved:e}"
        );
        let (error, at) = max_diff_at(&reference, &gpu(&ctx, &input, w, h, amount));
        assert!(
            error < 1e-4,
            "amount={amount}: GPU vs CPU {error:e} at pixel {}",
            at / 4
        );
    }
}

/// A NaN or infinite pixel must not trip the clamp on either side. The GPU
/// filter's running sums carry a non-finite sample further than the CPU's
/// (about 2× the poisoned area, with or without the clamp), so the gate
/// checks what both can promise: every pixel the CPU leaves non-finite is
/// non-finite on the GPU too (an inverted clamp range would instead write a
/// huge finite value), and wherever both are finite they agree.
#[test]
fn gpu_leaves_a_non_finite_neighbourhood_like_the_cpu() {
    let ctx = GpuContext::new_blocking().expect("GPU required");
    let (w, h) = (40usize, 40usize);
    for bad in [f32::NAN, f32::INFINITY] {
        let input = speckled(w, h, [bad, 0.17, 0.19]);
        let reference = cpu(&input, w, h, true, 25.0);
        let out = gpu(&ctx, &input, w, h, 25.0);
        let mut both_finite = 0usize;
        for (i, (c, g)) in reference.iter().zip(&out).enumerate() {
            match (c.is_finite(), g.is_finite()) {
                (true, true) => {
                    both_finite += 1;
                    assert!((c - g).abs() < 1e-4, "{bad}: index {i}: {c} vs {g}");
                }
                (false, true) => panic!("{bad}: index {i}: CPU non-finite, GPU wrote {g}"),
                _ => {}
            }
        }
        assert!(
            both_finite > reference.len() / 2,
            "{bad}: too little left to compare"
        );
    }
}
