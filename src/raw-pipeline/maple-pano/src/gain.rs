//! Gain compensation: per-frame scalar (optionally per-channel)
//! multipliers solved as least squares over mean intensities in
//! pairwise overlap regions — Brown & Lowe 2007 §6, in **linear**
//! scene light where exposure really is a single multiplier (M2-CPU,
//! #1155; stitching spec §5.5).
//!
//! ## Formulation
//!
//! For every overlapping pair `(i, j)` with `N_ij` corresponding sample
//! points and overlap means `m_ij` (frame `i`'s mean over the shared
//! region) and `m_ji` (frame `j`'s mean over the same region):
//!
//! ```text
//! e(g) = Σ_pairs N_ij [ (g_i·m_ij − g_j·m_ji)² / σ_N²
//!                        + ((1 − g_i)² + (1 − g_j)²) / σ_g² ]
//!        + Σ_i (1 − g_i)² / σ_g²
//! ```
//!
//! The trailing per-frame anchor (weight of a single sample) keeps
//! frames with no overlap solvable — they come out at exactly 1.0.
//! The quadratic is minimized by one dense symmetric solve (in-tree
//! Gaussian elimination — no external linear-algebra dependency).
//!
//! Defaults deviate from Brown & Lowe's `σ_N = 10/255, σ_g = 0.1`
//! deliberately: their strong gain prior guards against overlap means
//! measured over *different* pixel sets. Here the means come from
//! geometrically corresponding samples (frame `i`'s grid reprojected
//! into frame `j` and vice versa), so the measurement noise is far
//! smaller and a weak prior (`σ_g = 1.0`) with a tight data term
//! (`σ_N = 0.01`) recovers relative gains to well under 1% (the #1155
//! gate) while still anchoring the global scale.
//!
//! ## Where it runs
//!
//! Before warp: overlap means are gathered in **source space** by
//! reprojecting strided sample grids between frames (no canvas-sized
//! buffer needed). The solved gains are folded into the warp
//! ([`crate::warp::warp_to_canvas`]'s `gain` parameter).

use rayon::prelude::*;

use crate::camera::Camera;
use crate::error::PanoError;
use crate::ingest::PlanarImage;

/// Gain model (spec §5.5: "per-image scalar gain (optionally
/// per-channel)").
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum GainMode {
    /// One multiplier per frame, solved on mean linear intensity
    /// `(R + G + B) / 3`.
    #[default]
    Scalar,
    /// Independent multipliers per channel (three independent solves
    /// over the same overlap samples).
    PerChannel,
}

/// Options for [`solve_gains`].
#[derive(Debug, Clone)]
pub struct GainOptions {
    pub mode: GainMode,
    /// Data-term sigma (linear intensity units). Smaller = trust the
    /// overlap means harder.
    pub sigma_n: f64,
    /// Gain-prior sigma. Larger = weaker pull toward 1.0.
    pub sigma_g: f64,
    /// Sample-grid stride in source pixels (both axes). 4 → 1/16 of
    /// the overlap pixels are sampled.
    pub sample_stride: u32,
    /// Pairs with fewer corresponding samples than this are ignored.
    pub min_overlap_samples: usize,
}

impl Default for GainOptions {
    fn default() -> Self {
        Self {
            mode: GainMode::Scalar,
            sigma_n: 0.01,
            sigma_g: 1.0,
            sample_stride: 4,
            min_overlap_samples: 64,
        }
    }
}

/// Per-pair overlap statistics (per-channel sums over corresponding
/// sample points).
struct PairStats {
    i: usize,
    j: usize,
    count: usize,
    sum_i: [f64; 3],
    sum_j: [f64; 3],
}

