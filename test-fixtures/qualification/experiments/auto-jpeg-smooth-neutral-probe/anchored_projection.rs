use super::ColorLut;

pub(super) fn is_neutral_node(node: usize, size: usize) -> bool {
    node % size == node / size % size && node / size % size == node / (size * size)
}

pub(super) fn constrain_to_prior(
    data: &mut [f32],
    prior: &ColorLut,
    confidence: &[f64],
    anchors: &[f32],
) {
    super::super::projection::constrain_to_prior(data, prior, confidence);
    let n = prior.size;
    let count = n.pow(3);
    let epsilon = f64::from(0.002 / (n - 1) as f32);
    let strides = [1, n, n * n];
    let diagonal = 1 + n + n * n;
    let minimum =
        |i: usize, j: usize| (f64::from(prior.data[j]) - f64::from(prior.data[i])).min(epsilon);
    let mut upper = vec![1.; data.len()];
    for node in 0..count {
        if is_neutral_node(node, n) {
            for c in 0..3 {
                upper[node * 3 + c] = f64::from(anchors[node * 3 + c]);
            }
        }
    }
    for node in (0..count).rev() {
        let xyz = [node % n, node / n % n, node / (n * n)];
        for c in 0..3 {
            let i = node * 3 + c;
            if xyz[c] + 1 < n {
                let j = (node + strides[c]) * 3 + c;
                upper[i] = upper[i].min(upper[j] - minimum(i, j));
            }
            if is_neutral_node(node, n) && xyz[0] + 1 < n {
                let j = (node + diagonal) * 3 + c;
                upper[i] = upper[i].min(upper[j] - minimum(i, j));
            }
        }
    }
    let mut result: Vec<_> = data
        .iter()
        .zip(&upper)
        .map(|(&value, &limit)| f64::from(value).clamp(0., limit.max(0.)))
        .collect();
    for node in 0..count {
        let xyz = [node % n, node / n % n, node / (n * n)];
        for c in 0..3 {
            let i = node * 3 + c;
            if is_neutral_node(node, n) {
                result[i] = f64::from(anchors[i]);
            }
            if xyz[c] > 0 {
                let j = (node - strides[c]) * 3 + c;
                result[i] = result[i].max(result[j] + minimum(j, i));
            }
            if is_neutral_node(node, n) && xyz[0] > 0 {
                let j = (node - diagonal) * 3 + c;
                result[i] = result[i].max(result[j] + minimum(j, i));
            }
            result[i] = result[i].min(upper[i]).clamp(0., 1.);
        }
    }
    for (value, result) in data.iter_mut().zip(result) {
        *value = result as f32;
    }
}
