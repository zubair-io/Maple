//! Per-image color LUT: a smooth Nᶟ RGB→RGB grid applied by trilinear interpolation.
//! Value-keyed (no atan2 / ÷L) + smooth ⇒ spatially coherent (cannot blotch).
//!
//! In the render path this layers **after** the #550 per-channel curve: the fit
//! entry points are handed the already-curved display buffer, so the sampled
//! pairs are `(curve(maple), jpeg)` and the grid carries only the cross-channel
//! residual the separable curve can't (`fit_lut_from_pairs` seeds identity and
//! adds a confidence-weighted delta, so a tiny residual ⇒ near-identity LUT ⇒
//! `strength = 0` reproduces the pure #550 curve exactly).
use rayon::prelude::*;

use crate::image::ExifOrientation;

use super::pairs::DisplayPair;
use super::preview::JpegColorSpace;

/// Grid layout matches `bake.rs`: index = ((b*N + g)*N + r)*3 + c, values in [0,1].
#[derive(Clone, Debug, PartialEq)]
pub struct ColorLut {
    pub size: usize,
    pub data: Vec<f32>,
}

impl ColorLut {
    /// Identity LUT of `size` nodes per axis (clamped to ≥2).
    pub fn identity(size: usize) -> Self {
        let n = size.max(2);
        let mut data = vec![0.0f32; n * n * n * 3];
        let denom = (n - 1) as f32;
        for b in 0..n {
            for g in 0..n {
                for r in 0..n {
                    let i = ((b * n + g) * n + r) * 3;
                    data[i] = r as f32 / denom;
                    data[i + 1] = g as f32 / denom;
                    data[i + 2] = b as f32 / denom;
                }
            }
        }
        Self { size: n, data }
    }

    #[inline]
    fn node(&self, r: usize, g: usize, b: usize) -> [f32; 3] {
        let n = self.size;
        let i = ((b * n + g) * n + r) * 3;
        [self.data[i], self.data[i + 1], self.data[i + 2]]
    }

    /// Trilinear lookup of one RGB triplet (inputs clamped to [0,1]).
    pub fn sample(&self, rgb: [f32; 3]) -> [f32; 3] {
        let n = self.size;
        let last = (n - 1) as f32;
        let mut lo = [0usize; 3];
        let mut f = [0f32; 3];
        for c in 0..3 {
            let p = rgb[c].clamp(0.0, 1.0) * last;
            let l = p.floor().min(last - 1.0);
            lo[c] = l as usize;
            f[c] = p - l;
        }
        let mut out = [0f32; 3];
        for c in 0..3 {
            let c000 = self.node(lo[0], lo[1], lo[2])[c];
            let c100 = self.node(lo[0] + 1, lo[1], lo[2])[c];
            let c010 = self.node(lo[0], lo[1] + 1, lo[2])[c];
            let c110 = self.node(lo[0] + 1, lo[1] + 1, lo[2])[c];
            let c001 = self.node(lo[0], lo[1], lo[2] + 1)[c];
            let c101 = self.node(lo[0] + 1, lo[1], lo[2] + 1)[c];
            let c011 = self.node(lo[0], lo[1] + 1, lo[2] + 1)[c];
            let c111 = self.node(lo[0] + 1, lo[1] + 1, lo[2] + 1)[c];
            let c00 = c000 * (1.0 - f[0]) + c100 * f[0];
            let c10 = c010 * (1.0 - f[0]) + c110 * f[0];
            let c01 = c001 * (1.0 - f[0]) + c101 * f[0];
            let c11 = c011 * (1.0 - f[0]) + c111 * f[0];
            let c0 = c00 * (1.0 - f[1]) + c10 * f[1];
            let c1 = c01 * (1.0 - f[1]) + c11 * f[1];
            out[c] = c0 * (1.0 - f[2]) + c1 * f[2];
        }
        out
    }

    /// Apply in place to an interleaved RGB f32 buffer (DisplayEncodedSrgb, [0,1]).
    pub fn apply(&self, rgb: &mut [f32]) {
        rgb.par_chunks_mut(3).for_each(|p| {
            let o = self.sample([p[0], p[1], p[2]]);
            p[0] = o[0];
            p[1] = o[1];
            p[2] = o[2];
        });
    }