/// Solve per-frame gains. Always returns per-channel triples
/// (`[g, g, g]` in scalar mode) so the warp's gain input is uniform.
///
/// Frames and cameras correspond by index; every frame's dimensions
/// must match its camera's.
pub fn solve_gains(
    frames: &[PlanarImage],
    cameras: &[Camera],
    opts: &GainOptions,
) -> Result<Vec<[f32; 3]>, PanoError> {
    if frames.len() != cameras.len() {
        return Err(PanoError::InvalidOptions(format!(
            "solve_gains: {} frames vs {} cameras",
            frames.len(),
            cameras.len()
        )));
    }
    for (k, (f, c)) in frames.iter().zip(cameras).enumerate() {
        if (f.width(), f.height()) != (c.width, c.height) {
            return Err(PanoError::InvalidOptions(format!(
                "solve_gains: frame {k} is {}x{} but its camera is {}x{}",
                f.width(),
                f.height(),
                c.width,
                c.height
            )));
        }
    }
    if !(opts.sigma_n > 0.0 && opts.sigma_g > 0.0) || opts.sample_stride == 0 {
        return Err(PanoError::InvalidOptions(
            "solve_gains: sigma_n, sigma_g and sample_stride must be positive".into(),
        ));
    }
    let n = frames.len();
    if n == 0 {
        return Ok(Vec::new());
    }
    if n == 1 {
        return Ok(vec![[1.0; 3]]);
    }

    // Candidate pairs: prune by optical-axis separation vs. summed
    // half-diagonal FOVs (with slack for distortion) before sampling.
    let mut candidates: Vec<(usize, usize)> = Vec::new();
    for i in 0..n {
        for j in (i + 1)..n {
            if frames_may_overlap(&cameras[i], &cameras[j]) {
                candidates.push((i, j));
            }
        }
    }

    let stats: Vec<PairStats> = candidates
        .par_iter()
        .filter_map(|&(i, j)| {
            let s = pair_overlap_stats(
                &frames[i],
                &cameras[i],
                &frames[j],
                &cameras[j],
                opts.sample_stride,
            );
            (s.count >= opts.min_overlap_samples.max(1)).then_some(PairStats {
                i,
                j,
                count: s.count,
                sum_i: s.sum_i,
                sum_j: s.sum_j,
            })
        })
        .collect();

    // Channel index sets per mode: scalar solves once on the channel
    // mean; per-channel solves R, G, B independently.
    let solves: &[&[usize]] = match opts.mode {
        GainMode::Scalar => &[&[0, 1, 2]],
        GainMode::PerChannel => &[&[0], &[1], &[2]],
    };

    let mut gains = vec![[1.0_f32; 3]; n];
    for channels in solves {
        let mut a = vec![vec![0.0_f64; n]; n];
        let mut b = vec![0.0_f64; n];
        // Per-frame anchor (one sample's worth of prior): keeps
        // overlap-free frames at exactly 1.0 and the system SPD.
        let w_anchor = 1.0 / (opts.sigma_g * opts.sigma_g);
        for i in 0..n {
            a[i][i] += w_anchor;
            b[i] += w_anchor;
        }
        for s in &stats {
            let inv = 1.0 / (s.count as f64 * channels.len() as f64);
            let mi: f64 = channels.iter().map(|&c| s.sum_i[c]).sum::<f64>() * inv;
            let mj: f64 = channels.iter().map(|&c| s.sum_j[c]).sum::<f64>() * inv;
            if !(mi.is_finite() && mj.is_finite()) || mi.abs() < 1e-9 || mj.abs() < 1e-9 {
                continue; // black/degenerate overlap constrains nothing
            }
            let nf = s.count as f64;
            let wd = nf / (opts.sigma_n * opts.sigma_n);
            let wp = nf / (opts.sigma_g * opts.sigma_g);
            a[s.i][s.i] += wd * mi * mi + wp;
            a[s.j][s.j] += wd * mj * mj + wp;
            a[s.i][s.j] -= wd * mi * mj;
            a[s.j][s.i] -= wd * mi * mj;
            b[s.i] += wp;
            b[s.j] += wp;
        }
        let x = solve_dense(a, b).ok_or_else(|| {
            PanoError::InvalidOptions("solve_gains: singular normal equations".into())
        })?;
        for (i, gi) in x.iter().enumerate() {
            for &c in *channels {
                gains[i][c] = *gi as f32;
            }
        }
    }
    Ok(gains)
}

/// Cheap overlap pre-test: optical-axis separation must not exceed the
/// summed half-diagonal FOVs (with 10% slack for distortion).
fn frames_may_overlap(a: &Camera, b: &Camera) -> bool {
    let axis = |c: &Camera| c.rotation.mul_vec(crate::math::Vec3::new(0.0, 0.0, 1.0));
    let half_diag = |c: &Camera| {
        let rx = c.width as f64 * 0.5;
        let ry = c.height as f64 * 0.5;
        ((rx * rx + ry * ry).sqrt() / c.focal_px).atan() * 1.1
    };
    let ang = axis(a).dot(axis(b)).clamp(-1.0, 1.0).acos();
    ang <= half_diag(a) + half_diag(b)
}

struct OverlapSums {
    count: usize,
    sum_i: [f64; 3],
    sum_j: [f64; 3],
}

