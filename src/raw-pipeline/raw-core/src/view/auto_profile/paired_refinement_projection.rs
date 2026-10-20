use super::ColorLut;

pub(super) fn is_neutral_node(node: usize, size: usize) -> bool {
    node % size == node / size % size && node / size % size == node / (size * size)
}

pub(super) fn constrain_to_prior(data: &mut [f32], prior: &ColorLut, confidence: &[f64]) {
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
                upper[node * 3 + c] = f64::from(prior.data[node * 3 + c]);
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
                result[i] = f64::from(prior.data[i]);
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

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn neutral_axis_is_exactly_anchored_without_dropping_axis_constraints() {
        let n = 5;
        let prior = ColorLut::identity(n);
        let mut data: Vec<_> = (0..prior.data.len())
            .map(|i| ((i * 71 + 13) % 997) as f32 / 996.)
            .collect();
        constrain_to_prior(&mut data, &prior, &vec![1.; n.pow(3)]);
        let anchored = ColorLut {
            size: n,
            data: data.clone(),
        };
        for i in 0..1024 {
            let gray = [i as f32 / 1023.; 3];
            assert_eq!(anchored.sample(gray), prior.sample(gray));
        }
        for node in 0..n.pow(3) {
            for c in 0..3 {
                if is_neutral_node(node, n) {
                    assert_eq!(data[node * 3 + c], prior.data[node * 3 + c]);
                }
                let stride = [1, n, n * n][c];
                if node / stride % n + 1 < n {
                    assert!(
                        data[(node + stride) * 3 + c] - data[node * 3 + c]
                            >= 0.002 / (n - 1) as f32 - 1e-7
                    );
                }
            }
        }
    }
}
