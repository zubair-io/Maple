use super::*;
use crate::{
    image::{ColorSpace, Image},
    types::local_adjustment::Point2,
};
use raw_gpu::{ChainRunner, GpuContext, GpuImage, RetouchPass};

fn spot(kind: RetouchKind, center: (f32, f32), source: (f32, f32), radius: f32) -> RetouchSpot {
    RetouchSpot::new(
        kind,
        Point2 {
            x: center.0,
            y: center.1,
        },
        Point2 {
            x: source.0,
            y: source.1,
        },
        radius,
    )
}

fn input(width: u32, height: u32) -> Image {
    let mut image = Image::new(width, height, ColorSpace::SceneLinearRec2020);
    for (i, p) in image.pixels.iter_mut().enumerate() {
        *p = std::array::from_fn(|c| (((i * 67 + c * 31) % 101) as f32 / 100.).powi(3) * 8. - 0.04);
    }
    image
}

fn compare(ctx: &GpuContext, input: &Image, spots: &[RetouchSpot]) {
    let mut expected = input.clone();
    crate::stages::retouch::apply(&mut expected, spots).unwrap();
    let prepared = prepare_gpu_spots(spots, (input.width, input.height));
    let retouch = RetouchPass { spots: &prepared };
    let rgba: Vec<_> = input
        .pixels
        .iter()
        .enumerate()
        .flat_map(|(i, p)| [p[0], p[1], p[2], (i % 5) as f32 / 4.])
        .collect();
    let image = GpuImage::upload(ctx, &rgba, input.width, input.height);
    let runner = ChainRunner::new(ctx, &image);
    let actual = runner.run_blocking(&[&retouch]);
    let mut maximum = 0_f32;
    for (i, (a, e)) in actual.chunks_exact(4).zip(&expected.pixels).enumerate() {
        assert_eq!(a[3].to_bits(), rgba[i * 4 + 3].to_bits());
        for c in 0..3 {
            let error = (a[c] - e[c]).abs();
            assert!(
                error < 1e-4,
                "pixel {i}/{c}: actual {a:?}, expected {e:?}, error {error:e}"
            );
            maximum = maximum.max(error);
        }
    }
    eprintln!(
        "Retouch {}x{} {} spots: maximum {maximum:e}",
        input.width,
        input.height,
        spots.len()
    );
}

#[test]
fn actual_geometry_and_kernels_match_cpu_at_borders_and_with_overlap() {
    let ctx = GpuContext::new_blocking().expect("required GPU adapter");
    for (width, height) in [(1, 1), (1, 9), (9, 1), (17, 13), (32, 25)] {
        let image = input(width, height);
        for kind in [RetouchKind::Clone, RetouchKind::Heal] {
            for radius in [0.02, 0.3, 1.] {
                for (feather, opacity) in [(0., 1.), (1., 0.4), (-1., 2.)] {
                    let mut spot = spot(kind, (0.55, 0.55), (0.4, 0.35), radius);
                    spot.feather = feather;
                    spot.opacity = opacity;
                    compare(&ctx, &image, &[spot]);
                }
                for (center, source) in [
                    ((0., 0.), (1., 1.)),
                    ((1., 0.), (0., 1.)),
                    ((-0.1, 0.5), (0.5, 0.5)),
                ] {
                    compare(&ctx, &image, &[spot(kind, center, source, radius)]);
                }
            }
        }
    }
}

#[test]
fn sequential_spots_consume_prior_repairs_and_degenerate_spots_are_skipped() {
    let ctx = GpuContext::new_blocking().expect("required GPU adapter");
    let image = input(32, 25);
    let first = spot(RetouchKind::Clone, (0.25, 0.3), (0.75, 0.8), 0.24);
    let second = spot(RetouchKind::Heal, (0.65, 0.6), (0.25, 0.3), 0.22);
    let mut forward = image.clone();
    let mut reverse = image.clone();
    crate::stages::retouch::apply(&mut forward, &[first, second]).unwrap();
    crate::stages::retouch::apply(&mut reverse, &[second, first]).unwrap();
    assert_ne!(forward.pixels, reverse.pixels);
    compare(&ctx, &image, &[first, second]);
    compare(&ctx, &image, &[second, first]);
    let invalid = [
        RetouchSpot {
            radius: f32::NAN,
            ..first
        },
        RetouchSpot {
            opacity: 0.,
            ..first
        },
        RetouchSpot {
            source: first.center,
            ..first
        },
        RetouchSpot {
            center: Point2 {
                x: f32::INFINITY,
                y: 0.,
            },
            ..first
        },
        RetouchSpot {
            radius: 0.,
            ..first
        },
    ];
    assert!(prepare_gpu_spots(&invalid, (32, 25)).is_empty());
    compare(&ctx, &image, &invalid);
}
