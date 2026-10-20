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
        coefficients: [1.025, 0.003, -0.012, -0.002, 0.983, 0.008],
        ..Warp::IDENTITY
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
    let result = register(source, target, [1., 1.]).expect("known shifted scene should register");
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
    assert!(register(image.clone(), brighter, [1., 1.]).is_none());
    assert!(register(image.clone(), image, [1., 1.]).is_none());
    let flat = Gray {
        width: 64,
        height: 64,
        pixels: vec![0.5; 4096],
    };
    assert!(register(flat.clone(), flat, [1., 1.]).is_none());
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
    assert!(register(a, b, [1., 1.]).is_none());
}

#[test]
fn aligned_support_bounds_the_rotated_footprint_along_source_axes() {
    let warp = Warp {
        coefficients: [0.6, 0.8, 0., -0.8, 0.6, 0.],
        ..Warp::IDENTITY
    };
    let [x, y] = warp.support(400, 300, 100, 50, 0.3, 0.7);
    assert!((x - 400. * (0.6 / 100. + 0.8 / 50.)).abs() < 1e-12);
    assert!((y - 300. * (0.8 / 100. + 0.6 / 50.)).abs() < 1e-12);
    let unrotated = Warp {
        coefficients: [1.016, 0., 0., 0., 0.99, 0.],
        ..Warp::IDENTITY
    };
    let [x, y] = unrotated.support(400, 300, 100, 50, 0.3, 0.7);
    assert!((x - 1.016 * 400. / 100.).abs() < 1e-12 && (y - 0.99 * 300. / 50.).abs() < 1e-12);
}
