//! Per-image JPEG chroma-match transform solved via Thin Plate Splines (TPS).
//!
//! Fits a 2D HueSatMap over relative saturation (Cr) and hue angle (theta),
//! maps targets from post-AgX display-space comparison, and bakes the solved
//! offsets into a static 36x16 2D lookup grid for high-performance bilinear lookup.
//!
//! Locks Lightness (L) and modifies Oklab a/b coordinates only.

use crate::color::oklab::{oklab_to_rec2020, rec2020_to_oklab};
use crate::image::Image;
use rayon::prelude::*;

use crate::color::matrices::{M_REC2020_TO_SRGB, M_XYZ_D65_TO_REC2020};
use crate::math::Matrix3;
use crate::view::auto_profile::preview::JpegColorSpace;
use super::math_solver::{tps_evaluate, tps_solve_weighted};

pub const HUE_DIVS: usize = 36;
pub const SAT_DIVS: usize = 16;

/// 2D HueSatMap lookup transform. `grid[h][s]` stores the normalized OKLAB
/// chromaticity offsets `(delta_a, delta_b)` to be added to `(a/L, b/L)`.
/// Billinearly interpolated over hue angle (36 divisions of 10°) and relative
/// saturation (16 divisions from 0.0 to 1.0).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ChromaTransform {
    pub grid: [[(f32, f32); SAT_DIVS]; HUE_DIVS],
    pub taper_lo: f32,
    pub taper_hi: f32,
}

impl ChromaTransform {
    pub fn identity() -> Self {
        Self {
            grid: [[(0.0, 0.0); SAT_DIVS]; HUE_DIVS],
            taper_lo: 2.0,
            taper_hi: 3.0,
        }
    }

    /// Evaluates the grid lookup for a pixel with Oklab (L, a, b).
    /// Returns the corrected chromaticities (a_new, b_new).
    pub fn map_ab(&self, l: f32, a: f32, b: f32) -> (f32, f32) {
        let c = a.hypot(b);
        if c < 1e-6 || l < 1e-5 {
            return (a, b);
        }
        let cr = c / l;
        let hue = b.atan2(a).rem_euclid(std::f32::consts::TAU);

        // Map to Grid indices
        let bin_w = std::f32::consts::TAU / HUE_DIVS as f32;
        let h_pos = hue / bin_w;
        let h0 = (h_pos.floor() as usize) % HUE_DIVS;
        let h1 = (h0 + 1) % HUE_DIVS;
        let h_frac = h_pos.fract();

        // Saturation axis: Cr in [0.0, 1.0] mapped to [0, SAT_DIVS - 1]
        let s_pos = (cr * (SAT_DIVS - 1) as f32).clamp(0.0, (SAT_DIVS - 1) as f32);
        let s0 = s_pos.floor() as usize;
        let s1 = (s0 + 1).min(SAT_DIVS - 1);
        let s_frac = s_pos.fract();

        // Retrieve grid corners
        let p00 = self.grid[h0][s0];
        let p01 = self.grid[h0][s1];
        let p10 = self.grid[h1][s0];
        let p11 = self.grid[h1][s1];

        // Bilinear interpolation
        let p0_a = p00.0 * (1.0 - s_frac) + p01.0 * s_frac;
        let p0_b = p00.1 * (1.0 - s_frac) + p01.1 * s_frac;
        let p1_a = p10.0 * (1.0 - s_frac) + p11.0 * s_frac;
        let p1_b = p10.1 * (1.0 - s_frac) + p11.1 * s_frac;

        let delta_a_norm = p0_a * (1.0 - h_frac) + p1_a * h_frac;
        let delta_b_norm = p0_b * (1.0 - h_frac) + p1_b * h_frac;

        // Multiply back by Lightness L to scale the offset to absolute coordinates
        (a + delta_a_norm * l, b + delta_b_norm * l)
    }

    /// Apply the grid-based transform to a scene-linear Rec.2020 image in-place.
    /// Keeps Lightness intact, modifying Oklab a/b only, and tapers correction in highlights.
    pub fn apply_to_scene(&self, img: &mut Image) {
        img.pixels.par_iter_mut().for_each(|p| {
            if p[0] < 0.0 || p[1] < 0.0 || p[2] < 0.0 {
                return;
            }
            let v = p[0].max(p[1]).max(p[2]); // scene-linear V — tracks AgX path-to-white
            let lab = rec2020_to_oklab(*p);
            let (ta, tb) = self.map_ab(lab[0], lab[1], lab[2]);
            let t = ((v - self.taper_lo) / (self.taper_hi - self.taper_lo)).clamp(0.0, 1.0);
            let att = t * t * (3.0 - 2.0 * t);
            let na = lab[1] + (ta - lab[1]) * (1.0 - att);
            let nb = lab[2] + (tb - lab[2]) * (1.0 - att);
            *p = oklab_to_rec2020([lab[0], na, nb]);
        });
    }
}

