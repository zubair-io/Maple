use super::ColorLut;

fn minimum(prior: &[f32], i: usize, j: usize, epsilon: f64) -> f64 {
    (f64::from(prior[j]) - f64::from(prior[i])).min(epsilon)
}

fn project_edge(
    data: &mut [f32],
    prior: &[f32],
    confidence: &[f64],
    i: usize,
    j: usize,
    epsilon: f64,
) {
    let lower = minimum(prior, i, j, epsilon);
    let deficit = lower - (f64::from(data[j]) - f64::from(data[i]));
    if deficit <= 0. {
        return;
    }
    let (wi, wj) = (confidence[i / 3], confidence[j / 3]);
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

pub(super) fn constrain_to_prior(data: &mut [f32], prior: &ColorLut, confidence: &[f64]) {
    let n = prior.size;
    let epsilon = f64::from(0.002 / (n - 1) as f32);
    for value in data.iter_mut() {
        *value = value.clamp(0., 1.);
    }
    for _ in 0..32 {
        for z in 0..n {
            for y in 0..n {
                for x in 0..n {
                    let i = ((z * n + y) * n + x) * 3;
                    for (c, (coordinate, stride)) in
                        [(x, 3), (y, 3 * n), (z, 3 * n * n)].into_iter().enumerate()
                    {
                        if coordinate + 1 < n {
                            project_edge(
                                data,
                                &prior.data,
                                confidence,
                                i + c,
                                i + stride + c,
                                epsilon,
                            );
                        }
                    }
                }
            }
        }
        for k in 0..n - 1 {
            let i = ((k * n + k) * n + k) * 3;
            let j = (((k + 1) * n + k + 1) * n + k + 1) * 3;
            for c in 0..3 {
                project_edge(data, &prior.data, confidence, i + c, j + c, epsilon);
            }
        }
    }
    feasible_closure(data, prior, epsilon);
}

fn feasible_closure(data: &mut [f32], prior: &ColorLut, epsilon: f64) {
    let n = prior.size;
    let count = n * n * n;
    let strides = [1, n, n * n];
    let diagonal = 1 + n + n * n;
    let mut upper = vec![1f64; data.len()];
    for node in (0..count).rev() {
        let xyz = [node % n, node / n % n, node / (n * n)];
        for c in 0..3 {
            let i = node * 3 + c;
            if xyz[c] + 1 < n {
                let j = (node + strides[c]) * 3 + c;
                upper[i] = upper[i].min(upper[j] - minimum(&prior.data, i, j, epsilon));
            }
            if xyz[0] == xyz[1] && xyz[1] == xyz[2] && xyz[0] + 1 < n {
                let j = (node + diagonal) * 3 + c;
                upper[i] = upper[i].min(upper[j] - minimum(&prior.data, i, j, epsilon));
            }
        }
    }
    let mut result: Vec<f64> = data
        .iter()
        .zip(&upper)
        .map(|(&v, &limit)| f64::from(v).clamp(0., limit.max(0.)))
        .collect();
    // The constraint graph is acyclic; a forward closure under its feasible upper envelope finishes every edge.
    for node in 0..count {
        let xyz = [node % n, node / n % n, node / (n * n)];
        for c in 0..3 {
            let i = node * 3 + c;
            if xyz[c] > 0 {
                let j = (node - strides[c]) * 3 + c;
                result[i] = result[i].max(result[j] + minimum(&prior.data, j, i, epsilon));
            }
            if xyz[0] == xyz[1] && xyz[1] == xyz[2] && xyz[0] > 0 {
                let j = (node - diagonal) * 3 + c;
                result[i] = result[i].max(result[j] + minimum(&prior.data, j, i, epsilon));
            }
            result[i] = result[i].min(upper[i]).clamp(0., 1.);
        }
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
