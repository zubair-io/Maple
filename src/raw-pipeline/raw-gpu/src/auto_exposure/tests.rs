use super::*;
use crate::{ChainRunner, GpuImage};
use raw_core::{
    image::{ColorSpace, Image},
    stages::auto_exposure,
    xmp::AdjustmentModel,
};

fn scene(rgba: &[f32]) -> Image {
    Image {
        width: (rgba.len() / 4) as u32,
        height: 1,
        pixels: rgba.chunks_exact(4).map(|p| [p[0], p[1], p[2]]).collect(),
        space: ColorSpace::SceneLinearRec2020,
        whites_anchor_ev: None,
        nr_sampling_scale: 1.,
    }
}

// Full sorting and f64 accumulation are independent of both GPU radix selection
// and CPU quickselect. Count-based trimming explicitly includes split ties.
fn sorted_oracle(image: &Image) -> f32 {
    let w = auto_exposure::LUMA_REC2020;
    let mut ys = image
        .pixels
        .iter()
        .map(|p| w[0] * p[0] + w[1] * p[1] + w[2] * p[2])
        .filter(|y| y.is_finite())
        .collect::<Vec<_>>();
    if ys.is_empty() {
        return 1.;
    }
    ys.sort_by(f32::total_cmp);
    let n = ys.len();
    let begin = n / 4;
    let end = (n * 3 / 4).max(begin + 1).min(n);
    let positive = ys[begin..end]
        .iter()
        .filter(|y| **y > 0.)
        .collect::<Vec<_>>();
    if positive.is_empty() {
        return 1.;
    }
    let middle = (positive.iter().map(|y| (**y as f64).ln()).sum::<f64>() / positive.len() as f64)
        .exp() as f32;
    if !middle.is_finite() || middle < auto_exposure::MIDGREY_FLOOR {
        return 1.;
    }
    let mid_gain =
        (auto_exposure::SCENE_MIDGRAY_TARGET / middle).min(auto_exposure::MAX_ANCHOR_GAIN);
    let p95 = ys[(n * 95 / 100).min(n - 1)];
    let high_gain = if p95 > auto_exposure::MIDGREY_FLOOR {
        (auto_exposure::SCENE_HIGHLIGHT_TARGET / p95).min(auto_exposure::MAX_ANCHOR_GAIN)
    } else {
        mid_gain
    };
    mid_gain.max(high_gain)
}

fn assert_pixels(rgba: &[f32], actual: &[f32], label: &str) {
    let mut expected = scene(rgba);
    let oracle = sorted_oracle(&expected);
    let gain = auto_exposure::apply(&mut expected, &AdjustmentModel::default());
    assert!(
        (gain - oracle).abs() <= 1e-6,
        "CPU vs sorted oracle: {gain} / {oracle}"
    );
    let mut maximum = 0f32;
    for (i, ((input, actual), expected)) in rgba
        .chunks_exact(4)
        .zip(actual.chunks_exact(4))
        .zip(expected.pixels)
        .enumerate()
    {
        assert_eq!(input[3].to_bits(), actual[3].to_bits(), "alpha {label}/{i}");
        for c in 0..3 {
            if expected[c].is_nan() {
                assert!(actual[c].is_nan());
                continue;
            }
            if expected[c].is_infinite() {
                assert_eq!(expected[c], actual[c]);
                continue;
            }
            let error = (actual[c] - expected[c]).abs();
            assert!(
                error <= 1e-4,
                "{label}/{i}/{c}: gain {gain}, CPU {expected:?}, GPU {actual:?}, error {error:e}"
            );
            maximum = maximum.max(error);
        }
    }
    eprintln!(
        "AE {label}: {} pixels, gain {gain}, max {maximum:e}",
        rgba.len() / 4
    );
}

fn check(ctx: &GpuContext, rgba: &[f32], label: &str) -> Vec<f32> {
    let image = GpuImage::upload(ctx, rgba, (rgba.len() / 4) as u32, 1);
    let runner = ChainRunner::new(ctx, &image);
    let output = runner.run_blocking(&[&AutoExposurePass]);
    assert_eq!(
        runner.last_readback_count(),
        1,
        "only final output readback"
    );
    assert_pixels(rgba, &output, label);
    output
}

fn greys(values: impl IntoIterator<Item = f32>) -> Vec<f32> {
    values
        .into_iter()
        .enumerate()
        .flat_map(|(i, v)| [v, v, v, (i % 17) as f32 / 16.])
        .collect()
}

