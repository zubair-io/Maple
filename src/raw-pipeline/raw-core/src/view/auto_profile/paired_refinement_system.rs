use super::{projection::is_neutral_node, Observation, TrainingRow};

use rayon::prelude::*;

const CHUNK: usize = 2048;

/// The training rows' sparsity laid out twice: row-major for the per-row dot
/// products, node-major (rows in their original order) for the per-node sums.
/// Every output element is computed by one thread in the original order, so a
/// parallel product is byte-identical to the sequential row walk (#5104).
pub(super) struct Pattern {
    row_start: Vec<usize>,
    row_nodes: Vec<usize>,
    row_weights: Vec<f64>,
    node_start: Vec<usize>,
    node_rows: Vec<usize>,
    node_weights: Vec<f64>,
    edge_start: Vec<usize>,
    edge_peers: Vec<(usize, bool)>,
    normal_start: Vec<usize>,
    normal_columns: Vec<usize>,
}

impl Pattern {
    pub(super) fn new(rows: &[TrainingRow<'_>], size: usize, edges: &[(usize, usize)]) -> Self {
        let count = size.pow(3);
        let row_start: Vec<_> = std::iter::once(0)
            .chain(rows.iter().scan(0, |end, entry| {
                *end += entry.row.artifact_weights.len();
                Some(*end)
            }))
            .collect();
        let (row_nodes, row_weights): (Vec<_>, Vec<_>) = rows
            .iter()
            .flat_map(|entry| entry.row.artifact_weights.iter().copied())
            .unzip();
        let node_start = offsets(count, row_nodes.iter().copied());
        let mut cursor = node_start.clone();
        let mut node_rows = vec![0; row_nodes.len()];
        let mut node_weights = vec![0.; row_nodes.len()];
        for (row, entry) in rows.iter().enumerate() {
            for &(i, w) in &entry.row.artifact_weights {
                node_rows[cursor[i]] = row;
                node_weights[cursor[i]] = w;
                cursor[i] += 1;
            }
        }
        let edge_start = offsets(count, edges.iter().flat_map(|&(i, j)| [i, j]));
        let mut cursor = edge_start.clone();
        let mut edge_peers = vec![(0, false); edges.len() * 2];
        for &(i, j) in edges {
            edge_peers[cursor[i]] = (j, true);
            cursor[i] += 1;
            edge_peers[cursor[j]] = (i, false);
            cursor[j] += 1;
        }
        let mut seen = vec![usize::MAX; count];
        let mut normal_start = vec![0];
        let mut normal_columns = Vec::new();
        for node in 0..count {
            let first = normal_columns.len();
            for &row in &node_rows[node_start[node]..node_start[node + 1]] {
                for &j in &row_nodes[row_start[row]..row_start[row + 1]] {
                    if seen[j] != node {
                        seen[j] = node;
                        normal_columns.push(j);
                    }
                }
            }
            normal_columns[first..].sort_unstable();
            normal_start.push(normal_columns.len());
        }
        Self {
            row_start,
            row_nodes,
            row_weights,
            node_start,
            node_rows,
            node_weights,
            edge_start,
            edge_peers,
            normal_start,
            normal_columns,
        }
    }

    /// `out[i] = Σ coefficient[k] · per_row[row_k]` over node `i`'s rows, in row order.
    pub(super) fn scatter(&self, coefficients: &[f64], per_row: &[f64], out: &mut [f64]) {
        out.par_chunks_mut(CHUNK)
            .enumerate()
            .for_each(|(chunk, out)| {
                for (offset, value) in out.iter_mut().enumerate() {
                    let node = chunk * CHUNK + offset;
                    for k in self.node_start[node]..self.node_start[node + 1] {
                        *value += coefficients[k] * per_row[self.node_rows[k]];
                    }
                }
            });
    }
}

/// The weighted data term `Σ wᵣ·aᵣaᵣᵀ`, one sorted sparse row per node.
fn assemble(pattern: &Pattern, coefficients: &[f64], count: usize) -> Vec<f64> {
    let rows: Vec<Vec<f64>> = (0..count)
        .into_par_iter()
        .map_init(
            || vec![0.; count],
            |scratch, node| {
                for k in pattern.node_start[node]..pattern.node_start[node + 1] {
                    let row = pattern.node_rows[k];
                    let range = pattern.row_start[row]..pattern.row_start[row + 1];
                    for (&j, &w) in pattern.row_nodes[range.clone()]
                        .iter()
                        .zip(&pattern.row_weights[range])
                    {
                        scratch[j] += coefficients[k] * w;
                    }
                }
                pattern.normal_columns[pattern.normal_start[node]..pattern.normal_start[node + 1]]
                    .iter()
                    .map(|&j| std::mem::take(&mut scratch[j]))
                    .collect()
            },
        )
        .collect();
    rows.concat()
}

fn offsets(count: usize, nodes: impl Iterator<Item = usize>) -> Vec<usize> {
    let mut start = vec![0; count + 1];
    for node in nodes {
        start[node + 1] += 1;
    }
    for i in 0..count {
        start[i + 1] += start[i];
    }
    start
}

pub(super) struct System<'a> {
    pattern: &'a Pattern,
    coefficients: Vec<f64>,
    normal: Vec<f64>,
    pub diagonal: Vec<f64>,
    lambda: f64,
    ridge: f64,
    fixed: Vec<bool>,
}

