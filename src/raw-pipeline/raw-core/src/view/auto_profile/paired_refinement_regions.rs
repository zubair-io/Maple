use super::super::{ciede2000, lab};
use super::{projection::constrain_to_prior, system::prediction, ColorLut, Observation};

pub(super) fn constrain(
    candidate: &mut ColorLut,
    origin: &ColorLut,
    display: &[Observation],
    confidence: &[f64],
) {
    let mut populations = [0usize; 64];
    let mut baseline = [0.; 64];
    for row in display.iter().filter(|r| !r.validation) {
        populations[row.region] += row.population;
        baseline[row.region] +=
            row.population as f64 * error(prediction(&origin.data, row), row.target);
    }
    for r in 0..64 {
        baseline[r] /= populations[r].max(1) as f64;
    }
    for _ in 0..12 {
        let mut current = [0.; 64];
        for row in display.iter().filter(|r| !r.validation) {
            current[row.region] +=
                row.population as f64 * error(prediction(&candidate.data, row), row.target);
        }
        for r in 0..64 {
            current[r] /= populations[r].max(1) as f64;
        }
        let bad: Vec<_> = (0..64)
            .filter(|&r| current[r] > baseline[r] + 0.06)
            .collect();
        if bad.is_empty() {
            return;
        }
        for region in bad {
            let mut gradient = vec![[0.; 3]; origin.size.pow(3)];
            for row in display
                .iter()
                .filter(|r| !r.validation && r.region == region)
            {
                let rgb = prediction(&candidate.data, row);
                let derivative: [f64; 3] = std::array::from_fn(|c| {
                    let mut plus = rgb;
                    let mut minus = rgb;
                    plus[c] += 1e-4;
                    minus[c] -= 1e-4;
                    (error(plus, row.target) - error(minus, row.target)) / 2e-4
                });
                let mass = row.population as f64 / populations[region] as f64;
                for &(i, w) in &row.artifact_weights {
                    if super::projection::is_neutral_node(i, origin.size) {
                        continue;
                    }
                    for c in 0..3 {
                        gradient[i][c] += mass * w * derivative[c];
                    }
                }
            }
            let norm: f64 = gradient.iter().flat_map(|v| v.iter()).map(|v| v * v).sum();
            if !norm.is_finite() || norm <= 1e-20 {
                continue;
            }
            let factor = (current[region] - baseline[region] - 0.05) / norm;
            for (values, direction) in candidate.data.chunks_exact_mut(3).zip(gradient) {
                for c in 0..3 {
                    values[c] -= (factor * direction[c]) as f32;
                }
            }
        }
        constrain_to_prior(&mut candidate.data, origin, confidence);
    }
}

fn error(rgb: [f64; 3], target: [f64; 3]) -> f64 {
    f64::from(ciede2000(
        lab(rgb.map(|v| v as f32)),
        lab(target.map(|v| v as f32)),
    ))
}