#[test]
fn exact_ranks_cover_small_frames_ties_signed_hdr_and_nonfinite_luminance() {
    let ctx = GpuContext::new_blocking().expect("required GPU adapter");
    for n in [1, 2, 3, 4, 5, 7, 13, 63, 64, 65, 255, 256, 257, 4093, 32769] {
        for value in [-0.18, 0., 1e-8, 0.001, 0.18, 0.4, 2.5] {
            check(
                &ctx,
                &greys(std::iter::repeat_n(value, n)),
                &format!("uniform/{n}/{value}"),
            );
        }
        let values = (0..n).map(|i| [-0.5, 0., 0.005, 0.18, 0.18, 0.18, 0.5, 4.][i % 8]);
        check(&ctx, &greys(values), &format!("ties/{n}"));
    }
    let split_ties = [(0.01, 27), (0.02, 13), (0.25, 38), (2.5, 27)]
        .into_iter()
        .flat_map(|(value, n)| std::iter::repeat_n(value, n));
    check(
        &ctx,
        &greys(split_ties),
        "both rank boundaries split equal values",
    );
    let nonfinite = [
        f32::NAN,
        f32::INFINITY,
        f32::NEG_INFINITY,
        -0.0,
        0.0,
        0.01,
        0.18,
        0.5,
        4.,
    ];
    check(&ctx, &greys(nonfinite), "finite rank population");
    check(
        &ctx,
        &greys(nonfinite[..3].iter().copied()),
        "no finite population",
    );
}

#[test]
fn exact_ranks_match_sorted_oracle_for_broad_and_narrow_colored_distributions() {
    let ctx = GpuContext::new_blocking().expect("required GPU adapter");
    for narrow in [false, true] {
        let rgba = (0..131_071usize)
            .flat_map(|i| {
                let u = (i.wrapping_mul(2_654_435_761) & 0xffff) as f32 / 65535.;
                let v = if narrow {
                    0.18 + (u - 0.5) * 1e-4
                } else {
                    2f32.powf(u * 18. - 12.)
                };
                [
                    v * 1.1 - 0.01,
                    v * 0.8,
                    v * 0.6 + 0.005,
                    (i % 11) as f32 / 10.,
                ]
            })
            .collect::<Vec<_>>();
        check(&ctx, &rgba, &format!("colored/narrow={narrow}"));
    }
}

#[test]
fn exposure_floor_matches_cpu_with_adjacent_values_and_bright_witnesses() {
    let ctx = GpuContext::new_blocking().expect("required GPU adapter");
    let floor = auto_exposure::MIDGREY_FLOOR.to_bits();
    for n in [1, 2, 3, 5, 13, 257, 4093] {
        for offset in -3i32..=3 {
            let value = f32::from_bits(floor.wrapping_add_signed(offset));
            for dark_fraction in [0, 1, 2] {
                let rgba = greys((0..n).map(|i| {
                    if i == n - 1 {
                        // A bright witness makes identity-versus-gain errors visible;
                        // dark pixels alone would hide them under the pixel ceiling.
                        1.
                    } else if i < n * dark_fraction / 4 {
                        if i % 2 == 0 {
                            0.
                        } else {
                            -0.1
                        }
                    } else {
                        value
                    }
                }));
                check(&ctx, &rgba, &format!("floor/{n}/{offset}/{dark_fraction}"));
            }
        }
    }
    for offset in -3i32..=3 {
        let low = f32::from_bits(floor.wrapping_add_signed(offset));
        let high = f32::from_bits(floor.wrapping_add_signed(offset + 1));
        let excluded_high = greys([
            -0.1, -0.1, -0.1, -0.1, low, low, low, low, low, 1., 1., 1., 1.,
        ]);
        check(
            &ctx,
            &excluded_high,
            &format!("exclusive band endpoint/{offset}"),
        );
        for n in [13, 257, 4093] {
            let rgba = greys((0..n).map(|i| {
                if i == n - 1 {
                    1.
                } else if i % 3 == 0 {
                    low
                } else {
                    high
                }
            }));
            check(&ctx, &rgba, &format!("mixed floor/{n}/{offset}"));
        }
    }
}

#[test]
fn repeated_exposure_reuses_resources_and_recomputes_after_pixel_changes() {
    let ctx = GpuContext::new_blocking().expect("required GPU adapter");
    let rgba = greys((0..8193).map(|i| {
        if i % 13 == 0 {
            4.
        } else {
            0.05 + (i % 31) as f32 * 0.001
        }
    }));
    let image = GpuImage::upload(&ctx, &rgba, (rgba.len() / 4) as u32, 1);
    let runner = ChainRunner::new(&ctx, &image);
    let run = || {
        ctx.frame_pool.borrow_mut().begin_frame(4629001);
        let output = runner.run_blocking(&[&AutoExposurePass]);
        ctx.frame_pool.borrow_mut().end_frame();
        output
    };
    let first = run();
    assert_pixels(&rgba, &first, "first resident frame");
    let allocations = ctx.frame_pool.borrow().alloc_count();
    assert!(allocations > 0);
    assert_eq!(first, run());
    assert_eq!(allocations, ctx.frame_pool.borrow().alloc_count());
    let changed = rgba
        .chunks_exact(4)
        .enumerate()
        .flat_map(|(i, p)| {
            let gain = if i % 7 == 0 { 0.1 } else { 1.7 };
            [p[0] * gain, p[1] * gain * 0.8, p[2] * gain * 1.3, p[3]]
        })
        .collect::<Vec<_>>();
    ctx.queue
        .write_buffer(&image.buffer, 0, bytemuck::cast_slice(&changed));
    let second = run();
    assert_ne!(first, second);
    assert_pixels(&changed, &second, "changed resident pixels");
    assert_eq!(allocations, ctx.frame_pool.borrow().alloc_count());
}