impl<'a> System<'a> {
    pub(super) fn new(pattern: &'a Pattern, weights: &[f64], size: usize) -> Self {
        let count = size.pow(3);
        let lambda = 1e-5 * 8. / (size - 1) as f64 * 20.;
        let ridge = 1e-8 * 9f64.powi(3) / count as f64 * 20.;
        let coefficients: Vec<f64> = pattern
            .node_rows
            .iter()
            .zip(&pattern.node_weights)
            .map(|(&row, &w)| weights[row] * w)
            .collect();
        let mut diagonal = vec![ridge; count];
        for (node, value) in diagonal.iter_mut().enumerate() {
            for k in pattern.node_start[node]..pattern.node_start[node + 1] {
                *value += coefficients[k] * pattern.node_weights[k];
            }
        }
        for (node, value) in diagonal.iter_mut().enumerate() {
            for _ in pattern.edge_start[node]..pattern.edge_start[node + 1] {
                *value += lambda;
            }
        }
        let fixed: Vec<_> = (0..count).map(|i| is_neutral_node(i, size)).collect();
        for i in 0..count {
            if fixed[i] {
                diagonal[i] = 1.;
            }
        }
        let normal = assemble(pattern, &coefficients, count);
        Self {
            pattern,
            coefficients,
            normal,
            fixed,
            diagonal,
            lambda,
            ridge,
        }
    }

    pub(super) fn coefficients(&self) -> &[f64] {
        &self.coefficients
    }

    fn multiply(&self, values: &[f64], result: &mut [f64]) {
        let pattern = self.pattern;
        result
            .par_chunks_mut(CHUNK)
            .enumerate()
            .for_each(|(chunk, out)| {
                for (offset, value) in out.iter_mut().enumerate() {
                    let node = chunk * CHUNK + offset;
                    if self.fixed[node] {
                        *value = values[node];
                        continue;
                    }
                    *value = values[node] * self.ridge;
                    let range = pattern.normal_start[node]..pattern.normal_start[node + 1];
                    for (&column, &entry) in pattern.normal_columns[range.clone()]
                        .iter()
                        .zip(&self.normal[range])
                    {
                        *value += entry * values[column];
                    }
                    for &(peer, first) in
                        &pattern.edge_peers[pattern.edge_start[node]..pattern.edge_start[node + 1]]
                    {
                        if first {
                            *value += self.lambda * (values[node] - values[peer]);
                        } else {
                            *value -= self.lambda * (values[peer] - values[node]);
                        }
                    }
                }
            });
    }

    pub(super) fn solve(&self, rhs: &[f64], initial: Vec<f64>) -> Option<Vec<f64>> {
        let dot = |a: &[f64], b: &[f64]| a.iter().zip(b).map(|(u, v)| u * v).sum::<f64>();
        let mut ap = vec![0.; rhs.len()];
        let mut rhs = rhs.to_vec();
        let mut x = initial;
        for i in 0..x.len() {
            if self.fixed[i] {
                x[i] = 0.;
                rhs[i] = 0.;
            }
        }
        self.multiply(&x, &mut ap);
        let mut r: Vec<_> = rhs.iter().zip(&ap).map(|(b, a)| b - a).collect();
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
            self.multiply(&p, &mut ap);
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
        let pattern = Pattern::new(&rows, 2, &edges);
        let system = System::new(&pattern, &weights, 2);
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
