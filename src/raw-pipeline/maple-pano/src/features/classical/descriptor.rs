//! Orientation-normalised gradient-histogram patch descriptor.
//!
//! A keypoint's dominant gradient orientation is the peak of a
//! Gaussian-weighted 36-bin histogram around it. The descriptor samples a
//! square patch rotated into that frame, splits it into a 4×4 grid of
//! cells, and accumulates each pixel's gradient magnitude into 8 relative
//! orientation bins with trilinear weights — 128 values, mapped to the
//! Hellinger form (RootSIFT): L1-normalised, then square-rooted. The
//! square root damps single strong edges the way SIFT's 0.2 clamp did,
//! but smoothly, so dot products compare bin distributions rather than
//! letting one dominant gradient decide (#4553).

use std::f32::consts::TAU;

use super::pyramid::GrayImage;

pub(super) const DESCRIPTOR_DIM: usize = SPATIAL_BINS * SPATIAL_BINS * ORIENTATION_BINS;
const SPATIAL_BINS: usize = 4;
const ORIENTATION_BINS: usize = 8;
const ORIENTATION_HISTOGRAM_BINS: usize = 36;
const ORIENTATION_WINDOW_SIGMAS: f32 = 1.5;
const CELL_WIDTH_SIGMAS: f32 = 3.0;

/// Pixels of `image` within `radius` of `(x, y)` (continuous coords), as
/// `(dx, dy, gx, gy)` offsets from the centre.
fn patch(
    image: &GrayImage,
    x: f32,
    y: f32,
    radius: f32,
) -> impl Iterator<Item = (f32, f32, f32, f32)> + '_ {
    let lo = |c: f32| (c - radius - 0.5).floor().max(0.0) as usize;
    let hi = |c: f32, n: usize| ((c + radius - 0.5).ceil().max(0.0) as usize).min(n - 1);
    let (x0, x1, y0, y1) = (lo(x), hi(x, image.width), lo(y), hi(y, image.height));
    (y0..=y1).flat_map(move |py| {
        (x0..=x1).filter_map(move |px| {
            let (dx, dy) = (px as f32 + 0.5 - x, py as f32 + 0.5 - y);
            (dx * dx + dy * dy <= radius * radius).then(|| {
                let (gx, gy) = image.gradient(px, py);
                (dx, dy, gx, gy)
            })
        })
    })
}

fn wrap_angle(a: f32) -> f32 {
    a.rem_euclid(TAU)
}

/// Dominant gradient orientation (radians, image coordinates, y down).
pub(super) fn dominant_orientation(image: &GrayImage, x: f32, y: f32, sigma: f32) -> f32 {
    let window = ORIENTATION_WINDOW_SIGMAS * sigma;
    let bin_width = TAU / ORIENTATION_HISTOGRAM_BINS as f32;
    let raw = patch(image, x, y, 3.0 * window).fold(
        [0.0_f32; ORIENTATION_HISTOGRAM_BINS],
        |mut hist, (dx, dy, gx, gy)| {
            let weight = (-(dx * dx + dy * dy) / (2.0 * window * window)).exp();
            let pos = wrap_angle(gy.atan2(gx)) / bin_width - 0.5;
            let lower = pos.floor();
            let frac = pos - lower;
            let bin = |o: isize| {
                (lower as isize + o).rem_euclid(ORIENTATION_HISTOGRAM_BINS as isize) as usize
            };
            let magnitude = weight * gx.hypot(gy);
            hist[bin(0)] += magnitude * (1.0 - frac);
            hist[bin(1)] += magnitude * frac;
            hist
        },
    );
    let n = ORIENTATION_HISTOGRAM_BINS;
    let smooth: Vec<f32> = (0..n)
        .map(|i| 0.25 * raw[(i + n - 1) % n] + 0.5 * raw[i] + 0.25 * raw[(i + 1) % n])
        .collect();
    let peak = (0..n)
        .max_by(|&a, &b| smooth[a].total_cmp(&smooth[b]).then(b.cmp(&a)))
        .unwrap_or(0);
    let (left, center, right) = (
        smooth[(peak + n - 1) % n],
        smooth[peak],
        smooth[(peak + 1) % n],
    );
    let curvature = left - 2.0 * center + right;
    let offset = if curvature < 0.0 {
        0.5 * (left - right) / curvature
    } else {
        0.0
    };
    wrap_angle((peak as f32 + 0.5 + offset) * bin_width)
}