    /// Apply with a residual strength `k`: `p' = p + k·(sample(p) − p)`.
    ///
    /// Strength is an APPLY-time knob since #1085 — the fit always produces
    /// (and the cache stores) the full-strength LUT, so `MAPLE_AUTO_LUT_STRENGTH`
    /// can never be baked into a cached artifact. Because trilinear sampling is
    /// linear in the node values and the identity grid reproduces its input,
    /// this lerp equals sampling a `with_strength(k)`-scaled LUT (up to float
    /// rounding, and up to the node clamp at the gamut corners for `k < 1`).
    /// `k == 1.0` routes through [`ColorLut::apply`] (bit-identical to the
    /// pre-#1085 full-strength apply); `k == 0.0` is an exact no-op.
    pub fn apply_with_strength(&self, rgb: &mut [f32], k: f32) {
        if k == 0.0 {
            return;
        }
        if k == 1.0 {
            self.apply(rgb);
            return;
        }
        rgb.par_chunks_mut(3).for_each(|p| {
            let o = self.sample([p[0], p[1], p[2]]);
            p[0] += k * (o[0] - p[0]);
            p[1] += k * (o[1] - p[1]);
            p[2] += k * (o[2] - p[2]);
        });
    }

    /// A copy with the residual scaled toward identity by `k`:
    /// `node' = clamp01(id + k·(node − id))`. `k == 1.0` is a plain clone.
    /// Used by the GPU fit entries to honour `MAPLE_AUTO_LUT_STRENGTH` on the
    /// RETURNED artifact while the cache keeps the canonical full-strength LUT
    /// (#1085).
    pub fn with_strength(&self, k: f32) -> ColorLut {
        if k == 1.0 {
            return self.clone();
        }
        let id = ColorLut::identity(self.size);
        let mut out = self.clone();
        for (o, i) in out.data.iter_mut().zip(&id.data) {
            *o = (i + k * (*o - i)).clamp(0.0, 1.0);
        }
        out
    }
}

/// `MAPLE_AUTO_LUT_STRENGTH` (default `1.0`) — the verify-harness knob that
/// blends the residual toward identity (`0` ⇒ exactly the #550 curve, the
/// accuracy floor). Read at APPLY/RETURN time, never at fit time (#1085).
///
/// Invalid values (non-finite, or outside `[0.0, 2.0]`) are rejected with a
/// warning and replaced by the default `1.0`.
pub fn lut_strength_from_env() -> f32 {
    let Some(env_val) = std::env::var("MAPLE_AUTO_LUT_STRENGTH").ok() else {
        return 1.0;
    };
    let strength = env_val.parse::<f32>().unwrap_or(1.0);
    if strength.is_finite() && (0.0..=2.0).contains(&strength) {
        strength
    } else {
        eprintln!("MAPLE_AUTO_LUT_STRENGTH={env_val} out of range [0,2] or non-finite — using 1.0");
        1.0
    }
}

/// `MAPLE_DISABLE_AUTO_LUT` — when set, the residual-LUT stage is skipped
/// ENTIRELY: no pair sampling, no fit, no cache insert, nothing applied or
/// returned (#1085; pre-fix only the apply was gated, so the fit still ran
/// and its result was cached).
pub fn lut_disabled_by_env() -> bool {
    std::env::var_os("MAPLE_DISABLE_AUTO_LUT").is_some()
}

const FIT_CONF_COUNT: f32 = 8.0; // confidence half-count: c = count / (count + FIT_CONF_COUNT)

/// Grid resolution of the fitted per-image LUT (nodes per axis) — the single
/// fidelity knob, chosen by cross-fixture sweep on the 17-fixture Auto gate
/// (`test_color_pipeline.sh` baseline_auto): grand-mean ΔE-vs-ACR fell 9.6 (#550
/// only) → 8.0 (N=25) → 7.8 (N=49). 49 recovers the most grid-era-budget fixtures
/// (e.g. test_0011 passes at 49 but not 33/25) and posts the best grand mean, with
/// no observed overfitting — the per-cell fit stays confidence-damped + masked-
/// smoothed, so blotch is flat (~0.6) and no body regresses vs #550. A 49³ LUT is
/// 1.4 MB; the apply is O(1)/pixel and the fit O(pixels), both N-independent.
const LUT_SIZE: usize = 49;

