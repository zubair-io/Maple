use super::*;
use crate::{ChainRunner, GpuImage};
use raw_core::image::{ColorSpace, Image};
use raw_core::types::InpaintPatch;

fn run(ctx: &GpuContext, w: u32, h: u32, window: [f32; 4], patches: &[InpaintPatch]) {
    let input: Vec<f32> = (0..w * h)
        .flat_map(|i| [-0.1 + i as f32 / 37.0, 2.0, 0.2, 0.7])
        .collect();
    let mut reference = Image::new(w, h, ColorSpace::SceneLinearRec2020);
    for (p, rgba) in reference.pixels.iter_mut().zip(input.chunks_exact(4)) {
        *p = [rgba[0], rgba[1], rgba[2]];
    }
    raw_core::stages::inpaint_composite::apply_window(&mut reference, patches, window).unwrap();
    let passes: Vec<_> = patches
        .iter()
        .map(|p| {
            let rgba = p
                .pixels
                .iter()
                .zip(&p.coverage)
                .map(|(rgb, c)| [rgb[0], rgb[1], rgb[2], *c])
                .collect();
            InpaintCompositePass::new(
                p.width,
                p.height,
                raw_core::stages::inpaint_composite::sampling_map([w, h], p, window),
                rgba,
            )
            .unwrap()
        })
        .collect();
    let image = GpuImage::upload(ctx, &input, w, h);
    let runner = ChainRunner::new(ctx, &image);
    let chain: Vec<&dyn Pass> = passes.iter().map(|p| p as &dyn Pass).collect();
    let result = runner.run_blocking(&chain);
    for (i, (rgb, rgba)) in reference
        .pixels
        .iter()
        .zip(result.chunks_exact(4))
        .enumerate()
    {
        for c in 0..3 {
            assert!(
                (rgb[c] - rgba[c]).abs() < 1e-4,
                "pixel {i}, channel {c}: {} vs {}",
                rgb[c],
                rgba[c]
            );
        }
        assert_eq!(rgba[3].to_bits(), input[i * 4 + 3].to_bits());
        if rgb == &[input[i * 4], input[i * 4 + 1], input[i * 4 + 2]] {
            for c in 0..3 {
                assert_eq!(rgba[c].to_bits(), input[i * 4 + c].to_bits());
            }
        }
    }
}

#[test]
fn wgsl_matches_source_window_cpu_oracle_and_ordered_overlap() {
    let ctx = GpuContext::new_blocking().expect("GPU required for removal parity");
    let patch = InpaintPatch {
        width: 3,
        height: 2,
        origin: [0.25, 0.25],
        extent: [0.5, 0.5],
        pixels: vec![
            [-0.25, 0.18, 4.0],
            [0.4, 0.1, 0.2],
            [1.1, 0.7, 0.3],
            [0.1, 2.0, 0.5],
            [0.9, 0.7, 1.2],
            [0.6, 0.5, 0.2],
        ],
        coverage: vec![0.0, 0.5, 1.0, 1.0, 0.25, 0.0],
    };
    run(
        &ctx,
        16,
        8,
        [0.0, 0.0, 1.0, 1.0],
        std::slice::from_ref(&patch),
    );
    run(
        &ctx,
        8,
        4,
        [0.25, 0.25, 0.5, 0.5],
        std::slice::from_ref(&patch),
    );
    run(
        &ctx,
        8,
        4,
        [0.5, 0.0, 0.5, 0.5],
        std::slice::from_ref(&patch),
    );
    let other = InpaintPatch {
        pixels: vec![[0.25, 0.5, 0.75]; 6],
        coverage: vec![0.75; 6],
        ..patch.clone()
    };
    run(&ctx, 16, 8, [0.0, 0.0, 1.0, 1.0], &[patch, other]);
}

#[test]
fn opaque_coverage_copies_scene_values_exactly_despite_hdr_base() {
    let ctx = GpuContext::new_blocking().expect("GPU required for removal parity");
    let input = vec![65504.0, -65504.0, 128.0, 0.25, 65504.0, 0.0, 0.0, 0.75];
    let replacement = [0.18, -0.125, 8.0, 1.0];
    let pass = InpaintCompositePass::new(
        2,
        1,
        [1.0, 1.0, 0.0, 0.0],
        vec![replacement, [1.0, 1.0, 1.0, 0.0]],
    )
    .unwrap();
    let image = GpuImage::upload(&ctx, &input, 2, 1);
    let result = ChainRunner::new(&ctx, &image).run_blocking(&[&pass]);
    assert_eq!(&result[..3], &replacement[..3]);
    assert_eq!(result[3], input[3]);
    for i in 4..8 {
        assert_eq!(result[i].to_bits(), input[i].to_bits());
    }
}

#[test]
fn native_mask_edges_do_not_bleed_on_non_power_of_two_source() {
    let ctx = GpuContext::new_blocking().expect("GPU required for removal parity");
    let window = raw_core::types::accepted_removal::NativeWindow {
        x: 400,
        y: 1000,
        width: 1024,
        height: 1024,
    }
    .region(5984, 3992);
    let patch = InpaintPatch {
        width: 1024,
        height: 1024,
        origin: [window[0], window[1]],
        extent: [window[2], window[3]],
        pixels: vec![[-0.125, 0.18, 8.0]; 1024 * 1024],
        coverage: (0..1024 * 1024)
            .map(|i| {
                if (412..612).contains(&(i % 1024)) && (412..612).contains(&(i / 1024)) {
                    1.0
                } else {
                    0.0
                }
            })
            .collect(),
    };
    run(&ctx, 1024, 1024, window, &[patch]);
}

#[test]
fn invalid_patch_cannot_be_published_to_gpu() {
    for (w, sampling, rgba) in [
        (0, [1.0, 1.0, 0.0, 0.0], vec![]),
        (1, [1.0, 1.0, f32::NAN, 0.0], vec![[0.0; 4]]),
        (1, [0.0, 1.0, 0.0, 0.0], vec![[0.0; 4]]),
        (
            1,
            [1.0, 1.0, 0.0, 0.0],
            vec![[f32::INFINITY, 0.0, 0.0, 1.0]],
        ),
        (1, [1.0, 1.0, 0.0, 0.0], vec![[0.0, 0.0, 0.0, -0.1]]),
    ] {
        assert!(InpaintCompositePass::new(w, 1, sampling, rgba).is_err());
    }
}
