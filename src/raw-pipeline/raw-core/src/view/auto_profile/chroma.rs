//! Per-image JPEG chroma-match transform (Auto Profile chroma). Operates on
//! OKLAB a/b only — keeps L (AgX owns tone). Phase 1 of
//! docs/superpowers/specs/2026-06-04-jpeg-chroma-match-auto-profile-design.md.
//!
//! The transform is solved per image so the POST-AgX render matches the
//! embedded JPEG's chroma (the solver fits *through* AgX — see Task 4 of the
//! Phase-1 plan), and it is injected at decode (post-DCP, pre-AgX) so it rides
//! the shared scene-linear buffer to every platform like the DCP/HSM.

use crate::color::oklab::{oklab_to_rec2020, rec2020_to_oklab};
use crate::image::Image;
use rayon::prelude::*;

/// A root-polynomial chroma map on (a,b) plus a value-aware highlight taper.
/// `mat`/`bias`/`gain` express the linear term; `c2` the sqrt-magnitude
/// (root-polynomial) term; `taper_lo`/`taper_hi` attenuate the whole transform
/// toward identity as scene OKLAB L rises (the HSM-validated highlight guard).
/// Identity = `mat=I, bias=0, c2=0, gain=1`, taper above the L range.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ChromaTransform {
    pub mat: [[f32; 2]; 2],
    pub bias: [f32; 2],
    pub c2: [[f32; 2]; 2],
    pub gain: f32,
    pub taper_lo: f32,
    pub taper_hi: f32,
}

impl ChromaTransform {
    pub fn identity() -> Self {
        Self {
            mat: [[1.0, 0.0], [0.0, 1.0]],
            bias: [0.0, 0.0],
            c2: [[0.0; 2]; 2],
            gain: 1.0,
            taper_lo: 2.0,
            taper_hi: 3.0,
        }
    }

    /// Map (a,b) -> (a',b') (pure transform, before the value taper).
    #[inline]
    pub fn map_ab(&self, a: f32, b: f32) -> (f32, f32) {
        let g = self.gain;
        let ra = a.signum() * a.abs().sqrt();
        let rb = b.signum() * b.abs().sqrt();
        let na = g * (self.mat[0][0] * a + self.mat[0][1] * b)
            + self.c2[0][0] * ra
            + self.c2[0][1] * rb
            + self.bias[0];
        let nb = g * (self.mat[1][0] * a + self.mat[1][1] * b)
            + self.c2[1][0] * ra
            + self.c2[1][1] * rb
            + self.bias[1];
        (na, nb)
    }

    /// Apply in-place to a scene-linear Rec.2020 image. Keeps OKLAB L; tapers
    /// toward identity in highlights. Negative-component pixels are passed
    /// through unchanged (matching the HSM out-of-gamut bypass).
    pub fn apply_to_scene(&self, img: &mut Image) {
        img.pixels.par_iter_mut().for_each(|p| {
            if p[0] < 0.0 || p[1] < 0.0 || p[2] < 0.0 {
                return;
            }
            let lab = rec2020_to_oklab(*p);
            let (ta, tb) = self.map_ab(lab[1], lab[2]);
            // Value-aware taper toward identity as L rises (smoothstep).
            let t = ((lab[0] - self.taper_lo) / (self.taper_hi - self.taper_lo)).clamp(0.0, 1.0);
            let att = t * t * (3.0 - 2.0 * t);
            let na = lab[1] + (ta - lab[1]) * (1.0 - att);
            let nb = lab[2] + (tb - lab[2]) * (1.0 - att);
            *p = oklab_to_rec2020([lab[0], na, nb]);
        });
    }
}

/// Apply `t` to scene-linear samples, run AgX (the fixed forward tone model),
/// and return the **post-AgX** OKLAB `(a, b)` per sample. This is the primitive
/// the through-AgX solver (Task 4) minimizes its objective in: the solver
/// matches `forward_post_agx_ab(scene, T)` to the linearized JPEG's a/b, with
/// AgX as a fixed term in the loss, so the chroma cannot reproduce the HSM's
/// post-tone-curve highlight over-saturation. Output is display-linear Rec.2020
/// OKLAB — the same space the linearized JPEG lands in (decode → Rec.2020 →
/// `rec2020_to_oklab`), so the two are directly comparable.
///
/// `contrast` matches the render path's `model.contrast` AgX slope so the
/// forward model is the exact tone curve the final render uses.
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

// ── JPEG sampling + filtering (Task 3) ───────────────────────────────────────

use crate::color::matrices::{M_REC2020_TO_SRGB, M_XYZ_D65_TO_REC2020};
use crate::math::Matrix3;
use crate::view::auto_profile::preview::JpegColorSpace;

