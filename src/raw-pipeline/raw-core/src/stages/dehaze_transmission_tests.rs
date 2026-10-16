//! Transmission safety after guided refinement (#4654).
use super::*;
fn recover(p: [f32; 3], a: [f32; 3], t: f32, scale: f32) -> [f32; 3] {
    let mut image = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
    image.pixels[0] = p;
    recover_with_mask(&mut image, scale, &[t], a, &[0.0]);
    image.pixels[0]
}
#[test]
fn positive_observations_retain_the_haze_fraction_after_refinement() {
    for (scale, expected) in [
        (100., [1. / 81., 11. / 81., 21. / 81.]),
        (50., [21. / 181., 41. / 181., 61. / 181.]),
    ] {
        let out = recover([0.2, 0.3, 0.4], [1.; 3], 0.5, scale);
        for c in 0..3 {
            assert!(
                (out[c] - expected[c]).abs() < 1e-6,
                "scale{scale} channel{c}: {out:?} != {expected:?}"
            );
        }
    }
}
#[test]
fn nonnegative_scene_recovery_survives_infeasible_guided_estimates() {
    for a in [[1.; 3], [0.5, 2., 4.], [4., 0.5, 2.]] {
        for fraction in [0.001, 0.01, 0.1, 0.2, 0.5, 1., 2.] {
            for t in [0., 0.1, 0.5, 0.9, 1.] {
                let input = [
                    a[0] * fraction,
                    a[1] * (fraction + 0.1),
                    a[2] * (fraction + 0.2),
                ];
                let out = recover(input, a, t, 100.);
                assert!(
                    out.iter().all(|v| *v >= -1e-6),
                    "{input:?} {a:?} t{t}: {out:?}"
                );
            }
        }
    }
}
#[test]
fn safe_positive_and_negative_slider_results_keep_the_existing_model() {
    let input = [0.2, 0.3, 0.4];
    let a = [1.; 3];
    let out = recover(input, a, 0.95, 100.);
    for c in 0..3 {
        assert_eq!(out[c], (input[c] - a[c]) / 0.95 + a[c]);
    }
    let negative = recover(input, a, 0.5, -100.);
    for c in 0..3 {
        assert_eq!(negative[c], input[c] * 0.5 + a[c] * 0.5);
    }
}
#[test]
fn safety_adjusts_transmission_without_clipping_signed_or_hdr_pixels() {
    let signed = recover([-0.25, 0.3, 2.], [1.; 3], 0.1, 100.);
    for (a, b) in signed.into_iter().zip([-0.25, 0.3, 2.]) {
        assert!((a - b).abs() < 1e-6);
    }
    assert_eq!(recover([2., 3., 4.], [1.; 3], 0.5, 100.), [3., 5., 7.]);
}

#[test]
fn guided_refinement_keeps_positive_scene_observations_nonnegative() {
    for (x, y) in [(64usize, 64usize), (5, 64), (127, 3)] {
        let mut image = Image::new(129, 129, ColorSpace::SceneLinearRec2020);
        image.pixels.fill([0.8, 0.8, 0.8]);
        image.pixels[y * 129 + x] = [0.2, 0.2, 0.2];
        apply(&mut image, 100.);
        assert!(
            image.pixels.iter().flatten().all(|v| *v >= -1e-6),
            "positive observations must not invent negative recovered radiance"
        );
    }
}

#[test]
fn unit_transmission_preserves_signed_and_hdr_input_bits() {
    for (input, t) in [([-1e-10, 0.3, 2.0], 0.1), ([0.2, 0.3, 0.4], 1.0)] {
        let mut image = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
        image.pixels[0] = input;
        recover_with_mask(&mut image, 100.0, &[t], [1.0; 3], &[0.37]);
        assert_eq!(image.pixels[0].map(f32::to_bits), input.map(f32::to_bits));
    }
}
