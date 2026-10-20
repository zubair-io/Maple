use super::{features::Gray, Warp};

const PARAMETERS: usize = 9;
const RADIAL: usize = 8;

struct Evaluation {
    loss: f64,
    correlation: f64,
    normal: [[f64; PARAMETERS]; PARAMETERS],
    rhs: [f64; PARAMETERS],
}

/// Which pixels a stage fits or scores: all of them, or one half of the
/// frame so the opposite half is a spatial hold-out. A lens residual is the
/// same radial term in every half; keystone or projective misfit is not.
#[derive(Clone, Copy, PartialEq)]
pub(super) enum Pixels {
    All,
    Top,
    Bottom,
    Left,
    Right,
}

impl Pixels {
    pub(super) const HALVES: [Self; 4] = [Self::Top, Self::Bottom, Self::Left, Self::Right];

    pub(super) fn opposite(self) -> Self {
        match self {
            Self::Top => Self::Bottom,
            Self::Bottom => Self::Top,
            Self::Left => Self::Right,
            Self::Right => Self::Left,
            Self::All => Self::All,
        }
    }

    fn includes(self, x: usize, y: usize, w: usize, h: usize) -> bool {
        match self {
            Self::All => true,
            Self::Top => 2 * y < h,
            Self::Bottom => 2 * y >= h,
            Self::Left => 2 * x < w,
            Self::Right => 2 * x >= w,
        }
    }
}

pub(super) struct Stage {
    pub warp: Warp,
    pub identity_correlation: f64,
    pub correlation: f64,
    pub loss: f64,
}

fn evaluate(
    source: &Gray,
    target: &Gray,
    p: &[f64; PARAMETERS],
    derivatives: bool,
    pixels: Pixels,
    aspect: [f64; 2],
) -> Option<Evaluation> {
    let (w, h) = (target.width, target.height);
    let (bx, by) = (
        (w as f64 * 0.1).round_ties_even() as usize,
        (h as f64 * 0.1).round_ties_even() as usize,
    );
    let mut normal = [[0.; PARAMETERS]; PARAMETERS];
    let mut rhs = [0.; PARAMETERS];
    let mut sums = [0.; 6];
    let mut count = 0usize;
    for y in by..h - by {
        let yn = (y as f64 - (h - 1) as f64 * 0.5) / h as f64;
        for x in bx..w - bx {
            if !pixels.includes(x, y, w, h) {
                continue;
            }
            let xn = (x as f64 - (w - 1) as f64 * 0.5) / w as f64;
            // Warp::map's radial term, k·n·|n|² with n = 2u - 1, in pixels.
            let radius = 4. * ((xn * aspect[0]).powi(2) + (yn * aspect[1]).powi(2));
            let (rx, ry) = (2. * xn * radius * w as f64, 2. * yn * radius * h as f64);
            let [value, gx, gy] = source.sample(
                x as f64 + p[0] * xn + p[1] * yn + p[2] + p[RADIAL] * rx,
                y as f64 + p[3] * xn + p[4] * yn + p[5] + p[RADIAL] * ry,
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
                for i in 0..PARAMETERS {
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
    for i in 0..PARAMETERS {
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

fn solve(
    mut a: [[f64; PARAMETERS]; PARAMETERS],
    mut b: [f64; PARAMETERS],
    unknowns: usize,
) -> Option<[f64; PARAMETERS]> {
    let scale = (0..unknowns).map(|i| a[i][i].abs()).fold(0., f64::max);
    for i in 0..unknowns {
        let pivot = (i..unknowns).max_by(|&j, &k| a[j][i].abs().total_cmp(&a[k][i].abs()))?;
        if a[pivot][i].abs() <= scale * 1e-12 {
            return None;
        }
        a.swap(i, pivot);
        b.swap(i, pivot);
        for j in i + 1..unknowns {
            let ratio = a[j][i] / a[i][i];
            for k in i..unknowns {
                a[j][k] -= ratio * a[i][k];
            }
            b[j] -= ratio * b[i];
        }
    }
    let mut result = [0.; PARAMETERS];
    for i in (0..unknowns).rev() {
        result[i] = (b[i] - (i + 1..unknowns).map(|j| a[i][j] * result[j]).sum::<f64>()) / a[i][i];
    }
    result.iter().all(|v| v.is_finite()).then_some(result)
}

fn parameters(warp: Warp, w: f64, h: f64) -> [f64; PARAMETERS] {
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

fn bounded(p: &[f64; PARAMETERS], w: f64, h: f64) -> bool {
    (p[0] / w).abs() <= 0.1
        && (p[4] / h).abs() <= 0.1
        && (p[1] / w).abs() <= 0.1
        && (p[3] / h).abs() <= 0.1
        && (p[2] / w).abs() <= 0.1
        && (p[5] / h).abs() <= 0.1
        && (0.25..4.).contains(&p[6])
        && p[RADIAL].abs() <= Warp::MAXIMUM_RADIAL
}

fn warp(p: &[f64; PARAMETERS], w: f64, h: f64, aspect: [f64; 2]) -> Warp {
    let (a, b, c, d) = (1. + p[0] / w, p[1] / w, p[3] / h, 1. + p[4] / h);
    Warp {
        coefficients: [
            a,
            b,
            p[2] / w - (a + b - 1.) * 0.5,
            c,
            d,
            p[5] / h - (c + d - 1.) * 0.5,
        ],
        radial: p[RADIAL],
        aspect,
    }
}

/// Gauss-Newton refinement from `warp`, fitting on `fit` and scoring on
/// `score`. With `radial == false` the radial unknown stays at its start.
pub(super) fn stage(
    source: &Gray,
    target: &Gray,
    start: Warp,
    radial: bool,
    fit: Pixels,
    score: Pixels,
) -> Option<Stage> {
    let (w, h) = (target.width as f64, target.height as f64);
    let unknowns = if radial { PARAMETERS } else { RADIAL };
    let identity_correlation = evaluate(
        source,
        target,
        &parameters(Warp::IDENTITY, w, h),
        false,
        score,
        start.aspect,
    )?
    .correlation;
    let mut p = parameters(start, w, h);
    for _ in 0..80 {
        let before = evaluate(source, target, &p, true, fit, start.aspect)?;
        let delta = solve(before.normal, before.rhs, unknowns)?;
        let mut chosen = None;
        for fraction in [1., 0.5, 0.25, 0.125, 0.0625, 0.03125] {
            let trial = std::array::from_fn(|i| p[i] + fraction * delta[i]);
            if !bounded(&trial, w, h) {
                continue;
            }
            if let Some(after) = evaluate(source, target, &trial, false, fit, start.aspect) {
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
            && (fraction * delta[RADIAL]).abs() < 1e-7
        {
            break;
        }
    }
    let scored = evaluate(source, target, &p, false, score, start.aspect)?;
    Some(Stage {
        warp: warp(&p, w, h, start.aspect),
        identity_correlation,
        correlation: scored.correlation,
        loss: scored.loss,
    })
}
