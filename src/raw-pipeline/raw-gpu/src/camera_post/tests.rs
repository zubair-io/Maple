use super::*;
use crate::{ChainRunner, GpuImage};
use raw_core::{
    image::{ColorSpace, Image},
    types::adjustment::HighlightRecoveryMode,
};

fn input(width: u32, height: u32) -> Vec<f32> {
    (0..width * height)
        .flat_map(|i| {
            let value = |offset| (((i * 67 + offset) % 101) as f32 / 100.).powi(3) * 8. - 0.03;
            [value(13), value(37), value(89), (i % 5) as f32 / 4.]
        })
        .collect()
}

fn reference(input: &[f32], width: u32, height: u32, recovery: bool, strength: f32) -> Vec<f32> {
    let mut image = Image::new(width, height, ColorSpace::SceneLinearRec2020);
    for (p, rgba) in image.pixels.iter_mut().zip(input.chunks_exact(4)) {
        *p = [rgba[0], rgba[1], rgba[2]];
    }
    if recovery {
        raw_core::stages::highlight_recovery_oklab::apply_post_dcp(
            &mut image,
            HighlightRecoveryMode::OklabChromaReduction,
        );
    }
    raw_core::stages::chroma_prefilter::apply(&mut image, strength);
    image
        .pixels
        .iter()
        .zip(input.chunks_exact(4))
        .flat_map(|(p, rgba)| [p[0], p[1], p[2], rgba[3]])
        .collect()
}

fn assert_parity(actual: &[f32], expected: &[f32]) {
    assert_eq!(actual.len(), expected.len());
    let mut maximum = 0_f32;
    for (i, (a, e)) in actual.iter().zip(expected).enumerate() {
        let error = (a - e).abs();
        assert!(
            error < 1e-4,
            "channel {i}: actual {a}, expected {e}, error {error:e}"
        );
        if i % 4 == 3 {
            assert_eq!(a.to_bits(), e.to_bits());
        }
        maximum = maximum.max(error);
    }
    eprintln!("Post-camera maximum error {maximum:e}");
}

#[test]
fn both_stages_match_actual_cpu_across_borders_hdr_and_strengths() {
    let ctx = GpuContext::new_blocking().expect("required GPU adapter");
    for (width, height) in [(1, 1), (1, 9), (9, 1), (5, 7), (17, 19)] {
        let input = input(width, height);
        let image = GpuImage::upload(&ctx, &input, width, height);
        let runner = ChainRunner::new(&ctx, &image);
        for strength in [-10., 0., 0.0009, 0.001, 1., 25., 100., 150.] {
            let chroma = ChromaPrefilterPass { strength };
            for recovery in [false, true] {
                let actual = if recovery {
                    runner.run_blocking(&[&OklabHighlightRecoveryPass, &chroma])
                } else {
                    runner.run_blocking(&[&chroma])
                };
                assert_parity(
                    &actual,
                    &reference(&input, width, height, recovery, strength),
                );
                assert_eq!(runner.last_readback_count(), 1);
                if !recovery && strength < 1e-3 {
                    assert_eq!(actual, input);
                }
            }
        }
    }
}

#[test]
fn unclipped_recovery_and_uniform_chroma_are_exact_identities() {
    let ctx = GpuContext::new_blocking().expect("required GPU adapter");
    for rgb in [
        [0., 0., 0.],
        [0.18; 3],
        [0.8, 0.2, -0.01],
        [1.005, 0.3, 0.1],
        [4., 3., 2.],
    ] {
        let input: Vec<_> = (0..35)
            .flat_map(|i| [rgb[0], rgb[1], rgb[2], (i % 4) as f32 / 3.])
            .collect();
        let image = GpuImage::upload(&ctx, &input, 7, 5);
        let runner = ChainRunner::new(&ctx, &image);
        for strength in [0.001, 25., 100.] {
            assert_eq!(
                runner.run_blocking(&[&ChromaPrefilterPass { strength }]),
                input
            );
        }
        if rgb.into_iter().fold(f32::NEG_INFINITY, f32::max) <= 1.005 {
            assert_eq!(runner.run_blocking(&[&OklabHighlightRecoveryPass]), input);
        }
    }
}

#[test]
fn warmed_stage_sequence_reuses_resources_when_strength_changes() {
    let ctx = GpuContext::new_blocking().expect("required GPU adapter");
    let input = input(17, 19);
    let image = GpuImage::upload(&ctx, &input, 17, 19);
    let runner = ChainRunner::new(&ctx, &image);
    let mut allocations = None;
    for strength in [25., 100., 1., 0., 25.] {
        ctx.frame_pool.borrow_mut().begin_frame(4629);
        let actual = runner.run_blocking(&[
            &OklabHighlightRecoveryPass,
            &ChromaPrefilterPass { strength },
        ]);
        ctx.frame_pool.borrow_mut().end_frame();
        assert_parity(&actual, &reference(&input, 17, 19, true, strength));
        let count = ctx.frame_pool.borrow().alloc_count();
        assert!(count > 0);
        assert_eq!(*allocations.get_or_insert(count), count);
    }
}
