use super::{projection::is_neutral_node, Observation, TrainingRow};

pub(super) struct System<'a> {
    rows: &'a [TrainingRow<'a>],
    weights: &'a [f64],
    edges: &'a [(usize, usize)],
    pub diagonal: Vec<f64>,
    lambda: f64,
    ridge: f64,
    fixed: Vec<bool>,
}

impl<'a> System<'a> {
    pub(super) fn new(
        rows: &'a [TrainingRow<'a>],
        weights: &'a [f64],
        size: usize,
        edges: &'a [(usize, usize)],
    ) -> Self {
        let count = size.pow(3);
        let lambda = 1e-5 * 8. / (size - 1) as f64 * 20.;
        let ridge = 1e-8 * 9f64.powi(3) / count as f64 * 20.;
        let mut diagonal = vec![ridge; count];
        for (entry, &weight) in rows.iter().zip(weights) {
            for &(i, w) in &entry.row.artifact_weights {
                diagonal[i] += weight * w * w;
            }
        }
        for &(i, j) in edges {
            diagonal[i] += lambda;
            diagonal[j] += lambda;
        }
        let fixed: Vec<_> = (0..count).map(|i| is_neutral_node(i, size)).collect();
        for i in 0..count {
            if fixed[i] {
                diagonal[i] = 1.;
            }
        }
        Self {
            fixed,
            rows,
            weights,
            edges,
            diagonal,
            lambda,
            ridge,
        }
    }

    fn multiply(&self, values: &[f64]) -> Vec<f64> {
        let mut result: Vec<_> = values.iter().map(|v| v * self.ridge).collect();
        for (entry, &weight) in self.rows.iter().zip(self.weights) {
            let value: f64 = entry
                .row
                .artifact_weights
                .iter()
                .map(|&(i, w)| w * values[i])
                .sum();
            for &(i, w) in &entry.row.artifact_weights {
                result[i] += weight * w * value;
            }
        }
        for &(i, j) in self.edges {
            let delta = self.lambda * (values[i] - values[j]);
            result[i] += delta;
            result[j] -= delta;
        }
        for i in 0..result.len() {
            if self.fixed[i] {
                result[i] = values[i];
            }
        }
        result
    }

    pub(super) fn solve(&self, rhs: &[f64], initial: Vec<f64>) -> Option<Vec<f64>> {
        let dot = |a: &[f64], b: &[f64]| a.iter().zip(b).map(|(u, v)| u * v).sum::<f64>();
        let mut rhs = rhs.to_vec();
        let mut x = initial;
        for i in 0..x.len() {
            if self.fixed[i] {
                x[i] = 0.;
                rhs[i] = 0.;
            }
        }
        let ax = self.multiply(&x);
        let mut r: Vec<_> = rhs.iter().zip(ax).map(|(b, a)| b - a).collect();
        let mut z: Vec<_> = r.iter().zip(&self.diagonal).map(|(v, d)| v / d).collect();
        let mut p = z.clone();
        let mut rz = dot(&r, &z);
        let norm = dot(&rhs, &rhs);
        if norm < 1e-25 {
            return Some(vec![0.; rhs.len()]);
        }
        for _ in 0..256 {
            if dot(&r, &r) <= norm * 1e-12 {
                break;
            }
            let ap = self.multiply(&p);
            let denominator = dot(&p, &ap);
            if !denominator.is_finite() || denominator <= 0. {
                return None;
            }
            let alpha = rz / denominator;
            for i in 0..x.len() {
                x[i] += alpha * p[i];
                r[i] -= alpha * ap[i];
                z[i] = r[i] / self.diagonal[i];
            }
            let next = dot(&r, &z);
            let beta = next / rz;
            for i in 0..p.len() {
                p[i] = z[i] + beta * p[i];
            }
            rz = next;
        }
        x.iter().all(|v| v.is_finite()).then_some(x)
    }
}

pub(super) fn edges(size: usize) -> Vec<(usize, usize)> {
    let mut result = Vec::new();
    for i in 0..size.pow(3) {
        for stride in [1, size, size * size] {
            if i / stride % size + 1 < size {
                result.push((i, i + stride));
            }
        }
    }
    result
}

pub(super) fn prediction(lut: &[f32], row: &Observation) -> [f64; 3] {
    std::array::from_fn(|c| {
        row.artifact_weights
            .iter()
            .map(|&(i, w)| w * f64::from(lut[i * 3 + c]))
            .sum()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn matrix_free_solution_matches_its_independent_normal_equation_residual() {
        let row = Observation {
            weights: vec![],
            artifact_weights: vec![(1, 0.25), (2, 0.75)],
            source: [0.; 3],
            target: [0.; 3],
            baseline: [0.; 3],
            population: 1,
            validation: false,
            in_bias_region: true,
            region: 0,
        };
        let rows = [TrainingRow {
            row: &row,
            groups: [0, 1],
            count: 2,
        }];
        let weights = [2.];
        let edges = edges(2);
        let system = System::new(&rows, &weights, 2, &edges);
        let rhs = vec![0., 0.5, 1.5, 0., 0., 0., 0., 0.];
        let solved = system.solve(&rhs, vec![0.; 8]).unwrap();
        let mut residual: Vec<_> = solved.iter().map(|v| v * system.ridge).collect();
        let predicted = 0.25 * solved[1] + 0.75 * solved[2];
        residual[1] += 0.5 * predicted;
        residual[2] += 1.5 * predicted;
        for &(i, j) in &edges {
            let delta = system.lambda * (solved[i] - solved[j]);
            residual[i] += delta;
            residual[j] -= delta;
        }
        residual[0] = solved[0];
        residual[7] = solved[7];
        assert_eq!(solved[0], 0.);
        assert_eq!(solved[7], 0.);
        assert!(residual.iter().zip(rhs).all(|(a, b)| (a - b).abs() < 1e-6));
    }
}
