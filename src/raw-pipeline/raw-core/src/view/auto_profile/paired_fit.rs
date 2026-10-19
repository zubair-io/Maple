//! Regularized paired-pixel Auto candidate, qualified separately under #5000.
use super::{lut::ColorLut, pairs::DisplayPair};
use crate::view::{
    acr_fit::model::{ciede2000, srgb_linear_to_lab},
    agx_inverse::srgb_gamma_inv,
};
const GRID: usize = 9;
const CELLS: usize = GRID * GRID * GRID;
const SAMPLES: usize = 65536;

fn corners(rgb: [f32; 3]) -> [(usize, f64); 4] {
    let mut lo = [0; 3];
    let mut f = [0.; 3];
    for c in 0..3 {
        let x = f64::from(rgb[c].clamp(0., 1.)) * (GRID - 1) as f64;
        lo[c] = (x.floor() as usize).min(GRID - 2);
        f[c] = x - lo[c] as f64;
    }
    let mut axes = [0, 1, 2];
    axes.sort_by(|&a, &b| f[b].total_cmp(&f[a]));
    let stride = [1, GRID, GRID * GRID];
    let start = (lo[2] * GRID + lo[1]) * GRID + lo[0];
    [
        (start, 1. - f[axes[0]]),
        (start + stride[axes[0]], f[axes[0]] - f[axes[1]]),
        (
            start + stride[axes[0]] + stride[axes[1]],
            f[axes[1]] - f[axes[2]],
        ),
        (start + 1 + GRID + GRID * GRID, f[axes[2]]),
    ]
}

fn multiply(a: &[f64], x: &[f64]) -> Vec<f64> {
    a.chunks_exact(CELLS)
        .map(|row| row.iter().zip(x).map(|(u, v)| u * v).sum())
        .collect()
}
fn dot(a: &[f64], b: &[f64]) -> f64 {
    a.iter().zip(b).map(|(u, v)| u * v).sum()
}
fn solve(a: &[f64], b: &[f64]) -> Vec<f64> {
    let mut x = vec![0.; CELLS];
    let mut r = b.to_vec();
    let inverse: Vec<_> = (0..CELLS).map(|i| 1. / a[i * CELLS + i]).collect();
    let mut z: Vec<_> = r.iter().zip(&inverse).map(|(v, d)| v * d).collect();
    let mut p = z.clone();
    let mut rz = dot(&r, &z);
    let initial = dot(b, b);
    if initial < 1e-25 {
        return x;
    }
    for _ in 0..256 {
        let ap = multiply(a, &p);
        let denominator = dot(&p, &ap);
        if denominator <= 0. {
            break;
        }
        let alpha = rz / denominator;
        for i in 0..CELLS {
            x[i] += alpha * p[i];
            r[i] -= alpha * ap[i];
        }
        if dot(&r, &r) < initial * 1e-14 {
            break;
        }
        for i in 0..CELLS {
            z[i] = r[i] * inverse[i];
        }
        let next = dot(&r, &z);
        let beta = next / rz;
        for i in 0..CELLS {
            p[i] = z[i] + beta * p[i];
        }
        rz = next;
    }
    x
}

fn ordered(values: &mut [f64; GRID]) {
    let epsilon = 0.002 / (GRID - 1) as f64;
    let mut means = [0.; GRID];
    let mut counts = [0usize; GRID];
    let mut blocks = 0;
    for (i, value) in values.iter().enumerate() {
        means[blocks] = value - i as f64 * epsilon;
        counts[blocks] = 1;
        blocks += 1;
        while blocks > 1 && means[blocks - 2] > means[blocks - 1] {
            let j = blocks - 2;
            let count = counts[j] + counts[j + 1];
            means[j] =
                (means[j] * counts[j] as f64 + means[j + 1] * counts[j + 1] as f64) / count as f64;
            counts[j] = count;
            blocks -= 1;
        }
    }
    let mut index = 0;
    for j in 0..blocks {
        for _ in 0..counts[j] {
            values[index] = means[j].clamp(0., 1. - 0.002) + index as f64 * epsilon;
            index += 1;
        }
    }
}

