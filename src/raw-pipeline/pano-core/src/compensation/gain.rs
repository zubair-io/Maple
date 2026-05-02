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

// ===========================================================================
// Per-channel R/G/B gain (T5)
// ===========================================================================
//
// The luma-only solver above can produce an extreme single gain per image
// (e.g. 0.43 on cam[2,3] vs 1.09 on cam[1] on pano_01) when overlap regions
// have content with very different per-channel means than the rest of the
// image. The luma-only solve also can't compensate per-channel white-balance
// drift between adjacent frames.
//
// Per-channel solve runs the same Brown-Lowe LSQ formulation three times,
// once each for R, G, B. A small Tikhonov regulariser (λ·I added to A^T A)
// prevents the solver from pushing any single image's per-channel gain to
// extreme values when overlap area is small or content is unrepresentative.

/// Per-channel mean luma in the overlap of two images, returning
/// `Some((mean_a_rgb, mean_b_rgb))` if any pixels overlap, else `None`.
/// Both means are 3-tuples in [R, G, B] order.
fn compute_overlap_means_rgb(a: &PanoImage, b: &PanoImage) -> Option<([f32; 3], [f32; 3])> {
    if a.width != b.width || a.height != b.height {
        return None;
    }
    let n_pixels = (a.width as usize) * (a.height as usize);
    let mut sum_a = [0.0_f64; 3];
    let mut sum_b = [0.0_f64; 3];
    let mut count = 0u64;
    for idx in 0..n_pixels {
        if a.validity[idx] && b.validity[idx] {
            for c in 0..3 {
                sum_a[c] += a.pixels[idx * 3 + c] as f64;
                sum_b[c] += b.pixels[idx * 3 + c] as f64;
            }
            count += 1;
        }
    }
    if count == 0 {
        return None;
    }
    let inv = 1.0 / count as f64;
    Some((
        [
            (sum_a[0] * inv) as f32,
            (sum_a[1] * inv) as f32,
            (sum_a[2] * inv) as f32,
        ],
        [
            (sum_b[0] * inv) as f32,
            (sum_b[1] * inv) as f32,
            (sum_b[2] * inv) as f32,
        ],
    ))
}

/// Per-channel Brown-Lowe gain compensation solve with Tikhonov
/// regularisation.
///
/// Runs the existing luma-only formulation three times independently
/// (R, G, B) and returns per-image `[r_gain, g_gain, b_gain]` triples.
///
/// `lambda` is the Tikhonov regularisation strength on the per-image
/// log-gain. λ·I is added to A^T A before LU solve. Larger λ pulls
/// gains toward 1.0 (gauge); smaller λ trusts the per-pair constraints
/// even when they are extreme. Default 0.01.
///
/// Image 0's gains are pinned to (1, 1, 1) as the gauge fix, identical
/// to the luma-only solver.
pub fn solve_per_image_gain_rgb(
    images: &[&PanoImage],
    lambda: f64,
) -> Result<Vec<[f32; 3]>, PanoError> {
    let n = images.len();
    if n == 0 {
        return Ok(Vec::new());
    }
    if n == 1 {
        return Ok(vec![[1.0, 1.0, 1.0]]);
    }

    // Gather all pair overlap means (per-channel).
    struct PairMeans {
        i: usize,
        j: usize,
        mean_a: [f32; 3],
        mean_b: [f32; 3],
    }
    let mut pair_means: Vec<PairMeans> = Vec::new();
    for i in 0..n {
        for j in (i + 1)..n {
            if let Some((a, b)) = compute_overlap_means_rgb(images[i], images[j]) {
                if a.iter().any(|&v| v > 1e-6) && b.iter().any(|&v| v > 1e-6) {
                    pair_means.push(PairMeans {
                        i,
                        j,
                        mean_a: a,
                        mean_b: b,
                    });
                }
            }
        }
    }

    if pair_means.is_empty() {
        return Ok(vec![[1.0, 1.0, 1.0]; n]);
    }

    // Solve once per channel.
    let mut gains = vec![[1.0_f32; 3]; n];
    for c in 0..3 {
        // Constraints: log(g_i) - log(g_j) = log(mean_b_c / mean_a_c)
        // (gauge: g_0 = 1, x_k = log(g_{k+1})).
        let m_constraints = pair_means.len();
        let n_vars = n - 1;
        // Construct A (m × n_vars) and b (m).
        let mut a = nalgebra::DMatrix::<f64>::zeros(m_constraints, n_vars);
        let mut b_vec = nalgebra::DVector::<f64>::zeros(m_constraints);
        for (k, p) in pair_means.iter().enumerate() {
            if p.i > 0 {
                a[(k, p.i - 1)] = 1.0;
            }
            if p.j > 0 {
                a[(k, p.j - 1)] = -1.0;
            }
            let ratio = (p.mean_b[c] as f64) / (p.mean_a[c] as f64);
            if ratio.is_finite() && ratio > 1e-9 {
                b_vec[k] = ratio.ln();
            }
        }
        // Normal equations with Tikhonov: (A^T A + λ·I) x = A^T b.
        let at = a.transpose();
        let mut ata = &at * &a;
        for k in 0..n_vars {
            ata[(k, k)] += lambda;
        }
        let atb = &at * &b_vec;
        let x = ata
            .lu()
            .solve(&atb)
            .ok_or_else(|| PanoError::Other("gain_rgb solve: singular system".into()))?;
        for i in 1..n {
            gains[i][c] = x[i - 1].exp() as f32;
        }
    }
    Ok(gains)
}

