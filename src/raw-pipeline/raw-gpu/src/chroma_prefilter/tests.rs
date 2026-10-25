use super::*;
use crate::{chain::ChainRunner, image::GpuImage};
use raw_core::image::{ColorSpace, Image};

#[test]
fn chroma_prefilter_matches_cpu_edges_signed_hdr_and_alpha() {
    let ctx = GpuContext::new_blocking().expect("GPU parity requires an adapter");
    for (w, h) in [(1, 1), (2, 3), (19, 17), (65, 33)] {
        let input: Vec<f32> = (0..w * h)
            .flat_map(|i| {
                let y = (i / w) as f32 / h as f32;
                let n = ((i * 7919) % 97) as f32 / 97.0 - 0.5;
                [
                    y + 0.15 * n,
                    y - 0.08 * n,
                    y + 0.4 * n,
                    (i % 7) as f32 / 7.0,
                ]
            })
            .collect();
        for strength in [0.0, 0.0001, 5.0, 50.0, 100.0, 150.0] {
            let mut cpu = Image::new(w, h, ColorSpace::SceneLinearRec2020);
            for (p, q) in cpu.pixels.iter_mut().zip(input.chunks_exact(4)) {
                *p = [q[0], q[1], q[2]];
            }
            raw_core::stages::chroma_prefilter::apply(&mut cpu, strength);
            let image = GpuImage::upload(&ctx, &input, w, h);
            let runner = ChainRunner::new(&ctx, &image);
            let pass = ChromaPrefilterPass { strength };
            let gpu = runner.run_blocking(&[&pass]);
            let mut moved = 0.0_f32;
            for (i, (p, q)) in cpu.pixels.iter().zip(gpu.chunks_exact(4)).enumerate() {
                for c in 0..3 {
                    assert!(
                        (p[c] - q[c]).abs() < 2e-6,
                        "{w}x{h} s={strength} i={i} c={c}: {} != {}",
                        p[c],
                        q[c]
                    );
                    moved = moved.max((p[c] - input[i * 4 + c]).abs());
                }
                assert_eq!(q[3], input[i * 4 + 3]);
            }
            if strength >= 5.0 && w >= 19 {
                assert!(moved > 0.001);
            }
            if strength < 0.001 {
                assert_eq!(input, gpu);
            }
        }
    }
}

#[test]
fn chroma_prefilter_uniform_fields_are_exact_identity() {
    let ctx = GpuContext::new_blocking().expect("GPU parity requires an adapter");
    for p in [
        [0.18, 0.18, 0.18, 0.7],
        [-0.2, 0.4, 2.1, 1.0],
        [3.2, 1.3, 0.3, 0.0],
    ] {
        let input = p.repeat(17 * 13);
        let image = GpuImage::upload(&ctx, &input, 17, 13);
        let runner = ChainRunner::new(&ctx, &image);
        let gpu = runner.run_blocking(&[&ChromaPrefilterPass { strength: 100.0 }]);
        for (i, (a, b)) in input.iter().zip(&gpu).enumerate() {
            assert_eq!(a, b, "pixel {i} field {p:?}");
        }
    }
}

#[test]
fn chroma_prefilter_signed_luma_levels_stay_finite_and_match_cpu() {
    let ctx = GpuContext::new_blocking().expect("GPU parity requires an adapter");
    let (w, h) = (29, 23);
    let mut state = 0x2545_f491_u32;
    let signed: Vec<f32> = (0..w * h * 4)
        .map(|i| {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            if i % 4 == 3 {
                0.5
            } else {
                (state as f32 / u32::MAX as f32) * 3.4 - 0.4
            }
        })
        .collect();
    // Neighbours at luma exactly -PEDESTAL zeroed the unsigned range scale.
    let mut zero_level = [-PEDESTAL, -PEDESTAL, -PEDESTAL, 1.0].repeat((w * h) as usize);
    zero_level[5 * 4..5 * 4 + 3].copy_from_slice(&[0.2, -0.04, 0.1]);
    for input in [signed, zero_level] {
        let mut cpu = Image::new(w, h, ColorSpace::SceneLinearRec2020);
        for (p, q) in cpu.pixels.iter_mut().zip(input.chunks_exact(4)) {
            *p = [q[0], q[1], q[2]];
        }
        raw_core::stages::chroma_prefilter::apply(&mut cpu, 100.0);
        let image = GpuImage::upload(&ctx, &input, w, h);
        let gpu = ChainRunner::new(&ctx, &image)
            .run_blocking(&[&ChromaPrefilterPass { strength: 100.0 }]);
        for (p, q) in cpu.pixels.iter().zip(gpu.chunks_exact(4)) {
            for c in 0..3 {
                assert!(q[c].is_finite() && p[c].is_finite(), "{p:?} vs {q:?}");
                assert!(
                    (p[c] - q[c]).abs() <= 2e-6 * p[c].abs().max(1.0),
                    "{p:?} vs {q:?}"
                );
            }
        }
    }
}