fn constrain(data: &mut [f32]) {
    for _ in 0..32 {
        for c in 0..3 {
            for a in 0..GRID {
                for b in 0..GRID {
                    let indices: [usize; GRID] = std::array::from_fn(|k| {
                        let rgb = match c {
                            0 => [k, a, b],
                            1 => [a, k, b],
                            _ => [a, b, k],
                        };
                        ((rgb[2] * GRID + rgb[1]) * GRID + rgb[0]) * 3 + c
                    });
                    let mut values = indices.map(|i| f64::from(data[i]));
                    ordered(&mut values);
                    for (i, v) in indices.into_iter().zip(values) {
                        data[i] = v as f32;
                    }
                }
            }
            let indices: [usize; GRID] =
                std::array::from_fn(|k| ((k * GRID + k) * GRID + k) * 3 + c);
            let mut values = indices.map(|i| f64::from(data[i]));
            ordered(&mut values);
            for (i, v) in indices.into_iter().zip(values) {
                data[i] = v as f32;
            }
        }
    }
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
    let stride = pairs.len().div_ceil(SAMPLES);
    let mut a = vec![0.; CELLS * CELLS];
    let mut b = vec![[0.; 3]; CELLS];
    let mut count = 0;
    for (i, pair) in pairs.iter().step_by(stride).enumerate() {
        if i % 4 == 0 {
            continue;
        }
        let weights = corners(pair.maple);
        for (j, u) in weights {
            for (k, v) in weights {
                a[j * CELLS + k] += u * v;
            }
            for c in 0..3 {
                b[j][c] += u * f64::from(pair.jpeg[c] - pair.maple[c]);
            }
        }
        count += 1;
    }
    for v in &mut a {
        *v /= count as f64;
    }
    for row in &mut b {
        for v in row {
            *v /= count as f64;
        }
    }
    for i in 0..CELLS {
        a[i * CELLS + i] += 1e-8;
        let xyz = [i % GRID, (i / GRID) % GRID, i / (GRID * GRID)];
        for (axis, step) in [1, GRID, GRID * GRID].into_iter().enumerate() {
            if xyz[axis] + 1 < GRID {
                let j = i + step;
                let lambda = 1e-5;
                a[i * CELLS + i] += lambda;
                a[j * CELLS + j] += lambda;
                a[i * CELLS + j] -= lambda;
                a[j * CELLS + i] -= lambda;
            }
        }
    }
    let mut coarse = ColorLut::identity(GRID);
    for c in 0..3 {
        let target: Vec<_> = b.iter().map(|row| row[c]).collect();
        let delta = solve(&a, &target);
        for i in 0..CELLS {
            coarse.data[i * 3 + c] += delta[i] as f32;
        }
    }
    constrain(&mut coarse.data);
    let mut result = ColorLut::identity(size);
    for node in result.data.chunks_exact_mut(3) {
        node.copy_from_slice(&coarse.sample([node[0], node[1], node[2]]));
    }
    Some(result)
}

fn lab(rgb: [f32; 3]) -> [f32; 3] {
    srgb_linear_to_lab(rgb.map(srgb_gamma_inv))
}

pub(super) fn prefer(candidate: &ColorLut, current: &ColorLut, pairs: &[DisplayPair]) -> bool {
    let stride = pairs.len().div_ceil(SAMPLES).max(1);
    let mut squared = [[0.; 3]; 2];
    let mut absolute = [[0.; 3]; 2];
    let mut perceptual = [0.; 2];
    for pair in pairs.iter().step_by(stride).step_by(4) {
        let target = lab(pair.jpeg);
        for (i, lut) in [candidate, current].into_iter().enumerate() {
            let output = lut.sample(pair.maple);
            perceptual[i] += f64::from(ciede2000(lab(output), target));
            for c in 0..3 {
                let error = f64::from(output[c] - pair.jpeg[c]);
                squared[i][c] += error * error;
                absolute[i][c] += error.abs();
            }
        }
    }
    perceptual[0] < perceptual[1]
        && (0..3).all(|c| squared[0][c] <= squared[1][c] && absolute[0][c] <= absolute[1][c])
}

#[cfg(test)]
mod tests {
    use super::*;
    fn pairs(correction: f32) -> Vec<DisplayPair> {
        let mut result = Vec::new();
        for b in 0..9 {
            for g in 0..9 {
                for r in 0..9 {
                    let maple = [r as f32 / 8., g as f32 / 8., b as f32 / 8.];
                    let jpeg = maple.map(|x| x * (1. - correction) + 0.5 * correction);
                    for _ in 0..4 {
                        result.push(DisplayPair { maple, jpeg });
                    }
                }
            }
        }
        result
    }
    #[test]
    fn basis_matches_the_artifact_sampler() {
        let mut lut = ColorLut::identity(GRID);
        for (i, v) in lut.data.iter_mut().enumerate() {
            *v = ((i * 37) % 101) as f32 / 100.;
        }
        for i in 0..1000 {
            let rgb = [
                ((i * 13) % 997) as f32 / 996.,
                ((i * 29) % 991) as f32 / 990.,
                ((i * 53) % 983) as f32 / 982.,
            ];
            let actual = lut.sample(rgb);
            for c in 0..3 {
                let expected: f64 = corners(rgb)
                    .into_iter()
                    .map(|(j, w)| w * f64::from(lut.data[j * 3 + c]))
                    .sum();
                assert!((f64::from(actual[c]) - expected).abs() < 2e-6);
            }
        }
    }
    #[test]
    fn identity_is_preserved() {
        let lut = fit(&pairs(0.), 33).unwrap();
        for i in 0..100 {
            let x = i as f32 / 99.;
            assert!((lut.sample([x; 3])[0] - x).abs() < 1e-5);
        }
    }
    #[test]
    fn learns_pixel_mapping_on_held_out_pairs() {
        let data = pairs(0.2);
        let lut = fit(&data, 33).unwrap();
        assert!(prefer(&lut, &ColorLut::identity(33), &data));
        assert!(lut
            .data
            .iter()
            .all(|v| v.is_finite() && *v >= 0. && *v <= 1.));
        let mut last = -1.;
        for i in 0..4096 {
            let x = i as f32 / 4095.;
            let y = lut.sample([x; 3])[0];
            assert!(y > last);
            last = y;
        }
    }
    #[test]
    fn rejects_invalid_correspondences() {
        assert!(fit(&pairs(0.)[..100], 33).is_none());
        let mut data = pairs(0.);
        data[1].jpeg[0] = f32::NAN;
        assert!(fit(&data, 33).is_none());
    }
}