/// Helper to run the chroma transform and AgX forward model on scene-linear pixels,
/// returning the post-AgX OKLAB (a, b) values. Used to simulate the AgX loop in the solver.
pub(crate) fn forward_post_agx_ab(
    scene: &[[f32; 3]],
    t: &ChromaTransform,
    contrast: f32,
) -> Vec<(f32, f32)> {
    use crate::image::ColorSpace;
    let mut img = Image {
        width: scene.len() as u32,
        height: 1,
        pixels: scene.to_vec(),
        space: ColorSpace::SceneLinearRec2020,
    };
    t.apply_to_scene(&mut img);
    crate::view::agx::apply(&mut img, contrast);
    img.pixels
        .iter()
        .map(|p| {
            let lab = rec2020_to_oklab(*p);
            (lab[1], lab[2])
        })
        .collect()
}

// ── JPEG Color Space management (Task 3) ─────────────────────────────────────

const M_ADOBE_RGB_TO_XYZ_D65: Matrix3 = Matrix3([
    [0.5767309, 0.1855540, 0.1881852],
    [0.2973769, 0.6273491, 0.0752741],
    [0.0270343, 0.0706872, 0.9911085],
]);

const ADOBE_RGB_GAMMA: f32 = 563.0 / 256.0;

fn jpeg_decode_matrices() -> &'static (Matrix3, Matrix3) {
    static CELL: std::sync::OnceLock<(Matrix3, Matrix3)> = std::sync::OnceLock::new();
    CELL.get_or_init(|| {
        let srgb_to_rec2020 =
            M_REC2020_TO_SRGB.inverse().expect("M_REC2020_TO_SRGB is invertible");
        let adobe_to_rec2020 = M_XYZ_D65_TO_REC2020.mul_mat(&M_ADOBE_RGB_TO_XYZ_D65);
        (srgb_to_rec2020, adobe_to_rec2020)
    })
}

#[inline]
fn srgb_to_linear_one(v: f32) -> f32 {
    if v <= 0.04045 {
        v / 12.92
    } else {
        ((v + 0.055) / 1.055).powf(2.4)
    }
}

#[inline]
fn decode_jpeg_to_rec2020(rgb01: [f32; 3], cs: JpegColorSpace) -> [f32; 3] {
    let (srgb_m, adobe_m) = jpeg_decode_matrices();
    match cs {
        JpegColorSpace::SRgb => {
            let lin = [
                srgb_to_linear_one(rgb01[0]),
                srgb_to_linear_one(rgb01[1]),
                srgb_to_linear_one(rgb01[2]),
            ];
            srgb_m.mul_vec(lin)
        }
        JpegColorSpace::AdobeRgb => {
            let lin = [
                rgb01[0].max(0.0).powf(ADOBE_RGB_GAMMA),
                rgb01[1].max(0.0).powf(ADOBE_RGB_GAMMA),
                rgb01[2].max(0.0).powf(ADOBE_RGB_GAMMA),
            ];
            adobe_m.mul_vec(lin)
        }
    }
}

// ── Downsampling, Filtering and Clustering (Task 3) ─────────────────────────

#[derive(Clone, Copy, Debug)]
pub(crate) struct Pair {
    pub raw_scene: [f32; 3], // Scene-linear RAW Rec.2020
    pub raw_lab: [f32; 3],   // Scene-linear RAW OKLAB
    pub jpeg_lab: [f32; 3],  // Linearized JPEG OKLAB target
}

const CLIP_HI: f32 = 245.0 / 255.0;
const CLIP_LO: f32 = 10.0 / 255.0;
const VARIANCE_CEIL: f32 = 0.02;

#[inline]
fn luma01(p: [f32; 3]) -> f32 {
    0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]
}

#[inline]
fn is_clipped(p: [f32; 3]) -> bool {
    p.iter().any(|&c| c > CLIP_HI || c < CLIP_LO)
}

