use super::super::{ciede2000, lab};
use super::{projection::constrain_to_prior, system::prediction, ColorLut, Observation};
use rayon::prelude::*;

/// Training display rows grouped by region, in their original order, with each
/// region's origin error fixed once per refinement. Per-row ΔE runs in
/// parallel; every sum still folds in the original row order (#5104).
pub(super) struct Regions<'a> {
    rows: Vec<&'a Observation>,
    members: [Vec<&'a Observation>; 64],
    populations: [usize; 64],
    baseline: [f64; 64],
}

impl<'a> Regions<'a> {
    pub(super) fn new(origin: &ColorLut, display: &'a [Observation]) -> Self {
        let rows: Vec<_> = display.iter().filter(|r| !r.validation).collect();
        let mut members: [Vec<&Observation>; 64] = std::array::from_fn(|_| Vec::new());
        let mut populations = [0usize; 64];
        for &row in &rows {
            members[row.region].push(row);
            populations[row.region] += row.population;
        }
        let mut baseline = region_sums(&rows, origin);
        for r in 0..64 {
            baseline[r] /= populations[r].max(1) as f64;
        }
        Self {
            rows,
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
        for _ in 0..12 {
            let mut current = region_sums(&self.rows, candidate);
            for r in 0..64 {
                current[r] /= self.populations[r].max(1) as f64;
            }
            let bad: Vec<_> = (0..64)
                .filter(|&r| current[r] > self.baseline[r] + 0.06)
                .collect();
            if bad.is_empty() {
                return;
            }
            for region in bad {
                let derivatives: Vec<[f64; 3]> = self.members[region]
                    .par_iter()
                    .map(|row| {
                        let rgb = prediction(&candidate.data, row);
                        std::array::from_fn(|c| {
                            let mut plus = rgb;
                            let mut minus = rgb;
                            plus[c] += 1e-4;
                            minus[c] -= 1e-4;
                            (error(plus, row.target) - error(minus, row.target)) / 2e-4
                        })
                    })
                    .collect();
                for (row, derivative) in self.members[region].iter().zip(&derivatives) {
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

fn region_sums(rows: &[&Observation], lut: &ColorLut) -> [f64; 64] {
    let errors: Vec<f64> = rows
        .par_iter()
        .map(|row| row.population as f64 * error(prediction(&lut.data, row), row.target))
        .collect();
    let mut sums = [0.; 64];
    for (row, e) in rows.iter().zip(errors) {
        sums[row.region] += e;
    }
    sums
}

fn error(rgb: [f64; 3], target: [f64; 3]) -> f64 {
    f64::from(ciede2000(
        lab(rgb.map(|v| v as f32)),
        lab(target.map(|v| v as f32)),
    ))
}
