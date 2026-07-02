//! Fitting entry points for the per-image residual [`ColorLut`]: hard-bin
//! display-space `(maple, jpeg)` pairs, solve the smoothed/monotone Oklab
//! displacement field, and compose onto identity. Split out of `lut.rs`
//! under the 600-LOC file-size budget; contents moved verbatim (the LUT
//! struct + apply path stay in `lut.rs`, re-exporting these fits).
use rayon::prelude::*;

use crate::image::ExifOrientation;

use super::lut::ColorLut;
use super::pairs::DisplayPair;
use super::preview::JpegColorSpace;

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
