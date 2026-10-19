//! Small dual solve for smooth corrections of the actual baked LUT.
//! Five band constraints share one spatially smoothed basis; no per-camera rules.
use super::{jpeg_band_design::Design, lut::ColorLut};

fn smooth(field: &[f64], n: usize) -> Vec<f64> {
    let mut a = field.to_vec();
    let mut b = a.clone();
    // Separable symmetric binomial kernel; mirrored mass at cube boundaries.
    for _ in 0..4 {
        for stride in [1, n, n * n] {
            for i in 0..a.len() {
                let coordinate = (i / stride) % n;
                let lo = if coordinate > 0 { i - stride } else { i };
                let hi = if coordinate + 1 < n { i + stride } else { i };
                b[i] = 0.25 * a[lo] + 0.5 * a[i] + 0.25 * a[hi];
            }
            std::mem::swap(&mut a, &mut b);
        }
    }
    a
}

fn solve(mut a: [[f64; 5]; 5], mut rhs: [f64; 5]) -> [f64; 5] {
    for c in 0..5 {
        let pivot = (c..5)
            .max_by(|&i, &j| a[i][c].abs().total_cmp(&a[j][c].abs()))
            .unwrap();
        a.swap(c, pivot);
        rhs.swap(c, pivot);
        if a[c][c].abs() < 1e-15 {
            continue;
        }
        let diagonal = a[c][c];
        for j in c..5 {
            a[c][j] /= diagonal;
        }
        rhs[c] /= diagonal;
        for r in 0..5 {
            if r == c {
                continue;
            }
            let factor = a[r][c];
            for j in c..5 {
                a[r][j] -= factor * a[c][j];
            }
            rhs[r] -= factor * rhs[c];
        }
    }
    rhs
}

/// Isotonic least-squares projection with a small positive channel-axis slope.
fn project_line(values: &mut [f64], step: f64) {
    let n = values.len();
    let mut sums = Vec::<f64>::new();
    let mut counts = Vec::<usize>::new();
    for (i, &v) in values.iter().enumerate() {
        sums.push(v - i as f64 * step);
        counts.push(1);
        while sums.len() > 1 {
            let j = sums.len() - 1;
            if sums[j - 1] / counts[j - 1] as f64 <= sums[j] / counts[j] as f64 {
                break;
            }
            let s = sums.pop().unwrap();
            let c = counts.pop().unwrap();
            sums[j - 1] += s;
            counts[j - 1] += c;
        }
    }
    let mut i = 0;
    for (sum, count) in sums.into_iter().zip(counts) {
        for _ in 0..count {
            values[i] = ((sum / count as f64).clamp(0., 1. - step * (n - 1) as f64)
                + i as f64 * step)
                .clamp(0., 1.);
            i += 1;
        }
    }
}

fn project(data: &mut [f64], n: usize, channel: usize) {
    let stride = [1, n, n * n][channel];
    for start in 0..n * n * n {
        if (start / stride) % n != 0 {
            continue;
        }
        let mut line = (0..n).map(|i| data[start + i * stride]).collect::<Vec<_>>();
        project_line(&mut line, 0.05 / (n - 1) as f64);
        for (i, v) in line.into_iter().enumerate() {
            data[start + i * stride] = v;
        }
    }
    // Along equal RGB increments, tetrahedral interpolation's derivative
    // is the 000-to-111 node difference. Preserve brightness ordering too;
    // per-channel-axis ordering alone does not prevent a folded grey ramp.
    let stride = 1 + n + n * n;
    for start in 0..n * n * n {
        let (r, g, b) = (start % n, (start / n) % n, start / (n * n));
        if r != 0 && g != 0 && b != 0 {
            continue;
        }
        let length = (n - r).min(n - g).min(n - b);
        if length < 2 {
            continue;
        }
        let mut line = (0..length)
            .map(|i| data[start + i * stride])
            .collect::<Vec<_>>();
        project_line(&mut line, 0.05 / (n - 1) as f64);
        for (i, v) in line.into_iter().enumerate() {
            data[start + i * stride] = v;
        }
    }
}

pub(super) fn fit(lut: &mut ColorLut, design: &Design) {
    let active: [bool; 5] = std::array::from_fn(|b| design.counts[b] >= 100);
    if !active.iter().any(|&b| b) {
        return;
    }
    let basis: [Vec<f64>; 5] = std::array::from_fn(|b| smooth(&design.rows[b], lut.size));
    let mut gram = [[0.; 5]; 5];
    for b in 0..5 {
        for k in 0..5 {
            gram[b][k] = if active[b] && active[k] {
                design.rows[b]
                    .iter()
                    .zip(&basis[k])
                    .map(|(a, s)| a * s)
                    .sum()
            } else {
                0.
            };
        }
    }
    let ridge = (0..5).map(|b| gram[b][b]).fold(0., f64::max) * 1e-8;
    for b in 0..5 {
        gram[b][b] += if active[b] { ridge } else { 1. };
    }
    for c in 0..3 {
        let original = lut
            .data
            .chunks_exact(3)
            .map(|v| f64::from(v[c]))
            .collect::<Vec<_>>();
        let mut best = original.clone();
        let mut best_error = f64::INFINITY;
        // Restart a stalled constrained solve from a monotone global prior
        // derived from these same exact baked-node design rows.
        for restart in 0..2 {
            if best_error < 0.001 {
                break;
            }
            let mut values = if restart == 0 {
                original.clone()
            } else {
                super::jpeg_band_prior::channel(lut, design, c)
            };
            for _ in 0..64 {
                let error: [f64; 5] = std::array::from_fn(|b| {
                    if active[b] {
                        design.targets[b][c]
                            - design.rows[b]
                                .iter()
                                .zip(&values)
                                .map(|(a, v)| a * v)
                                .sum::<f64>()
                    } else {
                        0.
                    }
                });
                let worst = error.iter().map(|v| v.abs()).fold(0., f64::max);
                if worst < best_error {
                    best_error = worst;
                    best.clone_from(&values);
                }
                if worst < 0.001 {
                    break;
                }
                let coefficients = solve(gram, error);
                if !coefficients.iter().all(|v| v.is_finite()) {
                    break;
                }
                for (i, v) in values.iter_mut().enumerate() {
                    *v += coefficients
                        .iter()
                        .enumerate()
                        .map(|(b, k)| k * basis[b][i])
                        .sum::<f64>();
                    *v = v.clamp(0., 1.);
                }
                project(&mut values, lut.size, c);
            }
        }
        for (node, value) in lut.data.chunks_exact_mut(3).zip(best) {
            node[c] = value as f32;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn isotonic_projection_is_bounded_and_strictly_increasing() {
        let mut values = vec![1., 0., 0.8, -0.3, 1.8];
        project_line(&mut values, 0.05 / 4.);
        assert!(values.iter().all(|v| (0.0..=1.0).contains(v)));
        assert!(values.windows(2).all(|v| v[1] - v[0] >= 0.05 / 4. - 1e-12));
    }
    #[test]
    fn no_measurable_bands_preserves_existing_artifact_exactly() {
        let mut lut = ColorLut::identity(9);
        let before = lut.data.clone();
        let design = Design {
            rows: std::array::from_fn(|_| vec![0.; 729]),
            targets: [[0.; 3]; 5],
            counts: [0; 5],
        };
        fit(&mut lut, &design);
        assert_eq!(lut.data, before);
    }
}
