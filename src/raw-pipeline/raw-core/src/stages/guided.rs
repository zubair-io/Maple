//! Guided filter (He, Sun, Tang 2010 — "Guided Image Filtering"). An
//! O(N) edge-preserving smoother that runs in constant time regardless
//! of window radius. Currently **unused** by `noise_reduction.rs` — we
//! ship NLM (see [`super::nlm`]) as the spec-aligned algorithm. This
//! module is retained as a fast fallback should the NLM perf gap force
//! a future pivot, and is independently tested. Per-plane cost is
//! roughly one-tenth of NLM's at 2 MP.
//!
//! # Algorithm (self-guided variant, I = p)
//!
//!   mean_I  = box(I)
//!   mean_II = box(I * I)
//!   var_I   = mean_II - mean_I²
//!   a = var_I / (var_I + epsilon)            // edge-aware gain
//!   b = mean_I - a * mean_I = (1 - a) * mean_I
//!   mean_a = box(a)
//!   mean_b = box(b)
//!   out = mean_a * I + mean_b
//!
//! Where `box(.)` is a mean filter over a (2R+1)² window and
//! `epsilon` is the smoothing strength.
//!
//! Intuition:
//!   * In a flat region: var_I → 0, so a → 0, b → mean_I, and out ≈
//!     mean_I (heavy smoothing — exactly what we want).
//!   * On an edge: var_I >> epsilon, so a → 1, b → 0, and out ≈ I
//!     (preserves edge detail).
//!
//! `epsilon` couples to the noise level: at slider amount 100 we use
//! `epsilon = (h_max)²` where `h_max` is a per-stage constant (see
//! `noise_reduction.rs`).
//!
//! # Performance
//!
//! Four box filters per plane (`mean_I`, `mean_II`, `mean_a`,
//! `mean_b`), each a single separable pass via
//! [`super::blur::box_blur_channel`]. Measured at ~5 ms per plane
//! on 2 MP in release mode with rayon — well inside the slider
//! budget.

use rayon::prelude::*;

use crate::stages::blur::box_blur_channel;

/// Single-pass box-mean filter — exactly what He et al. specify for
/// the guided filter. We deliberately use one box pass (not the
/// 3-pass cascaded-Gaussian approximation in
/// [`super::blur::gaussian_blur_plane`]) because the guided filter
/// is itself a low-pass primitive — there's no visual benefit to a
/// steeper falloff, and the math is derived against a mean filter.
#[inline]
fn mean_filter(plane: &[f32], w: usize, h: usize, radius: usize) -> Vec<f32> {
    box_blur_channel(plane, w, h, radius)
}

