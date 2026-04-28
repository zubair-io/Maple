//! Per-image exposure/gain compensation via least-squares brightness matching.
//!
//! Given N warped images that overlap pairwise, solve for per-image gain
//! factors that minimize brightness mismatch in the overlap regions.
//!
//! Reference: Brown & Lowe 2007 § 5 "Gain Compensation" — same formulation
//! AliceVision's ExposureCompensator and Hugin's vig_optimize use.

use nalgebra::{DMatrix, DVector};

use crate::error::PanoError;
use crate::types::PanoImage;

/// Solve for per-image gain factors. Returns Vec<f32> of length N where
/// gains[0] = 1.0 (gauge fix) and gains[i] is the multiplicative factor
/// to apply to image i so that overlap brightness matches across all
/// pairs.
pub fn solve_per_image_gain(images: &[&PanoImage]) -> Result<Vec<f32>, PanoError> {
    let n = images.len();
    if n == 0 {
        return Ok(Vec::new());
    }
    if n == 1 {
        return Ok(vec![1.0]);
    }

    // For each pair (i, j) with valid overlap, compute mean brightness in
    // both images over the overlap region.
    struct Constraint {
        i: usize,
        j: usize,
        log_ratio: f32,
    }
    let mut constraints: Vec<Constraint> = Vec::new();

    for i in 0..n {
        for j in (i + 1)..n {
            if let Some((mean_i, mean_j)) = compute_overlap_means(images[i], images[j]) {
                if mean_i > 1e-6 && mean_j > 1e-6 {
                    // Constraint: g_i * mean_i = g_j * mean_j
                    //   → log(g_i) - log(g_j) = log(mean_j / mean_i)
                    let log_ratio = (mean_j / mean_i).ln();
                    constraints.push(Constraint { i, j, log_ratio });
                }
            }
        }
    }

    if constraints.is_empty() {
        // No overlap — no compensation possible. Return identity gains.
        return Ok(vec![1.0; n]);
    }

    // Build the linear system A · x = b where x = [log(g_1), log(g_2), ..., log(g_{n-1})]
    // (g_0 fixed at 1.0). For constraint (i, j, log_ratio):
    //   if i == 0:  -x_{j-1} = log_ratio    → row: -1 at column (j-1)
    //   if j == 0:  +x_{i-1} = log_ratio    → row: +1 at column (i-1)
    //   else:       x_{i-1} - x_{j-1} = log_ratio    → row: +1 at (i-1), -1 at (j-1)
    let m = constraints.len();
    let n_vars = n - 1;
    let mut a = DMatrix::<f64>::zeros(m, n_vars);
    let mut b = DVector::<f64>::zeros(m);
    for (k, c) in constraints.iter().enumerate() {
        if c.i > 0 {
            a[(k, c.i - 1)] = 1.0;
        }
        if c.j > 0 {
            a[(k, c.j - 1)] = -1.0;
        }
        b[k] = c.log_ratio as f64;
    }

    // Solve via normal equations: x = (A^T A)^-1 A^T b.
    // For a small N this is fast and numerically stable enough.
    let at = a.transpose();
    let ata = &at * &a;
    let atb = &at * &b;

    let x = ata
        .lu()
        .solve(&atb)
        .ok_or_else(|| PanoError::Other("gain solve: singular system".into()))?;

    // Reconstruct gains: g_0 = 1, g_i = exp(x_{i-1}) for i ≥ 1.
    let mut gains = vec![1.0f32; n];
    for i in 1..n {
        gains[i] = x[i - 1].exp() as f32;
    }
    Ok(gains)
}

fn compute_overlap_means(a: &PanoImage, b: &PanoImage) -> Option<(f32, f32)> {
    if a.width != b.width || a.height != b.height {
        return None;
    }
    let n_pixels = (a.width as usize) * (a.height as usize);
    let mut sum_a = 0.0_f64;
    let mut sum_b = 0.0_f64;
    let mut count = 0u64;
    for idx in 0..n_pixels {
        if a.validity[idx] && b.validity[idx] {
            let ar = a.pixels[idx * 3];
            let ag = a.pixels[idx * 3 + 1];
            let ab = a.pixels[idx * 3 + 2];
            let br = b.pixels[idx * 3];
            let bg = b.pixels[idx * 3 + 1];
            let bb = b.pixels[idx * 3 + 2];
            // Rec.709 luma.
            let ya = 0.2126 * ar + 0.7152 * ag + 0.0722 * ab;
            let yb = 0.2126 * br + 0.7152 * bg + 0.0722 * bb;
            sum_a += ya as f64;
            sum_b += yb as f64;
            count += 1;
        }
    }
    if count == 0 {
        return None;
    }
    Some((
        (sum_a / count as f64) as f32,
        (sum_b / count as f64) as f32,
    ))
}

/// Apply per-image gains in place. Multiplies every channel by gains[i].
pub fn apply_gains(images: &mut [PanoImage], gains: &[f32]) -> Result<(), PanoError> {
    if images.len() != gains.len() {
        return Err(PanoError::Other(format!(
            "apply_gains: image/gain count mismatch ({} vs {})",
            images.len(),
            gains.len()
        )));
    }
    for (img, &g) in images.iter_mut().zip(gains.iter()) {
        for p in img.pixels.iter_mut() {
            *p *= g;
        }
    }
    Ok(())
}