/// Gather per-channel sums over corresponding points of the (i, j)
/// overlap, sampling a strided grid of each frame and reprojecting into
/// the other (both directions, accumulated symmetrically).
fn pair_overlap_stats(
    fi: &PlanarImage,
    ci: &Camera,
    fj: &PlanarImage,
    cj: &Camera,
    stride: u32,
) -> OverlapSums {
    let mut out = OverlapSums {
        count: 0,
        sum_i: [0.0; 3],
        sum_j: [0.0; 3],
    };
    accumulate_direction(fi, ci, fj, cj, stride, false, &mut out);
    accumulate_direction(fj, cj, fi, ci, stride, true, &mut out);
    out
}

/// Walk `src`'s strided grid; for samples that land validly in `dst`,
/// accumulate `src`'s texel value and `dst`'s bilinear value. With
/// `swapped`, `src` plays the role of frame `j`.
fn accumulate_direction(
    src: &PlanarImage,
    c_src: &Camera,
    dst: &PlanarImage,
    c_dst: &Camera,
    stride: u32,
    swapped: bool,
    out: &mut OverlapSums,
) {
    let stride = stride.max(1);
    let w = src.width();
    let h = src.height();
    let mut y = stride / 2;
    while y < h {
        let mut x = stride / 2;
        while x < w {
            if src.validity.get(x, y) {
                let (px, py) = (x as f64 + 0.5, y as f64 + 0.5);
                if let Some(dir) = c_src.pixel_to_world_dir(px, py) {
                    if let Some((qx, qy)) = c_dst.world_dir_to_pixel(dir) {
                        if qx >= 0.0
                            && qx <= dst.width() as f64
                            && qy >= 0.0
                            && qy <= dst.height() as f64
                        {
                            if let Some(d) = bilinear_valid(dst, qx, qy) {
                                let i = (y * w + x) as usize;
                                let s = [src.r[i] as f64, src.g[i] as f64, src.b[i] as f64];
                                let (si, sj) = if swapped {
                                    (&mut out.sum_j, &mut out.sum_i)
                                } else {
                                    (&mut out.sum_i, &mut out.sum_j)
                                };
                                for c in 0..3 {
                                    si[c] += s[c];
                                    sj[c] += d[c] as f64;
                                }
                                out.count += 1;
                            }
                        }
                    }
                }
            }
            x += stride;
        }
        y += stride;
    }
}

/// Validity-weighted bilinear tap (texel centers at half-integers).
/// `None` when no valid in-bounds tap carries weight.
fn bilinear_valid(src: &PlanarImage, x_px: f64, y_px: f64) -> Option<[f32; 3]> {
    let w = src.width() as i64;
    let h = src.height() as i64;
    let x = x_px - 0.5;
    let y = y_px - 0.5;
    let x0 = x.floor();
    let y0 = y.floor();
    let fx = x - x0;
    let fy = y - y0;
    let (x0, y0) = (x0 as i64, y0 as i64);
    let taps = [
        (x0, y0, (1.0 - fx) * (1.0 - fy)),
        (x0 + 1, y0, fx * (1.0 - fy)),
        (x0, y0 + 1, (1.0 - fx) * fy),
        (x0 + 1, y0 + 1, fx * fy),
    ];
    let mut acc = [0.0_f64; 3];
    let mut wsum = 0.0_f64;
    for (tx, ty, wgt) in taps {
        if tx < 0 || tx >= w || ty < 0 || ty >= h || wgt == 0.0 {
            continue;
        }
        if !src.validity.get(tx as u32, ty as u32) {
            continue;
        }
        let i = (ty * w + tx) as usize;
        acc[0] += wgt * src.r[i] as f64;
        acc[1] += wgt * src.g[i] as f64;
        acc[2] += wgt * src.b[i] as f64;
        wsum += wgt;
    }
    if wsum < 1e-9 {
        return None;
    }
    let inv = 1.0 / wsum;
    Some([
        (acc[0] * inv) as f32,
        (acc[1] * inv) as f32,
        (acc[2] * inv) as f32,
    ])
}