/// Apply a self-guided filter to a single channel plane. Returns a
/// new buffer of the same length. `epsilon` controls the smoothing
/// strength — set to 0 for identity (short-circuited).
pub fn guided_self(plane: &[f32], w: usize, h: usize, radius: usize, epsilon: f32) -> Vec<f32> {
    let n = w * h;
    if plane.len() != n {
        panic!("guided_self: len {} != w*h = {}", plane.len(), n);
    }
    if epsilon <= 0.0 || radius == 0 {
        return plane.to_vec();
    }

    // mean(I), mean(I²).
    let mean_i = mean_filter(plane, w, h, radius);
    let ii: Vec<f32> = plane.par_iter().map(|&v| v * v).collect();
    let mean_ii = mean_filter(&ii, w, h, radius);

    // var(I) = mean(I²) − mean(I)². Clamp at zero to absorb roundoff
    // (var can never be physically negative).
    let var_i: Vec<f32> = mean_ii
        .par_iter()
        .zip(mean_i.par_iter())
        .map(|(&mii, &mi)| (mii - mi * mi).max(0.0))
        .collect();

    // a = var / (var + eps); b = (1 − a) * mean(I).
    let a_plane: Vec<f32> = var_i.par_iter().map(|&v| v / (v + epsilon)).collect();
    let b_plane: Vec<f32> = a_plane
        .par_iter()
        .zip(mean_i.par_iter())
        .map(|(&a, &mi)| (1.0 - a) * mi)
        .collect();

    let mean_a = mean_filter(&a_plane, w, h, radius);
    let mean_b = mean_filter(&b_plane, w, h, radius);

    // out = mean_a * I + mean_b
    plane
        .par_iter()
        .zip(mean_a.par_iter())
        .zip(mean_b.par_iter())
        .map(|((&p, &ma), &mb)| ma * p + mb)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn epsilon_zero_is_identity() {
        let w = 16;
        let h = 16;
        let mut plane = vec![0.0f32; w * h];
        for i in 0..plane.len() {
            plane[i] = (i as f32) * 0.001;
        }
        let out = guided_self(&plane, w, h, 3, 0.0);
        for i in 0..plane.len() {
            assert_eq!(out[i], plane[i], "epsilon=0 should be identity at {}", i);
        }
    }

    #[test]
    fn constant_plane_unchanged() {
        let w = 32;
        let h = 32;
        let plane = vec![0.5f32; w * h];
        let out = guided_self(&plane, w, h, 4, 0.01);
        for &v in &out {
            assert!((v - 0.5).abs() < 1e-5, "constant plane changed: {}", v);
        }
    }

    #[test]
    fn flat_noise_is_smoothed() {
        let w = 64;
        let h = 64;
        let mut plane = vec![0.0f32; w * h];
        let mut rng_state: u32 = 0xDEADBEEF;
        for v in plane.iter_mut() {
            rng_state ^= rng_state << 13;
            rng_state ^= rng_state >> 17;
            rng_state ^= rng_state << 5;
            let u1 = (rng_state as f32 / u32::MAX as f32).max(1e-6);
            rng_state ^= rng_state << 13;
            rng_state ^= rng_state >> 17;
            rng_state ^= rng_state << 5;
            let u2 = rng_state as f32 / u32::MAX as f32;
            let z = (-2.0 * u1.ln()).sqrt() * (2.0 * std::f32::consts::PI * u2).cos();
            *v = 0.5 + 0.05 * z;
        }
        let input_stdev = stdev(&plane);
        let out = guided_self(&plane, w, h, 5, 0.005);
        let output_stdev = stdev(&out);
        assert!(
            output_stdev < input_stdev * 0.5,
            "stdev not reduced enough: in={} out={}",
            input_stdev,
            output_stdev,
        );
    }

    #[test]
    fn edge_preserved_under_noise() {
        // Step from 0.3 to 0.7 down the centre column + noise.
        let w = 64;
        let h = 64;
        let mut plane = vec![0.0f32; w * h];
        let mut rng_state: u32 = 0xC0FFEE;
        for y in 0..h {
            for x in 0..w {
                let base = if x < w / 2 { 0.3 } else { 0.7 };
                rng_state ^= rng_state << 13;
                rng_state ^= rng_state >> 17;
                rng_state ^= rng_state << 5;
                let u1 = (rng_state as f32 / u32::MAX as f32).max(1e-6);
                rng_state ^= rng_state << 13;
                rng_state ^= rng_state >> 17;
                rng_state ^= rng_state << 5;
                let u2 = rng_state as f32 / u32::MAX as f32;
                let z = (-2.0 * u1.ln()).sqrt() * (2.0 * std::f32::consts::PI * u2).cos();
                plane[y * w + x] = (base + 0.04 * z).clamp(0.0, 1.0);
            }
        }
        let out = guided_self(&plane, w, h, 5, 0.005);

        // Mean across the edge column on either side should remain
        // far apart (>= 0.25 separation), so the edge is preserved.
        let mut left_sum = 0.0f32;
        let mut right_sum = 0.0f32;
        let mut left_n = 0usize;
        let mut right_n = 0usize;
        for y in 10..(h - 10) {
            // Sample one pixel inside each region, away from the edge.
            left_sum += out[y * w + 10];
            left_n += 1;
            right_sum += out[y * w + (w - 10)];
            right_n += 1;
        }
        let left_mean = left_sum / left_n as f32;
        let right_mean = right_sum / right_n as f32;
        assert!(
            (right_mean - left_mean) > 0.25,
            "edge collapsed: left={} right={}",
            left_mean,
            right_mean,
        );
    }

    fn stdev(v: &[f32]) -> f32 {
        let mean: f32 = v.iter().sum::<f32>() / v.len() as f32;
        let var: f32 = v.iter().map(|&x| (x - mean).powi(2)).sum::<f32>() / v.len() as f32;
        var.sqrt()
    }
}