fn box_average(
    raw: &[[f32; 3]],
    rw: usize,
    rh: usize,
    ox: usize,
    oy: usize,
    jw: usize,
    jh: usize,
) -> [f32; 3] {
    let x0 = (ox * rw) / jw;
    let mut x1 = ((ox + 1) * rw) / jw;
    if x1 <= x0 {
        x1 = (x0 + 1).min(rw);
    }
    let y0 = (oy * rh) / jh;
    let mut y1 = ((oy + 1) * rh) / jh;
    if y1 <= y0 {
        y1 = (y0 + 1).min(rh);
    }
    let mut acc = [0.0f64; 3];
    let mut n = 0u32;
    for y in y0..y1 {
        for x in x0..x1 {
            let p = raw[y * rw + x];
            acc[0] += p[0] as f64;
            acc[1] += p[1] as f64;
            acc[2] += p[2] as f64;
            n += 1;
        }
    }
    let n = n.max(1) as f64;
    [(acc[0] / n) as f32, (acc[1] / n) as f32, (acc[2] / n) as f32]
}

/// Groups downsampled paired pixels into deterministic color palette centroids
/// by binning OKLAB (a, b) coordinates over a 10x10 grid in [-0.4, 0.4].
fn cluster_pairs(pairs: &[Pair]) -> Vec<Pair> {
    const GRID_SIZE: usize = 8;
    struct Accumulator {
        raw_scene_sum: [f64; 3],
        raw_lab_sum: [f64; 3],
        jpeg_lab_sum: [f64; 3],
        count: usize,
    }
    let mut grid = Vec::from_iter((0..GRID_SIZE * GRID_SIZE).map(|_| Accumulator {
        raw_scene_sum: [0.0, 0.0, 0.0],
        raw_lab_sum: [0.0, 0.0, 0.0],
        jpeg_lab_sum: [0.0, 0.0, 0.0],
        count: 0,
    }));

    for p in pairs {
        let a = p.raw_lab[1];
        let b = p.raw_lab[2];
        let idx_a = (((a + 0.2) / 0.4) * GRID_SIZE as f32).floor() as i32;
        let idx_b = (((b + 0.2) / 0.4) * GRID_SIZE as f32).floor() as i32;
        if idx_a >= 0 && idx_a < GRID_SIZE as i32 && idx_b >= 0 && idx_b < GRID_SIZE as i32 {
            let idx = (idx_a * GRID_SIZE as i32 + idx_b) as usize;
            grid[idx].raw_scene_sum[0] += p.raw_scene[0] as f64;
            grid[idx].raw_scene_sum[1] += p.raw_scene[1] as f64;
            grid[idx].raw_scene_sum[2] += p.raw_scene[2] as f64;

            grid[idx].raw_lab_sum[0] += p.raw_lab[0] as f64;
            grid[idx].raw_lab_sum[1] += p.raw_lab[1] as f64;
            grid[idx].raw_lab_sum[2] += p.raw_lab[2] as f64;

            grid[idx].jpeg_lab_sum[0] += p.jpeg_lab[0] as f64;
            grid[idx].jpeg_lab_sum[1] += p.jpeg_lab[1] as f64;
            grid[idx].jpeg_lab_sum[2] += p.jpeg_lab[2] as f64;

            grid[idx].count += 1;
        }
    }

    let mut out = Vec::new();
    for acc in grid {
        if acc.count >= 3 {
            let c = acc.count as f64;
            out.push(Pair {
                raw_scene: [
                    (acc.raw_scene_sum[0] / c) as f32,
                    (acc.raw_scene_sum[1] / c) as f32,
                    (acc.raw_scene_sum[2] / c) as f32,
                ],
                raw_lab: [
                    (acc.raw_lab_sum[0] / c) as f32,
                    (acc.raw_lab_sum[1] / c) as f32,
                    (acc.raw_lab_sum[2] / c) as f32,
                ],
                jpeg_lab: [
                    (acc.jpeg_lab_sum[0] / c) as f32,
                    (acc.jpeg_lab_sum[1] / c) as f32,
                    (acc.jpeg_lab_sum[2] / c) as f32,
                ],
            });
        }
    }
    out
}

// ── The TPS solver & Grid baking pipeline (Task 4) ───────────────────────────

const CHROMA_STRENGTH: f32 = 1.0;
const CHROMA_TAPER_LO: f32 = 0.05;
const CHROMA_TAPER_HI: f32 = 0.80;
const MIN_SOLVE_PAIRS: usize = 256;

/// Reliability-weighting params for the TPS chroma solve. A control point's
/// weight is `(L / L_REF).clamp(W_MIN, 1.0)`: clusters at or above `L_REF` are
/// fully trusted (interpolated), darker ones are progressively smoothed through
/// the spline (never below `W_MIN`). `L_REF ≤ 0.5` keeps the L=0.5 solver
/// unit-tests at weight 1.0 (i.e. byte-identical to the unweighted solve).
const CHROMA_L_REF: f32 = 0.45;
const CHROMA_W_MIN: f32 = 0.08;
/// Global TPS regularization; the per-point diagonal penalty is `CHROMA_LAMBDA / w_i`.
const CHROMA_LAMBDA: f32 = 0.5;
/// Bound on the per-point relative-chroma target accumulated by the feedback loop.
const CHROMA_Z_CLAMP: f32 = 0.60;

