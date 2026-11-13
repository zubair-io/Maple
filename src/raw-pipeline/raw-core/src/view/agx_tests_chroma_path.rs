use super::*;

#[test]
fn finite_bright_colours_converge_to_the_neutral_shoulder() {
    for colour in [
        [1.0, 0.05, 0.05],
        [0.05, 1.0, 0.05],
        [0.05, 0.05, 1.0],
        [1.0, 0.4, 0.1],
        [0.1, 0.4, 1.0],
    ] {
        for contrast in [-100.0f32, 0.0, 100.0] {
            let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
            img.pixels[0] = colour.map(|v| v * 1.0e6);
            apply_with_resolved_whites(&mut img, contrast, 0.0);
            let p = img.pixels[0];
            let spread = p[0].max(p[1]).max(p[2]) - p[0].min(p[1]).min(p[2]);
            assert!(
                spread < 1.0e-4,
                "colour={colour:?}, contrast={contrast}, out={p:?}"
            );
        }
    }
}

#[test]
fn hue_range_maps_extrema_and_preserves_the_middle_channel_fraction() {
    for rgb in [[4.0f32, 2.0, 1.0], [1.0, 4.0, 2.0], [2.0, 1.0, 4.0]] {
        let out = hue_restoration::sigmoid_hue_range(rgb, |x| x.sqrt());
        for c in 0..3 {
            // Minimum is diffuse white: the current ratio curve is unchanged.
            let expected = rgb[c] * 0.5;
            assert!((out[c] - expected).abs() < 1.0e-6);
        }
    }
}

#[test]
fn hue_range_is_identity_for_a_linear_curve_and_keeps_neutrals() {
    for rgb in [[0.4f32, 0.2, 0.1], [-0.1, 0.3, 0.2], [0.18; 3]] {
        let out = hue_restoration::sigmoid_hue_range(rgb, |x| x);
        for c in 0..3 {
            assert!((out[c] - rgb[c]).abs() < 1.0e-6);
        }
    }
    for v in [0.01f32, 0.18, 1.0, 8.0] {
        let out = hue_restoration::sigmoid_hue_range([v; 3], |x| x.sqrt());
        let expected = if v <= 1.0 {
            v * (v.sqrt() / v)
        } else {
            v.sqrt()
        };
        assert_eq!(out, [expected; 3]);
    }
}

#[test]
fn common_highlight_weight_matches_independent_ramp_and_channel_fractions() {
    for rgb in [[8.0f32, 4.0, 2.0], [2.0, 8.0, 4.0], [4.0, 2.0, 8.0]] {
        let out = hue_restoration::sigmoid_hue_range(rgb, |x| x.sqrt());
        let high = 8.0f32.sqrt();
        let fraction = 1.0 / (AGX_MAX_EV + AGX_MID_GRAY.log2());
        let weight = 3.0 * fraction.powi(2) - 2.0 * fraction.powi(3);
        let old_low = high / 4.0;
        let low = old_low + weight * (2.0f32.sqrt() - old_low);
        for c in 0..3 {
            let expected = low + (rgb[c] - 2.0) / 6.0 * (high - low);
            assert!((out[c] - expected).abs() < 1.0e-6);
        }
    }
}

#[test]
fn common_highlight_forward_inverse_roundtrip_before_lossy_gamut_compression() {
    for scene in [[6.0f32, 4.0, 2.0], [2.0, 6.0, 4.0], [4.0, 2.0, 6.0]] {
        let inset = matrix_mul(&AGX_INSET_MATRIX, scene);
        let mapped = hue_restoration::sigmoid_hue_range(inset, |x| neutral_curve(x, 1.0, 0.0));
        let display = matrix_mul(&AGX_OUTSET_MATRIX, mapped);
        let back = crate::view::agx_inverse::inverse_agx_pixel(display, 1.0, 0.0);
        for c in 0..3 {
            assert!(
                (back[c] - scene[c]).abs() < 2.0e-4,
                "scene={scene:?}, back={back:?}"
            );
        }
    }
}

#[test]
fn non_common_highlights_keep_exact_ratio_arithmetic_and_one_curve_sample() {
    use std::cell::Cell;
    for rgb in [
        [0.18f32; 3],
        [1.0; 3],
        [0.18, 0.18000001, 0.18],
        [-0.25, 0.4, 0.8],
        [64.0, 1.0, 8.0],
        [8.0, 0.25, 2.0],
    ] {
        let calls = Cell::new(0);
        let actual = hue_restoration::sigmoid_hue_range(rgb, |v| {
            calls.set(calls.get() + 1);
            v.sqrt()
        });
        let expected = hue_restoration::norm_sigmoid_ratio(rgb, |v| v.sqrt());
        assert_eq!(actual, expected, "rgb={rgb:?}");
        assert_eq!(calls.get(), 1);
    }
}

#[test]
fn common_highlight_low_endpoint_is_monotone_and_bounded_for_slider_extremes() {
    for slope in [0.5f32, 1.0, 1.5] {
        for whites in [-100.0f32, 0.0, 100.0] {
            for hi in [1.01f32, 2.0, 8.0, 32.0] {
                let high_out = neutral_curve(hi, slope, whites);
                let mut previous = f32::NEG_INFINITY;
                for step in 0..=4096 {
                    let lo = hi * step as f32 / 4096.0;
                    let low_out = common_highlight_minimum(
                        lo,
                        hi,
                        high_out,
                        neutral_curve(lo, slope, whites),
                    );
                    assert!(
                        low_out + 2.0e-7 >= previous,
                        "lo={lo}, hi={hi}, slope={slope}, whites={whites}"
                    );
                    assert!(low_out <= high_out + 2.0e-7);
                    assert!(low_out + 2.0e-7 >= lo * high_out / hi);
                    previous = low_out;
                }
            }
        }
    }
}

#[test]
fn common_highlight_weight_meets_diffuse_white_without_a_derivative_jump() {
    let hi = 8.0f32;
    let high_out = hi.sqrt();
    let h = 0.001f32;
    let mapped = |lo: f32| common_highlight_minimum(lo, hi, high_out, lo.sqrt());
    let center = mapped(1.0);
    let left_slope = (center - mapped(1.0 - h)) / h;
    let right_slope = (mapped(1.0 + h) - center) / h;
    assert!((left_slope - high_out / hi).abs() < 1.0e-4);
    assert!((right_slope - left_slope).abs() < 5.0e-4);
}