/// Floor on surviving `(maple, jpeg)` pairs before a LUT fit is attempted. Below
/// this the correspondence set is too sparse to constrain the LUT grid, so the
/// entry points return `None` and the caller falls back to identity (= the
/// AgX-Neutral render with no LUT layered on).
const MIN_LUT_PAIRS: usize = 256;

/// Fit a smooth Nᶟ RGB→RGB residual LUT from display-space `(maple, jpeg)` pairs.
///
/// Hard-bins every pair into its nearest grid cell, takes the per-cell mean shift
/// toward the JPEG, damps sparse cells toward identity by a count confidence
/// (`c = count / (count + FIT_CONF_COUNT)`), smooths the delta grid for cell-to-cell
/// coherence (confidence-masked — populated cells aren't diluted by empty
/// neighbours; trilinear interpolation fills empty cells at apply time), and
/// composes onto identity with `strength`. This is the O(pixels) limit of the
/// former Gaussian RBF gather — at the resolved σ the kernel had collapsed to
/// SIZE is the only fidelity knob. Value-keyed + smoothed ⇒ spatially coherent
/// (cannot blotch).
#[allow(non_snake_case)]
pub fn fit_lut_from_pairs(pairs: &[DisplayPair], size: usize, strength: f32) -> ColorLut {
    let n = size.max(2);
    let id = ColorLut::identity(n);
    if pairs.is_empty() {
        return id;
    }
    let last = (n - 1) as f32;
    let denom = last;
    let cells = n * n * n;

    // 1. Convert all grid coordinates to Oklab
    let mut l_in = vec![0.0f32; cells];
    let mut a_in = vec![0.0f32; cells];
    let mut b_in = vec![0.0f32; cells];
    let mut c_in = vec![0.0f32; cells];

    for b in 0..n {
        for g in 0..n {
            for r in 0..n {
                let idx = (b * n + g) * n + r;
                let rgb_srgb = [r as f32 / denom, g as f32 / denom, b as f32 / denom];
                let rgb_lin = [
                    super::apply::srgb_gamma_decode(rgb_srgb[0]),
                    super::apply::srgb_gamma_decode(rgb_srgb[1]),
                    super::apply::srgb_gamma_decode(rgb_srgb[2]),
                ];
                let lab = crate::color::oklab::srgb_linear_to_oklab(rgb_lin);
                l_in[idx] = lab[0];
                a_in[idx] = lab[1];
                b_in[idx] = lab[2];
                c_in[idx] = (lab[1] * lab[1] + lab[2] * lab[2]).sqrt();
            }
        }
    }

    // 2. Precompute radial parents and sort indices by input chroma
    let mut radial_parent = vec![None; cells];
    let mut indices: Vec<usize> = (0..cells).collect();

    let at = |r: usize, g: usize, b: usize| (b * n + g) * n + r;

    for b in 0..n {
        for g in 0..n {
            for r in 0..n {
                let idx = at(r, g, b);
                let mean = (r as f32 + g as f32 + b as f32) / 3.0;
                let dr = if (r as f32) > mean {
                    -1
                } else if (r as f32) < mean {
                    1
                } else {
                    0
                };
                let dg = if (g as f32) > mean {
                    -1
                } else if (g as f32) < mean {
                    1
                } else {
                    0
                };
                let db = if (b as f32) > mean {
                    -1
                } else if (b as f32) < mean {
                    1
                } else {
                    0
                };
                if dr != 0 || dg != 0 || db != 0 {
                    let pr = (r as isize + dr) as usize;
                    let pg = (g as isize + dg) as usize;
                    let pb = (b as isize + db) as usize;
                    radial_parent[idx] = Some(at(pr, pg, pb));
                }
            }
        }
    }

    // Sort indices by input chroma (ascending) so we propagate from neutral outward
    indices.sort_unstable_by(|&i, &j| c_in[i].partial_cmp(&c_in[j]).unwrap());

    // 3. Hard-bin all pairs, accumulating target L, a, b values and counts
    let (acc_l, acc_a, acc_b, cnt) = pairs
        .par_iter()
        .fold(
            || {
                (
                    vec![0.0f64; cells],
                    vec![0.0f64; cells],
                    vec![0.0f64; cells],
                    vec![0u32; cells],
                )
            },
            |(mut acc_l, mut acc_a, mut acc_b, mut cnt), pr| {
                let cr = ((pr.maple[0].clamp(0.0, 1.0) * last) + 0.5) as usize;
                let cg = ((pr.maple[1].clamp(0.0, 1.0) * last) + 0.5) as usize;
                let cb = ((pr.maple[2].clamp(0.0, 1.0) * last) + 0.5) as usize;
                let idx = (cb.min(n - 1) * n + cg.min(n - 1)) * n + cr.min(n - 1);

                let j_lin = [
                    super::apply::srgb_gamma_decode(pr.jpeg[0].clamp(0.0, 1.0)),
                    super::apply::srgb_gamma_decode(pr.jpeg[1].clamp(0.0, 1.0)),
                    super::apply::srgb_gamma_decode(pr.jpeg[2].clamp(0.0, 1.0)),
                ];

                let j_ok = crate::color::oklab::srgb_linear_to_oklab(j_lin);

                acc_l[idx] += j_ok[0] as f64;
                acc_a[idx] += j_ok[1] as f64;
                acc_b[idx] += j_ok[2] as f64;
                cnt[idx] += 1;
                (acc_l, acc_a, acc_b, cnt)
            },
        )
        .reduce(
            || {
                (
                    vec![0.0f64; cells],
                    vec![0.0f64; cells],
                    vec![0.0f64; cells],
                    vec![0u32; cells],
                )
            },
            |(mut l1, mut a1, mut b1, mut c1), (l2, a2, b2, c2)| {
                for i in 0..cells {
                    l1[i] += l2[i];
                    a1[i] += a2[i];
                    b1[i] += b2[i];
                    c1[i] += c2[i];
                }
                (l1, a1, b1, c1)
            },
        );

    // 4. Compute target L and k for each cell, plus confidence weights
    let mut l_target = vec![0.0f32; cells];
    let mut a_target = vec![0.0f32; cells];
    let mut b_target = vec![0.0f32; cells];
    let mut w = vec![0.0f32; cells];

    for i in 0..cells {
        if cnt[i] > 0 {
            let c_val = cnt[i] as f32;
            w[i] = c_val / (c_val + FIT_CONF_COUNT);
            l_target[i] = (acc_l[i] / cnt[i] as f64) as f32;
            a_target[i] = (acc_a[i] / cnt[i] as f64) as f32;
            b_target[i] = (acc_b[i] / cnt[i] as f64) as f32;
        }
    }

    // 5. Initialize optimization variables (displacements from identity)
    let mut dL = vec![0.0f32; cells];
    let mut da = vec![0.0f32; cells];
    let mut db = vec![0.0f32; cells];

    let mut L_target_disp = vec![0.0f32; cells];
    let mut a_target_disp = vec![0.0f32; cells];
    let mut b_target_disp = vec![0.0f32; cells];

    for i in 0..cells {
        if cnt[i] > 0 {
            L_target_disp[i] = l_target[i] - l_in[i];
            a_target_disp[i] = a_target[i] - a_in[i];
            b_target_disp[i] = b_target[i] - b_in[i];
        }
    }

    // Regularization parameters
    let lambda_l = 2.0f32;
    let lambda_a = 2.0f32;
    let lambda_b = 2.0f32;
    const ITERATIONS: usize = 15;

    for _ in 0..ITERATIONS {
        // 1. Update dL (Raster order, with monotonicity clamps)
        for b_coord in 0..n {
            for g_coord in 0..n {
                for r_coord in 0..n {
                    let idx = at(r_coord, g_coord, b_coord);
                    let w_i = w[idx];
                    if w_i == 0.0 {
                        dL[idx] = 0.0;
                        continue;
                    }

                    let mut sum_dL = 0.0f32;
                    let mut count_neighbors = 0.0f32;
                    if r_coord > 0 && w[at(r_coord - 1, g_coord, b_coord)] > 0.0 {
                        sum_dL += dL[at(r_coord - 1, g_coord, b_coord)];
                        count_neighbors += 1.0;
                    }
                    if r_coord < n - 1 && w[at(r_coord + 1, g_coord, b_coord)] > 0.0 {
                        sum_dL += dL[at(r_coord + 1, g_coord, b_coord)];
                        count_neighbors += 1.0;
                    }
                    if g_coord > 0 && w[at(r_coord, g_coord - 1, b_coord)] > 0.0 {
                        sum_dL += dL[at(r_coord, g_coord - 1, b_coord)];
                        count_neighbors += 1.0;
                    }
                    if g_coord < n - 1 && w[at(r_coord, g_coord + 1, b_coord)] > 0.0 {
                        sum_dL += dL[at(r_coord, g_coord + 1, b_coord)];
                        count_neighbors += 1.0;
                    }
                    if b_coord > 0 && w[at(r_coord, g_coord, b_coord - 1)] > 0.0 {
                        sum_dL += dL[at(r_coord, g_coord, b_coord - 1)];
                        count_neighbors += 1.0;
                    }
                    if b_coord < n - 1 && w[at(r_coord, g_coord, b_coord + 1)] > 0.0 {
                        sum_dL += dL[at(r_coord, g_coord, b_coord + 1)];
                        count_neighbors += 1.0;
                    }

                    let avg_dL = if count_neighbors > 0.0 {
                        sum_dL / count_neighbors
                    } else {
                        0.0
                    };
                    let dL_new = (w_i * L_target_disp[idx] + lambda_l * count_neighbors * avg_dL)
                        / (w_i + lambda_l * count_neighbors);

                    // Reconstruct L and clamp for lightness monotonicity: non-decreasing in r, g, b directions
                    let L_val = l_in[idx] + dL_new;

                    let mut lower_bound = 0.0f32;
                    if r_coord > 0 {
                        lower_bound = lower_bound.max(
                            l_in[at(r_coord - 1, g_coord, b_coord)]
                                + dL[at(r_coord - 1, g_coord, b_coord)],
                        );
                    }
                    if g_coord > 0 {
                        lower_bound = lower_bound.max(
                            l_in[at(r_coord, g_coord - 1, b_coord)]
                                + dL[at(r_coord, g_coord - 1, b_coord)],
                        );
                    }
                    if b_coord > 0 {
                        lower_bound = lower_bound.max(
                            l_in[at(r_coord, g_coord, b_coord - 1)]
                                + dL[at(r_coord, g_coord, b_coord - 1)],
                        );
                    }

                    let mut upper_bound = 1.0f32;
                    if r_coord < n - 1 {
                        upper_bound = upper_bound.min(
                            l_in[at(r_coord + 1, g_coord, b_coord)]
                                + dL[at(r_coord + 1, g_coord, b_coord)],
                        );
                    }
                    if g_coord < n - 1 {
                        upper_bound = upper_bound.min(
                            l_in[at(r_coord, g_coord + 1, b_coord)]
                                + dL[at(r_coord, g_coord + 1, b_coord)],
                        );
                    }
                    if b_coord < n - 1 {
                        upper_bound = upper_bound.min(
                            l_in[at(r_coord, g_coord, b_coord + 1)]
                                + dL[at(r_coord, g_coord, b_coord + 1)],
                        );
                    }

                    dL[idx] = L_val.clamp(lower_bound, upper_bound) - l_in[idx];
                }
            }
        }

        // 2. Update da and db (in raster order, then we will project using sorted indices)
        for b_coord in 0..n {
            for g_coord in 0..n {
                for r_coord in 0..n {
                    let idx = at(r_coord, g_coord, b_coord);
                    let w_i = w[idx];
                    if w_i == 0.0 {
                        da[idx] = 0.0;
                        db[idx] = 0.0;
                        continue;
                    }

                    let mut sum_da = 0.0f32;
                    let mut sum_db = 0.0f32;
                    let mut count_neighbors = 0.0f32;
                    if r_coord > 0 && w[at(r_coord - 1, g_coord, b_coord)] > 0.0 {
                        sum_da += da[at(r_coord - 1, g_coord, b_coord)];
                        sum_db += db[at(r_coord - 1, g_coord, b_coord)];
                        count_neighbors += 1.0;
                    }
                    if r_coord < n - 1 && w[at(r_coord + 1, g_coord, b_coord)] > 0.0 {
                        sum_da += da[at(r_coord + 1, g_coord, b_coord)];
                        sum_db += db[at(r_coord + 1, g_coord, b_coord)];
                        count_neighbors += 1.0;
                    }
                    if g_coord > 0 && w[at(r_coord, g_coord - 1, b_coord)] > 0.0 {
                        sum_da += da[at(r_coord, g_coord - 1, b_coord)];
                        sum_db += db[at(r_coord, g_coord - 1, b_coord)];
                        count_neighbors += 1.0;
                    }
                    if g_coord < n - 1 && w[at(r_coord, g_coord + 1, b_coord)] > 0.0 {
                        sum_da += da[at(r_coord, g_coord + 1, b_coord)];
                        sum_db += db[at(r_coord, g_coord + 1, b_coord)];
                        count_neighbors += 1.0;
                    }
                    if b_coord > 0 && w[at(r_coord, g_coord, b_coord - 1)] > 0.0 {
                        sum_da += da[at(r_coord, g_coord, b_coord - 1)];
                        sum_db += db[at(r_coord, g_coord, b_coord - 1)];
                        count_neighbors += 1.0;
                    }
                    if b_coord < n - 1 && w[at(r_coord, g_coord, b_coord + 1)] > 0.0 {
                        sum_da += da[at(r_coord, g_coord, b_coord + 1)];
                        sum_db += db[at(r_coord, g_coord, b_coord + 1)];
                        count_neighbors += 1.0;
                    }

                    let avg_da = if count_neighbors > 0.0 {
                        sum_da / count_neighbors
                    } else {
                        0.0
                    };
                    let avg_db = if count_neighbors > 0.0 {
                        sum_db / count_neighbors
                    } else {
                        0.0
                    };

                    da[idx] = (w_i * a_target_disp[idx] + lambda_a * count_neighbors * avg_da)
                        / (w_i + lambda_a * count_neighbors);
                    db[idx] = (w_i * b_target_disp[idx] + lambda_b * count_neighbors * avg_db)
                        / (w_i + lambda_b * count_neighbors);
                }
            }
        }

        // 3. Project a and b to enforce saturation monotonicity (sorted order from neutral outward)
        for &idx in &indices {
            if w[idx] == 0.0 {
                continue;
            }
            let a_val = a_in[idx] + da[idx];
            let b_val = b_in[idx] + db[idx];
            let c_i = (a_val * a_val + b_val * b_val).sqrt();
            if let Some(parent_idx) = radial_parent[idx] {
                let a_p = a_in[parent_idx] + da[parent_idx];
                let b_p = b_in[parent_idx] + db[parent_idx];
                let c_parent = (a_p * a_p + b_p * b_p).sqrt();
                let L_parent = l_in[parent_idx] + dL[parent_idx];
                let L_i = l_in[idx] + dL[idx];

                // Saturation: S = C / (L + 1e-5). We enforce S_i >= S_parent.
                let s_parent = c_parent / (L_parent + 1e-5);
                let c_min = s_parent * (L_i + 1e-5);

                if c_i < c_min {
                    let mut next_a = a_val;
                    let mut next_b = b_val;
                    if c_i > 1e-6 {
                        let scale = c_min / c_i;
                        next_a *= scale;
                        next_b *= scale;
                    } else {
                        // If c_i is 0/near-0, try input direction
                        let c_in_val = c_in[idx];
                        if c_in_val > 1e-6 {
                            let scale = c_min / c_in_val;
                            next_a = a_in[idx] * scale;
                            next_b = b_in[idx] * scale;
                        } else {
                            // Try parent direction
                            let c_p = (a_p * a_p + b_p * b_p).sqrt();
                            if c_p > 1e-6 {
                                let scale = c_min / c_p;
                                next_a = a_p * scale;
                                next_b = b_p * scale;
                            } else {
                                next_a = 0.0;
                                next_b = 0.0;
                            }
                        }
                    }
                    da[idx] = next_a - a_in[idx];
                    db[idx] = next_b - b_in[idx];
                }
            }
        }
    }

    // 6. Convert back to sRGB and compose with strength
    let mut lut = id.clone();
    for i in 0..cells {
        let lab = [l_in[i] + dL[i], a_in[i] + da[i], b_in[i] + db[i]];
        let rgb_lin = crate::color::oklab::oklab_to_srgb_linear(lab);
        let rgb_srgb = [
            crate::view::encode::srgb_gamma(rgb_lin[0]),
            crate::view::encode::srgb_gamma(rgb_lin[1]),
            crate::view::encode::srgb_gamma(rgb_lin[2]),
        ];

        let r = i % n;
        let g = (i / n) % n;
        let b = i / (n * n);
        let id_r = r as f32 / denom;
        let id_g = g as f32 / denom;
        let id_b = b as f32 / denom;

        lut.data[i * 3] = (id_r + strength * (rgb_srgb[0] - id_r)).clamp(0.0, 1.0);
        lut.data[i * 3 + 1] = (id_g + strength * (rgb_srgb[1] - id_g)).clamp(0.0, 1.0);
        lut.data[i * 3 + 2] = (id_b + strength * (rgb_srgb[2] - id_b)).clamp(0.0, 1.0);
    }
    lut
}

