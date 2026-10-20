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

/// The best affine-only registration at the full grid: what the fit would
/// use without the radial term.
fn affine_only(tw: usize, th: usize, truth: impl Fn(f64, f64) -> [f64; 2]) -> Warp {
    let (source, target) = (grid(tw, th, |u, v| [u, v]), grid(tw, th, truth));
    let start = Warp {
        aspect: Warp::aspect_of(tw, th),
        ..Warp::IDENTITY
    };
    [64, 128, 256].into_iter().fold(start, |warp, edge| {
        let (src, dst) = (source.normalized(edge), target.normalized(edge));
        super::optimizer::stage(&src, &dst, warp, false, Pixels::All, Pixels::All)
            .map_or(warp, |stage| stage.warp)
    })
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
    let scale = |[u, v]: [f64; 2]| [1.016 * u - 0.0079, 1.016 * v - 0.0071];
    let keystone = |u: f64, v: f64| scale([0.5 + (u - 0.5) * (1. + 0.03 * (v - 0.5)), v]);
    let projective = |u: f64, v: f64| {
        let w = 1. + 0.02 * (u - 0.5) + 0.015 * (v - 0.5);
        scale([0.5 + (u - 0.5) / w, 0.5 + (v - 0.5) / w])
    };
    let affine = |u: f64, v: f64| scale([u, v]);
    for (name, truth) in [
        ("affine", &affine as &dyn Fn(f64, f64) -> [f64; 2]),
        ("keystone", &keystone),
        ("projective", &projective),
    ] {
        let found = register_frame(tw, th, truth).expect("the scaled scene must register");
        assert_eq!(found.radial, 0., "{name}: {found:?}");
    }
    let found = register_frame(tw, th, affine).expect("an affine scene must register");
    assert!(worst_error_px(found, affine, tw, th) < 0.3, "{found:?}");
}

#[test]
fn keystone_on_top_of_a_lens_residual_is_rejected_or_still_helps() {
    let (tw, th) = (1024, 683);
    let truth = Warp {
        coefficients: [1.016, 0., -0.0079, 0., 1.016, -0.0071],
        radial: -0.008,
        aspect: Warp::aspect_of(tw, th),
    };
    let composite = |u: f64, v: f64| truth.map(0.5 + (u - 0.5) * (1. + 0.02 * (v - 0.5)), v);
    let found = register_frame(tw, th, composite).expect("the scaled scene must register");
    // Unmodelled keystone may bias k; an accepted term must still help.
    assert!(
        found.radial == 0.
            || (found.radial * truth.radial > 0.
                && worst_error_px(found, composite, tw, th)
                    <= worst_error_px(affine_only(tw, th, composite), composite, tw, th)),
        "{found:?}"
    );
}

#[test]
fn a_half_the_term_makes_worse_vetoes_it() {
    let (tw, th) = (1024, 683);
    let [sx, sy] = Warp::aspect_of(tw, th);
    let truth = |u: f64, v: f64| {
        let (nx, ny) = (2. * u - 1., 2. * v - 1.);
        [
            u + 0.01 * nx * ((nx * sx).powi(2) + (ny * sy).powi(2)),
            0.5 + (v - 0.5) * (1. + 0.03 * (u - 0.5)),
        ]
    };
    let found = register_frame(tw, th, truth).expect("the scene must register");
    assert!(
        found.radial == 0.
            || worst_error_px(found, truth, tw, th)
                <= worst_error_px(affine_only(tw, th, truth), truth, tw, th),
        "{found:?}"
    );
}

#[test]
fn a_texture_poor_half_does_not_veto_a_lens_residual() {
    let (tw, th) = (1024, 683);
    let truth = Warp {
        coefficients: [1.016, 0., -0.0079, 0., 1.016, -0.0071],
        radial: -0.008,
        aspect: Warp::aspect_of(tw, th),
    };
    let sky = |u: f64, v: f64| {
        if v < 0.45 {
            0.8 + 0.002 * (u * 40.).sin()
        } else {
            0.7 * scene(u, v) + 0.1
        }
    };
    let image = |map: &dyn Fn(f64, f64) -> [f64; 2]| {
        let (nx, ny) = (256, 256);
        let pixels = (0..ny)
            .flat_map(|gy| (0..nx).map(move |gx| (gx, gy)))
            .map(|(gx, gy)| {
                let (u, v) = (
                    ((2 * gx + 1) * tw / (2 * nx)) as f64 / tw as f64,
                    ((2 * gy + 1) * th / (2 * ny)) as f64 / th as f64,
                );
                let p = map(u, v);
                sky(p[0], p[1])
            })
            .collect();
        Gray {
            width: nx,
            height: ny,
            pixels,
        }
    };
    let found = register(
        image(&|u, v| [u, v]),
        image(&|u, v| truth.map(u, v)),
        Warp::aspect_of(tw, th),
    )
    .expect("the scene must register")
    .warp;
    assert!(
        (found.radial - truth.radial).abs() < 0.15 * truth.radial.abs(),
        "{found:?}"
    );
}

#[test]
fn jacobian_matches_finite_differences_of_the_map() {
    for i in 0..500u64 {
        let r = |k: u64| (hash(i * 7 + k) % 10_000) as f64 / 10_000.;
        let warp = Warp {
            coefficients: [
                0.98 + 0.04 * r(1),
                0.01 * (r(2) - 0.5),
                0.01 * (r(3) - 0.5),
                0.01 * (r(4) - 0.5),
                0.98 + 0.04 * r(5),
                0.01 * (r(6) - 0.5),
            ],
            radial: 0.05 * (r(7) - 0.5),
            aspect: [0.5 + 0.5 * r(8), 0.5 + 0.5 * r(9)],
        };
        let (u, v) = (r(10), r(11));
        let h = 1e-6;
        let [du0, du1] = [warp.map(u + h, v), warp.map(u - h, v)];
        let [dv0, dv1] = [warp.map(u, v + h), warp.map(u, v - h)];
        let numeric = [
            (du0[0] - du1[0]) / (2. * h),
            (dv0[0] - dv1[0]) / (2. * h),
            (du0[1] - du1[1]) / (2. * h),
            (dv0[1] - dv1[1]) / (2. * h),
        ];
        for (a, b) in warp.jacobian(u, v).iter().zip(numeric) {
            assert!((a - b).abs() < 1e-7, "{warp:?} at ({u}, {v})");
        }
    }
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
