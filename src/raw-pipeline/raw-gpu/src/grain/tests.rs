//! Parity tests for the grain WGSL kernel (#1110).
//!
//! Split out of `grain.rs` (600-LOC budget; mirrors vignette's split).
//! Included via `#[path = "grain/tests.rs"] mod tests;`.

use super::*;
use crate::chain::ChainRunner;
use crate::image::GpuImage;

/// A 2-D DISPLAY-LINEAR test buffer ([0, 1] post-AgX domain) with varied
/// luminance so the w(Yd) weight spans its whole curve: deep blacks,
/// midtones (max weight), and near-white. Grain is position-dependent, so
/// the buffer carries real width × height.
fn display_buffer_16x12() -> (Vec<f32>, u32, u32) {
    let (w, h) = (16u32, 12u32);
    let mut v = Vec::with_capacity((w * h * 4) as usize);
    for y in 0..h {
        for x in 0..w {
            let i = y * w + x;
            let t = i as f32 / (w * h) as f32;
            let (r, g, b) = match i % 6 {
                0 => (0.01, 0.01, 0.01), // deep black (weight → 0)
                2 => (0.98, 0.97, 0.99), // near-white (weight → 0)
                4 => (0.62, 0.30, 0.18), // warm midtone
                _ => (0.1 + t * 0.8, 0.8 - t * 0.6, 0.3 + t * 0.4),
            };
            v.extend_from_slice(&[r, g, b, 1.0]);
        }
    }
    (v, w, h)
}

/// Run `raw_core::stages::grain::apply` on a flat interleaved RGBA f32
/// buffer (the ticket's actual reference — the Rust stage itself).
fn raw_core_grain(buf: &[f32], w: u32, h: u32, pass: &GrainPass) -> Vec<f32> {
    use raw_core::image::{ColorSpace, Image};
    let mut img = Image::new(w, h, ColorSpace::DisplayLinearRec2020);
    for (i, chunk) in buf.chunks_exact(4).enumerate() {
        img.pixels[i] = [chunk[0], chunk[1], chunk[2]];
    }
    raw_core::stages::grain::apply(&mut img, pass.amount, pass.size, pass.roughness);
    let mut out = Vec::with_capacity(buf.len());
    for (i, p) in img.pixels.iter().enumerate() {
        out.extend_from_slice(&[p[0], p[1], p[2], buf[i * 4 + 3]]);
    }
    out
}

/// THE PARITY GATE: the WGSL grain kernel matches
/// `raw_core::stages::grain::apply` within 1e-4 across amount/size/
/// roughness spreads — direct evidence the hash constants + the noise
/// float sequence are IDENTICAL on both sides (the determinism contract).
#[test]
fn wgsl_grain_matches_raw_core_stage_within_1e_4() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (input, w, h) = display_buffer_16x12();

    for pass in &[
        GrainPass {
            amount: 30.0,
            size: 0.0,
            roughness: 0.0,
        },
        GrainPass {
            amount: 70.0,
            size: 25.0,
            roughness: 50.0,
        },
        GrainPass {
            amount: 100.0,
            size: 100.0,
            roughness: 100.0,
        },
        GrainPass {
            amount: 50.0,
            size: 60.0,
            roughness: 0.0,
        },
    ] {
        let reference = raw_core_grain(&input, w, h, pass);

        let img = GpuImage::upload(&ctx, &input, w, h);
        let runner = ChainRunner::new(&ctx, &img);
        let gpu = runner.run_blocking(&[pass]);

        let max_diff = reference
            .iter()
            .zip(&gpu)
            .map(|(a, b)| (a - b).abs())
            .fold(0.0_f32, f32::max);
        eprintln!(
            "PARITY vs raw-core grain amount={} size={} rough={}: \
             max abs diff = {max_diff:e}",
            pass.amount, pass.size, pass.roughness
        );
        assert!(
            max_diff < 1e-4,
            "grain({}, {}, {}): GPU vs raw-core stage max abs diff \
             {max_diff} exceeds 1e-4",
            pass.amount,
            pass.size,
            pass.roughness
        );
    }
}

/// Pin the local CPU oracle to raw-core's stage (same float sequence ⇒
/// exact), so the transcribed constants can't drift.
#[test]
fn local_oracle_matches_raw_core_stage_exactly() {
    let (input, w, h) = display_buffer_16x12();
    for pass in &[
        GrainPass {
            amount: 70.0,
            size: 25.0,
            roughness: 50.0,
        },
        GrainPass {
            amount: 100.0,
            size: 0.0,
            roughness: 100.0,
        },
    ] {
        let reference = raw_core_grain(&input, w, h, pass);
        let mut local = input.clone();
        apply_grain(
            &mut local,
            w as usize,
            h as usize,
            GrainWindow {
                origin: (0, 0),
                full: (w, h),
            },
            pass,
        );
        let max_diff = reference
            .iter()
            .zip(&local)
            .map(|(a, b)| (a - b).abs())
            .fold(0.0_f32, f32::max);
        assert!(
            max_diff == 0.0,
            "grain({}, {}, {}): local oracle vs raw-core diff \
             {max_diff} != 0",
            pass.amount,
            pass.size,
            pass.roughness
        );
    }
}

/// Monochromaticity survives the GPU: a neutral pixel stays exactly
/// neutral (one noise value on all three channels).
#[test]
fn gpu_grain_is_monochromatic_on_neutral() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (w, h) = (8u32, 8u32);
    let mut input = vec![0.0f32; (w * h * 4) as usize];
    for px in input.chunks_exact_mut(4) {
        px.copy_from_slice(&[0.5, 0.5, 0.5, 1.0]);
    }
    let img = GpuImage::upload(&ctx, &input, w, h);
    let runner = ChainRunner::new(&ctx, &img);
    let gpu = runner.run_blocking(&[&GrainPass {
        amount: 100.0,
        size: 30.0,
        roughness: 50.0,
    }]);
    let mut moved = 0;
    for px in gpu.chunks_exact(4) {
        assert_eq!(px[0], px[1], "R != G — grain must be monochromatic");
        assert_eq!(px[1], px[2], "G != B — grain must be monochromatic");
        if px[0] != 0.5 {
            moved += 1;
        }
    }
    assert!(moved > 32, "grain at amount 100 must perturb most pixels ({moved}/64)");
}

/// Determinism on the GPU: two renders of the same input are bit-identical
/// (fixed seed, pure function — no RNG anywhere).
#[test]
fn gpu_grain_is_deterministic_across_runs() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (input, w, h) = display_buffer_16x12();
    let render = || {
        let img = GpuImage::upload(&ctx, &input, w, h);
        let runner = ChainRunner::new(&ctx, &img);
        runner.run_blocking(&[&GrainPass {
            amount: 70.0,
            size: 25.0,
            roughness: 50.0,
        }])
    };
    let a = render();
    let b = render();
    assert_eq!(a, b, "grain renders must be bit-identical across runs");
}
