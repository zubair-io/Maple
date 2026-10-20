use super::*;

fn hash(mut x: u64) -> u64 {
    x = (x ^ (x >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
    x = (x ^ (x >> 27)).wrapping_mul(0x94d049bb133111eb);
    x ^ (x >> 31)
}

fn scene(u: f64, v: f64) -> f64 {
    let waves = 0.5
        + 0.08 * (41. * u + 17. * v).sin()
        + 0.07 * (23. * v - 7. * u).cos()
        + 0.06 * (171. * u * v + 3.).sin()
        + 0.05 * (97. * u - 131. * v).sin();
    (0..60u64).fold(waves, |sum, k| {
        let h = hash(k + 11);
        let (cx, cy) = (
            (h & 0xffff) as f64 / 65535.,
            ((h >> 16) & 0xffff) as f64 / 65535.,
        );
        let r = 0.005 + ((h >> 32) & 0xff) as f64 / 255. * 0.03;
        let sign = if (h >> 40) & 1 == 0 { 1. } else { -1. };
        sum + sign * 0.15 * (-((u - cx).powi(2) + (v - cy).powi(2)) / (r * r)).exp()
    })
}

/// The 256×256 cell-centre grid registration sees for a `tw × th` display:
/// each axis is capped at 256 cells independently, as production does.
fn grid(tw: usize, th: usize, map: impl Fn(f64, f64) -> [f64; 2]) -> Gray {
    let (nx, ny) = (tw.min(256), th.min(256));
    let pixels = (0..ny)
        .flat_map(|gy| (0..nx).map(move |gx| (gx, gy)))
        .map(|(gx, gy)| {
            let x = (2 * gx + 1) * tw / (2 * nx);
            let y = (2 * gy + 1) * th / (2 * ny);
            let p = map((x as f64 + 0.5) / tw as f64, (y as f64 + 0.5) / th as f64);
            0.7 * scene(p[0], p[1]) + 0.1
        })
        .collect();
    Gray {
        width: nx,
        height: ny,
        pixels,
    }
}

fn worst_error_px(found: Warp, truth: impl Fn(f64, f64) -> [f64; 2], tw: usize, th: usize) -> f64 {
    (0..=20)
        .flat_map(|j| (0..=20).map(move |i| (0.1 + 0.04 * i as f64, 0.1 + 0.04 * j as f64)))
        .map(|(u, v)| {
            let (a, b) = (found.map(u, v), truth(u, v));
            ((a[0] - b[0]) * tw as f64).hypot((a[1] - b[1]) * th as f64)
        })
        .fold(0., f64::max)
}

fn register_frame(
    tw: usize,
    th: usize,
    truth: impl Fn(f64, f64) -> [f64; 2] + Copy,
) -> Option<Warp> {
    register(
        grid(tw, th, |u, v| [u, v]),
        grid(tw, th, truth),
        Warp::aspect_of(tw, th),
    )
    .map(|r| r.warp)
}

#[test]
fn recovers_a_pixel_isotropic_lens_residual_on_square_and_wide_frames() {
    for (tw, th) in [(1024, 1024), (1024, 683), (1024, 512)] {
        for (coefficients, radial) in [
            ([1.016, 0., -0.0079, 0., 1.016, -0.0071], -0.008),
            ([1., 0., 0., 0., 1., 0.], 0.008),
            ([0.998, 0., 0.001, 0., 0.998, 0.001], -0.0037),
        ] {
            let truth = Warp {
                coefficients,
                radial,
                aspect: Warp::aspect_of(tw, th),
            };
            let found = register_frame(tw, th, |u, v| truth.map(u, v))
                .expect("a bounded radial scene must register");
            assert!(
                (found.radial - radial).abs() < 0.15 * radial.abs(),
                "{tw}x{th} {found:?} vs {truth:?}"
            );
            assert!(
                worst_error_px(found, |u, v| truth.map(u, v), tw, th) < 0.6,
                "{tw}x{th} {found:?} vs {truth:?}"
            );
        }
    }
}

#[test]
fn affine_keystone_and_projective_scenes_keep_a_zero_radial_term() {
    let (tw, th) = (1024, 683);
    let affine = |u: f64, v: f64| [1.016 * u - 0.0079, 1.016 * v - 0.0071];
    let shift = |u: f64, v: f64| [u + 3. / 1024., v];
    let keystone = |u: f64, v: f64| [0.5 + (u - 0.5) * (1. + 0.03 * (v - 0.5)), v];
    let projective = |u: f64, v: f64| {
        let w = 1. + 0.02 * (u - 0.5) + 0.015 * (v - 0.5);
        [0.5 + (u - 0.5) / w, 0.5 + (v - 0.5) / w]
    };
    for (name, truth) in [
        ("affine", &affine as &dyn Fn(f64, f64) -> [f64; 2]),
        ("shift", &shift),
        ("keystone", &keystone),
        ("projective", &projective),
    ] {
        if let Some(found) = register_frame(tw, th, |u, v| truth(u, v)) {
            assert_eq!(found.radial, 0., "{name}: {found:?}");
        }
    }
    let found = register_frame(tw, th, affine).expect("an affine scene must register");
    assert!(worst_error_px(found, affine, tw, th) < 0.3, "{found:?}");
}

#[test]
fn inverse_map_round_trips_the_radial_term() {
    let warp = Warp {
        coefficients: [1.016, 0.001, -0.008, -0.001, 1.015, -0.007],
        radial: 0.008,
        aspect: Warp::aspect_of(1024, 683),
    };
    for (u, v) in [(0.02, 0.97), (0.5, 0.5), (0.9, 0.1)] {
        let [x, y] = warp.map(u, v);
        let [ru, rv] = warp.inverse_map(x, y).expect("unfolded warp inverts");
        assert!((ru - u).abs().max((rv - v).abs()) < 1e-10);
    }
}
