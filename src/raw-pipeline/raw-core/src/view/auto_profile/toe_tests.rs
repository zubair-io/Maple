use super::*;

const GATE_CEILING: f64 = 0.004007;

/// The gate's measurement: worst second difference of the linear-light luma of
/// the neutral ramp, sampled through the real tetrahedral lookup.
fn neutral_ramp_second_difference(lut: &ColorLut) -> f64 {
    let luma: Vec<f64> = (0..RAMP_STEPS)
        .map(|step| {
            let encoded = srgb_gamma(step as f32 / (RAMP_STEPS - 1) as f32);
            let out = lut.sample([encoded; 3]);
            (0..3)
                .map(|c| LUMA[c] * f64::from(srgb_gamma_inv(out[c])))
                .sum()
        })
        .collect();
    luma.windows(3)
        .map(|w| (w[2] - 2. * w[1] + w[0]).abs())
        .fold(0., f64::max)
}

/// A LUT that lifts linear light by `1 + gain / (1 + l / 0.002)`: `gain + 1`×
/// at black, easing back to identity.
fn black_lift(size: usize, gain: f64) -> ColorLut {
    let mut lut = ColorLut::identity(size);
    for value in &mut lut.data {
        let linear = f64::from(srgb_gamma_inv(*value));
        let lifted = linear * (1. + gain / (1. + linear / 0.002));
        *value = srgb_gamma(lifted.min(1.) as f32);
    }
    lut
}

#[test]
fn a_steep_black_lift_is_brought_inside_the_ramp_budget() {
    let original = black_lift(33, 30.);
    assert!(neutral_ramp_second_difference(&original) > GATE_CEILING);
    let mut lut = original.clone();
    soften_black_toe(&mut lut);
    assert!(neutral_ramp_second_difference(&lut) < GATE_CEILING);
}

#[test]
fn only_the_toe_shells_change_and_black_stays_put() {
    let original = black_lift(33, 30.);
    let mut lut = original.clone();
    soften_black_toe(&mut lut);
    let n = 33;
    assert_eq!(lut.data[..3], original.data[..3]);
    for (index, (after, before)) in lut
        .data
        .chunks_exact(3)
        .zip(original.data.chunks_exact(3))
        .enumerate()
    {
        let shell = (index % n).max(index / n % n).max(index / (n * n));
        if shell == 0 || shell > SHELLS {
            assert_eq!(after, before, "node {index} in shell {shell} must not move");
        } else {
            let coordinates = [index % n, index / n % n, index / (n * n)];
            for ((a, b), coordinate) in after.iter().zip(before).zip(coordinates) {
                let identity = coordinate as f32 / (n - 1) as f32;
                assert!((a - identity).abs() <= (b - identity).abs() + 1e-6);
            }
        }
    }
}

#[test]
fn the_softened_diagonal_stays_strictly_increasing() {
    let mut lut = black_lift(33, 30.);
    soften_black_toe(&mut lut);
    let diagonal: Vec<f32> = (0..33)
        .map(|i| lut.data[((i * 33 + i) * 33 + i) * 3])
        .collect();
    assert!(diagonal.windows(2).all(|w| w[1] > w[0]), "{diagonal:?}");
}

#[test]
fn off_axis_nodes_keep_their_lift_direction() {
    let mut lut = black_lift(33, 30.);
    let before = lut.clone();
    soften_black_toe(&mut lut);
    let at = |lut: &ColorLut, r: usize, g: usize, b: usize| {
        let i = ((b * 33 + g) * 33 + r) * 3;
        [lut.data[i], lut.data[i + 1], lut.data[i + 2]]
    };
    let (a, b) = (at(&before, 2, 1, 0), at(&lut, 2, 1, 0));
    let identity = [2. / 32., 1. / 32., 0.];
    let scale = (b[0] - identity[0]) / (a[0] - identity[0]);
    assert!(scale < 1.);
    for c in 1..3 {
        assert!((b[c] - identity[c] - scale * (a[c] - identity[c])).abs() < 1e-6);
    }
}

#[test]
fn a_ramp_already_inside_the_limit_is_left_bit_identical() {
    for original in [
        ColorLut::identity(33),
        black_lift(33, 1.),
        black_lift(17, 0.5),
    ] {
        assert!(neutral_ramp_second_difference(&original) < SECOND_DIFFERENCE_LIMIT);
        let mut lut = original.clone();
        soften_black_toe(&mut lut);
        assert_eq!(lut, original);
    }
}