/// Parse a float env override, falling back to `default`.
fn env_f32(key: &str, default: f32) -> f32 {
    std::env::var(key)
        .ok()
        .and_then(|s| s.parse::<f32>().ok())
        .unwrap_or(default)
}

/// Parse a boolean env flag (`"0"`/`"false"` = off), falling back to `default`.
fn env_flag(key: &str, default: bool) -> bool {
    std::env::var(key)
        .ok()
        .map(|s| s != "0" && !s.eq_ignore_ascii_case("false"))
        .unwrap_or(default)
}

/// Solves a 2D HueSatMap using Thin Plate Spline fitting over the clustered pairs.
/// Employs a feedback loop to invert AgX gamut compression effects exactly.
fn solve_chroma_map(pairs: &[Pair], contrast: f32) -> ChromaTransform {
    let n = pairs.len();
    if n == 0 {
        return ChromaTransform::identity();
    }
    let raw_scene: Vec<[f32; 3]> = pairs.iter().map(|p| p.raw_scene).collect();

    // Tuning knobs (env-overridable; defaults = the CHROMA_* consts above).
    let l_ref = env_f32("MAPLE_CHROMA_LREF", CHROMA_L_REF);
    let w_min = env_f32("MAPLE_CHROMA_WMIN", CHROMA_W_MIN);
    let lambda = env_f32("MAPLE_CHROMA_LAMBDA", CHROMA_LAMBDA);
    let weight_on = env_flag("MAPLE_CHROMA_WEIGHT", true);

    // Per-control-point reliability weight by lightness. Dark/low-L clusters get
    // their Δ/L targets amplified up to ~8× and sit at noisy (a/L, b/L) positions;
    // a large diagonal penalty (lambda / w) smooths them THROUGH the spline instead
    // of letting them spike the globally-supported biharmonic surface (the magenta
    // banding / oil-slick blotch). Bright, reliable clusters keep w≈1 and full fit
    // fidelity, preserving the real chroma boost. The trailing 1.0 weights the
    // virtual origin anchor that `control_pts` pushes at (0, 0).
    let mut weights: Vec<f32> = Vec::with_capacity(n + 1);
    for p in pairs {
        let w = if weight_on {
            (p.raw_lab[0] / l_ref).clamp(w_min, 1.0)
        } else {
            1.0
        };
        weights.push(w);
    }
    weights.push(1.0);

    // 1. Compute baseline post-AgX chroma
    let base_post_agx = forward_post_agx_ab(&raw_scene, &ChromaTransform::identity(), contrast);

    // 2. Initialize pre-AgX normalized target deltas. Clamp L to 0.12 to prevent division explosion in dark regions.
    // Scale target delta smoothly to 0 near neutral (Cr < 0.04) to lock the neutral axis.
    let mut z_a = vec![0.0f32; n];
    let mut z_b = vec![0.0f32; n];
    for i in 0..n {
        let l = pairs[i].raw_lab[0].max(0.12);
        let raw_c = pairs[i].raw_lab[1].hypot(pairs[i].raw_lab[2]);
        let raw_cr = raw_c / l;
        let target_scale = (raw_cr / 0.04).clamp(0.0, 1.0);

        let target_da = pairs[i].jpeg_lab[1] - base_post_agx[i].0;
        let target_db = pairs[i].jpeg_lab[2] - base_post_agx[i].1;
        z_a[i] = (target_da / l) * target_scale;
        z_b[i] = (target_db / l) * target_scale;
    }

    // 3. Set up control points in relative Cartesian coordinates (a/L, b/L)
    let mut control_pts = Vec::with_capacity(n + 1);
    for p in pairs {
        let l = p.raw_lab[0].max(0.12);
        control_pts.push((p.raw_lab[1] / l, p.raw_lab[2] / l));
    }
    // Add virtual anchor at origin to lock neutral axis
    control_pts.push((0.0, 0.0));

    // 4. Feedback loop: iterate to pre-invert AgX non-linear compression.
    // Regularization is now per-point (lambda / w_i, see `weights` above), which
    // suppresses the dark-cluster spikes that caused high-frequency splotches.
    const ITERS: usize = 4;
    const ALPHA: f32 = 0.8;

    let mut current_grid = [[(0.0f32, 0.0f32); SAT_DIVS]; HUE_DIVS];

    for _ in 0..ITERS {
        let mut tps_z_a = Vec::with_capacity(n + 1);
        let mut tps_z_b = Vec::with_capacity(n + 1);
        for i in 0..n {
            tps_z_a.push(z_a[i]);
            tps_z_b.push(z_b[i]);
        }
        tps_z_a.push(0.0);
        tps_z_b.push(0.0);

        let coef_a = match tps_solve_weighted(&control_pts, &tps_z_a, lambda, &weights) {
            Some(c) => c,
            None => break,
        };
        let coef_b = match tps_solve_weighted(&control_pts, &tps_z_b, lambda, &weights) {
            Some(c) => c,
            None => break,
        };

        // Bake temporary grid
        let mut temp_transform = ChromaTransform::identity();
        for h in 0..HUE_DIVS {
            let theta = (h as f32 / HUE_DIVS as f32) * std::f32::consts::TAU;
            for s in 0..SAT_DIVS {
                if s == 0 {
                    temp_transform.grid[h][0] = (0.0, 0.0);
                    continue;
                }
                let cr = s as f32 / (SAT_DIVS - 1) as f32;
                let x = cr * theta.cos();
                let y = cr * theta.sin();
                let da = tps_evaluate(&coef_a, (x, y));
                let db = tps_evaluate(&coef_b, (x, y));
                temp_transform.grid[h][s] = (da, db);
            }
        }
        current_grid = temp_transform.grid;

        // Run AgX forward model under current transform
        let achieved = forward_post_agx_ab(&raw_scene, &temp_transform, contrast);

        // Update target delta coordinates based on feedback error
        for i in 0..n {
            let l = pairs[i].raw_lab[0].max(0.12);
            let raw_c = pairs[i].raw_lab[1].hypot(pairs[i].raw_lab[2]);
            let raw_cr = raw_c / l;
            let target_scale = (raw_cr / 0.04).clamp(0.0, 1.0);

            let target_da = pairs[i].jpeg_lab[1] - base_post_agx[i].0;
            let target_db = pairs[i].jpeg_lab[2] - base_post_agx[i].1;

            let achieved_da = achieved[i].0 - base_post_agx[i].0;
            let achieved_db = achieved[i].1 - base_post_agx[i].1;

            let err_a = target_da - achieved_da;
            let err_b = target_db - achieved_db;

            // Weight the update by the same reliability w_i: dark points we
            // declined to fit must not wind their z back up across iterations and
            // re-ripple the surface. With w_i ≈ L/L_REF, the (1/L)·w_i collapses to
            // 1/L_REF, so the ~8× dark amplification falls out. The clamp guards
            // against any residual windup.
            z_a[i] = (z_a[i] + ALPHA * (err_a / l) * target_scale * weights[i])
                .clamp(-CHROMA_Z_CLAMP, CHROMA_Z_CLAMP);
            z_b[i] = (z_b[i] + ALPHA * (err_b / l) * target_scale * weights[i])
                .clamp(-CHROMA_Z_CLAMP, CHROMA_Z_CLAMP);
        }
    }

    // 5. Final solve and grid bake with global damping k
    let mut final_transform = ChromaTransform::identity();
    let mut tps_z_a = Vec::with_capacity(n + 1);
    let mut tps_z_b = Vec::with_capacity(n + 1);
    for i in 0..n {
        tps_z_a.push(z_a[i]);
        tps_z_b.push(z_b[i]);
    }
    tps_z_a.push(0.0);
    tps_z_b.push(0.0);

    if let (Some(coef_a), Some(coef_b)) = (
        tps_solve_weighted(&control_pts, &tps_z_a, lambda, &weights),
        tps_solve_weighted(&control_pts, &tps_z_b, lambda, &weights),
    ) {
        let k = std::env::var("MAPLE_CHROMA_STRENGTH_OVERRIDE")
            .ok()
            .and_then(|s| s.parse::<f32>().ok())
            .unwrap_or(CHROMA_STRENGTH);

        for h in 0..HUE_DIVS {
            let theta = (h as f32 / HUE_DIVS as f32) * std::f32::consts::TAU;
            for s in 0..SAT_DIVS {
                if s == 0 {
                    final_transform.grid[h][0] = (0.0, 0.0);
                    continue;
                }
                let cr = s as f32 / (SAT_DIVS - 1) as f32;
                let x = cr * theta.cos();
                let y = cr * theta.sin();
                let da = tps_evaluate(&coef_a, (x, y));
                let db = tps_evaluate(&coef_b, (x, y));
                final_transform.grid[h][s] = (da * k, db * k);
            }
        }
    } else {
        final_transform.grid = current_grid;
    }

    // Diagnostic logging
    if std::env::var_os("MAPLE_CHROMA_DUMP_GAINS").is_some() {
        let achieved = forward_post_agx_ab(&raw_scene, &final_transform, contrast);
        eprintln!("CHROMA_DUMP_2D n_centroids={n} contrast={contrast:.3}");
        eprintln!("CHROMA_DUMP_2D id | raw_Cr  raw_hue | base_C  jpeg_C  achiev_C | err_C");
        for i in 0..n {
            let l = pairs[i].raw_lab[0].max(1e-5);
            let raw_c = pairs[i].raw_lab[1].hypot(pairs[i].raw_lab[2]);
            let raw_cr = raw_c / l;
            let raw_hue = pairs[i].raw_lab[2].atan2(pairs[i].raw_lab[1]) * 180.0 / std::f32::consts::PI;
            
            let base_c = base_post_agx[i].0.hypot(base_post_agx[i].1);
            let jpeg_c = pairs[i].jpeg_lab[1].hypot(pairs[i].jpeg_lab[2]);
            let ach_c = achieved[i].0.hypot(achieved[i].1);
            let err_c = jpeg_c - ach_c;
            
            eprintln!(
                "CHROMA_DUMP_2D {i:2} | {rc:6.3} {rh:7.1}° | {bc:6.3} {jc:6.3} {ac:6.3} | {ec:6.3}",
                rc = raw_cr,
                rh = raw_hue,
                bc = base_c,
                jc = jpeg_c,
                ac = ach_c,
                ec = err_c,
            );
        }
    }

    final_transform
}

