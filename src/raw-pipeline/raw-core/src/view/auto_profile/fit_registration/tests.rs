use super::*;

fn pattern(u: f64, v: f64) -> f64 {
    0.5 + 0.12 * (41. * u + 17. * v).sin()
        + 0.1 * (23. * v - 7. * u).cos()
        + 0.08 * (71. * u * v).sin()
}

#[test]
fn recovers_bounded_scene_correspondences_despite_brightness_and_contrast_difference() {
    let (width, height) = (128, 128);
    let expected = Warp {
        radial: 0.,
        coefficients: [1.025, 0.003, -0.012, -0.002, 0.983, 0.008],
    };
    let mut a = Vec::new();
    let mut b = Vec::new();
    for y in 0..height {
        for x in 0..width {
            let (u, v) = (
                (x as f64 + 0.5) / width as f64,
                (y as f64 + 0.5) / height as f64,
            );
            a.push(pattern(u, v));
            let p = expected.map(u, v);
            b.push(0.72 * pattern(p[0], p[1]) + 0.09);
        }
    }
    let source = Gray {
        width,
        height,
        pixels: a,
    };
    let target = Gray {
        width,
        height,
        pixels: b,
    };
    let result = register(source, target).expect("known shifted scene should register");
    for v in [0.1, 0.5, 0.9] {
        for u in [0.1, 0.5, 0.9] {
            let a = result.warp.map(u, v);
            let b = expected.map(u, v);
            assert!(
                ((a[0] - b[0]) * width as f64).hypot((a[1] - b[1]) * height as f64) < 0.4,
                "{:?}",
                result.warp
            );
        }
    }
}

#[test]
fn aligned_and_flat_scenes_keep_identity_sampling() {
    let image = Gray {
        width: 64,
        height: 64,
        pixels: (0..4096)
            .map(|i| pattern((i % 64) as f64 / 64., (i / 64) as f64 / 64.))
            .collect(),
    };
    let brighter = Gray {
        pixels: image.pixels.iter().map(|v| 0.7 * v + 0.1).collect(),
        ..image.clone()
    };
    assert!(register(image.clone(), brighter).is_none());
    assert!(register(image.clone(), image).is_none());
    let flat = Gray {
        width: 64,
        height: 64,
        pixels: vec![0.5; 4096],
    };
    assert!(register(flat.clone(), flat).is_none());
}

#[test]
fn unrelated_structure_is_not_accepted_as_a_correspondence() {
    let a = Gray {
        width: 64,
        height: 64,
        pixels: (0..4096)
            .map(|i| ((i * 193 + 71) % 997) as f64 / 997.)
            .collect(),
    };
    let b = Gray {
        width: 64,
        height: 64,
        pixels: (0..4096)
            .map(|i| ((i * 719 + 131) % 991) as f64 / 991.)
            .collect(),
    };
    assert!(register(a, b).is_none());
}

#[test]
fn radial_candidate_recovers_curved_correspondence_on_held_out_regions() {
    let (width, height) = (256, 256);
    let expected = Warp {
        coefficients: [1.006, 0., -0.003, 0., 1.006, -0.003],
        radial: 0.012,
    };
    let source = Gray {
        width,
        height,
        pixels: (0..width * height)
            .map(|i| {
                pattern(
                    (i % width) as f64 / width as f64,
                    (i / width) as f64 / height as f64,
                )
            })
            .collect(),
    };
    let target = Gray {
        width,
        height,
        pixels: (0..width * height)
            .map(|i| {
                let p = expected.map(
                    (i % width) as f64 / width as f64,
                    (i / width) as f64 / height as f64,
                );
                0.8 * pattern(p[0], p[1]) + 0.06
            })
            .collect(),
    };
    let a = source.normalized(256);
    let b = target.normalized(256);
    let affine = optimizer::stage(&a, &b, Warp::IDENTITY).unwrap().0;
    let fitted = radial_optimizer::refine(&a, &b, affine).expect("held-out radial improvement");
    for v in [0.1, 0.5, 0.9] {
        for u in [0.1, 0.5, 0.9] {
            let a = fitted.map(u, v);
            let b = expected.map(u, v);
            assert!((a[0] - b[0]).hypot(a[1] - b[1]) * 256. < 0.6, "{fitted:?}");
            let inverse = fitted.inverse_map(a[0], a[1]).unwrap();
            assert!((inverse[0] - u).hypot(inverse[1] - v) < 1e-8);
        }
    }
}
