use super::ColorLut;
use rayon::prelude::*;

fn minimum(prior: &[f32], i: usize, j: usize, epsilon: f64) -> f64 {
    (f64::from(prior[j]) - f64::from(prior[i])).min(epsilon)
}

#[cfg(test)]
fn project_edge(
    data: &mut [f32],
    prior: &[f32],
    confidence: &[f64],
    i: usize,
    j: usize,
    epsilon: f64,
) {
    project(
        data,
        prior,
        [confidence[i / 3], confidence[j / 3]],
        i,
        j,
        epsilon,
    );
}

fn project(data: &mut [f32], prior: &[f32], [wi, wj]: [f64; 2], i: usize, j: usize, epsilon: f64) {
    let lower = minimum(prior, i, j, epsilon);
    let deficit = lower - (f64::from(data[j]) - f64::from(data[i]));
    if deficit <= 0. {
        return;
    }
    let mut a = f64::from(data[i]) - deficit * wj / (wi + wj);
    let mut b = f64::from(data[j]) + deficit * wi / (wi + wj);
    if a < 0. {
        a = 0.;
        b = lower;
    } else if b > 1. {
        b = 1.;
        a = 1. - lower;
    }
    data[i] = a.clamp(0., 1.) as f32;
    data[j] = b.clamp(0., 1.) as f32;
}

/// Each channel is constrained only along its own axis and the grey
/// diagonal, so the three channels are independent sequences; running them
/// in parallel keeps every channel's update order and its bits (#5104).
pub(super) fn constrain_to_prior(data: &mut [f32], prior: &ColorLut, confidence: &[f64]) {
    let channels: Vec<Vec<f32>> = (0..3)
        .into_par_iter()
        .map(|c| {
            let mut values: Vec<f32> = data.iter().skip(c).step_by(3).copied().collect();
            let reference: Vec<f32> = prior.data.iter().skip(c).step_by(3).copied().collect();
            constrain_channel(&mut values, &reference, confidence, prior.size, c);
            values
        })
        .collect();
    for (node, values) in data.chunks_exact_mut(3).enumerate() {
        for c in 0..3 {
            values[c] = channels[c][node];
        }
    }
}

fn constrain_channel(data: &mut [f32], prior: &[f32], confidence: &[f64], n: usize, c: usize) {
    let epsilon = f64::from(0.002 / (n - 1) as f32);
    let stride = [1, n, n * n][c];
    let diagonal = 1 + n + n * n;
    for value in data.iter_mut() {
        *value = value.clamp(0., 1.);
    }
    for _ in 0..32 {
        for node in 0..data.len() {
            if node / stride % n + 1 < n {
                let j = node + stride;
                project(
                    data,
                    prior,
                    [confidence[node], confidence[j]],
                    node,
                    j,
                    epsilon,
                );
            }
        }
        for k in 0..n - 1 {
            let i = k * diagonal;
            let j = i + diagonal;
            project(data, prior, [confidence[i], confidence[j]], i, j, epsilon);
        }
    }
    feasible_closure(data, prior, n, stride, epsilon);
}

fn feasible_closure(data: &mut [f32], prior: &[f32], n: usize, stride: usize, epsilon: f64) {
    let diagonal = 1 + n + n * n;
    let on_diagonal = |node: usize| node % diagonal == 0;
    let mut upper = vec![1f64; data.len()];
    for node in (0..data.len()).rev() {
        if node / stride % n + 1 < n {
            let j = node + stride;
            upper[node] = upper[node].min(upper[j] - minimum(prior, node, j, epsilon));
        }
        if on_diagonal(node) && node + diagonal < data.len() {
            let j = node + diagonal;
            upper[node] = upper[node].min(upper[j] - minimum(prior, node, j, epsilon));
        }
    }
    let mut result: Vec<f64> = data
        .iter()
        .zip(&upper)
        .map(|(&v, &limit)| f64::from(v).clamp(0., limit.max(0.)))
        .collect();
    // The constraint graph is acyclic; a forward closure under its feasible upper envelope finishes every edge.
    for node in 0..data.len() {
        if node / stride % n > 0 {
            let j = node - stride;
            result[node] = result[node].max(result[j] + minimum(prior, j, node, epsilon));
        }
        if on_diagonal(node) && node > 0 {
            let j = node - diagonal;
            result[node] = result[node].max(result[j] + minimum(prior, j, node, epsilon));
        }
        result[node] = result[node].min(upper[node]).clamp(0., 1.);
    }
    for (value, result) in data.iter_mut().zip(result) {
        *value = result as f32;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn supported_nodes_move_only_as_far_as_the_unchanged_constraint_requires() {
        let prior = [0., 0., 0., 1., 1., 1.];
        let mut data = [0.9, 0., 0., 0.1, 1., 1.];
        project_edge(&mut data, &prior, &[1., 1e-8], 0, 3, 0.01);
        assert!((data[0] - 0.9).abs() < 1e-7);
        assert!(data[3] - data[0] >= 0.01 - 1e-7);
        data[0] = 1.;
        data[3] = 0.5;
        project_edge(&mut data, &prior, &[1., 1e-8], 0, 3, 0.01);
        assert_eq!(data[3], 1.);
        assert!((data[0] - 0.99).abs() < 1e-7);
    }

    #[test]
    fn projection_finishes_all_axis_and_gray_constraints_with_unequal_confidence() {
        let n = 9;
        let prior = ColorLut::identity(n);
        let mut data: Vec<_> = (0..prior.data.len())
            .map(|i| ((i * 193 + 71) % 997) as f32 / 996.)
            .collect();
        let confidence: Vec<_> = (0..n * n * n)
            .map(|i| if i % 7 == 0 { 1. } else { 1e-8 })
            .collect();
        constrain_to_prior(&mut data, &prior, &confidence);
        assert!(data.iter().all(|v| v.is_finite() && (0. ..=1.).contains(v)));
        let epsilon = f64::from(0.002 / (n - 1) as f32);
        for node in 0..n * n * n {
            let xyz = [node % n, node / n % n, node / (n * n)];
            for c in 0..3 {
                let i = node * 3 + c;
                let mut successors = Vec::new();
                if xyz[c] + 1 < n {
                    successors.push(node + [1, n, n * n][c]);
                }
                if xyz[0] == xyz[1] && xyz[1] == xyz[2] && xyz[0] + 1 < n {
                    successors.push(node + 1 + n + n * n);
                }
                for successor in successors {
                    let j = successor * 3 + c;
                    assert!(
                        f64::from(data[j]) - f64::from(data[i]) + 2e-7
                            >= minimum(&prior.data, i, j, epsilon)
                    );
                }
            }
        }
    }
}