/// Fit a per-image color [`ColorLut`] from an ALREADY-extracted embedded
/// preview, against the developed display buffer (#1085 — the caller extracts
/// the preview once and threads it through both fits).
///
/// Mirrors #550's [`super::fit_display::fit_curve_from_preview_display`]:
/// sample display-space correspondences, gate on a minimum pair count, then
/// fit the smooth grid at [`LUT_SIZE`]. `source_rgb` is the caller's
/// interleaved RGB f32 buffer in **f32 sRGB-encoded display space**
/// ([`crate::image::ColorSpace::DisplayEncodedSrgb`], values nominally `[0, 1]`),
/// sensor-oriented (the render applies `orientation` after this stage);
/// `preview` is the SENSOR-oriented embedded JPEG.
///
/// Always fits at FULL strength — `MAPLE_AUTO_LUT_STRENGTH` is an apply-time
/// knob ([`ColorLut::apply_with_strength`] / [`ColorLut::with_strength`]), so
/// the env value can never be baked into a cached LUT (#1085; pre-fix the env
/// was read here and the scaled grid landed in the shared cache).
///
/// Returns `None` (→ identity / Neutral fallback) when too few clean pairs
/// survive ([`MIN_LUT_PAIRS`]).
pub fn fit_lut_from_preview(
    source_rgb: &[f32],
    source_w: usize,
    source_h: usize,
    preview: image::DynamicImage,
    cs: JpegColorSpace,
    orientation: ExifOrientation,
) -> Option<ColorLut> {
    let pairs = super::pairs::sample_display_pairs(
        source_rgb,
        source_w,
        source_h,
        preview,
        cs,
        orientation,
    );
    if pairs.len() < MIN_LUT_PAIRS {
        return None;
    }
    Some(fit_lut_from_pairs(&pairs, LUT_SIZE, 1.0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_lut_is_noop() {
        let lut = ColorLut::identity(17);
        let mut px = vec![0.2f32, 0.5, 0.8, 0.0, 1.0, 0.33];
        let before = px.clone();
        lut.apply(&mut px);
        for (a, b) in px.iter().zip(&before) {
            assert!((a - b).abs() < 1e-4, "{a} vs {b}");
        }
    }

    #[test]
    fn trilinear_recovers_node_values() {
        // A LUT that adds +0.1 to red everywhere: sampling returns node+shift.
        let mut lut = ColorLut::identity(9);
        for n in lut.data.chunks_mut(3) {
            n[0] = (n[0] + 0.1).min(1.0);
        }
        let mut px = vec![0.5f32, 0.5, 0.5];
        lut.apply(&mut px);
        assert!((px[0] - 0.6).abs() < 1e-3, "got {}", px[0]);
        assert!((px[1] - 0.5).abs() < 1e-3);
    }

    #[test]
    fn sparse_pairs_stay_identity() {
        // A lone neutral pair leaves distant corner nodes at identity.
        let pairs = vec![DisplayPair {
            maple: [0.5, 0.5, 0.5],
            jpeg: [0.5, 0.5, 0.5],
        }];
        let lut = fit_lut_from_pairs(&pairs, 9, 1.0);
        let id = ColorLut::identity(9);
        assert!((lut.node(0, 0, 0)[0] - id.node(0, 0, 0)[0]).abs() < 1e-3);
        assert!((lut.node(0, 0, 0)[2] - id.node(0, 0, 0)[2]).abs() < 1e-3);
    }

    /// #1085 strength contract: the cache stores the full-strength LUT and
    /// strength is applied at apply/return time. `apply_with_strength(_, 1.0)`
    /// must be BIT-identical to `apply` (the default path the harness gates);
    /// `0.0` must be an exact no-op; a mid `k` must lerp input → sample.
    #[test]
    fn apply_with_strength_matches_contract() {
        let mut lut = ColorLut::identity(9);
        for n in lut.data.chunks_mut(3) {
            n[0] = (n[0] + 0.2).min(1.0); // +0.2 red everywhere
        }
        let src = vec![0.4f32, 0.5, 0.6];

        let mut full = src.clone();
        lut.apply(&mut full);
        let mut k1 = src.clone();
        lut.apply_with_strength(&mut k1, 1.0);
        assert_eq!(k1, full, "k=1.0 must be bit-identical to plain apply");

        let mut k0 = src.clone();
        lut.apply_with_strength(&mut k0, 0.0);
        assert_eq!(k0, src, "k=0.0 must be an exact no-op");

        let mut half = src.clone();
        lut.apply_with_strength(&mut half, 0.5);
        for c in 0..3 {
            let expect = src[c] + 0.5 * (full[c] - src[c]);
            assert!(
                (half[c] - expect).abs() < 1e-6,
                "k=0.5 channel {c}: got {} want {expect}",
                half[c]
            );
        }
    }

    /// `with_strength` (the GPU-return scaling) agrees with the apply-time
    /// lerp away from the node clamp, and `1.0` is a plain clone.
    #[test]
    fn with_strength_scales_nodes_toward_identity() {
        let mut lut = ColorLut::identity(9);
        for n in lut.data.chunks_mut(3) {
            n[0] = (n[0] + 0.2).min(1.0);
        }
        assert_eq!(lut.with_strength(1.0), lut, "k=1.0 is a plain clone");
        let half = lut.with_strength(0.5);
        // Mid-grey is far from the clamp: scaled-LUT sample == lerped apply.
        let mut via_scaled = vec![0.4f32, 0.5, 0.6];
        half.apply(&mut via_scaled);
        let mut via_lerp = vec![0.4f32, 0.5, 0.6];
        lut.apply_with_strength(&mut via_lerp, 0.5);
        for c in 0..3 {
            assert!(
                (via_scaled[c] - via_lerp[c]).abs() < 1e-6,
                "channel {c}: scaled {} vs lerp {}",
                via_scaled[c],
                via_lerp[c]
            );
        }
    }

    #[test]
    fn recovers_uniform_shift() {
        // Pairs along the grey diagonal that all add +0.1 red → LUT boosts mid-grey red.
        let pairs: Vec<_> = (0..200)
            .map(|i| {
                let v = i as f32 / 199.0;
                DisplayPair {
                    maple: [v, v, v],
                    jpeg: [(v + 0.1).min(1.0), v, v],
                }
            })
            .collect();
        let lut = fit_lut_from_pairs(&pairs, 9, 1.0);
        let mut px = vec![0.5f32, 0.5, 0.5];
        lut.apply(&mut px);
        assert!(px[0] > 0.55, "red not boosted: {}", px[0]);
        assert!(
            (px[1] - 0.5).abs() < 0.03 && (px[2] - 0.5).abs() < 0.03,
            "green/blue drifted"
        );
    }
}