/// Adobe RGB (1998) → XYZ (D65). Sourced from the Adobe RGB (1998) Color Image
/// Encoding spec (ASTM E308 D65 white). Composed with [`M_XYZ_D65_TO_REC2020`]
/// at runtime to land Adobe-RGB-linear pixels in linear Rec.2020 D65 — both
/// already D65, so no chromatic adaptation. test_0003 (Canon 5DS R) ships an
/// Adobe RGB embedded JPEG (`Canon:ColorSpace = Adobe RGB`); reading it as sRGB
/// understates saturation 30–50% and would corrupt the chroma target.
const M_ADOBE_RGB_TO_XYZ_D65: Matrix3 = Matrix3([
    [0.5767309, 0.1855540, 0.1881852],
    [0.2973769, 0.6273491, 0.0752741],
    [0.0270343, 0.0706872, 0.9911085],
]);

/// Adobe RGB (1998) decoding gamma — the spec's 2+51/256 = 563/256 power.
/// No linear toe segment (unlike sRGB), per the Adobe RGB (1998) spec.
const ADOBE_RGB_GAMMA: f32 = 563.0 / 256.0;

/// Cached JPEG-decode matrices into linear Rec.2020 D65, one per
/// [`JpegColorSpace`]. Tuple order: (sRGB-linear→Rec.2020, AdobeRGB-linear→
/// Rec.2020). sRGB uses `inverse(M_REC2020_TO_SRGB)`; AdobeRGB composes the
/// sourced primaries matrix with `M_XYZ_D65_TO_REC2020`. Computed once.
fn jpeg_decode_matrices() -> &'static (Matrix3, Matrix3) {
    static CELL: std::sync::OnceLock<(Matrix3, Matrix3)> = std::sync::OnceLock::new();
    CELL.get_or_init(|| {
        let srgb_to_rec2020 =
            M_REC2020_TO_SRGB.inverse().expect("M_REC2020_TO_SRGB is invertible");
        let adobe_to_rec2020 = M_XYZ_D65_TO_REC2020.mul_mat(&M_ADOBE_RGB_TO_XYZ_D65);
        (srgb_to_rec2020, adobe_to_rec2020)
    })
}

/// sRGB (IEC 61966-2-1) inverse OETF on one channel — display-encoded → linear.
#[inline]
fn srgb_to_linear_one(v: f32) -> f32 {
    if v <= 0.04045 {
        v / 12.92
    } else {
        ((v + 0.055) / 1.055).powf(2.4)
    }
}

/// Decode one display-encoded JPEG pixel (channels in `[0, 1]`) to **linear
/// Rec.2020 D65**, honoring its color space. This is the colorimetrically-
/// correct path the spec's Component-1 step 2 calls for: the JPEG's a/b only
/// match the RAW's a/b once both are in the same absolute Rec.2020 OKLAB.
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
            // Adobe RGB power-law decode (no linear segment).
            let lin = [
                rgb01[0].max(0.0).powf(ADOBE_RGB_GAMMA),
                rgb01[1].max(0.0).powf(ADOBE_RGB_GAMMA),
                rgb01[2].max(0.0).powf(ADOBE_RGB_GAMMA),
            ];
            adobe_m.mul_vec(lin)
        }
    }
}

/// One sampled grid point. Carries the RAW's box-averaged **scene-linear
/// Rec.2020** pixel (the solver runs AgX through it — AgX needs full RGB, not
/// just a/b, because it keeps the RAW's L), its pre-AgX OKLAB `a/b` (the LSQ
/// feature), the linearized-JPEG OKLAB `a/b` target (both absolute Rec.2020
/// OKLAB), the JPEG pixel position, a center-weight, and the clip flag.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Pair {
    /// RAW box-averaged scene-linear Rec.2020 pixel at this grid point.
    pub raw_scene: [f32; 3],
    /// RAW scene-linear (pre-AgX) OKLAB `(a, b)` — `rec2020_to_oklab(raw_scene)`.
    pub raw_ab: (f32, f32),
    /// Linearized-JPEG OKLAB `(a, b)` target at this grid point.
    pub jpeg_ab: (f32, f32),
    pub x: usize,
    pub y: usize,
    /// Radial center-weight (lens falloff guard) — 1.0 at center, →0 at edges.
    pub weight: f32,
    /// True if any JPEG channel byte is railed (`> 245` or `< 10` of 255).
    pub clipped: bool,
}

/// JPEG clip thresholds in `[0, 1]` (byte `> 245` / `< 10`).
const CLIP_HI: f32 = 245.0 / 255.0;
const CLIP_LO: f32 = 10.0 / 255.0;

