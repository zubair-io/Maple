//! Scale-normalised Harris response and scale-space extrema.
//!
//! Per level the structure tensor `[A B; B C]` of the gradients is
//! integrated over a Gaussian window and scored as `(AC − B²)/(A + C + ε)`
//! (determinant over trace: a smooth stand-in for the smaller eigenvalue).
//! The curvature gate rejects edge-like points whose eigenvalue ratio
//! exceeds `edge_ratio`; non-maximum suppression keeps strict maxima over
//! a spatial window and the adjacent levels.

use rayon::prelude::*;

use super::pyramid::{gaussian_blur, GrayImage, ScaleLevel};

const TRACE_EPSILON: f32 = 1e-10;
/// Integration window relative to the level's differentiation scale.
const WINDOW_SIGMAS: f32 = 1.5;

/// One detection in an octave's own continuous pixel coordinates.
#[derive(Debug, Clone, Copy)]
pub(super) struct Candidate {
    pub octave: usize,
    pub level: usize,
    pub x: f32,
    pub y: f32,
    pub sigma: f32,
    pub response: f32,
}

pub(super) struct ExtremaOptions {
    pub response_floor: f32,
    pub nms_radius: usize,
}

/// Scale-normalised (`σ²` per tensor term) and curvature-gated response.
pub(super) fn harris_response(level: &ScaleLevel, edge_ratio: f32) -> Vec<f32> {
    let image = &level.image;
    let (w, h) = (image.width, image.height);
    let gradients: Vec<(f32, f32)> = (0..w * h)
        .into_par_iter()
        .map(|i| image.gradient(i % w, i / w))
        .collect();
    let norm = level.sigma * level.sigma;
    let tensor_term = |f: fn((f32, f32)) -> f32| {
        let raw = GrayImage {
            width: w,
            height: h,
            data: gradients.iter().map(|&g| norm * f(g)).collect(),
        };
        gaussian_blur(&raw, WINDOW_SIGMAS * level.sigma).data
    };
    let a = tensor_term(|(gx, _)| gx * gx);
    let b = tensor_term(|(gx, gy)| gx * gy);
    let c = tensor_term(|(_, gy)| gy * gy);
    let edge_limit = (edge_ratio + 1.0).powi(2) / edge_ratio;
    a.par_iter()
        .zip(b.par_iter())
        .zip(c.par_iter())
        .map(|((&a, &b), &c)| {
            let det = a * c - b * b;
            let trace = a + c;
            let corner_like = det > 0.0 && trace * trace < edge_limit * det;
            if corner_like {
                det / (trace + TRACE_EPSILON)
            } else {
                0.0
            }
        })
        .collect()
}

/// Sub-texel peak offset of a 1-D parabola through three samples.
fn parabola_offset(left: f32, center: f32, right: f32) -> f32 {
    let curvature = left - 2.0 * center + right;
    if curvature >= 0.0 {
        0.0
    } else {
        (0.5 * (left - right) / curvature).clamp(-0.5, 0.5)
    }
}

/// Strict maxima over detection levels `0..detect_levels`: the spatial
/// `(2·nms_radius + 1)²` window at the level itself, plus a 3×3 window at
/// `level ± 1` wherever that response exists.
pub(super) fn scale_space_maxima(
    octave: usize,
    levels: &[ScaleLevel],
    responses: &[Vec<f32>],
    detect_levels: usize,
    opts: &ExtremaOptions,
) -> Vec<Candidate> {
    let (w, h) = (levels[0].image.width, levels[0].image.height);
    let r = opts.nms_radius.max(1);
    if w <= 2 * r || h <= 2 * r {
        return Vec::new();
    }
    let rows = h - 2 * r;
    (0..detect_levels * rows)
        .into_par_iter()
        .flat_map_iter(|i| {
            let (k, y) = (i / rows, r + i % rows);
            let resp = &responses[k];
            let at = |x: usize, y: usize| resp[y * w + x];
            (r..w - r)
                .filter_map(|x| {
                    let v = at(x, y);
                    if v <= opts.response_floor {
                        return None;
                    }
                    let spatial_max = (y - r..=y + r)
                        .all(|ny| (x - r..=x + r).all(|nx| (nx == x && ny == y) || at(nx, ny) < v));
                    let scale_max = [k.checked_sub(1), Some(k + 1)]
                        .into_iter()
                        .flatten()
                        .filter(|&n| n < responses.len())
                        .all(|n| {
                            (y - 1..=y + 1)
                                .all(|ny| (x - 1..=x + 1).all(|nx| responses[n][ny * w + nx] < v))
                        });
                    (spatial_max && scale_max).then(|| Candidate {
                        octave,
                        level: k,
                        x: x as f32 + 0.5 + parabola_offset(at(x - 1, y), v, at(x + 1, y)),
                        y: y as f32 + 0.5 + parabola_offset(at(x, y - 1), v, at(x, y + 1)),
                        sigma: levels[k].sigma,
                        response: v,
                    })
                })
                .collect::<Vec<_>>()
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::classical::pyramid::{gaussian_blur, octave_levels};

    fn quadrant_corner(size: usize, cx: usize, cy: usize) -> GrayImage {
        GrayImage {
            width: size,
            height: size,
            data: (0..size * size)
                .map(|i| {
                    let (x, y) = (i % size, i / size);
                    if x >= cx && y >= cy {
                        1.0
                    } else {
                        0.0
                    }
                })
                .collect(),
        }
    }

    fn extrema_options() -> ExtremaOptions {
        ExtremaOptions {
            response_floor: 1e-4,
            nms_radius: 2,
        }
    }

    #[test]
    fn single_corner_is_detected_at_its_location() {
        let base = gaussian_blur(&quadrant_corner(48, 24, 20), 1.1);
        let levels = octave_levels(base, 1.2, 3);
        let responses: Vec<Vec<f32>> = levels.iter().map(|l| harris_response(l, 10.0)).collect();
        let found = scale_space_maxima(0, &levels, &responses, 3, &extrema_options());
        let best = found
            .iter()
            .max_by(|a, b| a.response.total_cmp(&b.response))
            .expect("corner detected");
        assert!((best.x - 24.0).abs() < 2.0, "x {}", best.x);
        assert!((best.y - 20.0).abs() < 2.0, "y {}", best.y);
    }

    #[test]
    fn straight_edge_fails_the_curvature_gate() {
        let edge = GrayImage {
            width: 32,
            height: 32,
            data: (0..32 * 32)
                .map(|i| if i % 32 >= 16 { 1.0 } else { 0.0 })
                .collect(),
        };
        let levels = octave_levels(gaussian_blur(&edge, 1.1), 1.2, 3);
        let response = harris_response(&levels[0], 10.0);
        assert!(response.iter().all(|&v| v == 0.0));
    }

    #[test]
    fn parabola_offset_recovers_the_vertex() {
        let f = |x: f32| -(x - 0.3).powi(2);
        assert!((parabola_offset(f(-1.0), f(0.0), f(1.0)) - 0.3).abs() < 1e-5);
        assert_eq!(parabola_offset(1.0, 0.0, 1.0), 0.0);
    }
}
