pub(super) fn worst_ratios(
    native: [f64; 2],
    perceptual: [f64; 2],
    p95: &[f64],
    regional: &[[[f64; 3]; 64]; 2],
    populations: &[usize; 64],
    rgb_p95: &[[f64; 3]; 2],
) -> [f64; 2] {
    let count = populations.iter().sum::<usize>().max(1) as f64;
    std::array::from_fn(|side| {
        let tiles = (0..64)
            .flat_map(|r| {
                (0..3).map(move |c| regional[side][r][c] / populations[r].max(1) as f64 / 0.05)
            })
            .fold(0., f64::max);
        let tail = rgb_p95[side].iter().copied().fold(0., f64::max) / 0.1;
        native[side]
            .max(perceptual[side] / count / 5.)
            .max(p95[side] / 10.)
            .max(tiles)
            .max(tail)
    })
}

pub(super) fn tail_preserved(before: f64, after: f64, worst: [f64; 2]) -> bool {
    after <= before || (before > 10. && worst[1] > 1. && worst[0] < worst[1])
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn already_failed_tail_can_trade_only_for_a_smaller_worst_fixed_budget_violation() {
        assert!(tail_preserved(21., 22., [3.2, 3.6]));
        assert!(!tail_preserved(21., 22., [3.6, 3.6]));
        assert!(!tail_preserved(21., 22., [3.7, 3.6]));
        assert!(!tail_preserved(10., 10.01, [1.1, 3.6]));
        assert!(!tail_preserved(9., 9.5, [1.1, 3.6]));
        assert!(tail_preserved(9., 8., [1.1, 3.6]));
    }
    #[test]
    fn scoring_uses_the_existing_budgets_and_all_regions_channels_and_native_bands() {
        let mut regional = [[[0.; 3]; 64]; 2];
        regional[0][63][2] = 0.2;
        let ratios = worst_ratios(
            [0., 0.],
            [5., 5.],
            &[10., 10.],
            &regional,
            &[1; 64],
            &[[0.1; 3]; 2],
        );
        assert_eq!(ratios, [4., 1.]);
        assert_eq!(
            worst_ratios(
                [5., 6.],
                [0., 0.],
                &[0., 0.],
                &regional,
                &[1; 64],
                &[[0.; 3]; 2]
            ),
            [5., 6.]
        );
    }
}
