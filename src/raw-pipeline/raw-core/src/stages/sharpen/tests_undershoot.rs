use super::*;

/// #4112: positive light beside a brighter region must not change RGB signs.
/// A neutral HDR neighborhood isolates USM from calibration and the view tail.
#[test]
fn high_amount_does_not_invert_positive_light_beside_a_bright_neighbor() {
    for exposure in [0.1, 1.0, 10.0] {
        for amount in [40.0, 100.0, 150.0] {
            let mut image = Image::new(9, 9, ColorSpace::SceneLinearRec2020);
            image.pixels.fill([exposure; 3]);
            image.pixels[40] = [0.1 * exposure; 3];

            apply(&mut image, amount, 1.0, 25.0, 0.0);

            // Bounded full-strength attenuation implies u <= amount/100.
            // The positive tangent continuation has this analytic minimum;
            // unbounded raw contrast must not bypass it (#4112).
            let mix = amount / 100.0;
            let minimum_gain = if mix <= 0.4 {
                1.0 - mix
            } else {
                0.36 / (0.6 + (mix - 0.4))
            };
            let minimum = 0.1 * exposure * minimum_gain;
            assert!(image.pixels[40][0] >= minimum - 1e-7,
                "bounded target violated: exposure={exposure}, amount={amount}, center={:?}, minimum={minimum}", image.pixels[40]);
            assert!(
                image.pixels.iter().flatten().all(|value| *value > 0.0),
                "exposure={exposure}, amount={amount}, center={:?}",
                image.pixels[40]
            );
        }
    }
}

#[test]
fn brightening_keeps_original_usm_gain_and_unbounded_hdr() {
    for exposure in [0.1, 1.0, 10.0] {
        for amount in [40.0, 100.0, 150.0] {
            let mut image = Image::new(9, 9, ColorSpace::SceneLinearRec2020);
            image.pixels.fill([exposure; 3]);
            let original = [2.0 * exposure, 3.0 * exposure, 4.0 * exposure];
            image.pixels[40] = original;
            let luma: Vec<f32> = image
                .pixels
                .iter()
                .map(|p| LUMA_R * p[0] + LUMA_G * p[1] + LUMA_B * p[2])
                .collect();
            let blur = gaussian_blur_plane_sigma(&luma, 9, 9, 1.0);
            let li = luma[40];
            assert!(li > blur[40]);
            let scale = ((li + (li - blur[40])) / li).clamp(0.0, 4.0);
            let expected = original.map(|o| o + (o * scale - o) * (amount / 100.0));
            apply(&mut image, amount, 1.0, 25.0, 0.0);
            assert_eq!(image.pixels[40], expected);
            assert!(image.pixels[40][2] > original[2]);
        }
    }
}

#[test]
fn darkening_preserves_signed_chroma_and_exposure_scaling() {
    let render = |exposure: f32| {
        let mut image = Image::new(9, 9, ColorSpace::SceneLinearRec2020);
        image.pixels.fill([exposure; 3]);
        image.pixels[40] = [-0.01 * exposure, 0.10 * exposure, 0.05 * exposure];
        apply(&mut image, 150.0, 1.0, 25.0, 0.0);
        image.pixels[40]
    };
    let base = render(1.0);
    assert!(base[0] < 0.0 && base[1] > 0.0 && base[2] > 0.0);
    assert!((base[0] / base[1] + 0.1).abs() < 1e-6);
    assert!((base[2] / base[1] - 0.5).abs() < 1e-6);
    for exposure in [0.1, 10.0] {
        for (actual, expected) in render(exposure).into_iter().zip(base) {
            assert!((actual / exposure - expected).abs() < 1e-6);
        }
    }
}

#[test]
fn zero_and_negative_luma_remain_unchanged_beside_positive_light() {
    for original in [[0.0; 3], [-0.1; 3], [-0.5, 0.01, 0.02]] {
        let mut image = Image::new(9, 9, ColorSpace::SceneLinearRec2020);
        image.pixels.fill([2.0; 3]);
        image.pixels[40] = original;
        apply(&mut image, 150.0, 1.0, 25.0, 0.0);
        assert_eq!(image.pixels[40], original);
        assert!(image.pixels.iter().flatten().all(|value| value.is_finite()));
    }
}

/// The strongest full-strength attenuation reaches u=mix. The supported
/// default must use the old arithmetic exactly, even at the zero-scale edge.
#[test]
fn default_amount_and_join_rounding_retain_supported_darkening() {
    for exposure in [0.1_f32, 1.0, 10.0] {
        for amount in [0.0_f32, 10.0, 25.0, 40.0] {
            let mut image = Image::new(9, 9, ColorSpace::SceneLinearRec2020);
            image.pixels.fill([exposure; 3]);
            let o = 0.1 * exposure;
            image.pixels[40] = [o; 3];
            apply(&mut image, amount, 1.0, 25.0, 0.0);
            let old = o + (0.0 - o) * (amount / 100.0);
            assert_eq!(image.pixels[40], [old; 3]);
        }
    }
    let amounts = [
        f32::from_bits(40.0_f32.to_bits() - 1),
        40.0,
        f32::from_bits(40.0_f32.to_bits() + 1),
    ];
    let centers: Vec<f32> = amounts
        .into_iter()
        .map(|amount| {
            let mut image = Image::new(9, 9, ColorSpace::SceneLinearRec2020);
            image.pixels.fill([1.0; 3]);
            image.pixels[40] = [0.1; 3];
            apply(&mut image, amount, 1.0, 25.0, 0.0);
            image.pixels[40][0]
        })
        .collect();
    assert!(centers.windows(2).all(|p| p[1] <= p[0] + 1e-8));
    assert!(centers.iter().all(|c| (c - 0.06).abs() <= 2e-8));
}

#[test]
fn overdrive_remains_monotonic_without_preserving_legacy_zero_at_100() {
    let mut previous = 0.1_f32;
    for amount in [0.0_f32, 40.0, 60.0, 80.0, 100.0, 125.0, 150.0] {
        let mut image = Image::new(9, 9, ColorSpace::SceneLinearRec2020);
        image.pixels.fill([1.0; 3]);
        image.pixels[40] = [0.1; 3];
        apply(&mut image, amount, 1.0, 25.0, 0.0);
        let actual = image.pixels[40][0];
        assert!(actual > 0.0 && actual <= previous);
        if amount == 100.0 {
            assert!((actual - 0.03).abs() < 1e-7);
        }
        previous = actual;
    }
}
