//! Separable blur utilities for clarity/texture stages.
//!
//! `gaussian_blur_rgb` approximates a 2D Gaussian by three successive 1D box
//! blurs per axis (Wells 1986, "Efficient synthesis of Gaussian filters"). At
//! the slice-3 radii (3 and 40), the approximation is visually indistinguishable
//! from a true Gaussian and runs in O(n) per pixel independent of radius.
//!
//! Also hosts `guided_filter` (He, Sun, Tang 2010) — the edge-preserving
//! base/detail decomposition primitive shared by clarity (#264) and texture
//! (#265). Self-guided (`guide == p`) gives a structure-aware local mean
//! that does not bleed across high-contrast edges, eliminating the
//! unsharp-mask halo around dark/bright transitions.

use crate::image::{ColorSpace, Image};
use rayon::prelude::*;

/// Separable box blur of a single channel plane.
/// `buf` is row-major w×h. Returns a new blurred buffer.
///
/// Both sweeps run in parallel via rayon:
/// * **Horizontal sweep** writes `tmp` row by row; each row's output is a
///   disjoint `w`-element slice, so `par_chunks_mut(w)` is safe and trivial.
/// * **Vertical sweep** reads `tmp` column-by-column (stride `w`) and
///   historically wrote back into a row-major `out` via the same stride.
///   That stride-`w` scatter prevents a clean parallel-mut over rows. The
///   fix: write the vertical pass into a column-major `tmp_col` buffer
///   (each column is a contiguous `h`-element slice, so `par_chunks_mut(h)`
///   is safe), then transpose column-major → row-major in a final parallel
///   pass. Memory cost: one extra w×h f32 buffer (same size as `tmp`).
///   CPU cost: one extra pass, amortized against doing the full sweep in
///   parallel on 8+ cores.
pub(crate) fn box_blur_plane(buf: &[f32], w: usize, h: usize, r: usize) -> Vec<f32> {
    box_blur_channel(buf, w, h, r)
}

pub(crate) fn box_blur_channel(buf: &[f32], w: usize, h: usize, r: usize) -> Vec<f32> {
    if r == 0 { return buf.to_vec(); }

    // --- Horizontal sweep: row-parallel, row-major output ---
    let mut tmp = vec![0.0f32; buf.len()];
    tmp.par_chunks_mut(w).enumerate().for_each(|(y, out_row)| {
        let row = &buf[y * w..(y + 1) * w];
        let right0 = r.min(w - 1);
        let mut acc: f32 = row[0..=right0].iter().sum();
        let mut count = right0 + 1;
        out_row[0] = acc / count as f32;
        for x in 1..w {
            if x + r < w { acc += row[x + r]; count += 1; }
            if x > r     { acc -= row[x - r - 1]; count -= 1; }
            out_row[x] = acc / count as f32;
        }
    });

    // --- Vertical sweep: column-parallel into a column-major scratch ---
    //
    // `tmp_col[x * h + y]` = `tmp[y * w + x]` after blur along y.
    // Each column is a contiguous `h`-element chunk of `tmp_col`, and
    // columns don't overlap, so par_chunks_mut(h) is safe.
    let mut tmp_col = vec![0.0f32; buf.len()];
    tmp_col.par_chunks_mut(h).enumerate().for_each(|(x, out_col)| {
        let bot0 = r.min(h - 1);
        let mut acc: f32 = (0..=bot0).map(|i| tmp[i * w + x]).sum();
        let mut count = bot0 + 1;
        out_col[0] = acc / count as f32;
        for y in 1..h {
            if y + r < h { acc += tmp[(y + r) * w + x]; count += 1; }
            if y > r     { acc -= tmp[(y - r - 1) * w + x]; count -= 1; }
            out_col[y] = acc / count as f32;
        }
    });

    // --- Transpose column-major → row-major (parallel by output row) ---
    let mut out = vec![0.0f32; buf.len()];
    out.par_chunks_mut(w).enumerate().for_each(|(y, out_row)| {
        for x in 0..w {
            out_row[x] = tmp_col[x * h + y];
        }
    });
    out
}