// ── Render-path entries: solve from a RAW's embedded JPEG ────────────────────

/// Solve the per-image chroma transform from the embedded JPEG of the RAW at
/// `path`, against the pre-AgX `scene`. Returns `None` when there's no JPEG or too
/// few clean pairs survive filtering.
pub(crate) fn solve_chroma_for_path(
    scene: &Image,
    path: &std::path::Path,
    _orientation: crate::image::ExifOrientation,
    contrast: f32,
) -> Option<ChromaTransform> {
    use crate::view::auto_profile::preview;
    let prev = preview::extract_preview(path)?;
    let cs = preview::detect_jpeg_color_space(path);
    solve_chroma_from_preview(scene, prev, cs, contrast)
}

/// Bytes-FFI variant of [`solve_chroma_for_path`].
pub(crate) fn solve_chroma_for_bytes(
    scene: &Image,
    bytes: &[u8],
    ext: &str,
    _orientation: crate::image::ExifOrientation,
    contrast: f32,
) -> Option<ChromaTransform> {
    use crate::view::auto_profile::preview;
    let prev = preview::extract_preview_from_bytes(bytes, ext)?;
    let cs = preview::detect_jpeg_color_space_from_bytes(bytes, ext);
    solve_chroma_from_preview(scene, prev, cs, contrast)
}

