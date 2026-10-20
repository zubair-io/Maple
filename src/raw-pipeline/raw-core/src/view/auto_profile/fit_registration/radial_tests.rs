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

/// The 256×192 regular geometry grid registration sees for a 1024×768
/// display: one sample at each cell centre.
fn grid(warp: Option<Warp>) -> Gray {
    let (tw, th, nx, ny) = (1024, 768, 256, 192);
    let pixels = (0..ny)
        .flat_map(|gy| (0..nx).map(move |gx| (gx, gy)))
        .map(|(gx, gy)| {
            let x = (2 * gx + 1) * tw / (2 * nx);
            let y = (2 * gy + 1) * th / (2 * ny);
            let (u, v) = ((x as f64 + 0.5) / tw as f64, (y as f64 + 0.5) / th as f64);
            let p = warp.map_or([u, v], |w| w.map(u, v));
            0.7 * scene(p[0], p[1]) + 0.1
        })
        .collect();
    Gray {
        width: nx,
        height: ny,
        pixels,
    }
}

fn worst_error_px(found: Warp, truth: Warp) -> f64 {
    (0..=20)
        .flat_map(|j| (0..=20).map(move |i| (0.1 + 0.04 * i as f64, 0.1 + 0.04 * j as f64)))
        .map(|(u, v)| {
            let (a, b) = (found.map(u, v), truth.map(u, v));
            ((a[0] - b[0]) * 1024.).hypot((a[1] - b[1]) * 768.)
        })
        .fold(0., f64::max)
}

#[test]
fn recovers_a_lens_correction_residual_that_no_affine_map_expresses() {
    for truth in [
        Warp {
            coefficients: [1.016, 0., -0.0079, 0., 1.016, -0.0071],
            radial: -0.008,
        },
        Warp {
            coefficients: [1., 0., 0., 0., 1., 0.],
            radial: 0.008,
        },
        Warp {
            coefficients: [0.998, 0., 0.001, 0., 0.998, 0.001],
            radial: -0.0037,
        },
    ] {
        let found = register(grid(None), grid(Some(truth)))
            .expect("a bounded radial scene must register")
            .warp;
        assert!(
            (found.radial - truth.radial).abs() < 0.15 * truth.radial.abs(),
            "{found:?} vs {truth:?}"
        );
        assert!(worst_error_px(found, truth) < 0.6, "{found:?} vs {truth:?}");
    }
}

#[test]
fn affine_scenes_keep_a_zero_radial_term() {
    for truth in [
        Warp {
            coefficients: [1.016, 0., -0.0079, 0., 1.016, -0.0071],
            radial: 0.,
        },
        Warp {
            coefficients: [1., 0., 3. / 1024., 0., 1., 0.],
            radial: 0.,
        },
    ] {
        let found = register(grid(None), grid(Some(truth)))
            .expect("an affine scene must register")
            .warp;
        assert_eq!(found.radial, 0., "{found:?}");
        assert!(worst_error_px(found, truth) < 0.3, "{found:?}");
    }
}

#[test]
fn inverse_map_round_trips_the_radial_term() {
    let warp = Warp {
        coefficients: [1.016, 0.001, -0.008, -0.001, 1.015, -0.007],
        radial: 0.008,
    };
    for (u, v) in [(0.02, 0.97), (0.5, 0.5), (0.9, 0.1)] {
        let [x, y] = warp.map(u, v);
        let [ru, rv] = warp.inverse_map(x, y).expect("unfolded warp inverts");
        assert!((ru - u).abs().max((rv - v).abs()) < 1e-10);
    }
}
