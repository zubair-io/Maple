//! Smooth paired-pixel Auto alternative, validated on held-out pairs (#5000).
use super::{lut::ColorLut, pairs::DisplayPair};
const N: usize = 17;
const MIN_STEP: f64 = 0.02 / (N - 1) as f64;

fn monotone(values: &mut [f64; N]) {
    let mut means = [0.; N];
    let mut weights = [0usize; N];
    let mut blocks = 0;
    for (i, value) in values.iter().enumerate() {
        means[blocks] = value - i as f64 * MIN_STEP;
        weights[blocks] = 1;
        blocks += 1;
        while blocks > 1 && means[blocks - 2] > means[blocks - 1] {
            let a = blocks - 2;
            let count = weights[a] + weights[a + 1];
            means[a] = (means[a] * weights[a] as f64 + means[a + 1] * weights[a + 1] as f64)
                / count as f64;
            weights[a] = count;
            blocks -= 1;
        }
    }
    let mut index = 0;
    for block in 0..blocks {
        for _ in 0..weights[block] {
            values[index] =
                means[block].clamp(0., 1. - MIN_STEP * (N - 1) as f64) + index as f64 * MIN_STEP;
            index += 1;
        }
    }
}

fn channel(pairs: &[DisplayPair], stride: usize, c: usize) -> [f64; N] {
    let mut a = [[0.; N]; N];
    let mut b = [0.; N];
    let mut count = 0;
    for (i, pair) in pairs.iter().step_by(stride).enumerate() {
        if i % 4 == 0 {
            continue;
        }
        let x = f64::from(pair.maple[c].clamp(0., 1.)) * (N - 1) as f64;
        let lo = (x.floor() as usize).min(N - 2);
        let f = x - lo as f64;
        let nodes = [(lo, 1. - f), (lo + 1, f)];
        for (j, w) in nodes {
            b[j] += w * f64::from(pair.jpeg[c]);
            for (k, v) in nodes {
                a[j][k] += w * v;
            }
        }
        count += 1;
    }
    for i in 0..N {
        b[i] /= count as f64;
        for v in &mut a[i] {
            *v /= count as f64;
        }
        a[i][i] += 0.00001;
        b[i] += 0.00001 * i as f64 / (N - 1) as f64;
    }
    for i in 1..N - 1 {
        let d = [(i - 1, 1.), (i, -2.), (i + 1, 1.)];
        for (j, u) in d {
            for (k, v) in d {
                a[j][k] += 0.03 * u * v;
            }
        }
    }
    let step = 1.
        / a.iter()
            .map(|row| row.iter().map(|v| v.abs()).sum::<f64>())
            .fold(0., f64::max);
    let mut y = std::array::from_fn(|i| i as f64 / (N - 1) as f64);
    for _ in 0..1000 {
        let mut next = std::array::from_fn(|i| {
            y[i] - step * (a[i].iter().zip(y).map(|(v, x)| v * x).sum::<f64>() - b[i])
        });
        monotone(&mut next);
        let change = y
            .iter()
            .zip(next)
            .map(|(a, b)| (a - b).abs())
            .fold(0., f64::max);
        y = next;
        if change < 1e-8 {
            break;
        }
    }
    y
}

pub(super) fn fit(pairs: &[DisplayPair], size: usize) -> Option<ColorLut> {
    if pairs.len() < 256
        || size < 2
        || pairs
            .iter()
            .any(|p| p.maple.iter().chain(&p.jpeg).any(|v| !v.is_finite()))
    {
        return None;
    }
    let stride = pairs.len().div_ceil(65536);
    let curves: [[f64; N]; 3] = std::array::from_fn(|c| channel(pairs, stride, c));
    let mut lut = ColorLut::identity(size);
    for node in lut.data.chunks_exact_mut(3) {
        for c in 0..3 {
            let x = f64::from(node[c]) * (N - 1) as f64;
            let lo = (x.floor() as usize).min(N - 2);
            let f = x - lo as f64;
            node[c] = (curves[c][lo] * (1. - f) + curves[c][lo + 1] * f) as f32;
        }
    }
    Some(lut)
}

pub(super) fn prefer(candidate: &ColorLut, current: &ColorLut, pairs: &[DisplayPair]) -> bool {
    let mut candidate_error = [0.; 3];
    let mut current_error = [0.; 3];
    let stride = pairs.len().div_ceil(65536).max(1);
    for pair in pairs.iter().step_by(stride).step_by(4) {
        let a = candidate.sample(pair.maple);
        let b = current.sample(pair.maple);
        for c in 0..3 {
            candidate_error[c] += f64::from(a[c] - pair.jpeg[c]).powi(2);
            current_error[c] += f64::from(b[c] - pair.jpeg[c]).powi(2);
        }
    }
    (0..3).all(|c| candidate_error[c] <= current_error[c])
        && (0..3).any(|c| candidate_error[c] < current_error[c])
}

#[cfg(test)]
mod tests {
    use super::*;
    fn pairs(power: f32) -> Vec<DisplayPair> {
        (0..4096)
            .map(|i| {
                let x = i as f32 / 4095.;
                DisplayPair {
                    maple: [x; 3],
                    jpeg: [x.powf(power); 3],
                }
            })
            .collect()
    }
    #[test]
    fn identity_is_preserved() {
        let lut = fit(&pairs(1.), 33).unwrap();
        for i in 0..100 {
            let x = i as f32 / 99.;
            assert!((lut.sample([x; 3])[0] - x).abs() < 0.00001);
        }
    }
    #[test]
    fn learns_smooth_pixel_correspondences_without_flat_ramps() {
        let data = pairs(0.7);
        let lut = fit(&data, 33).unwrap();
        assert!(prefer(&lut, &ColorLut::identity(33), &data));
        let mut previous = -1.;
        for i in 0..4096 {
            let x = i as f32 / 4095.;
            let y = lut.sample([x; 3])[0];
            assert!(y > previous);
            previous = y;
            if x > 0.1 {
                assert!((y - x.powf(0.7)).abs() < 0.025);
            }
        }
    }
    #[test]
    fn rejects_invalid_or_undersized_correspondences() {
        assert!(fit(&pairs(1.)[..100], 33).is_none());
        let mut p = pairs(1.);
        p[2].maple[1] = f32::NAN;
        assert!(fit(&p, 33).is_none());
    }
}