/// The 128-D descriptor at `(x, y)` rotated into `angle`, or `None` for a
/// gradient-free patch.
pub(super) fn describe(
    image: &GrayImage,
    x: f32,
    y: f32,
    sigma: f32,
    angle: f32,
) -> Option<Vec<f32>> {
    let cell = CELL_WIDTH_SIGMAS * sigma;
    let half_bins = SPATIAL_BINS as f32 / 2.0;
    let radius = cell * (half_bins + 0.5) * std::f32::consts::SQRT_2;
    let (sin, cos) = angle.sin_cos();
    let orientation_scale = ORIENTATION_BINS as f32 / TAU;
    let raw = patch(image, x, y, radius).fold(
        vec![0.0_f32; DESCRIPTOR_DIM],
        |mut hist, (dx, dy, gx, gy)| {
            let rx = (cos * dx + sin * dy) / cell;
            let ry = (-sin * dx + cos * dy) / cell;
            let (bx, by) = (rx + half_bins - 0.5, ry + half_bins - 0.5);
            if bx <= -1.0 || by <= -1.0 || bx >= SPATIAL_BINS as f32 || by >= SPATIAL_BINS as f32 {
                return hist;
            }
            let weight = (-(rx * rx + ry * ry) / (2.0 * half_bins * half_bins)).exp();
            let magnitude = weight * gx.hypot(gy);
            let bo = wrap_angle(gy.atan2(gx) - angle) * orientation_scale;
            let (x0, y0, o0) = (bx.floor(), by.floor(), bo.floor());
            let (fx, fy, fo) = (bx - x0, by - y0, bo - o0);
            for (cy, wy) in [(y0 as isize, 1.0 - fy), (y0 as isize + 1, fy)] {
                for (cx, wx) in [(x0 as isize, 1.0 - fx), (x0 as isize + 1, fx)] {
                    if !(0..SPATIAL_BINS as isize).contains(&cy)
                        || !(0..SPATIAL_BINS as isize).contains(&cx)
                    {
                        continue;
                    }
                    for (co, wo) in [(o0 as usize, 1.0 - fo), (o0 as usize + 1, fo)] {
                        let o = co % ORIENTATION_BINS;
                        let idx = (cy as usize * SPATIAL_BINS + cx as usize) * ORIENTATION_BINS + o;
                        hist[idx] += magnitude * wx * wy * wo;
                    }
                }
            }
            hist
        },
    );
    root_normalize(raw)
}

/// Hellinger map of a non-negative histogram; unit L2 norm by construction.
fn root_normalize(v: Vec<f32>) -> Option<Vec<f32>> {
    let total: f32 = v.iter().sum();
    (total > f32::EPSILON).then(|| v.into_iter().map(|x| (x / total).sqrt()).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn blob_scene(size: usize, rotate: f32) -> GrayImage {
        let c = size as f32 / 2.0;
        let (s, co) = rotate.sin_cos();
        GrayImage {
            width: size,
            height: size,
            data: (0..size * size)
                .map(|i| {
                    let (px, py) = ((i % size) as f32 + 0.5 - c, (i / size) as f32 + 0.5 - c);
                    let (u, v) = (co * px + s * py, -s * px + co * py);
                    (-((u - 5.0).powi(2) + v.powi(2)) / 18.0).exp()
                        + 0.6 * (-((u + 3.0).powi(2) + (v - 6.0).powi(2)) / 8.0).exp()
                })
                .collect(),
        }
    }

    fn dot(a: &[f32], b: &[f32]) -> f32 {
        a.iter().zip(b).map(|(x, y)| x * y).sum()
    }

    #[test]
    fn descriptor_is_unit_norm() {
        let img = blob_scene(64, 0.0);
        let angle = dominant_orientation(&img, 32.0, 32.0, 2.0);
        let d = describe(&img, 32.0, 32.0, 2.0, angle).expect("textured patch");
        assert_eq!(d.len(), DESCRIPTOR_DIM);
        assert!((dot(&d, &d) - 1.0).abs() < 1e-4);
    }

    #[test]
    fn orientation_normalisation_makes_the_descriptor_rotation_invariant() {
        let upright = blob_scene(64, 0.0);
        let rotated = blob_scene(64, 0.9);
        let describe_center = |img: &GrayImage| {
            let angle = dominant_orientation(img, 32.0, 32.0, 2.0);
            (angle, describe(img, 32.0, 32.0, 2.0, angle).expect("patch"))
        };
        let (a0, d0) = describe_center(&upright);
        let (a1, d1) = describe_center(&rotated);
        let turned = wrap_angle(a1 - a0);
        assert!((turned - 0.9).abs() < 0.1, "orientation moved {turned} rad");
        assert!(dot(&d0, &d1) > 0.9, "similarity {}", dot(&d0, &d1));
    }

    #[test]
    fn hellinger_map_square_roots_the_bin_shares() {
        let d = root_normalize(vec![9.0, 1.0, 0.0]).expect("non-empty histogram");
        let expected = [0.9_f32.sqrt(), 0.1_f32.sqrt(), 0.0];
        assert!(d.iter().zip(expected).all(|(a, b)| (a - b).abs() < 1e-6));
        assert!(root_normalize(vec![0.0; 4]).is_none());
    }

    #[test]
    fn flat_patch_has_no_descriptor() {
        let flat = GrayImage {
            width: 32,
            height: 32,
            data: vec![0.5; 32 * 32],
        };
        assert!(describe(&flat, 16.0, 16.0, 1.5, 0.0).is_none());
    }
}