/// Gaussian-ish blur of an RGB image via 3 successive box-blur passes per axis
/// (approximation per Wells 1986). `radius` is the effective Gaussian radius;
/// internally uses 3 box passes of `radius / 3`.
///
/// A radius of 0 returns a clone of the input unchanged.
pub fn gaussian_blur_plane(buf: &[f32], w: usize, h: usize, radius: usize) -> Vec<f32> {
    if radius == 0 {
        return buf.to_vec();
    }
    let r_box = (radius / 3).max(1);
    let mut plane = buf.to_vec();
    for _ in 0..3 {
        plane = box_blur_channel(&plane, w, h, r_box);
    }
    plane
}

/// Edge-preserving local-mean filter (He, Sun, Tang 2010 — "Guided
/// Image Filtering"). Returns the filtered `p` plane in which each
/// pixel is a locally-linear regression of `p` against `guide` over a
/// `(2r+1)²` window. `eps` is the regularisation that controls how
/// strongly `guide` edges propagate into the output: small `eps`
/// (≪ var(guide)) means "follow the edges sharply", large `eps`
/// (≫ var(guide)) collapses the filter back toward a plain box blur.
///
/// Self-guided (`guide == p`) is the classic structure-preserving
/// smoother — gives the "base" layer for base/detail decomposition.
/// `detail = p - guided(p, p, r, eps)` is high-frequency without the
/// cross-edge bleed that an unsharp mask suffers.
///
/// Effective stencil reach is `2r` per side: the `mean_a` / `mean_b`
/// passes box-blur a buffer that was itself box-blurred at radius `r`.
/// Pin tile overlap accordingly when adding new callers — see
/// `pipeline::tile::TILE_OVERLAP_PX` and the const-assertion against
/// `CLARITY_GUIDED_RADIUS` in `pipeline::tile::mod`.
///
/// Used by `stages::clarity` (radius 20, structure-scale) and
/// `stages::texture` (radius 2, fine-detail-scale).
pub(crate) fn guided_filter(
    guide: &[f32],
    p: &[f32],
    w: usize,
    h: usize,
    r: usize,
    eps: f32,
) -> Vec<f32> {
    assert_eq!(guide.len(), p.len());
    let n = guide.len();
    if r == 0 {
        return p.to_vec();
    }

    // Pre-compute the cross-products so all four `box_blur_plane`
    // passes operate on independent buffers and can run in parallel.
    let ip: Vec<f32> = guide
        .par_iter()
        .zip(p.par_iter())
        .map(|(&a, &b)| a * b)
        .collect();
    let ii: Vec<f32> = guide.par_iter().map(|&a| a * a).collect();

    // Box-blur the four planes concurrently. Each call already does
    // internal rayon parallelism over rows/columns; rayon::join lets
    // them overlap end-to-end so the cumulative wall-clock cost is
    // dominated by the slowest one, not the sum.
    let ((mean_i, mean_p), (mean_ip, mean_ii)) = rayon::join(
        || {
            rayon::join(
                || box_blur_plane(guide, w, h, r),
                || box_blur_plane(p, w, h, r),
            )
        },
        || {
            rayon::join(
                || box_blur_plane(&ip, w, h, r),
                || box_blur_plane(&ii, w, h, r),
            )
        },
    );

    // Fuse the covariance / variance / a / b derivations into a
    // single parallel pass — eliminates four intermediate Vecs.
    let (a, b): (Vec<f32>, Vec<f32>) = (0..n)
        .into_par_iter()
        .map(|i| {
            let cov_ip = mean_ip[i] - mean_i[i] * mean_p[i];
            let var_i = mean_ii[i] - mean_i[i] * mean_i[i];
            let a_i = cov_ip / (var_i + eps);
            let b_i = mean_p[i] - a_i * mean_i[i];
            (a_i, b_i)
        })
        .unzip();

    let (mean_a, mean_b) = rayon::join(
        || box_blur_plane(&a, w, h, r),
        || box_blur_plane(&b, w, h, r),
    );

    (0..n)
        .into_par_iter()
        .map(|i| mean_a[i] * guide[i] + mean_b[i])
        .collect()
}

