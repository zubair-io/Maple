use super::{projection::is_neutral_node, Observation, TrainingRow};

use rayon::prelude::*;

const CHUNK: usize = 2048;

/// Assembly may cost at most this many row walks' worth of multiply-adds per
/// solve; the full-resolution 100 MP fixture needs about 53.
const ASSEMBLY_WORK_PER_ROW_TERM: usize = 64;

/// The training rows' sparsity laid out row-major and node-major with rows in
/// their original order, so `scatter`, the Jacobi diagonal and the row-walk
/// product keep the original bits. The assembled product sums in a different
/// order, moving Auto by ≤ 1/255 (#5104); rows too wide to assemble within
/// budget keep the row walk.
pub(super) struct Pattern {
    row_start: Vec<usize>,
    row_nodes: Vec<usize>,
    row_weights: Vec<f64>,
    node_start: Vec<usize>,
    node_rows: Vec<usize>,
    node_weights: Vec<f64>,
    edge_start: Vec<usize>,
    edge_peers: Vec<(usize, bool)>,
    normal: Option<NormalPattern>,
}

struct NormalPattern {
    start: Vec<usize>,
    columns: Vec<usize>,
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
        let normal = normal_pattern(&row_start, &row_nodes, &node_start, &node_rows, count);
        Self {
            row_start,
            row_nodes,
            row_weights,
            node_start,
            node_rows,
            node_weights,
            edge_start,
            edge_peers,
            normal,
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

/// Column sets of `Σ wᵣ·aᵣaᵣᵀ`, or `None` when assembling it would cost more
/// than the budget or hold more entries than the row layout itself.
fn normal_pattern(
    row_start: &[usize],
    row_nodes: &[usize],
    node_start: &[usize],
    node_rows: &[usize],
    count: usize,
) -> Option<NormalPattern> {
    let assembly_work: usize = row_start.windows(2).map(|r| (r[1] - r[0]).pow(2)).sum();
    if assembly_work > ASSEMBLY_WORK_PER_ROW_TERM * row_nodes.len() {
        return None;
    }
    let layout = (row_start, row_nodes, node_start, node_rows);
    let mut seen = vec![usize::MAX; count];
    let mut entries = 0;
    for node in 0..count {
        each_column(layout, node, &mut seen, |_| entries += 1);
    }
    if entries > row_nodes.len() {
        return None;
    }
    seen.fill(usize::MAX);
    let mut start = Vec::with_capacity(count + 1);
    start.push(0);
    let mut columns = Vec::with_capacity(entries);
    for node in 0..count {
        let first = columns.len();
        each_column(layout, node, &mut seen, |j| columns.push(j));
        columns[first..].sort_unstable();
        start.push(columns.len());
    }
    Some(NormalPattern { start, columns })
}

type Layout<'a> = (&'a [usize], &'a [usize], &'a [usize], &'a [usize]);

fn each_column(
    (row_start, row_nodes, node_start, node_rows): Layout<'_>,
    node: usize,
    seen: &mut [usize],
    mut visit: impl FnMut(usize),
) {
    for &row in &node_rows[node_start[node]..node_start[node + 1]] {
        for &j in &row_nodes[row_start[row]..row_start[row + 1]] {
            if seen[j] != node {
                seen[j] = node;
                visit(j);
            }
        }
    }
}

/// The weighted data term `Σ wᵣ·aᵣaᵣᵀ`, one sorted sparse row per node.
fn assemble(
    pattern: &Pattern,
    normal: &NormalPattern,
    coefficients: &[f64],
    count: usize,
) -> Vec<f64> {
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
                normal.columns[normal.start[node]..normal.start[node + 1]]
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
    normal: Option<Vec<f64>>,
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
        // One λ per edge, not degree·λ: the repeated sum keeps the diagonal's bits.
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
        let normal = pattern
            .normal
            .as_ref()
            .map(|normal| assemble(pattern, normal, &coefficients, count));
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

    fn multiply(&self, values: &[f64], per_row: &mut [f64], result: &mut [f64]) {
        let pattern = self.pattern;
        let assembled = pattern.normal.as_ref().zip(self.normal.as_ref());
        if assembled.is_none() {
            per_row
                .par_chunks_mut(CHUNK)
                .enumerate()
                .for_each(|(chunk, out)| {
                    for (offset, value) in out.iter_mut().enumerate() {
                        let row = chunk * CHUNK + offset;
                        let range = pattern.row_start[row]..pattern.row_start[row + 1];
                        *value = pattern.row_nodes[range.clone()]
                            .iter()
                            .zip(&pattern.row_weights[range])
                            .map(|(&i, &w)| w * values[i])
                            .sum();
                    }
                });
        }
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
                    match assembled {
                        Some((normal, entries)) => {
                            let range = normal.start[node]..normal.start[node + 1];
                            for (&column, &entry) in
                                normal.columns[range.clone()].iter().zip(&entries[range])
                            {
                                *value += entry * values[column];
                            }
                        }
                        None => {
                            for k in pattern.node_start[node]..pattern.node_start[node + 1] {
                                *value += self.coefficients[k] * per_row[pattern.node_rows[k]];
                            }
                        }
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

    #[cfg(test)]
    fn product_terms(&self) -> usize {
        let data_terms = self
            .normal
            .as_ref()
            .map_or(2 * self.pattern.row_nodes.len(), Vec::len);
        data_terms + self.pattern.edge_peers.len() + self.diagonal.len()
    }

    pub(super) fn solve(&self, rhs: &[f64], initial: Vec<f64>) -> Option<(Vec<f64>, usize)> {
        let dot = |a: &[f64], b: &[f64]| a.iter().zip(b).map(|(u, v)| u * v).sum::<f64>();
        let mut ap = vec![0.; rhs.len()];
        let mut per_row = vec![
            0.;
            if self.normal.is_some() {
                0
            } else {
                self.pattern.row_start.len() - 1
            }
        ];
        let mut rhs = rhs.to_vec();
        let mut x = initial;
        for i in 0..x.len() {
            if self.fixed[i] {
                x[i] = 0.;
                rhs[i] = 0.;
            }
        }
        self.multiply(&x, &mut per_row, &mut ap);
        let mut products = 1;
        let mut r: Vec<_> = rhs.iter().zip(&ap).map(|(b, a)| b - a).collect();
        let mut z: Vec<_> = r.iter().zip(&self.diagonal).map(|(v, d)| v / d).collect();
        let mut p = z.clone();
        let mut rz = dot(&r, &z);
        let norm = dot(&rhs, &rhs);
        if norm < 1e-25 {
            return Some((vec![0.; rhs.len()], products));
        }
        for _ in 0..256 {
            if dot(&r, &r) <= norm * 1e-12 {
                break;
            }
            self.multiply(&p, &mut per_row, &mut ap);
            products += 1;
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
        x.iter().all(|v| v.is_finite()).then_some((x, products))
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
#[path = "paired_refinement_system_tests.rs"]
mod tests;