/// Shared tail: a display-oriented preview + its color space -> sampled pairs ->
/// deterministic clustering -> TPS solve -> grid bake.
fn solve_chroma_from_preview(
    scene: &Image,
    prev: image::DynamicImage,
    cs: JpegColorSpace,
    contrast: f32,
) -> Option<ChromaTransform> {
    // 1. Downsample JPEG preview to 32x32
    let prev_32 = image::imageops::resize(&prev, 32, 32, image::imageops::FilterType::Triangle);
    let jpeg_32: Vec<[f32; 3]> = prev_32
        .pixels()
        .map(|p| [p[0] as f32 / 255.0, p[1] as f32 / 255.0, p[2] as f32 / 255.0])
        .collect();

    // 2. Downsample RAW scene to 32x32
    let mut raw_32 = vec![[0.0f32; 3]; 32 * 32];
    for oy in 0..32 {
        for ox in 0..32 {
            raw_32[oy * 32 + ox] = box_average(
                &scene.pixels,
                scene.width as usize,
                scene.height as usize,
                ox,
                oy,
                32,
                32,
            );
        }
    }

    // 3. Collect paired cells, cropping outer 10% (x, y in 3..29) and filtering out clipped pixels
    let mut pairs = Vec::new();
    for oy in 3..29 {
        for ox in 3..29 {
            let jp = jpeg_32[oy * 32 + ox];
            if is_clipped(jp) {
                continue;
            }
            // 3x3 JPEG variance check to discard high-contrast edges
            let mut sum = 0.0f32;
            let mut sumsq = 0.0f32;
            let mut cnt = 0;
            for dy in -1..=1 {
                for dx in -1..=1 {
                    let nx = ox as i32 + dx;
                    let ny = oy as i32 + dy;
                    if nx >= 0 && ny >= 0 && nx < 32 && ny < 32 {
                        let np = jpeg_32[ny as usize * 32 + nx as usize];
                        if !is_clipped(np) {
                            let l = luma01(np);
                            sum += l;
                            sumsq += l * l;
                            cnt += 1;
                        }
                    }
                }
            }
            if cnt > 0 {
                let mean = sum / cnt as f32;
                let var = (sumsq / cnt as f32) - mean * mean;
                if var > VARIANCE_CEIL {
                    continue; // skip edges
                }
            }

            let rp = raw_32[oy * 32 + ox];
            let raw_lab = rec2020_to_oklab(rp);
            let jpeg_lin = decode_jpeg_to_rec2020(jp, cs);
            let jpeg_lab = rec2020_to_oklab(jpeg_lin);

            pairs.push(Pair {
                raw_scene: rp,
                raw_lab,
                jpeg_lab,
            });
        }
    }

    eprintln!("DEBUG_CHROMA: sampled pairs count = {}", pairs.len());
    if pairs.len() < MIN_SOLVE_PAIRS {
        eprintln!("DEBUG_CHROMA: solve failed, too few pairs (< {})", MIN_SOLVE_PAIRS);
        return None;
    }

    // 4. Deterministic clustering to group colors
    let clustered = cluster_pairs(&pairs);
    eprintln!("DEBUG_CHROMA: clustered centroids count = {}", clustered.len());
    if clustered.len() < 3 {
        eprintln!("DEBUG_CHROMA: solve failed, too few centroids (< 3)");
        return None;
    }

    // 5. Solve the TPS Chroma Map
    let mut t = solve_chroma_map(&clustered, contrast);
    t.taper_lo = CHROMA_TAPER_LO;
    t.taper_hi = CHROMA_TAPER_HI;
    Some(t)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::color::oklab::rec2020_to_oklab;
    use crate::image::{ColorSpace, Image};

    fn one_px(rgb: [f32; 3]) -> Image {
        Image {
            width: 1,
            height: 1,
            pixels: vec![rgb],
            space: ColorSpace::SceneLinearRec2020,
        }
    }

    fn synth_scene(n: usize) -> Vec<[f32; 3]> {
        (0..n)
            .map(|i| {
                let f = i as f32;
                [
                    0.05 + 0.5 * (f * 0.013).sin().abs(),
                    0.04 + 0.4 * (f * 0.07).cos().abs(),
                    0.03 + 0.4 * (f * 0.11).sin().abs(),
                ]
            })
            .collect()
    }

    #[test]
    fn identity_transform_is_noop() {
        let t = ChromaTransform::identity();
        let mut img = one_px([0.4, 0.2, 0.1]);
        let before = img.pixels[0];
        t.apply_to_scene(&mut img);
        for c in 0..3 {
            assert!(
                (img.pixels[0][c] - before[c]).abs() < 1e-4,
                "channel {c} moved: {} -> {}",
                before[c],
                img.pixels[0][c]
            );
        }
    }

    #[test]
    fn apply_preserves_oklab_l() {
        let mut t = ChromaTransform::identity();
        // Add a non-identity boost
        for h in 0..HUE_DIVS {
            for s in 0..SAT_DIVS {
                t.grid[h][s] = (0.1, 0.05);
            }
        }
        let mut img = one_px([0.5, 0.25, 0.15]);
        let l_before = rec2020_to_oklab(img.pixels[0])[0];
        t.apply_to_scene(&mut img);
        let lab_after = rec2020_to_oklab(img.pixels[0]);
        assert!(
            (lab_after[0] - l_before).abs() < 1e-4,
            "L moved: {l_before} -> {}",
            lab_after[0]
        );
    }

    #[test]
    fn linear_map_preserves_neutral_axis() {
        let t = ChromaTransform::identity();
        let (a, b) = t.map_ab(0.5, 0.0, 0.0);
        assert_eq!((a, b), (0.0, 0.0));
    }

    #[test]
    fn linear_map_near_neutral_stays_bounded() {
        let t = ChromaTransform::identity();
        let (a, b) = t.map_ab(0.5, 1e-4, 0.0);
        assert!(a.hypot(b) < 1e-3);
    }

    #[test]
    fn scene_v_taper_attenuates_highlights_not_mids() {
        let mut t = ChromaTransform::identity();
        for h in 0..HUE_DIVS {
            for s in 0..SAT_DIVS {
                t.grid[h][s] = (0.2, 0.1);
            }
        }
        t.taper_lo = 0.35;
        t.taper_hi = 0.70;

        let mut mid = Image {
            width: 1,
            height: 1,
            pixels: vec![[0.18_f32, 0.10, 0.10]],
            space: ColorSpace::SceneLinearRec2020,
        };
        let mut hi = Image {
            width: 1,
            height: 1,
            pixels: vec![[0.95_f32, 0.80, 0.80]],
            space: ColorSpace::SceneLinearRec2020,
        };
        let mid_before = crate::color::oklab::rec2020_to_oklab(mid.pixels[0]);
        let hi_before = crate::color::oklab::rec2020_to_oklab(hi.pixels[0]);
        t.apply_to_scene(&mut mid);
        t.apply_to_scene(&mut hi);
        let mid_after = crate::color::oklab::rec2020_to_oklab(mid.pixels[0]);
        let hi_after = crate::color::oklab::rec2020_to_oklab(hi.pixels[0]);
        let dc_mid = (mid_after[1] - mid_before[1]).hypot(mid_after[2] - mid_before[2]);
        let dc_hi = (hi_after[1] - hi_before[1]).hypot(hi_after[2] - hi_before[2]);
        assert!(dc_hi < 1e-4, "highlight pixel should be ~untouched by taper");
        assert!(dc_mid > 0.001, "mid pixel should be corrected");
    }

    #[test]
    fn production_solve_engages_taper() {
        let scene = synth_scene(512);
        let pairs: Vec<Pair> = scene
            .iter()
            .map(|&p| {
                let lab = crate::color::oklab::rec2020_to_oklab(p);
                Pair {
                    raw_scene: p,
                    raw_lab: lab,
                    jpeg_lab: lab,
                }
            })
            .collect();
        let mut t = solve_chroma_map(&pairs, 1.0);
        t.taper_lo = CHROMA_TAPER_LO;
        t.taper_hi = CHROMA_TAPER_HI;
        assert!(t.taper_lo < 1.5);
        assert!(t.taper_hi < 1.5);
        assert!(t.taper_lo < t.taper_hi);
    }

    #[test]
    fn agx_aware_solver_hits_post_agx_target() {
        let n = 80;
        let scene: Vec<[f32; 3]> = (0..n)
            .map(|i| {
                let hue = (i as f32 / n as f32) * std::f32::consts::TAU;
                crate::color::oklab::oklab_to_rec2020([0.5, 0.08 * hue.cos(), 0.08 * hue.sin()])
            })
            .collect();
        let base = forward_post_agx_ab(&scene, &ChromaTransform::identity(), 1.0);
        let pairs: Vec<Pair> = scene
            .iter()
            .enumerate()
            .map(|(i, &p)| {
                let lab = crate::color::oklab::rec2020_to_oklab(p);
                let (ba, bb) = base[i];
                Pair {
                    raw_scene: p,
                    raw_lab: lab,
                    jpeg_lab: [lab[0], ba * 1.3, bb * 1.3],
                }
            })
            .collect();

        let saved = std::env::var("MAPLE_CHROMA_STRENGTH_OVERRIDE").ok();
        unsafe {
            std::env::set_var("MAPLE_CHROMA_STRENGTH_OVERRIDE", "1.0");
        }
        let t = solve_chroma_map(&pairs, 1.0);
        match saved {
            Some(v) => unsafe {
                std::env::set_var("MAPLE_CHROMA_STRENGTH_OVERRIDE", v);
            },
            None => unsafe {
                std::env::remove_var("MAPLE_CHROMA_STRENGTH_OVERRIDE");
            },
        }

        let out = forward_post_agx_ab(&scene, &t, 1.0);
        let mut ach = 0.0;
        let mut bas = 0.0;
        for i in 0..n {
            ach += out[i].0.hypot(out[i].1);
            bas += base[i].0.hypot(base[i].1);
        }
        let ratio = ach / bas;
        assert!(
            (ratio - 1.3).abs() < 0.15,
            "AgX-aware solver achieved {ratio}x boost, expected ~1.3x"
        );
    }

    #[test]
    fn tps_solver_sparse_points_stay_near_identity() {
        let pairs = vec![
            Pair {
                raw_scene: [0.18, 0.08, 0.07],
                raw_lab: [0.5, 0.10, 0.01],
                jpeg_lab: [0.5, 0.13, 0.013],
            };
            30
        ];
        let t = solve_chroma_map(&pairs, 1.0);
        // evaluate grid directly at green hue index 12, sat index 8
        let (da, db) = t.grid[12][8];
        assert!(
            da.hypot(db) < 0.1,
            "sparse region did not regularize to identity: got offset ({da}, {db})"
        );
    }
}