/// Apply per-image per-channel gains in place. `gains[i] = [r, g, b]`.
pub fn apply_gains_rgb(
    images: &mut [PanoImage],
    gains: &[[f32; 3]],
) -> Result<(), PanoError> {
    if images.len() != gains.len() {
        return Err(PanoError::Other(format!(
            "apply_gains_rgb: image/gain count mismatch ({} vs {})",
            images.len(),
            gains.len()
        )));
    }
    for (img, g) in images.iter_mut().zip(gains.iter()) {
        for px in img.pixels.chunks_exact_mut(3) {
            px[0] *= g[0];
            px[1] *= g[1];
            px[2] *= g[2];
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::color::ColorSpace;

    /// 32×32 image of a solid colour. Validity bits are true only for
    /// columns in `[valid_col_start, valid_col_end)` so we can chain
    /// per-pair overlaps deliberately.
    fn make_solid(
        width: u32,
        height: u32,
        rgb: [f32; 3],
        valid_col_start: u32,
        valid_col_end: u32,
    ) -> PanoImage {
        let mut img = PanoImage::new(width, height, ColorSpace::rec2020_d65_linear());
        let n = (width as usize) * (height as usize);
        for idx in 0..n {
            img.pixels[idx * 3] = rgb[0];
            img.pixels[idx * 3 + 1] = rgb[1];
            img.pixels[idx * 3 + 2] = rgb[2];
        }
        for y in 0..height {
            for x in 0..width {
                if x < valid_col_start || x >= valid_col_end {
                    img.set_invalid(x, y);
                }
            }
        }
        img
    }

    #[test]
    fn solve_per_image_gain_rgb_equalises_means_in_overlap() {
        // Three 32×32 solid images with chained validity:
        //   img0: cols 0..16   RGB [1.0, 1.0, 1.0]
        //   img1: cols 8..24   RGB [0.5, 0.8, 1.2]
        //   img2: cols 16..32  RGB [2.0, 1.5, 0.7]
        // → pair (0,1) overlap cols 8..16; pair (1,2) overlap cols 16..24.
        // Image 0 is the gauge, so expected gains are mean_0 / mean_i per
        // channel. After application, every overlap pair's per-channel
        // means should equalise to within 1 % (plan-mandated tolerance).
        let img0 = make_solid(32, 32, [1.0, 1.0, 1.0], 0, 16);
        let img1 = make_solid(32, 32, [0.5, 0.8, 1.2], 8, 24);
        let img2 = make_solid(32, 32, [2.0, 1.5, 0.7], 16, 32);

        // Use a tiny λ so the regularisation barely biases the
        // exactly-determined (2 vars, 2 constraints per channel) system.
        let gains =
            solve_per_image_gain_rgb(&[&img0, &img1, &img2], 1e-9).expect("solve succeeds");
        assert_eq!(gains.len(), 3);
        // Image 0 is gauged at exactly 1.
        for c in 0..3 {
            assert!(
                (gains[0][c] - 1.0).abs() < 1e-6,
                "gauge: gains[0][{}] = {}",
                c,
                gains[0][c]
            );
        }
        let exp1 = [1.0_f32 / 0.5, 1.0 / 0.8, 1.0 / 1.2];
        let exp2 = [1.0_f32 / 2.0, 1.0 / 1.5, 1.0 / 0.7];
        for c in 0..3 {
            assert!(
                (gains[1][c] - exp1[c]).abs() < 1e-3,
                "gains[1][{}] = {} (expected {})",
                c,
                gains[1][c],
                exp1[c]
            );
            assert!(
                (gains[2][c] - exp2[c]).abs() < 1e-3,
                "gains[2][{}] = {} (expected {})",
                c,
                gains[2][c],
                exp2[c]
            );
        }

        // Apply and verify per-channel means match in each overlap pair.
        let mut imgs = vec![img0.clone(), img1.clone(), img2.clone()];
        apply_gains_rgb(&mut imgs, &gains).expect("apply succeeds");
        let (m0a, m1a) =
            compute_overlap_means_rgb(&imgs[0], &imgs[1]).expect("pair (0,1) overlap");
        let (m1b, m2b) =
            compute_overlap_means_rgb(&imgs[1], &imgs[2]).expect("pair (1,2) overlap");
        for c in 0..3 {
            let dev01 = (m0a[c] - m1a[c]).abs() / m0a[c].max(1e-6);
            let dev12 = (m1b[c] - m2b[c]).abs() / m1b[c].max(1e-6);
            assert!(
                dev01 < 0.01,
                "pair (0,1) channel {}: mean_0 = {}, mean_1 = {} ({:.3}% off)",
                c,
                m0a[c],
                m1a[c],
                100.0 * dev01
            );
            assert!(
                dev12 < 0.01,
                "pair (1,2) channel {}: mean_1 = {}, mean_2 = {} ({:.3}% off)",
                c,
                m1b[c],
                m2b[c],
                100.0 * dev12
            );
        }
    }

    #[test]
    fn solve_per_image_gain_rgb_no_overlap_returns_identity() {
        // Two images with no shared valid columns → nothing to constrain,
        // so the function returns identity gains for every image.
        let img0 = make_solid(32, 32, [1.0, 1.0, 1.0], 0, 16);
        let img1 = make_solid(32, 32, [2.0, 2.0, 2.0], 16, 32);
        let gains = solve_per_image_gain_rgb(&[&img0, &img1], 0.01).expect("solve");
        assert_eq!(gains, vec![[1.0_f32, 1.0, 1.0]; 2]);
    }

    #[test]
    fn solve_per_image_gain_rgb_handles_trivial_inputs() {
        let zero: Vec<&PanoImage> = Vec::new();
        assert!(solve_per_image_gain_rgb(&zero, 0.01).unwrap().is_empty());
        let one = PanoImage::new(4, 4, ColorSpace::rec2020_d65_linear());
        let g = solve_per_image_gain_rgb(&[&one], 0.01).unwrap();
        assert_eq!(g, vec![[1.0_f32, 1.0, 1.0]]);
    }

    #[test]
    fn apply_gains_rgb_size_mismatch_errors() {
        let mut imgs = vec![PanoImage::new(8, 8, ColorSpace::rec2020_d65_linear())];
        assert!(apply_gains_rgb(&mut imgs, &[]).is_err());
    }

    #[test]
    fn apply_gains_rgb_scales_each_channel_independently() {
        let mut img = PanoImage::new(2, 2, ColorSpace::rec2020_d65_linear());
        for idx in 0..4 {
            img.pixels[idx * 3] = 0.5;
            img.pixels[idx * 3 + 1] = 0.25;
            img.pixels[idx * 3 + 2] = 0.10;
        }
        let mut imgs = vec![img];
        apply_gains_rgb(&mut imgs, &[[2.0, 4.0, 10.0]]).unwrap();
        for idx in 0..4 {
            assert!((imgs[0].pixels[idx * 3] - 1.0).abs() < 1e-6);
            assert!((imgs[0].pixels[idx * 3 + 1] - 1.0).abs() < 1e-6);
            assert!((imgs[0].pixels[idx * 3 + 2] - 1.0).abs() < 1e-6);
        }
    }
}