pub fn gaussian_blur_rgb(img: &Image, radius: usize) -> Image {
    img.assert_space(ColorSpace::SceneLinearRec2020);
    if radius == 0 {
        return img.clone();
    }
    let w = img.width as usize;
    let h = img.height as usize;
    let r_box = (radius / 3).max(1);

    // Split into three channel planes.
    let mut r_plane: Vec<f32> = img.pixels.iter().map(|p| p[0]).collect();
    let mut g_plane: Vec<f32> = img.pixels.iter().map(|p| p[1]).collect();
    let mut b_plane: Vec<f32> = img.pixels.iter().map(|p| p[2]).collect();

    for _ in 0..3 {
        r_plane = box_blur_channel(&r_plane, w, h, r_box);
        g_plane = box_blur_channel(&g_plane, w, h, r_box);
        b_plane = box_blur_channel(&b_plane, w, h, r_box);
    }

    let mut out = Image::new(img.width, img.height, ColorSpace::SceneLinearRec2020);
    for i in 0..img.pixels.len() {
        out.pixels[i] = [r_plane[i], g_plane[i], b_plane[i]];
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blur_of_constant_is_constant() {
        let mut img = Image::new(20, 20, ColorSpace::SceneLinearRec2020);
        for p in &mut img.pixels { *p = [0.3, 0.5, 0.7]; }
        let blurred = gaussian_blur_rgb(&img, 5);
        for p in &blurred.pixels {
            assert!((p[0] - 0.3).abs() < 1e-5);
            assert!((p[1] - 0.5).abs() < 1e-5);
            assert!((p[2] - 0.7).abs() < 1e-5);
        }
    }

    #[test]
    fn blur_smooths_a_delta() {
        // Single bright pixel should diffuse across the blur radius.
        let mut img = Image::new(21, 21, ColorSpace::SceneLinearRec2020);
        for p in &mut img.pixels { *p = [0.0; 3]; }
        img.pixels[10 * 21 + 10] = [1.0, 1.0, 1.0];
        let blurred = gaussian_blur_rgb(&img, 3);
        // Center should be much less than 1 (energy spread out).
        let center = blurred.pixels[10 * 21 + 10][0];
        assert!(center < 0.5, "center still bright: {}", center);
        // Neighbor should have non-zero value (energy diffused).
        let neighbor = blurred.pixels[10 * 21 + 12][0];
        assert!(neighbor > 0.0);
    }

    #[test]
    fn radius_zero_is_identity() {
        let mut img = Image::new(3, 3, ColorSpace::SceneLinearRec2020);
        for (i, p) in img.pixels.iter_mut().enumerate() {
            *p = [i as f32, i as f32 * 2.0, i as f32 * 3.0];
        }
        let before = img.pixels.clone();
        let after = gaussian_blur_rgb(&img, 0);
        for (a, b) in after.pixels.iter().zip(before.iter()) {
            assert_eq!(a, b);
        }
    }

    #[test]
    fn blur_asymmetric_horizontal_stripe_preserves_axis() {
        // A single bright horizontal stripe on a wide-short image. After
        // a box blur, energy must spread *vertically* (because the stripe
        // is already uniform horizontally) and leave the horizontal
        // profile untouched within the row. An axis-swap in the vertical
        // sweep (e.g. reading column-major data as row-major during the
        // transpose) would shift energy into the wrong axis.
        let w = 40;
        let h = 10;
        let mut img = Image::new(w as u32, h as u32, ColorSpace::SceneLinearRec2020);
        for p in &mut img.pixels { *p = [0.0; 3]; }
        // Stripe at row 5, all columns.
        for x in 0..w { img.pixels[5 * w + x] = [1.0, 0.0, 0.0]; }

        let blurred = gaussian_blur_rgb(&img, 3);

        // Every row in [0..h] has the same value at every column (the
        // stripe was uniform horizontally). Check this by picking two
        // arbitrary columns on row 4 and asserting they agree.
        for row in 0..h {
            let left  = blurred.pixels[row * w + 3][0];
            let right = blurred.pixels[row * w + (w - 3)][0];
            assert!((left - right).abs() < 1e-5,
                "row {}: left={}, right={} (horizontal profile should be uniform)",
                row, left, right);
        }

        // Row 5 (the stripe) must have the max response; rows 0 and h-1
        // must have less. This locks the vertical axis of the sweep.
        let stripe  = blurred.pixels[5 * w][0];
        let top_row = blurred.pixels[0 * w][0];
        let bot_row = blurred.pixels[(h - 1) * w][0];
        assert!(stripe > top_row, "stripe row not brightest: stripe={}, top={}", stripe, top_row);
        assert!(stripe > bot_row, "stripe row not brightest: stripe={}, bot={}", stripe, bot_row);
    }

    #[test]
    fn guided_filter_of_constants_is_constant() {
        // Edge-preserving filter on a flat input collapses to the
        // input — no halo, no drift.
        let guide = vec![0.5f32; 40 * 40];
        let p = vec![0.7f32; 40 * 40];
        let out = guided_filter(&guide, &p, 40, 40, 5, 1e-3);
        assert!(out.iter().all(|v| (*v - 0.7).abs() < 1e-4));
    }

    #[test]
    fn self_guided_preserves_sharp_edge() {
        // Self-guided (guide == p) keeps a hard step edge sharp.
        // A plain box blur would smear it across `2r+1` pixels; the
        // guided filter should leave the step almost intact when eps
        // is small.
        let w = 32usize;
        let h = 8usize;
        let mut p = vec![0.0f32; w * h];
        for y in 0..h {
            for x in 0..w {
                p[y * w + x] = if x < w / 2 { 0.2 } else { 0.8 };
            }
        }
        let out = guided_filter(&p, &p, w, h, 4, 1e-4);
        // Far from the edge, output equals input.
        for y in 0..h {
            assert!((out[y * w + 1] - 0.2).abs() < 1e-3,
                "left side drifted at row {}: {}", y, out[y * w + 1]);
            assert!((out[y * w + (w - 2)] - 0.8).abs() < 1e-3,
                "right side drifted at row {}: {}", y, out[y * w + (w - 2)]);
        }
        // Edge transition: the two pixels straddling the step retain
        // most of the contrast (≥ 0.5 of the original 0.6 gap), which
        // a Gaussian at radius 4 would not.
        let edge_left  = out[3 * w + (w / 2 - 1)];
        let edge_right = out[3 * w + (w / 2)];
        assert!(edge_right - edge_left > 0.3,
            "edge contrast collapsed: {} -> {}", edge_left, edge_right);
    }

    #[test]
    fn self_guided_local_mean_does_not_overshoot() {
        // Property that drives #264 / #265: on a dark blob in a bright
        // field the self-guided base never exceeds the field's
        // brightness. A Gaussian blur of the same plane *would*
        // produce values outside the input range only via accumulated
        // float error, but in practice the unsharp-mask combine step
        // is what generates the overshoot. Here we just check the GF
        // produces nothing outside [min(p), max(p)] up to f32 noise.
        let w = 24usize;
        let h = 24usize;
        let mut p = vec![0.8f32; w * h];
        for y in 8..16 {
            for x in 8..16 {
                p[y * w + x] = 0.2;
            }
        }
        let out = guided_filter(&p, &p, w, h, 3, 1e-3);
        for &v in &out {
            assert!(v >= 0.2 - 1e-3 && v <= 0.8 + 1e-3,
                "guided output out of input range: {}", v);
        }
    }
}
