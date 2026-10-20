use super::{features::Gray, Warp};

struct Evaluation {
    loss: f64,
    correlation: f64,
    normal: [[f64; 9]; 9],
    rhs: [f64; 9],
}

fn evaluate(
    source: &Gray,
    target: &Gray,
    p: &[f64; 9],
    derivatives: bool,
    fold: usize,
) -> Option<Evaluation> {
    let (w, h) = (target.width, target.height);
    let (bx, by) = (
        (w as f64 * 0.1).round_ties_even() as usize,
        (h as f64 * 0.1).round_ties_even() as usize,
    );
    let mut normal = [[0.; 9]; 9];
    let mut rhs = [0.; 9];
    let mut sums = [0.; 6];
    let mut count = 0usize;
    for y in by..h - by {
        let yn = (y as f64 - (h - 1) as f64 * 0.5) / h as f64;
        for x in bx..w - bx {
            if ((x / 8) + (y / 8)) % 2 != fold {
                continue;
            }
            let xn = (x as f64 - (w - 1) as f64 * 0.5) / w as f64;
            let radius = 4. * (xn * xn + yn * yn);
            let rx = 2. * xn * radius * w as f64;
            let ry = 2. * yn * radius * h as f64;
            let [value, gx, gy] = source.sample(
                x as f64 + p[0] * xn + p[1] * yn + p[2] + p[8] * rx,
                y as f64 + p[3] * xn + p[4] * yn + p[5] + p[8] * ry,
            )?;
            let reference = target.pixels[y * w + x];
            let error = p[6] * value + p[7] - reference;
            for (sum, term) in sums.iter_mut().zip([
                error * error,
                value,
                reference,
                value * value,
                reference * reference,
                value * reference,
            ]) {
                *sum += term;
            }
            count += 1;
            if derivatives {
                let jac = [
                    p[6] * gx * xn,
                    p[6] * gx * yn,
                    p[6] * gx,
                    p[6] * gy * xn,
                    p[6] * gy * yn,
                    p[6] * gy,
                    value,
                    1.,
                    p[6] * (gx * rx + gy * ry),
                ];
                for i in 0..9 {
                    rhs[i] -= jac[i] * error;
                    for j in 0..=i {
                        normal[i][j] += jac[i] * jac[j];
                    }
                }
            }
        }
    }
    let n = count as f64;
    let variance = (sums[3] - sums[1] * sums[1] / n) * (sums[4] - sums[2] * sums[2] / n);
    if count < 128 || variance <= 1e-12 {
        return None;
    }
    for i in 0..9 {
        for j in 0..i {
            normal[j][i] = normal[i][j];
        }
        normal[i][i] += 1e-4 * (normal[i][i] + 1e-8);
    }
    Some(Evaluation {
        loss: sums[0] / n,
        correlation: (sums[5] - sums[1] * sums[2] / n) / variance.sqrt(),
        normal,
        rhs,
    })
}

fn solve(mut a: [[f64; 9]; 9], mut b: [f64; 9]) -> Option<[f64; 9]> {
    let scale = (0..9).map(|i| a[i][i].abs()).fold(0., f64::max);
    for i in 0..9 {
        let pivot = (i..9).max_by(|&j, &k| a[j][i].abs().total_cmp(&a[k][i].abs()))?;
        if a[pivot][i].abs() <= scale * 1e-12 {
            return None;
        }
        a.swap(i, pivot);
        b.swap(i, pivot);
        for j in i + 1..9 {
            let ratio = a[j][i] / a[i][i];
            for k in i..9 {
                a[j][k] -= ratio * a[i][k];
            }
            b[j] -= ratio * b[i];
        }
    }
    let mut result = [0.; 9];
    for i in (0..9).rev() {
        result[i] = (b[i] - (i + 1..9).map(|j| a[i][j] * result[j]).sum::<f64>()) / a[i][i];
    }
    result.iter().all(|v| v.is_finite()).then_some(result)
}

fn parameters(warp: Warp, w: f64, h: f64) -> [f64; 9] {
    let [a, b, tx, c, d, ty] = warp.coefficients;
    [
        (a - 1.) * w,
        b * w,
        w * (tx + (a + b - 1.) * 0.5),
        c * h,
        (d - 1.) * h,
        h * (ty + (c + d - 1.) * 0.5),
        1.,
        0.,
        warp.radial,
    ]
}

fn bounded(p: &[f64; 9], w: f64, h: f64) -> bool {
    (p[0] / w).abs() <= 0.1
        && (p[4] / h).abs() <= 0.1
        && (p[1] / w).abs() <= 0.1
        && (p[3] / h).abs() <= 0.1
        && (p[2] / w).abs() <= 0.1
        && (p[5] / h).abs() <= 0.1
        && (0.25..4.).contains(&p[6])
        && p[8].abs() <= 0.025
}

pub(super) fn refine(source: &Gray, target: &Gray, warp: Warp) -> Option<Warp> {
    let (w, h) = (target.width as f64, target.height as f64);
    let baseline = evaluate(source, target, &parameters(warp, w, h), false, 1)?.correlation;
    let mut p = parameters(warp, w, h);
    for _ in 0..90 {
        let before = evaluate(source, target, &p, true, 0)?;
        let delta = solve(before.normal, before.rhs)?;
        let mut chosen = None;
        for fraction in [1., 0.5, 0.25, 0.125, 0.0625, 0.03125] {
            let trial = std::array::from_fn(|i| p[i] + fraction * delta[i]);
            if !bounded(&trial, w, h) {
                continue;
            }
            if let Some(after) = evaluate(source, target, &trial, false, 0) {
                if after.loss < before.loss {
                    chosen = Some((trial, fraction));
                    break;
                }
            }
        }
        let Some((trial, fraction)) = chosen else {
            break;
        };
        p = trial;
        if delta[..6].iter().all(|v| (fraction * v).abs() < 1e-4)
            && (fraction * delta[8]).abs() < 1e-7
        {
            break;
        }
    }
    let score = evaluate(source, target, &p, false, 1)?.correlation;
    let (a, b, c, d) = (1. + p[0] / w, p[1] / w, p[3] / h, 1. + p[4] / h);
    if 1. - score > 0.75 * (1. - baseline) || score <= baseline + 1e-3 {
        return None;
    }
    Some(Warp {
        radial: p[8],
        coefficients: [
            a,
            b,
            p[2] / w - (a + b - 1.) * 0.5,
            c,
            d,
            p[5] / h - (c + d - 1.) * 0.5,
        ],
    })
}