/// Dense linear solve via Gaussian elimination with partial pivoting
/// (the gain systems are tiny — one row per frame). `None` when the
/// matrix is numerically singular.
fn solve_dense(mut a: Vec<Vec<f64>>, mut b: Vec<f64>) -> Option<Vec<f64>> {
    let n = b.len();
    for col in 0..n {
        // Pivot.
        let mut piv = col;
        for row in (col + 1)..n {
            if a[row][col].abs() > a[piv][col].abs() {
                piv = row;
            }
        }
        if a[piv][col].abs() < 1e-12 {
            return None;
        }
        a.swap(col, piv);
        b.swap(col, piv);
        // Eliminate below.
        let pivot = a[col][col];
        for row in (col + 1)..n {
            let factor = a[row][col] / pivot;
            if factor == 0.0 {
                continue;
            }
            for k in col..n {
                let v = a[col][k];
                a[row][k] -= factor * v;
            }
            b[row] -= factor * b[col];
        }
    }
    // Back substitution.
    let mut x = vec![0.0_f64; n];
    for col in (0..n).rev() {
        let mut s = b[col];
        for k in (col + 1)..n {
            s -= a[col][k] * x[k];
        }
        x[col] = s / a[col][col];
    }
    Some(x)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ingest::ValidityMask;
    use crate::math::Vec3;
    use crate::prng::SplitMix64;
    use crate::render::{build_camera_set, CameraSetOptions, Pattern};

    /// Smooth deterministic scene function of world direction.
    fn scene(dir: Vec3) -> [f32; 3] {
        let base = 0.45 + 0.2 * (3.0 * dir.x + 1.0).sin() + 0.15 * (2.0 * dir.y - 0.5).cos();
        [
            base as f32,
            (base * 0.8 + 0.1 * (4.0 * dir.z).sin()) as f32,
            (base * 0.6 + 0.05) as f32,
        ]
    }

    /// Render a frame of the scene function through a camera.
    fn frame_from_scene(cam: &Camera, mul: [f32; 3]) -> PlanarImage {
        let (w, h) = (cam.width, cam.height);
        let n = (w as usize) * (h as usize);
        let (mut r, mut g, mut b) = (vec![0.0; n], vec![0.0; n], vec![0.0; n]);
        for y in 0..h {
            for x in 0..w {
                let d = cam
                    .pixel_to_world_dir(x as f64 + 0.5, y as f64 + 0.5)
                    .expect("invertible");
                let s = scene(d);
                let i = (y * w + x) as usize;
                r[i] = s[0] * mul[0];
                g[i] = s[1] * mul[1];
                b[i] = s[2] * mul[2];
            }
        }
        PlanarImage::from_planes(w, h, r, g, b, ValidityMask::new_filled(w, h, true))
    }

    fn ring_cameras(count: u32, fov: f64, overlap: f64) -> Vec<Camera> {
        let opts = CameraSetOptions {
            count,
            pattern: Pattern::Ring { full: false },
            fov_deg: fov,
            overlap,
            pitch_deg: 0.0,
            jitter_deg: 0.0,
            k1: 0.0,
            k2: 0.0,
            width: 96,
            height: 72,
        };
        build_camera_set(&opts, &mut SplitMix64::new(3))
            .expect("valid")
            .iter()
            .map(|c| c.to_camera())
            .collect()
    }

    fn geometric_mean(g: &[[f32; 3]], c: usize) -> f64 {
        let s: f64 = g.iter().map(|v| (v[c] as f64).ln()).sum();
        (s / g.len() as f64).exp()
    }

    /// Unity input solves to gains of exactly ~1.0 (#1155 gate).
    #[test]
    fn unity_input_solves_to_one() {
        let cams = ring_cameras(3, 60.0, 0.4);
        let frames: Vec<_> = cams.iter().map(|c| frame_from_scene(c, [1.0; 3])).collect();
        let gains = solve_gains(&frames, &cams, &GainOptions::default()).unwrap();
        for g in &gains {
            for c in 0..3 {
                assert!((g[c] - 1.0).abs() < 1e-3, "unity gain drifted: {g:?}");
            }
        }
    }

    /// ±1 EV pre-multiplied frames: relative gains recovered within 1%
    /// (#1155 gate). Compared after geometric-mean normalization (the
    /// prior fixes the global scale, the data term the ratios).
    #[test]
    fn plus_minus_one_ev_recovered_within_one_percent() {
        let cams = ring_cameras(3, 60.0, 0.45);
        let muls = [2.0_f32, 1.0, 0.5];
        let frames: Vec<_> = cams
            .iter()
            .zip(muls)
            .map(|(c, m)| frame_from_scene(c, [m; 3]))
            .collect();
        let gains = solve_gains(&frames, &cams, &GainOptions::default()).unwrap();
        let gm = geometric_mean(&gains, 0);
        let want_gm = (muls.iter().map(|m| (1.0 / *m as f64).ln()).sum::<f64>() / 3.0).exp();
        for (g, m) in gains.iter().zip(muls) {
            let got = g[0] as f64 / gm;
            let want = (1.0 / m as f64) / want_gm;
            let rel = (got - want).abs() / want;
            assert!(
                rel < 0.01,
                "gain for x{m} frame: normalized {got:.5}, want {want:.5} ({:.3}% off)",
                rel * 100.0
            );
        }
        // The compensated overlap means must match: g_i·m_i ≈ const.
        let products: Vec<f64> = gains
            .iter()
            .zip(muls)
            .map(|(g, m)| g[0] as f64 * m as f64)
            .collect();
        let spread = (products.iter().cloned().fold(f64::MIN, f64::max)
            - products.iter().cloned().fold(f64::MAX, f64::min))
            / products[0];
        assert!(spread < 0.01, "compensated products spread: {products:?}");
    }

    /// Per-channel mode recovers independent per-channel multipliers.
    #[test]
    fn per_channel_multipliers_recovered() {
        let cams = ring_cameras(3, 60.0, 0.45);
        let muls: [[f32; 3]; 3] = [[1.6, 1.0, 0.7], [1.0, 1.0, 1.0], [0.8, 1.2, 1.0]];
        let frames: Vec<_> = cams
            .iter()
            .zip(muls)
            .map(|(c, m)| frame_from_scene(c, m))
            .collect();
        let gains = solve_gains(
            &frames,
            &cams,
            &GainOptions {
                mode: GainMode::PerChannel,
                ..GainOptions::default()
            },
        )
        .unwrap();
        for c in 0..3 {
            let gm = geometric_mean(&gains, c);
            let want_gm = (muls.iter().map(|m| (1.0 / m[c] as f64).ln()).sum::<f64>() / 3.0).exp();
            for (g, m) in gains.iter().zip(muls) {
                let got = g[c] as f64 / gm;
                let want = (1.0 / m[c] as f64) / want_gm;
                assert!(
                    (got - want).abs() / want < 0.01,
                    "channel {c}: normalized {got:.5} want {want:.5}"
                );
            }
        }
    }

    /// Disconnected frames anchor at exactly 1.0.
    #[test]
    fn disconnected_frames_get_unit_gain() {
        let a = Camera::new([0.0; 3], 90.0, 0.0, 0.0, 64, 48);
        let b = Camera::new([0.0, std::f64::consts::PI, 0.0], 90.0, 0.0, 0.0, 64, 48);
        let frames = vec![frame_from_scene(&a, [3.0; 3]), frame_from_scene(&b, [0.25; 3])];
        let gains = solve_gains(&frames, &[a, b], &GainOptions::default()).unwrap();
        for g in &gains {
            for c in 0..3 {
                assert_eq!(g[c], 1.0, "no-overlap gain must stay 1.0: {gains:?}");
            }
        }
    }

    #[test]
    fn input_validation() {
        let cam = Camera::new([0.0; 3], 90.0, 0.0, 0.0, 64, 48);
        let frame = frame_from_scene(&cam, [1.0; 3]);
        assert!(solve_gains(&[frame.clone()], &[], &GainOptions::default()).is_err());
        let wrong = Camera::new([0.0; 3], 90.0, 0.0, 0.0, 32, 24);
        assert!(solve_gains(&[frame.clone()], &[wrong], &GainOptions::default()).is_err());
        let bad = GainOptions {
            sigma_n: 0.0,
            ..GainOptions::default()
        };
        assert!(solve_gains(&[frame], &[cam], &bad).is_err());
        assert!(solve_gains(&[], &[], &GainOptions::default())
            .unwrap()
            .is_empty());
    }

    #[test]
    fn solve_dense_matches_known_system() {
        // [[2, 1], [1, 3]] x = [5, 10] → x = [1, 3].
        let a = vec![vec![2.0, 1.0], vec![1.0, 3.0]];
        let x = solve_dense(a, vec![5.0, 10.0]).unwrap();
        assert!((x[0] - 1.0).abs() < 1e-12 && (x[1] - 3.0).abs() < 1e-12);
        // Singular.
        let s = vec![vec![1.0, 2.0], vec![2.0, 4.0]];
        assert!(solve_dense(s, vec![1.0, 2.0]).is_none());
    }

    /// Bilinear validity tap: invalid neighbors are renormalized away.
    #[test]
    fn bilinear_valid_renormalizes() {
        let mut img = frame_from_scene(&Camera::new([0.0; 3], 90.0, 0.0, 0.0, 8, 8), [0.0; 3]);
        for i in 0..img.pixel_count() {
            img.r[i] = 0.5;
        }
        img.validity.set(4, 4, false);
        img.r[(4 * 8 + 4) as usize] = 99.0; // poison
        let s = bilinear_valid(&img, 4.6, 4.6).expect("partially valid");
        assert!((s[0] - 0.5).abs() < 1e-6, "leaked poison: {}", s[0]);
    }
}
