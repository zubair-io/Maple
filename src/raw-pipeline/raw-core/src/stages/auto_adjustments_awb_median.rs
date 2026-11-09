//! Component median of the final gray population's chromaticity (#4671).
//!
//! Cold analysis only. A histogram bins each admitted pixel's R/G and B/G
//! around the running neutral and returns the mean of the median bin, so the
//! estimator stays one linear pass with fixed memory — no per-pixel scratch
//! vector and no selection over a 100 MP probe. A population of identical
//! chromaticities returns that value exactly.

const BINS: usize = 4096;

/// The chroma gate admits at most a 0.625× – 1.6× ratio about the running
/// neutral (`max - mean ≤ gate · max` at the tightest 0.25 gate), so this
/// window holds every admitted pixel; anything outside clamps into an edge bin.
const WINDOW_LO: f32 = 0.5;
const WINDOW_HI: f32 = 2.0;
const BIN_SCALE: f32 = BINS as f32 / (WINDOW_HI - WINDOW_LO);

pub(super) struct RatioMedian {
    inv_center: f32,
    counts: Vec<u32>,
    sums: Vec<f64>,
    total: usize,
}

impl RatioMedian {
    /// `center` is the running neutral's ratio for this component.
    pub(super) fn new(center: f32) -> Self {
        Self {
            inv_center: 1.0 / center.max(1e-6),
            counts: vec![0; BINS],
            sums: vec![0.0; BINS],
            total: 0,
        }
    }

    pub(super) fn len(&self) -> usize {
        self.total
    }

    pub(super) fn add(&mut self, ratio: f32) {
        let bin = (((ratio * self.inv_center - WINDOW_LO) * BIN_SCALE) as usize).min(BINS - 1);
        self.counts[bin] += 1;
        self.sums[bin] += ratio as f64;
        self.total += 1;
    }

    /// Mean of the bin holding the element at sorted index `len / 2`.
    pub(super) fn median(&self) -> Option<f32> {
        let target = self.total / 2;
        let mut seen = 0;
        self.counts.iter().zip(&self.sums).find_map(|(&n, &sum)| {
            seen += n as usize;
            (n > 0 && seen > target).then(|| (sum / n as f64) as f32)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn exact_median(values: &mut [f32]) -> f32 {
        values.sort_by(f32::total_cmp);
        values[values.len() / 2]
    }

    #[test]
    fn identical_values_return_exactly() {
        let mut m = RatioMedian::new(1.3);
        (0..500).for_each(|_| m.add(1.234_567));
        assert_eq!(m.median(), Some(1.234_567));
        assert_eq!(m.len(), 500);
    }

    #[test]
    fn empty_population_has_no_median() {
        assert_eq!(RatioMedian::new(1.0).median(), None);
    }

    #[test]
    fn skewed_population_tracks_the_exact_median_within_a_bin() {
        let mut state = 0x2545_f491_u32;
        let mut next = || {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            state as f32 / u32::MAX as f32
        };
        let mut values: Vec<f32> = (0..20_001)
            .map(|i| {
                let u = next();
                if i % 4 == 0 {
                    1.05 + 0.4 * u
                } else {
                    0.9 + 0.15 * u * u
                }
            })
            .collect();
        let mut m = RatioMedian::new(1.0);
        values.iter().for_each(|&v| m.add(v));
        let bin_width = (WINDOW_HI - WINDOW_LO) / BINS as f32;
        let got = m.median().unwrap();
        let want = exact_median(&mut values);
        assert!((got - want).abs() <= bin_width, "{got} vs {want}");
    }

    #[test]
    fn minority_does_not_move_the_median() {
        let mut m = RatioMedian::new(1.0);
        (0..700).for_each(|_| m.add(1.0));
        (0..300).for_each(|_| m.add(1.45));
        assert_eq!(m.median(), Some(1.0));
    }

    #[test]
    fn values_outside_the_window_clamp_into_edge_bins() {
        let mut m = RatioMedian::new(1.0);
        (0..3).for_each(|_| m.add(9.0));
        m.add(0.01);
        assert_eq!(m.median(), Some(9.0));
    }
}
