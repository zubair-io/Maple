//! A separable monotone restart for the same baked-LUT optimization.
//! Marginalize the exact tetrahedral design; no second image pass or proxy loss.
use super::{curve::eval_channel, jpeg_band_design::Design, lut::ColorLut, solve};

pub(super) fn channel(lut: &ColorLut, design: &Design, c: usize) -> Vec<f64> {
    let n = lut.size;
    let stride = [1, n, n * n][c];
    let mut matrix = [[0.0f64; solve::ANCHORS]; 5];
    for b in 0..5 {
        if design.counts[b] < 100 {
            continue;
        }
        for (node, &weight) in design.rows[b].iter().enumerate() {
            let v = ((node / stride) % n) as f32 / (n - 1) as f32;
            let position = v * (solve::ANCHORS - 1) as f32;
            let lo = (position.floor() as usize).min(solve::ANCHORS - 2);
            let f = f64::from(position - lo as f32);
            matrix[b][lo] += weight * (1. - f);
            matrix[b][lo + 1] += weight * f;
        }
    }
    let matrix = matrix.map(|row| row.map(|v| v as f32));
    let targets = std::array::from_fn(|b| design.targets[b][c] as f32);
    let curve = solve::solve_minimax_monotone(&matrix, &targets, &design.counts);
    (0..n * n * n)
        .map(|node| {
            let v = ((node / stride) % n) as f32 / (n - 1) as f32;
            f64::from(eval_channel(&curve, v))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn prior_matches_feasible_separable_baked_node_targets() {
        let n = 33;
        let lut = ColorLut::identity(n);
        let mut design = Design {
            rows: std::array::from_fn(|_| vec![0.; n * n * n]),
            targets: [[0.; 3]; 5],
            counts: [100; 5],
        };
        for (b, k) in [6usize, 10, 16, 22, 26].into_iter().enumerate() {
            let node = (k * n + k) * n + k;
            design.rows[b][node] = 1.;
            let v = k as f64 / (n - 1) as f64;
            design.targets[b] = [1.4 * (v - 0.5) + 0.5; 3];
        }
        let prior = channel(&lut, &design, 0);
        for b in 0..5 {
            let predicted = design.rows[b]
                .iter()
                .zip(&prior)
                .map(|(a, v)| a * v)
                .sum::<f64>();
            assert!((predicted - design.targets[b][0]).abs() < 0.01);
        }
        for bg in 0..n * n {
            for r in 1..n {
                assert!(prior[bg * n + r] >= prior[bg * n + r - 1]);
            }
        }
    }
}
