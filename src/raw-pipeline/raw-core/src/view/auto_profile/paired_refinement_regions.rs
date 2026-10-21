use super::super::{ciede2000, lab};
use super::{projection::constrain_to_prior, system::prediction, ColorLut, Observation};
use rayon::prelude::*;

// Best-effort: assess_against enforces the hard regional margin at selection;
// passes past 3 cost ~0.2 s on 100 MP without changing any fixture (#5104).
const REGION_GUARD_PASSES: usize = 3;

/// Training display rows grouped by region, in their original order, with each
/// region's origin error fixed once per refinement. Per-row ΔE runs in
/// parallel; every sum still folds in the original row order (#5104).
pub(super) struct Regions<'a> {
    rows: Vec<&'a Observation>,
    targets: Vec<[f32; 3]>,
    members: [Vec<usize>; 64],
    populations: [usize; 64],
    baseline: [f64; 64],
}

impl<'a> Regions<'a> {
    pub(super) fn new(origin: &ColorLut, display: &'a [Observation]) -> Self {
        let rows: Vec<_> = display.iter().filter(|r| !r.validation).collect();
        let targets: Vec<_> = rows
            .par_iter()
            .map(|row| lab(row.target.map(|v| v as f32)))
            .collect();
        let mut members: [Vec<usize>; 64] = std::array::from_fn(|_| Vec::new());
        let mut populations = [0usize; 64];
        for (index, row) in rows.iter().enumerate() {
            members[row.region].push(index);
            populations[row.region] += row.population;
        }
        let baseline = region_means(&rows, &targets, &populations, origin);
        Self {
            rows,
            targets,
            members,
            populations,
            baseline,
        }
    }

    pub(super) fn constrain(
        &self,
        candidate: &mut ColorLut,
        origin: &ColorLut,
        confidence: &[f64],
    ) {
        let nodes = origin.size.pow(3);
        let mut gradient = vec![[0.; 3]; nodes];
        let mut touched = vec![false; nodes];
        let mut active = Vec::new();
        for _ in 0..REGION_GUARD_PASSES {
            let current = region_means(&self.rows, &self.targets, &self.populations, candidate);
            let bad: Vec<_> = (0..64)
                .filter(|&r| current[r] > self.baseline[r] + 0.06)
                .collect();
            if bad.is_empty() {
                return;
            }
            for region in bad {
                let derivatives: Vec<[f64; 3]> = self.members[region]
                    .par_iter()
                    .map(|&index| {
                        let (row, target) = (self.rows[index], self.targets[index]);
                        let rgb = prediction(&candidate.data, row);
                        std::array::from_fn(|c| {
                            let mut plus = rgb;
                            let mut minus = rgb;
                            plus[c] += 1e-4;
                            minus[c] -= 1e-4;
                            (error(plus, target) - error(minus, target)) / 2e-4
                        })
                    })
                    .collect();
                for (&index, derivative) in self.members[region].iter().zip(&derivatives) {
                    let row = self.rows[index];
                    let mass = row.population as f64 / self.populations[region] as f64;
                    for &(i, w) in &row.artifact_weights {
                        if super::projection::is_neutral_node(i, origin.size) {
                            continue;
                        }
                        if !touched[i] {
                            touched[i] = true;
                            active.push(i);
                        }
                        for c in 0..3 {
                            gradient[i][c] += mass * w * derivative[c];
                        }
                    }
                }
                // Untouched entries are exact zeros, so a node-order sum over the
                // touched ones equals the dense sum.
                active.sort_unstable();
                let norm: f64 = active
                    .iter()
                    .flat_map(|&i| gradient[i].iter())
                    .map(|v| v * v)
                    .sum();
                if norm.is_finite() && norm > 1e-20 {
                    let factor = (current[region] - self.baseline[region] - 0.05) / norm;
                    for (values, direction) in candidate.data.chunks_exact_mut(3).zip(&gradient) {
                        for c in 0..3 {
                            values[c] -= (factor * direction[c]) as f32;
                        }
                    }
                }
                for &i in &active {
                    gradient[i] = [0.; 3];
                    touched[i] = false;
                }
                active.clear();
            }
            constrain_to_prior(&mut candidate.data, origin, confidence);
        }
    }
}

fn region_means(
    rows: &[&Observation],
    targets: &[[f32; 3]],
    populations: &[usize; 64],
    lut: &ColorLut,
) -> [f64; 64] {
    let errors: Vec<f64> = rows
        .par_iter()
        .zip(targets)
        .map(|(row, &target)| row.population as f64 * error(prediction(&lut.data, row), target))
        .collect();
    let mut sums = [0.; 64];
    for (row, e) in rows.iter().zip(errors) {
        sums[row.region] += e;
    }
    std::array::from_fn(|r| sums[r] / populations[r].max(1) as f64)
}

fn error(rgb: [f64; 3], target: [f32; 3]) -> f64 {
    f64::from(ciede2000(lab(rgb.map(|v| v as f32)), target))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rows(target: [f64; 3]) -> Vec<Observation> {
        (0..40)
            .map(|_| Observation {
                weights: vec![],
                artifact_weights: vec![(1, 1.)],
                source: [0.; 3],
                target,
                baseline: [0.; 3],
                population: 1,
                validation: false,
                in_bias_region: true,
                region: 0,
            })
            .collect()
    }

    fn region_error(lut: &ColorLut, display: &[Observation]) -> f64 {
        let regions = Regions::new(lut, display);
        region_means(&regions.rows, &regions.targets, &regions.populations, lut)[0]
    }

    #[test]
    fn a_candidate_within_every_region_margin_is_left_untouched() {
        let origin = ColorLut::identity(2);
        let display = rows([1., 0., 0.]);
        let regions = Regions::new(&origin, &display);
        let mut candidate = origin.clone();
        regions.constrain(&mut candidate, &origin, &[1.; 8]);
        assert_eq!(candidate.data, origin.data);
    }

    #[test]
    fn a_region_pushed_past_its_margin_is_pulled_back_toward_its_origin_error() {
        let origin = ColorLut::identity(2);
        let display = rows([1., 0., 0.]);
        let regions = Regions::new(&origin, &display);
        let mut candidate = origin.clone();
        candidate.data[3..6].copy_from_slice(&[0.6, 0.2, 0.2]);
        let before = region_error(&candidate, &display);
        regions.constrain(&mut candidate, &origin, &[1.; 8]);
        assert!(region_error(&candidate, &display) < before);
        assert_eq!(&candidate.data[..3], &origin.data[..3]);
        assert_eq!(&candidate.data[21..], &origin.data[21..]);
    }
}
