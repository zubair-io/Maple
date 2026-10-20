#[derive(Default)]
pub(super) struct NativeBands {
    counts: [usize; 5],
    inner_counts: [usize; 5],
    absolute: [[[f64; 3]; 5]; 2],
    inner_signed: [[[f64; 3]; 5]; 2],
    absolute_correction: [[[f64; 3]; 5]; 2],
    signed_correction: [[[f64; 3]; 5]; 2],
}

fn accumulate(sum: &mut f64, correction: &mut f64, value: f64) {
    let adjusted = value - *correction;
    let next = *sum + adjusted;
    *correction = (next - *sum) - adjusted;
    *sum = next;
}

fn band(target: [f64; 3]) -> usize {
    let luma = 0.2126 * target[0] + 0.7152 * target[1] + 0.0722 * target[2];
    [0.1, 0.25, 0.5, 0.75].partition_point(|edge| luma >= *edge)
}

fn preserves(before: f64, after: f64, count: usize) -> bool {
    count == 0 || (before / count as f64).abs() > 0.05 || (after / count as f64).abs() <= 0.05
}

impl NativeBands {
    pub(super) fn observe(
        &mut self,
        target: [f64; 3],
        inner: bool,
        outputs: [[f64; 3]; 2],
        population: usize,
    ) {
        let band = band(target);
        self.counts[band] += population;
        self.inner_counts[band] += if inner { population } else { 0 };
        for (i, output) in outputs.into_iter().enumerate() {
            for c in 0..3 {
                let error = output[c] - target[c];
                accumulate(
                    &mut self.absolute[i][band][c],
                    &mut self.absolute_correction[i][band][c],
                    population as f64 * error.abs(),
                );
                if inner {
                    accumulate(
                        &mut self.inner_signed[i][band][c],
                        &mut self.signed_correction[i][band][c],
                        population as f64 * error,
                    );
                }
            }
        }
    }

    pub(super) fn preserved(&self) -> bool {
        (0..5).all(|band| {
            (0..3).all(|c| {
                preserves(
                    self.absolute[1][band][c],
                    self.absolute[0][band][c],
                    self.counts[band],
                ) && preserves(
                    self.inner_signed[1][band][c],
                    self.inner_signed[0][band][c],
                    self.inner_counts[band],
                )
            })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn population_weighted_band_cannot_hide_a_large_cell_regression() {
        let mut weighted = NativeBands::default();
        weighted.observe([0.625; 3], true, [[0.685; 3], [0.665; 3]], 19);
        weighted.observe([0.625; 3], true, [[0.625; 3], [0.665; 3]], 1);
        assert!(!weighted.preserved());
        let mut expanded = NativeBands::default();
        for _ in 0..19 {
            expanded.observe([0.625; 3], true, [[0.685; 3], [0.665; 3]], 1);
        }
        expanded.observe([0.625; 3], true, [[0.625; 3], [0.665; 3]], 1);
        assert_eq!(weighted.preserved(), expanded.preserved());
        let mut equal_samples = NativeBands::default();
        equal_samples.observe([0.625; 3], true, [[0.685; 3], [0.665; 3]], 1);
        equal_samples.observe([0.625; 3], true, [[0.625; 3], [0.665; 3]], 1);
        assert!(equal_samples.preserved());
    }

    #[test]
    fn accumulation_does_not_invent_a_threshold_crossing() {
        let mut bands = NativeBands::default();
        for _ in 0..10_000 {
            bands.observe([0.175; 3], true, [[0.125; 3], [0.175; 3]], 1);
        }
        assert!(bands.preserved());
        let mut failed = NativeBands::default();
        for _ in 0..10_000 {
            failed.observe([0.175; 3], true, [[0.1249; 3], [0.175; 3]], 1);
        }
        assert!(!failed.preserved());
    }

    #[test]
    fn native_absolute_error_cannot_hide_inside_global_improvement_or_signed_cancellation() {
        let mut bands = NativeBands::default();
        for i in 0..1000 {
            let target = if i < 100 { 0.625 } else { 0.25 };
            let before = target + if i < 100 { 0.04 } else { 0.2 };
            let after = target
                + if i < 100 {
                    if i % 2 == 0 {
                        0.06
                    } else {
                        -0.06
                    }
                } else {
                    0.
                };
            bands.observe([target; 3], false, [[after; 3], [before; 3]], 1);
        }
        assert!(!bands.preserved());
        assert!(
            bands.absolute[0].iter().map(|v| v[0]).sum::<f64>()
                < bands.absolute[1].iter().map(|v| v[0]).sum::<f64>()
        );
    }

    #[test]
    fn inner_signed_band_bias_is_protected_even_when_full_frame_absolute_error_improves() {
        let mut bands = NativeBands::default();
        for _ in 0..100 {
            bands.observe([0.625; 3], true, [[0.535; 3], [0.585; 3]], 1);
            bands.observe([0.625; 3], false, [[0.625; 3], [0.825; 3]], 1);
        }
        assert!(bands.absolute[0][3][0] < bands.absolute[1][3][0]);
        assert!(!bands.preserved());
        let mut outside_only = NativeBands::default();
        for _ in 0..100 {
            outside_only.observe([0.625; 3], false, [[0.535; 3], [0.585; 3]], 1);
            outside_only.observe([0.625; 3], true, [[0.625; 3], [0.825; 3]], 1);
        }
        assert!(outside_only.preserved());
    }

    #[test]
    fn existing_failed_band_does_not_discard_a_useful_correction() {
        let mut bands = NativeBands::default();
        bands.observe([0.625; 3], true, [[0.725; 3], [0.685; 3]], 1);
        assert!(bands.preserved());
        assert!(NativeBands::default().preserved());
        assert_eq!(band([1.; 3]), 4);
        assert_eq!(band([0.; 3]), 0);
    }
}