/// 3×3 JPEG-luma variance ceiling. Above this a grid point is dropped as a
/// block/CA/edge artifact (the spec's filter). Tuned loose enough that one
/// railed outlier in an otherwise-flat field doesn't poison a clean pixel
/// (clipped neighbors are excluded from the statistic below), tight enough to
/// reject genuine high-contrast texture where demosaic/JPEG disagree on color.
const VARIANCE_CEIL: f32 = 0.02;

#[inline]
fn luma01(p: [f32; 3]) -> f32 {
    0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]
}

#[inline]
fn is_clipped(p: [f32; 3]) -> bool {
    p.iter().any(|&c| c > CLIP_HI || c < CLIP_LO)
}

/// Box-average the RAW scene-linear buffer into the JPEG grid cell `(ox, oy)`,
/// using the SAME integer-span mapping as the #550 fit's `footprint_sizes`
/// (`(o·dim)/out .. ((o+1)·dim)/out`, each span ≥ 1px). Returns the mean
/// scene-linear Rec.2020 triple over the cell's source footprint.
fn box_average(raw: &[[f32; 3]], rw: usize, rh: usize, ox: usize, oy: usize, jw: usize, jh: usize) -> [f32; 3] {
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

/// Sample paired RAW/JPEG grid points for the chroma solve.
///
/// - `raw_scene` is the **scene-linear Rec.2020** buffer (pre-AgX, the AgX
///   input) at dims `rw×rh`; box-downscaled to the JPEG grid.
/// - `jpeg01` is the display-encoded JPEG at dims `jw×jh`, channels in `[0, 1]`
///   (`byte / 255`); decoded to linear Rec.2020 per `cs`.
///
/// Filters per the spec: drops JPEG-clipped pairs, drops high-3×3-luma-variance
/// pairs (clipped neighbors excluded from the variance), and center-weights the
/// grid (the JPEG is lens-corrected, the RAW is not). Returns the surviving
/// clean, center-weighted pairs.
pub(crate) fn sample_pairs(
    raw_scene: &[[f32; 3]],
    rw: usize,
    rh: usize,
    jpeg01: &[[f32; 3]],
    jw: usize,
    jh: usize,
    cs: JpegColorSpace,
) -> Vec<Pair> {
    let mut out = Vec::new();
    if jw == 0 || jh == 0 || rw == 0 || rh == 0 {
        return out;
    }
    let cx = (jw as f32 - 1.0) * 0.5;
    let cy = (jh as f32 - 1.0) * 0.5;
    // Max radius for the cosine falloff (corner distance), guard div-by-zero.
    let r_max = (cx * cx + cy * cy).sqrt().max(1e-6);
    for oy in 0..jh {
        for ox in 0..jw {
            let jp = jpeg01[oy * jw + ox];
            let clipped = is_clipped(jp);
            if clipped {
                continue; // never a target
            }
            // 3×3 JPEG-luma variance over non-clipped neighbors.
            let mut sum = 0.0f32;
            let mut sumsq = 0.0f32;
            let mut cnt = 0u32;
            for dy in -1i32..=1 {
                for dx in -1i32..=1 {
                    let nx = ox as i32 + dx;
                    let ny = oy as i32 + dy;
                    if nx < 0 || ny < 0 || nx >= jw as i32 || ny >= jh as i32 {
                        continue;
                    }
                    let np = jpeg01[ny as usize * jw + nx as usize];
                    if is_clipped(np) {
                        continue; // don't let a railed neighbor poison the stat
                    }
                    let l = luma01(np);
                    sum += l;
                    sumsq += l * l;
                    cnt += 1;
                }
            }
            if cnt > 0 {
                let mean = sum / cnt as f32;
                let var = (sumsq / cnt as f32) - mean * mean;
                if var > VARIANCE_CEIL {
                    continue; // edge / block / CA — skip
                }
            }
            // Radial cosine center-weight: 1 at center, 0 at the corners.
            let dx = ox as f32 - cx;
            let dy = oy as f32 - cy;
            let r = (dx * dx + dy * dy).sqrt() / r_max;
            let weight = (0.5 * (1.0 + (std::f32::consts::PI * r.clamp(0.0, 1.0)).cos())).max(0.0);

            let raw_avg = box_average(raw_scene, rw, rh, ox, oy, jw, jh);
            let raw_lab = rec2020_to_oklab(raw_avg);
            let jpeg_lin = decode_jpeg_to_rec2020(jp, cs);
            let jpeg_lab = rec2020_to_oklab(jpeg_lin);
            out.push(Pair {
                raw_scene: raw_avg,
                raw_ab: (raw_lab[1], raw_lab[2]),
                jpeg_ab: (jpeg_lab[1], jpeg_lab[2]),
                x: ox,
                y: oy,
                weight,
                clipped,
            });
        }
    }
    out
}

// ── The through-AgX solver (Task 4) ──────────────────────────────────────────

/// Iterations of the damped fixed-point. AgX is locally near-affine in (a, b)
/// at fixed L, so a handful of refits converge; more is wasted work on the
/// cold path.
const SOLVE_ITERS: usize = 12;

/// Damping on the post-AgX residual fed back into the pre-AgX target. < 1 so
/// the fixed-point can't overshoot through AgX's local gain.
const SOLVE_LAMBDA: f32 = 0.7;

/// Ridge strength pulling the fit toward identity (mat→I, c2→0, bias→0). Keeps
/// under-sampled hues from drifting — the blue-overshoot guard. Applied
/// per-feature (`μ_i = SOLVE_RIDGE · diagonal_i`) so it is a dimensionless
/// fraction; TDD-discovered against the recovery / identity / sparse-hue guard
/// tests, which all pass over a wide 0.1–0.4 window (see
/// `solver_ridge_suppresses_sparse_hue_blowup`). 0.2 sits mid-window: it
/// halves the sparse-hue blowup while keeping the recovery residual ≤ 15% of
/// identity.
const SOLVE_RIDGE: f32 = 0.2;

/// Root-polynomial feature vector for one (a, b): `[a, b, sign·√|a|, sign·√|b|, 1]`.
#[inline]
fn chroma_features(a: f32, b: f32) -> [f32; 5] {
    let ra = a.signum() * a.abs().sqrt();
    let rb = b.signum() * b.abs().sqrt();
    [a, b, ra, rb, 1.0]
}

/// Reassemble a [`ChromaTransform`] from the two solved 5-vectors (a-channel,
/// b-channel), each `[mat0, mat1, c2_0, c2_1, bias]`. `gain` folds into `mat`
/// (held at 1.0), taper left inactive (caller sets it from the real-image L
/// distribution; the synthetic solve keeps it above the data range).
fn transform_from_coeffs(ca: [f32; 5], cb: [f32; 5]) -> ChromaTransform {
    ChromaTransform {
        mat: [[ca[0], ca[1]], [cb[0], cb[1]]],
        c2: [[ca[2], ca[3]], [cb[2], cb[3]]],
        bias: [ca[4], cb[4]],
        gain: 1.0,
        taper_lo: 2.0,
        taper_hi: 3.0,
    }
}

/// Solve a weighted **ridge-to-`c0`** least squares over the 5 root-poly
/// features for one output channel: minimize
/// `Σ w·(Φ·c − y)² + Σ_i μ_i·(c_i − c0_i)²`. The ridge is **per-feature**:
/// `μ_i = ridge · Σ w·φ_i²` (the i-th normal-equation diagonal), so `ridge`
/// is a dimensionless pull-toward-identity strength that constrains every
/// feature proportionally — including the constant/bias term, whose diagonal
/// scale is ~`Σw` while the linear a/b terms' is ~`Σw·E[a²]`. A single scalar
/// added to all diagonals (the naive form) leaves the small-diagonal a/b/bias
/// terms essentially unconstrained, which let sparse hues drift. Hand-rolled
/// 5×5 Gaussian elimination with partial pivoting (no new dep, matches repo
/// style). Normal equations: `(ΦᵀWΦ + diag(μ))·c = ΦᵀW·y + diag(μ)·c0`.
fn ridge_solve_channel(
    feats: &[[f32; 5]],
    targets: &[f32],
    weights: &[f32],
    ridge: f32,
    c0: [f32; 5],
) -> [f32; 5] {
    let mut ata = [[0.0f64; 5]; 5];
    let mut atb = [0.0f64; 5];
    for ((phi, &y), &w) in feats.iter().zip(targets).zip(weights) {
        let w = w as f64;
        for i in 0..5 {
            let pi = phi[i] as f64;
            atb[i] += w * pi * y as f64;
            for j in 0..5 {
                ata[i][j] += w * pi * phi[j] as f64;
            }
        }
    }
    // Per-feature ridge toward c0: μ_i = ridge · (i-th diagonal of ΦᵀWΦ).
    // A small floor keeps a feature with ~zero support from being completely
    // unconstrained (it then snaps to its identity coefficient).
    let r = ridge as f64;
    let diag_floor = 1e-6;
    for i in 0..5 {
        let mu = r * ata[i][i].max(diag_floor);
        ata[i][i] += mu;
        atb[i] += mu * c0[i] as f64;
    }
    // Gaussian elimination with partial pivoting.
    for col in 0..5 {
        let mut piv = col;
        let mut best = ata[col][col].abs();
        for r in (col + 1)..5 {
            if ata[r][col].abs() > best {
                best = ata[r][col].abs();
                piv = r;
            }
        }
        if best < 1e-12 {
            // Singular column — fall back to the identity coefficient.
            return c0;
        }
        if piv != col {
            ata.swap(col, piv);
            atb.swap(col, piv);
        }
        let d = ata[col][col];
        for r in (col + 1)..5 {
            let f = ata[r][col] / d;
            if f == 0.0 {
                continue;
            }
            for c in col..5 {
                ata[r][c] -= f * ata[col][c];
            }
            atb[r] -= f * atb[col];
        }
    }
    let mut x = [0.0f64; 5];
    for i in (0..5).rev() {
        let mut s = atb[i];
        for j in (i + 1)..5 {
            s -= ata[i][j] * x[j];
        }
        x[i] = s / ata[i][i];
    }
    [x[0] as f32, x[1] as f32, x[2] as f32, x[3] as f32, x[4] as f32]
}

/// Solve a [`ChromaTransform`] whose **post-AgX** output best matches each
/// pair's `jpeg_ab` target, with AgX as a fixed forward model in the loss.
///
/// Damped fixed-point (the spec's "fit through AgX"): AgX is locally
/// near-affine in (a, b) at fixed L, so we (1) run the current transform
/// through AgX, (2) measure the post-AgX residual to the target, (3) map that
/// residual back to a damped pre-AgX nudge, (4) re-fit the transform's
/// root-poly to `current_pre_agx_target + λ·residual` by weighted ridge-to-
/// identity least squares, and iterate. The ridge keeps sparse hues from
/// drifting (the blue-overshoot guard). The returned transform's taper is left
/// inactive — the caller engages it from the real-image L distribution (the
/// HSM-validated highlight guard); the synthetic recovery tests keep it above
/// the data range so it never fires.
///
/// `contrast` is the AgX slope used in the forward model (matches the render's
/// `model.contrast`).
pub(crate) fn solve_chroma_through_agx(pairs: &[Pair], contrast: f32) -> ChromaTransform {
    solve_chroma_through_agx_with_ridge(pairs, contrast, SOLVE_RIDGE)
}

/// Inner solver with an explicit `ridge` strength — the seam the
/// regularization guard test drives (ridge on vs ridge≈0). Production callers
/// use [`solve_chroma_through_agx`] (ridge = [`SOLVE_RIDGE`]).
pub(crate) fn solve_chroma_through_agx_with_ridge(
    pairs: &[Pair],
    contrast: f32,
    ridge: f32,
) -> ChromaTransform {
    if pairs.is_empty() {
        return ChromaTransform::identity();
    }
    let n = pairs.len();
    // The scene-linear pixels AgX runs through (full RGB — AgX keeps L).
    let scene: Vec<[f32; 3]> = pairs.iter().map(|p| p.raw_scene).collect();
    let scene_ab: Vec<(f32, f32)> = pairs.iter().map(|p| p.raw_ab).collect();
    let target: Vec<(f32, f32)> = pairs.iter().map(|p| p.jpeg_ab).collect();
    let weights: Vec<f32> = pairs.iter().map(|p| p.weight.max(0.0)).collect();
    let feats: Vec<[f32; 5]> = scene_ab.iter().map(|&(a, b)| chroma_features(a, b)).collect();
    let wsum: f32 = weights.iter().sum::<f32>().max(1e-6);

    // Identity coefficients per channel (ridge pulls toward these).
    let c0_a = [1.0, 0.0, 0.0, 0.0, 0.0];
    let c0_b = [0.0, 1.0, 0.0, 0.0, 0.0];

    // Weighted post-AgX mean (a, b) error of transform `t`.
    let post_agx_err = |t: &ChromaTransform| -> f32 {
        let out = forward_post_agx_ab(&scene, t, contrast);
        let mut werr = 0.0f32;
        for (i, &(ta, tb)) in target.iter().enumerate() {
            let da = ta - out[i].0;
            let db = tb - out[i].1;
            werr += weights[i] * (da * da + db * db).sqrt();
        }
        werr / wsum
    };

    let mut t = ChromaTransform::identity();
    let mut best = t;
    let mut best_err = post_agx_err(&t);
    for _ in 0..SOLVE_ITERS {
        let out = forward_post_agx_ab(&scene, &t, contrast);
        // Adjusted pre-AgX targets: current pre-AgX mapping + λ·post-AgX residual.
        let mut adj_a = vec![0.0f32; n];
        let mut adj_b = vec![0.0f32; n];
        for i in 0..n {
            let (a, b) = scene_ab[i];
            let (ma, mb) = t.map_ab(a, b);
            adj_a[i] = ma + SOLVE_LAMBDA * (target[i].0 - out[i].0);
            adj_b[i] = mb + SOLVE_LAMBDA * (target[i].1 - out[i].1);
        }
        let ca = ridge_solve_channel(&feats, &adj_a, &weights, ridge, c0_a);
        let cb = ridge_solve_channel(&feats, &adj_b, &weights, ridge, c0_b);
        t = transform_from_coeffs(ca, cb);
        let err = post_agx_err(&t);
        if err < best_err {
            best_err = err;
            best = t;
        }
    }
    best
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::color::oklab::rec2020_to_oklab;
    use crate::image::{ColorSpace, Image};
    use crate::view::auto_profile::preview::JpegColorSpace;

    fn one_px(rgb: [f32; 3]) -> Image {
        Image { width: 1, height: 1, pixels: vec![rgb], space: ColorSpace::SceneLinearRec2020 }
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
        // gain=1.5 scales a,b by 1.5; OKLAB L must survive within float noise.
        let t = ChromaTransform { gain: 1.5, ..ChromaTransform::identity() };
        let mut img = one_px([0.5, 0.25, 0.15]);
        let l_before = rec2020_to_oklab(img.pixels[0])[0];
        let ab_before = {
            let lab = rec2020_to_oklab(img.pixels[0]);
            (lab[1], lab[2])
        };
        t.apply_to_scene(&mut img);
        let lab_after = rec2020_to_oklab(img.pixels[0]);
        assert!(
            (lab_after[0] - l_before).abs() < 1e-4,
            "L moved: {l_before} -> {}",
            lab_after[0]
        );
        // Sanity: a/b actually changed (transform is non-trivial).
        assert!(
            (lab_after[1] - ab_before.0).abs() > 1e-3 || (lab_after[2] - ab_before.1).abs() > 1e-3,
            "a/b did not change under gain=1.5"
        );
    }

    // ── Task 2: post-AgX forward model ───────────────────────────────────────

    #[test]
    fn forward_identity_matches_plain_agx() {
        // forward_post_agx_ab with the identity transform must equal running
        // plain AgX on the same pixels and reading the post-AgX OKLAB a/b.
        let scene: Vec<[f32; 3]> =
            vec![[0.3, 0.18, 0.12], [0.6, 0.5, 0.45], [0.05, 0.04, 0.04]];
        let id = ChromaTransform::identity();
        let got = forward_post_agx_ab(&scene, &id, 0.0);
        let mut img = Image {
            width: 3,
            height: 1,
            pixels: scene.clone(),
            space: ColorSpace::SceneLinearRec2020,
        };
        crate::view::agx::apply(&mut img, 0.0);
        for (i, p) in img.pixels.iter().enumerate() {
            let lab = rec2020_to_oklab(*p);
            assert!(
                (got[i].0 - lab[1]).abs() < 1e-4 && (got[i].1 - lab[2]).abs() < 1e-4,
                "pixel {i}: forward {:?} != plain-AgX a/b ({}, {})",
                got[i],
                lab[1],
                lab[2]
            );
        }
    }

    // ── Task 3: JPEG sampling + filtering ────────────────────────────────────

    #[test]
    fn sampling_excludes_clipped_and_weights_center() {
        // 4x4 RAW scene-linear + 4x4 JPEG bytes-as-[0,1]. One JPEG pixel is
        // clipped (R railed high, G crushed low); it must be dropped, and
        // center pixels must outweigh corner pixels (radial center-weight).
        let raw = vec![[0.2_f32, 0.18, 0.15]; 16];
        let mut jpeg = vec![[0.4_f32, 0.35, 0.30]; 16];
        jpeg[5] = [1.0, 0.02, 0.30]; // clipped R (>245/255) and crushed G (<10/255)
        let pairs = sample_pairs(&raw, 4, 4, &jpeg, 4, 4, JpegColorSpace::SRgb);
        assert!(pairs.iter().all(|p| !p.clipped), "clipped pair retained");
        // The clipped pixel at flat index 5 = (x=1, y=1) must be gone.
        assert!(
            !pairs.iter().any(|p| p.x == 1 && p.y == 1),
            "clipped (1,1) survived sampling"
        );
        let w_center = pairs
            .iter()
            .find(|p| p.x == 2 && p.y == 2)
            .expect("center pixel present")
            .weight;
        let w_corner = pairs
            .iter()
            .find(|p| p.x == 0 && p.y == 0)
            .expect("corner pixel present")
            .weight;
        assert!(w_center > w_corner, "center {w_center} !> corner {w_corner}");
    }

    #[test]
    fn adobe_rgb_decode_differs_from_srgb_and_is_more_saturated() {
        // A saturated reddish JPEG pixel. Decoding it as Adobe RGB must land
        // a DIFFERENT (and more-saturated, larger |a|) Rec.2020 chroma than
        // decoding the same bytes as sRGB — the load-bearing color-management
        // fact (Adobe RGB packs saturated color into smaller RGB excursions,
        // so reading it as sRGB understates saturation). One flat pixel so
        // there is no spatial filtering to confound the comparison.
        let raw = vec![[0.2_f32, 0.1, 0.1]];
        let jpeg = vec![[0.82_f32, 0.20, 0.18]];
        let srgb = sample_pairs(&raw, 1, 1, &jpeg, 1, 1, JpegColorSpace::SRgb);
        let adobe = sample_pairs(&raw, 1, 1, &jpeg, 1, 1, JpegColorSpace::AdobeRgb);
        assert_eq!(srgb.len(), 1);
        assert_eq!(adobe.len(), 1);
        // jpeg_ab is the linearized-JPEG OKLAB (a, b) target.
        let (sa, sb) = srgb[0].jpeg_ab;
        let (aa, ab) = adobe[0].jpeg_ab;
        let s_chroma = (sa * sa + sb * sb).sqrt();
        let a_chroma = (aa * aa + ab * ab).sqrt();
        assert!(
            (sa - aa).abs() > 1e-3 || (sb - ab).abs() > 1e-3,
            "Adobe-RGB decode identical to sRGB: srgb=({sa},{sb}) adobe=({aa},{ab})"
        );
        assert!(
            a_chroma > s_chroma,
            "Adobe-RGB chroma {a_chroma} not > sRGB chroma {s_chroma} for the same red bytes"
        );
    }

    // ── Task 4: through-AgX solver ───────────────────────────────────────────

    /// Mean Euclidean (a, b) distance between two post-AgX sample sets.
    fn mean_ab_err(got: &[(f32, f32)], want: &[(f32, f32)]) -> f32 {
        assert_eq!(got.len(), want.len());
        let s: f32 = got
            .iter()
            .zip(want)
            .map(|(g, w)| {
                let da = g.0 - w.0;
                let db = g.1 - w.1;
                (da * da + db * db).sqrt()
            })
            .sum();
        s / got.len().max(1) as f32
    }

    /// Deterministic pseudo-random-ish scene of `n` scene-linear pixels with a
    /// spread of hues and lightnesses, all well below the taper L range.
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

    /// Build uniform unit weights for a fit set (no center-weighting in the
    /// synthetic recovery tests — the geometry is abstract).
    fn unit_pairs(scene: &[[f32; 3]], target: &[(f32, f32)]) -> Vec<Pair> {
        scene
            .iter()
            .zip(target)
            .map(|(&p, &t)| {
                let lab = rec2020_to_oklab(p);
                Pair {
                    raw_scene: p,
                    raw_ab: (lab[1], lab[2]),
                    jpeg_ab: t,
                    x: 0,
                    y: 0,
                    weight: 1.0,
                    clipped: false,
                }
            })
            .collect()
    }

    #[test]
    fn solver_recovers_known_shift_through_agx_held_out() {
        // Ground-truth chroma transform: scale b by 1.18 (no taper).
        let truth = ChromaTransform {
            gain: 1.0,
            mat: [[1.0, 0.0], [0.0, 1.18]],
            ..ChromaTransform::identity()
        };
        let scene = synth_scene(400);
        // "JPEG target" = post-AgX of the truth-transformed scene, so a
        // perfect solver matches it exactly.
        let jpeg_ab = forward_post_agx_ab(&scene, &truth, 0.0);
        let (fit, meas) = (&scene[..300], &scene[300..]);
        let (fit_t, meas_t) = (&jpeg_ab[..300], &jpeg_ab[300..]);
        let fit_pairs = unit_pairs(fit, fit_t);
        let solved = solve_chroma_through_agx(&fit_pairs, 0.0);
        // On HELD-OUT pixels, post-AgX a/b must match the target far better
        // than identity.
        let id_err = mean_ab_err(
            &forward_post_agx_ab(meas, &ChromaTransform::identity(), 0.0),
            meas_t,
        );
        let solved_err = mean_ab_err(&forward_post_agx_ab(meas, &solved, 0.0), meas_t);
        assert!(
            solved_err < id_err * 0.25,
            "solved {solved_err} not << identity {id_err}"
        );
    }

    #[test]
    fn solver_identity_when_target_is_plain_agx() {
        // Target = forward(identity): the solved transform must be ~identity,
        // i.e. it must not move held-out pixels away from plain AgX.
        let scene = synth_scene(400);
        let id_target = forward_post_agx_ab(&scene, &ChromaTransform::identity(), 0.0);
        let (fit, meas) = (&scene[..300], &scene[300..]);
        let (fit_t, meas_t) = (&id_target[..300], &id_target[300..]);
        let fit_pairs = unit_pairs(fit, fit_t);
        let solved = solve_chroma_through_agx(&fit_pairs, 0.0);
        let solved_err = mean_ab_err(&forward_post_agx_ab(meas, &solved, 0.0), meas_t);
        // Already-correct target → residual stays at the noise floor.
        assert!(
            solved_err < 1e-3,
            "solver drifted off an already-correct target: {solved_err}"
        );
    }

    /// Build a scene-linear Rec.2020 pixel at OKLAB (L, chroma, hue°).
    fn oklab_pixel(l: f32, c: f32, hue_deg: f32) -> [f32; 3] {
        let h = hue_deg.to_radians();
        crate::color::oklab::oklab_to_rec2020([l, c * h.cos(), c * h.sin()])
    }

    /// A cluster of `n` pixels in a narrow hue wedge `[hue0, hue0+span]`,
    /// spread over a range of L and chroma (deterministic).
    fn hue_wedge(n: usize, hue0: f32, span: f32, seed: f32) -> Vec<[f32; 3]> {
        (0..n)
            .map(|i| {
                let t = i as f32 / n.max(1) as f32;
                let hue = hue0 + span * ((seed + t * 7.3).sin().abs());
                let l = 0.35 + 0.30 * ((seed + t * 3.1).cos().abs());
                let c = 0.06 + 0.10 * ((seed + t * 5.7).sin().abs());
                oklab_pixel(l, c, hue)
            })
            .collect()
    }

    #[test]
    fn solver_ridge_suppresses_sparse_hue_blowup() {
        // The blue-overshoot mechanism: a SPARSE, NOISY hue cluster drags the
        // fit into a wild excursion there. Here a well-sampled clean RED wedge
        // (identity target) is joined by a tiny BLUE cluster (~14 px) whose
        // target carries a spurious +b shift. The ridge-to-identity must
        // suppress the blue blowup; with ridge≈0 the solver chases the 14
        // noisy points and over-saturates blue. Held-out: CLEAN blue pixels at
        // the same hue, where identity is the right answer — we measure how
        // far each solve drags them.
        let red = hue_wedge(160, 20.0, 30.0, 0.4); // well-sampled, clean
        // Sparse blue cluster, full-rank (jittered L/C) so the ridge≈0 solve
        // actually blows up rather than hitting the singular→identity fallback.
        let blue_sparse = hue_wedge(14, 250.0, 12.0, 2.3);
        // Held-out clean blue at the same hue band.
        let blue_held = hue_wedge(60, 250.0, 12.0, 5.1);

        // Targets: red is identity (already correct); blue_sparse gets a
        // spurious +b boost (the noisy sparse signal the ridge must resist).
        let blue_boost = ChromaTransform {
            mat: [[1.0, 0.0], [0.0, 1.7]],
            ..ChromaTransform::identity()
        };
        let mut scene = red.clone();
        scene.extend_from_slice(&blue_sparse);
        let mut target = forward_post_agx_ab(&red, &ChromaTransform::identity(), 0.0);
        target.extend(forward_post_agx_ab(&blue_sparse, &blue_boost, 0.0));
        let pairs = unit_pairs(&scene, &target);

        let solved_ridge = solve_chroma_through_agx_with_ridge(&pairs, 0.0, SOLVE_RIDGE);
        let solved_noridge = solve_chroma_through_agx_with_ridge(&pairs, 0.0, 1e-5);

        let id_held = forward_post_agx_ab(&blue_held, &ChromaTransform::identity(), 0.0);
        let drift_ridge =
            mean_ab_err(&forward_post_agx_ab(&blue_held, &solved_ridge, 0.0), &id_held);
        let drift_noridge =
            mean_ab_err(&forward_post_agx_ab(&blue_held, &solved_noridge, 0.0), &id_held);

        // Ridge≈0 must actually blow up (else the differential is meaningless).
        assert!(
            drift_noridge > 0.01,
            "ridge≈0 did not chase the sparse blue noise (drift {drift_noridge}) — \
             cluster may have hit the singular fallback; widen it"
        );
        // The ridge must suppress that blowup by at least 2× AND keep the
        // absolute blue drift small. A linear root-poly can't drive blue to
        // exactly identity while red shares feature support, so "small" is
        // relative to the no-ridge blowup (~0.06 here) — 0.03 is well under
        // half of it and far below the over-saturation a sat-scale would add.
        assert!(
            drift_ridge < drift_noridge * 0.5,
            "ridge did not suppress the sparse-hue blowup: ridge {drift_ridge} vs no-ridge {drift_noridge}"
        );
        assert!(
            drift_ridge < 0.03,
            "ridge left blue over-saturated: {drift_ridge}"
        );
    }
}
