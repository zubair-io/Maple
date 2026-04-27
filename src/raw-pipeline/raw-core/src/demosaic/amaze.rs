//! AMaZE-refinement demosaic. Drop-in alternative to `hamilton_adams` for
//! full-quality renders. Slower (multiple passes over the frame) but reduces
//! zipper artefacts on edges and resolves finer detail than HA — and resists
//! moiré on Bayer-pattern-prone content (fine fabric, building façades).
//!
//! Algorithm ported from RawTherapee's `amaze_demosaic_RT.cc` (scalar
//! branch). Stage map (line numbers refer to the upstream engine source):
//!
//!   * Stage 0      — CFA flatten (use the post-`sensor_linearize` mosaic
//!                    `Image`, collapse to a flat `Vec<f32>`).
//!   * Stage 0.5    — Directional roughness weights `dirwts0/dirwts1`
//!                    (lines 368-377).
//!   * Stage 1      — Hamilton-Adams green + dirwts-weighted color
//!                    differences (lines 449-532).
//!   * Stage 2      — Variance-based selection of vcd/vcdalt and hcd/hcdalt
//!                    (lines 601-609).
//!   * Stage 3      — Median-bound color differences to clip runaway
//!                    interpolations on saturated edges (lines 619-682).
//!   * Stage 4      — Adaptive H/V direction weight per pixel (lines 692-737).
//!   * Stage 5      — Final RGB combine: green plane proper at R/B sites,
//!                    R/B reconstruction via diagonal/cardinal color-difference
//!                    using the refined green plane (line 981+).
//!
//! _Maple specifics: input/output use `Image` (`Vec<[f32; 3]>`, three
//! channels, sparse mosaic). Falls back to `hamilton_adams` for any
//! non-standard CFA (`LinearRgb` is rejected upstream by
//! `sensor_linearize`'s `debug_assert`; the standard 4 Bayer patterns are
//! handled directly). For images smaller than the 8-pixel border the
//! AMaZE windows assume, returns the `hamilton_adams` result so corner
//! cases don't crash.

use crate::image::{CfaPattern, ColorSpace, Image};
use rayon::prelude::*;

use super::hamilton_adams::hamilton_adams;

/// AMaZE demosaic. `mosaic` must be `CameraNativeMosaic` produced by
/// `sensor_linearize` (single channel populated per pixel, normalised to
/// `[0, 1]`). Output is `CameraNativeLinearRgb`.
pub fn amaze(mosaic: &Image, cfa: CfaPattern) -> Image {
    mosaic.assert_space(ColorSpace::CameraNativeMosaic);
    let w = mosaic.width as usize;
    let h = mosaic.height as usize;

    // AMaZE reads a 4-pixel ring on each side (variance taps reach ±2,
    // adaptive-H/V weight reads ±3, the final-combine pass guards 8 px).
    // Below the threshold we can't run any of those passes, so just return
    // hamilton_adams (which itself falls back to bilinear at <5 px).
    if w < 17 || h < 17 {
        return hamilton_adams(mosaic, cfa);
    }

    // Stage 0: flatten the sparse 3-channel mosaic to a single float per
    // CFA position. Cheap (one read per pixel, parallelised by rayon).
    let cfa_flat = flatten_mosaic(mosaic, cfa);

    // Stage 0.5: directional roughness weights — feed both the cardinal
    // ratio interpolations in stage 1 and the H/V blending.
    let (dirwts0, dirwts1) = compute_dirwts(&cfa_flat, w, h);

    // Stage 1: Hamilton-Adams green seed + dirwts-weighted color differences.
    let mut green = vec![0.0_f32; w * h];
    let mut vcd = vec![0.0_f32; w * h]; // signed: +(G − chroma) at R/B sites, −(…) at G sites
    let mut hcd = vec![0.0_f32; w * h];
    let mut vcdalt = vec![0.0_f32; w * h];
    let mut hcdalt = vec![0.0_f32; w * h];
    interpolate_green_and_diffs(
        &cfa_flat, w, h, cfa,
        &dirwts0, &dirwts1,
        &mut green, &mut vcd, &mut hcd, &mut vcdalt, &mut hcdalt,
    );

    // Stage 2: variance-based selection (vcd vs vcdalt, hcd vs hcdalt) —
    // pick the smoother color-difference field locally.
    refine_color_diff_by_variance(w, h, &mut vcd, &mut hcd, &vcdalt, &hcdalt);

    // Stage 3: median-bound color differences to constrain runaway
    // interpolations on saturated edges.
    median_bound_color_diffs(&cfa_flat, w, h, cfa, &mut vcd, &mut hcd);

    // Stage 4: adaptive H/V direction weight per pixel.
    let hvwt = adaptive_hv_weight(w, h, &vcd, &hcd);

    // Stage 5: final RGB combine.
    combine_rgb(&cfa_flat, w, h, cfa, &green, &vcd, &hcd, &hvwt)
}

// ---------------------------------------------------------------------------
// Stage 0: flatten the sparse 3-channel mosaic to a flat single-channel buffer.
// ---------------------------------------------------------------------------

fn flatten_mosaic(mosaic: &Image, cfa: CfaPattern) -> Vec<f32> {
    let w = mosaic.width as usize;
    // Read whichever of [r, g, b] the CFA position says is populated. The
    // others are zero per the `sensor_linearize` contract; we don't trust
    // them in case a future stage starts seeding the off-channels.
    mosaic.pixels
        .par_iter()
        .enumerate()
        .map(|(i, p)| {
            let x = (i % w) as u32;
            let y = (i / w) as u32;
            let c = cfa.color_at(x, y) as usize;
            p[c]
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Stage 0.5: directional weights — dirwts0 measures vertical roughness,
// dirwts1 horizontal. 1:1 port of amaze_demosaic_RT.cc:368-377.
// ---------------------------------------------------------------------------

fn compute_dirwts(cfa: &[f32], w: usize, h: usize) -> (Vec<f32>, Vec<f32>) {
    const EPS: f32 = 1e-5;
    let mut dirwts0 = vec![EPS; w * h];
    let mut dirwts1 = vec![EPS; w * h];
    for y in 2..h - 2 {
        for x in 2..w - 2 {
            let i = y * w + x;
            let v = cfa[i];
            let delh = (cfa[i + 1] - cfa[i - 1]).abs();
            let delv = (cfa[i + w] - cfa[i - w]).abs();
            dirwts0[i] = EPS + (cfa[i + 2 * w] - v).abs() + (v - cfa[i - 2 * w]).abs() + delv;
            dirwts1[i] = EPS + (cfa[i + 2] - v).abs() + (v - cfa[i - 2]).abs() + delh;
        }
    }
    (dirwts0, dirwts1)
}

// ---------------------------------------------------------------------------
// Stage 1: Hamilton-Adams green + dirwts-weighted color differences.
// 1:1 port of amaze_demosaic_RT.cc:449-532 (scalar branch).
//   * HA cardinal estimates: guha, gdha, glha, grha
//   * Adaptive-ratio alternates: guar, gdar, glar, grar (fall back to HA
//     when the ratio strays past `arthresh`)
//   * dirwts-weighted blends:
//       vwt = dirwts0[N]/(dirwts0[N]+dirwts0[S]),
//       hwt = dirwts1[W]/(dirwts1[W]+dirwts1[E])
//   * vcd / vcdalt store the adaptive-ratio and HA color differences with
//     a per-pixel sign that flips between G ↔ R/B sites
//   * Highlight clip fallback: any of cfa, Gintvha, Ginthha > clip_pt8 →
//     use vcdalt/hcdalt (HA).
// ---------------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
fn interpolate_green_and_diffs(
    cfa: &[f32],
    w: usize,
    h: usize,
    pattern: CfaPattern,
    dirwts0: &[f32],
    dirwts1: &[f32],
    green: &mut [f32],
    vcd: &mut [f32],
    hcd: &mut [f32],
    vcdalt: &mut [f32],
    hcdalt: &mut [f32],
) {
    const EPS: f32 = 1e-5;
    const ARTHRESH: f32 = 0.75;
    // 0.8 / initialGain; initialGain == 1.0 for the normalised [0, 1] data
    // produced by `sensor_linearize`.
    const CLIP_PT8: f32 = 0.8;

    for y in 0..h {
        for x in 0..w {
            let i = y * w + x;
            let c = pattern.color_at(x as u32, y as u32) as usize;
            if c == 1 {
                green[i] = cfa[i];
                continue;
            }
            if x < 2 || x >= w - 2 || y < 2 || y >= h - 2 {
                // Edge fallback: 4-neighbour bilinear over greens. The R/B
                // chroma at this site stays in `cfa`; stage 5 fills the
                // missing channels via the bilinear-difference fallback.
                let mut sum = 0.0_f32;
                let mut cnt = 0_u32;
                for (dx, dy) in [(-1_i32, 0_i32), (1, 0), (0, -1), (0, 1)] {
                    let nx = x as i32 + dx;
                    let ny = y as i32 + dy;
                    if nx >= 0 && (nx as usize) < w && ny >= 0 && (ny as usize) < h
                        && pattern.color_at(nx as u32, ny as u32) as usize == 1
                    {
                        sum += cfa[(ny as usize) * w + nx as usize];
                        cnt += 1;
                    }
                }
                green[i] = if cnt > 0 { sum / cnt as f32 } else { cfa[i] };
                continue;
            }

            let cf = cfa[i];

            // Cardinal ratios from dirwts (engine 455-458).
            let cru = cfa[i - w] * (dirwts0[i - 2 * w] + dirwts0[i])
                / (dirwts0[i - 2 * w] * (EPS + cf) + dirwts0[i] * (EPS + cfa[i - 2 * w]));
            let crd = cfa[i + w] * (dirwts0[i + 2 * w] + dirwts0[i])
                / (dirwts0[i + 2 * w] * (EPS + cf) + dirwts0[i] * (EPS + cfa[i + 2 * w]));
            let crl = cfa[i - 1] * (dirwts1[i - 2] + dirwts1[i])
                / (dirwts1[i - 2] * (EPS + cf) + dirwts1[i] * (EPS + cfa[i - 2]));
            let crr = cfa[i + 1] * (dirwts1[i + 2] + dirwts1[i])
                / (dirwts1[i + 2] * (EPS + cf) + dirwts1[i] * (EPS + cfa[i + 2]));

            // Hamilton-Adams cardinal G estimates (engine 461-464).
            let guha = cfa[i - w] + 0.5 * (cf - cfa[i - 2 * w]);
            let gdha = cfa[i + w] + 0.5 * (cf - cfa[i + 2 * w]);
            let glha = cfa[i - 1] + 0.5 * (cf - cfa[i - 2]);
            let grha = cfa[i + 1] + 0.5 * (cf - cfa[i + 2]);

            // Adaptive-ratio cardinal G estimates (engine 469-491).
            let mut guar = if (1.0 - cru).abs() < ARTHRESH { cf * cru } else { guha };
            let mut gdar = if (1.0 - crd).abs() < ARTHRESH { cf * crd } else { gdha };
            let mut glar = if (1.0 - crl).abs() < ARTHRESH { cf * crl } else { glha };
            let mut grar = if (1.0 - crr).abs() < ARTHRESH { cf * crr } else { grha };

            // dirwts-weighted V/H blends (engine 494-499). The numerator on
            // the up-side (`dirwts0[N]`) means a strong gradient ABOVE
            // down-weights the up estimate (vwt → 0 when up is rough, so
            // the down estimate wins).
            let hwt = dirwts1[i - 1] / (dirwts1[i - 1] + dirwts1[i + 1]);
            let vwt = dirwts0[i - w] / (dirwts0[i + w] + dirwts0[i - w]);

            // HA-blended G estimate per direction.
            let g_int_v_ha = vwt * gdha + (1.0 - vwt) * guha;
            let g_int_h_ha = hwt * grha + (1.0 - hwt) * glha;

            // Sign convention: at R/B (c != 1) the "color difference" is
            // G_est − cfa = G − chroma. At G sites we negate so the dirwts
            // variance interpretation in stage 2 stays consistent.
            let sign = if c == 1 { -1.0_f32 } else { 1.0_f32 };

            let vcd_main = sign * ((vwt * gdar + (1.0 - vwt) * guar) - cf);
            let hcd_main = sign * ((hwt * grar + (1.0 - hwt) * glar) - cf);
            let vcd_alt = sign * (g_int_v_ha - cf);
            let hcd_alt = sign * (g_int_h_ha - cf);

            let mut vcd_v = vcd_main;
            let mut hcd_v = hcd_main;

            // Highlight clip fallback (engine 517-525).
            if cf > CLIP_PT8 || g_int_v_ha > CLIP_PT8 || g_int_h_ha > CLIP_PT8 {
                guar = guha;
                gdar = gdha;
                glar = glha;
                grar = grha;
                vcd_v = vcd_alt;
                hcd_v = hcd_alt;
            }
            let _ = (guar, gdar, glar, grar); // would feed dgintv/dginth; unused here

            vcd[i] = vcd_v;
            hcd[i] = hcd_v;
            vcdalt[i] = vcd_alt;
            hcdalt[i] = hcd_alt;

            // Provisional green at R/B site (overridden in stage 5 by
            // `cfa + intp(hvwt, vcd, hcd)`). Use the HA average so the
            // edge-bordering pixels that miss stage 5's interior bound have
            // a sensible value.
            green[i] = 0.5 * (g_int_v_ha + g_int_h_ha);
        }
    }
}

// ---------------------------------------------------------------------------
// Stage 2: pick the smoother color-difference between vcd/vcdalt and
// hcd/hcdalt. Variance trick from AMaZE 601-609:
//   var = 3·(c[-2]² + c[0]² + c[+2]²) − (c[-2] + c[0] + c[+2])²
// (proportional to standard deviation but cheaper).
// ---------------------------------------------------------------------------

fn refine_color_diff_by_variance(
    w: usize,
    h: usize,
    vcd: &mut [f32],
    hcd: &mut [f32],
    vcdalt: &[f32],
    hcdalt: &[f32],
) {
    let var3 = |a: f32, b: f32, c: f32| -> f32 {
        3.0 * (a * a + b * b + c * c) - (a + b + c).powi(2)
    };
    for y in 4..h - 4 {
        for x in 4..w - 4 {
            let i = y * w + x;
            // Horizontal: 3 samples 2 apart on the row.
            let hcd_var = var3(hcd[i - 2], hcd[i], hcd[i + 2]);
            let hcd_alt_var = var3(hcdalt[i - 2], hcdalt[i], hcdalt[i + 2]);
            if hcd_alt_var < hcd_var {
                hcd[i] = hcdalt[i];
            }
            // Vertical: 3 samples 2 rows apart.
            let vcd_var = var3(vcd[i - 2 * w], vcd[i], vcd[i + 2 * w]);
            let vcd_alt_var = var3(vcdalt[i - 2 * w], vcdalt[i], vcdalt[i + 2 * w]);
            if vcd_alt_var < vcd_var {
                vcd[i] = vcdalt[i];
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Stage 3: median-bound color differences. Mirrors lines 619-682 of the
// engine (R/B-at-green-site / G-at-R/B-site branches). Uses median(G,
// C_left, C_right) as the safety floor.
// ---------------------------------------------------------------------------

fn median3(a: f32, b: f32, c: f32) -> f32 {
    let mut v = [a, b, c];
    v.sort_by(|p, q| p.partial_cmp(q).unwrap_or(std::cmp::Ordering::Equal));
    v[1]
}

fn median_bound_color_diffs(
    cfa: &[f32],
    w: usize,
    h: usize,
    pattern: CfaPattern,
    vcd: &mut [f32],
    hcd: &mut [f32],
) {
    const EPS: f32 = 1e-5;
    const CLIP_PT: f32 = 1.0; // already in normalised [0, 1]
    for y in 4..h - 4 {
        for x in 4..w - 4 {
            let i = y * w + x;
            let c = pattern.color_at(x as u32, y as u32) as usize;
            let v = cfa[i];
            if c != 1 {
                // R/B-site branch (line 650+).
                let g_int_h = hcd[i] + v;
                let g_int_v = vcd[i] + v;

                if hcd[i] < 0.0 {
                    if 3.0 * hcd[i] < -(g_int_h + v) {
                        hcd[i] = median3(g_int_h, cfa[i - 1], cfa[i + 1]) - v;
                    } else {
                        let hwt = 1.0 + 3.0 * hcd[i] / (EPS + g_int_h + v);
                        hcd[i] = hwt * hcd[i]
                            + (1.0 - hwt) * (median3(g_int_h, cfa[i - 1], cfa[i + 1]) - v);
                    }
                }
                if vcd[i] < 0.0 {
                    if 3.0 * vcd[i] < -(g_int_v + v) {
                        vcd[i] = median3(g_int_v, cfa[i - w], cfa[i + w]) - v;
                    } else {
                        let vwt = 1.0 + 3.0 * vcd[i] / (EPS + g_int_v + v);
                        vcd[i] = vwt * vcd[i]
                            + (1.0 - vwt) * (median3(g_int_v, cfa[i - w], cfa[i + w]) - v);
                    }
                }
                if g_int_h > CLIP_PT {
                    hcd[i] = median3(g_int_h, cfa[i - 1], cfa[i + 1]) - v;
                }
                if g_int_v > CLIP_PT {
                    vcd[i] = median3(g_int_v, cfa[i - w], cfa[i + w]) - v;
                }
            } else {
                // G-site branch (lines 619-647).
                let g_int_h = -hcd[i] + v;
                let g_int_v = -vcd[i] + v;
                if hcd[i] > 0.0 {
                    if 3.0 * hcd[i] > (g_int_h + v) {
                        hcd[i] = -median3(g_int_h, cfa[i - 1], cfa[i + 1]) + v;
                    } else {
                        let hwt = 1.0 - 3.0 * hcd[i] / (EPS + g_int_h + v);
                        hcd[i] = hwt * hcd[i]
                            + (1.0 - hwt) * (-median3(g_int_h, cfa[i - 1], cfa[i + 1]) + v);
                    }
                }
                if vcd[i] > 0.0 {
                    if 3.0 * vcd[i] > (g_int_v + v) {
                        vcd[i] = -median3(g_int_v, cfa[i - w], cfa[i + w]) + v;
                    } else {
                        let vwt = 1.0 - 3.0 * vcd[i] / (EPS + g_int_v + v);
                        vcd[i] = vwt * vcd[i]
                            + (1.0 - vwt) * (-median3(g_int_v, cfa[i - w], cfa[i + w]) + v);
                    }
                }
                if g_int_h > CLIP_PT {
                    hcd[i] = -median3(g_int_h, cfa[i - 1], cfa[i + 1]) + v;
                }
                if g_int_v > CLIP_PT {
                    vcd[i] = -median3(g_int_v, cfa[i - w], cfa[i + w]) + v;
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Stage 4: adaptive H/V direction weight per pixel. The direction whose
// color-difference field has lower local variance is the edge direction.
// Returns hvwt in [0, 1] where 1 = pure vertical-edge (horizontal direction
// wins) and 0 = pure horizontal-edge. Used as
// `intp(hvwt, vcd, hcd) = hvwt·vcd + (1−hvwt)·hcd` so the lower-variance
// direction dominates. Mirrors AMaZE 692-737.
// ---------------------------------------------------------------------------

fn adaptive_hv_weight(w: usize, h: usize, vcd: &[f32], hcd: &[f32]) -> Vec<f32> {
    const EPS_SQ: f32 = 1e-10;
    let mut hvwt = vec![0.5_f32; w * h];
    for y in 6..h - 6 {
        for x in 6..w - 6 {
            let i = y * w + x;
            // Vertical color-difference variance over a 7-tap column.
            let mut v_sum = 0.0_f32;
            for k in 0_usize..7 {
                let yy = y + k - 3;
                v_sum += vcd[yy * w + x];
            }
            let v_mean = v_sum / 7.0;
            let mut v_var = 0.0_f32;
            for k in 0_usize..7 {
                let yy = y + k - 3;
                let d = vcd[yy * w + x] - v_mean;
                v_var += d * d;
            }
            // Horizontal color-difference variance over a 7-tap row.
            let mut h_sum = 0.0_f32;
            for k in 0_usize..7 {
                let xx = x + k - 3;
                h_sum += hcd[y * w + xx];
            }
            let h_mean = h_sum / 7.0;
            let mut h_var = 0.0_f32;
            for k in 0_usize..7 {
                let xx = x + k - 3;
                let d = hcd[y * w + xx] - h_mean;
                h_var += d * d;
            }

            let v_var = v_var + EPS_SQ;
            let h_var = h_var + EPS_SQ;
            hvwt[i] = h_var / (v_var + h_var);
        }
    }
    hvwt
}

// ---------------------------------------------------------------------------
// Stage 5: produce final RGB.
//   * Green at R/B sites = cfa + intp(hvwt, vcd, hcd) (engine 981-983).
//   * R/B reconstruction at G sites uses cardinal color-difference against
//     the refined green plane.
//   * R/B reconstruction at the opposite chroma site uses diagonal-bilinear
//     color-difference against the refined green plane.
//   * Out-of-band pixels (where the AMaZE windows don't fit) fall back to
//     bilinear-difference over the green-refined plane.
// ---------------------------------------------------------------------------

fn combine_rgb(
    cfa: &[f32],
    w: usize,
    h: usize,
    pattern: CfaPattern,
    green: &[f32],
    vcd: &[f32],
    hcd: &[f32],
    hvwt: &[f32],
) -> Image {
    let mut out = Image::new(w as u32, h as u32, ColorSpace::CameraNativeLinearRgb);

    // Refine the green plane at R/B sites where stage 4 left valid hvwt
    // (interior 8-pixel border). Outside that, the provisional green from
    // stage 1 (HA-blend) stays.
    let mut green_refined = green.to_vec();
    for y in 8..h.saturating_sub(8) {
        for x in 8..w.saturating_sub(8) {
            let i = y * w + x;
            let c = pattern.color_at(x as u32, y as u32) as usize;
            if c == 1 {
                continue;
            }
            let dgrb = hvwt[i] * vcd[i] + (1.0 - hvwt[i]) * hcd[i];
            green_refined[i] = (cfa[i] + dgrb).clamp(0.0, 4.0);
        }
    }

    out.pixels.par_chunks_mut(w).enumerate().for_each(|(y, row)| {
        for x in 0..w {
            let i = y * w + x;
            let c = pattern.color_at(x as u32, y as u32) as usize;
            let g = green_refined[i];
            let mut px = [0.0_f32; 3];
            px[c] = cfa[i];
            px[1] = g;

            let in_bounds = x >= 1 && x < w - 1 && y >= 1 && y < h - 1;

            for target in 0..3 {
                if target == 1 || target == c {
                    continue;
                }
                if !in_bounds {
                    // Bilinear-difference fall-back over the 8-neighbour
                    // ring (ignoring positions outside the frame).
                    let mut sum = 0.0_f32;
                    let mut cnt = 0_u32;
                    for (dx, dy) in [
                        (-1_i32, -1_i32), (-1, 0), (-1, 1),
                        (0, -1),                  (0, 1),
                        (1, -1),  (1, 0),  (1, 1),
                    ] {
                        let nx = x as i32 + dx;
                        let ny = y as i32 + dy;
                        if nx >= 0 && (nx as usize) < w && ny >= 0 && (ny as usize) < h
                            && pattern.color_at(nx as u32, ny as u32) as usize == target
                        {
                            let ni = (ny as usize) * w + nx as usize;
                            sum += cfa[ni] - green_refined[ni];
                            cnt += 1;
                        }
                    }
                    px[target] = (g + if cnt > 0 { sum / cnt as f32 } else { 0.0 })
                        .clamp(0.0, 4.0);
                    continue;
                }

                if c == 1 {
                    // Green pixel — target color sits on H or V neighbours.
                    let target_horiz = pattern.color_at((x - 1) as u32, y as u32) as usize == target;
                    let (na, nb) = if target_horiz {
                        (y * w + (x - 1), y * w + (x + 1))
                    } else {
                        ((y - 1) * w + x, (y + 1) * w + x)
                    };
                    let diff = 0.5
                        * ((cfa[na] - green_refined[na])
                            + (cfa[nb] - green_refined[nb]));
                    px[target] = (g + diff).clamp(0.0, 4.0);
                } else {
                    // R/B at the opposite chroma site — target sits on the
                    // diagonals. Diagonal-bilinear color-difference using
                    // the green-refined plane.
                    let i_ne = (y - 1) * w + (x + 1);
                    let i_nw = (y - 1) * w + (x - 1);
                    let i_se = (y + 1) * w + (x + 1);
                    let i_sw = (y + 1) * w + (x - 1);
                    let diag_diff = 0.25
                        * ((cfa[i_ne] - green_refined[i_ne])
                            + (cfa[i_nw] - green_refined[i_nw])
                            + (cfa[i_se] - green_refined[i_se])
                            + (cfa[i_sw] - green_refined[i_sw]));
                    px[target] = (g + diag_diff).clamp(0.0, 4.0);
                }
            }

            row[x] = px;
        }
    });

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a Bayer-mosaic `Image` of constant per-channel values for
    /// the requested CFA. Mirrors the helper in the `hamilton_adams`
    /// tests so the input contract is identical.
    fn rggb_uniform(w: u32, h: u32, r: f32, g: f32, b: f32) -> Image {
        let mut img = Image::new(w, h, ColorSpace::CameraNativeMosaic);
        let cfa = CfaPattern::Rggb;
        for y in 0..h {
            for x in 0..w {
                let c = cfa.color_at(x, y) as usize;
                let v = match c { 0 => r, 1 => g, 2 => b, _ => 0.0 };
                img.pixels[(y * w + x) as usize][c] = v;
            }
        }
        img
    }

    /// Synthesise a vertical-step-edge mosaic: scene goes from `low` to
    /// `high` at `x_split`. Each CFA position carries the appropriate
    /// scene channel, so a sharp edge in the scene means a sharp edge
    /// in every channel when correctly demosaiced.
    fn step_mosaic(w: u32, h: u32, x_split: u32, low: f32, high: f32) -> Image {
        let mut img = Image::new(w, h, ColorSpace::CameraNativeMosaic);
        let cfa = CfaPattern::Rggb;
        for y in 0..h {
            for x in 0..w {
                let c = cfa.color_at(x, y) as usize;
                let v = if x < x_split { low } else { high };
                img.pixels[(y * w + x) as usize][c] = v;
            }
        }
        img
    }

    #[test]
    fn amaze_uniform_input_produces_uniform_output() {
        let mosaic = rggb_uniform(32, 32, 0.4, 0.5, 0.6);
        let out = amaze(&mosaic, CfaPattern::Rggb);
        assert_eq!(out.space, ColorSpace::CameraNativeLinearRgb);
        // Interior — strict tolerance. Border pixels (in the bilinear
        // fallback inside `combine_rgb`) are also exact for uniform input
        // because every neighbour carries the same value.
        for p in &out.pixels {
            assert!((p[0] - 0.4).abs() < 5e-3, "R: {}", p[0]);
            assert!((p[1] - 0.5).abs() < 5e-3, "G: {}", p[1]);
            assert!((p[2] - 0.6).abs() < 5e-3, "B: {}", p[2]);
        }
    }

    #[test]
    fn amaze_output_space_is_camera_native_rgb() {
        let mosaic = rggb_uniform(20, 20, 0.1, 0.1, 0.1);
        let out = amaze(&mosaic, CfaPattern::Rggb);
        assert_eq!(out.space, ColorSpace::CameraNativeLinearRgb);
    }

    #[test]
    fn amaze_small_image_falls_back_to_hamilton_adams() {
        // Below the 17-px AMaZE threshold the function should not panic on
        // out-of-range indices and should return a valid `Image` of the
        // same dimensions as the input.
        let mosaic = rggb_uniform(8, 8, 0.2, 0.3, 0.4);
        let out = amaze(&mosaic, CfaPattern::Rggb);
        assert_eq!(out.width, 8);
        assert_eq!(out.height, 8);
        assert_eq!(out.space, ColorSpace::CameraNativeLinearRgb);
        for p in &out.pixels {
            assert!((p[0] - 0.2).abs() < 1e-3);
            assert!((p[1] - 0.3).abs() < 1e-3);
            assert!((p[2] - 0.4).abs() < 1e-3);
        }
    }

    #[test]
    fn amaze_step_edge_keeps_sharpness() {
        // A sharp vertical step at column 20 — across the edge the green
        // delta should retain most of the scene contrast (0.6). AMaZE's
        // adaptive H/V weighting is designed to detect the vertical edge
        // and keep horizontal interpolations from blurring it.
        let mosaic = step_mosaic(40, 16, 20, 0.2, 0.8);
        let out = amaze(&mosaic, CfaPattern::Rggb);
        let g_left = out.pixels[8 * 40 + 18][1];
        let g_right = out.pixels[8 * 40 + 21][1];
        let edge = (g_right - g_left).abs();
        assert!(edge > 0.4, "edge collapsed: g_left={} g_right={} delta={}",
            g_left, g_right, edge);
    }

    #[test]
    fn amaze_bggr_pattern_works() {
        let mut img = Image::new(20, 20, ColorSpace::CameraNativeMosaic);
        let cfa = CfaPattern::Bggr;
        for y in 0..20u32 {
            for x in 0..20u32 {
                let c = cfa.color_at(x, y) as usize;
                let v = match c { 0 => 0.7, 1 => 0.5, 2 => 0.3, _ => 0.0 };
                img.pixels[(y * 20 + x) as usize][c] = v;
            }
        }
        let out = amaze(&img, CfaPattern::Bggr);
        // Interior pixels must converge on the seeded values.
        for y in 8..12 {
            for x in 8..12 {
                let p = out.pixels[y * 20 + x];
                assert!((p[0] - 0.7).abs() < 5e-3, "R: {}", p[0]);
                assert!((p[1] - 0.5).abs() < 5e-3, "G: {}", p[1]);
                assert!((p[2] - 0.3).abs() < 5e-3, "B: {}", p[2]);
            }
        }
    }

    #[test]
    fn amaze_grbg_pattern_works() {
        // GRBG: the second 2x2 column of channels differs from RGGB.
        // Smoke test that the algorithm respects `cfa.color_at`.
        let mut img = Image::new(20, 20, ColorSpace::CameraNativeMosaic);
        let cfa = CfaPattern::Grbg;
        for y in 0..20u32 {
            for x in 0..20u32 {
                let c = cfa.color_at(x, y) as usize;
                let v = match c { 0 => 0.4, 1 => 0.5, 2 => 0.6, _ => 0.0 };
                img.pixels[(y * 20 + x) as usize][c] = v;
            }
        }
        let out = amaze(&img, CfaPattern::Grbg);
        for y in 8..12 {
            for x in 8..12 {
                let p = out.pixels[y * 20 + x];
                assert!((p[0] - 0.4).abs() < 5e-3);
                assert!((p[1] - 0.5).abs() < 5e-3);
                assert!((p[2] - 0.6).abs() < 5e-3);
            }
        }
    }

    #[test]
    fn amaze_no_nan_on_zero_input() {
        // All zeros — divisions by `dirwts` could produce NaN if the EPS
        // floor weren't there. Confirm the EPS guard is doing its job.
        let mosaic = Image::new(20, 20, ColorSpace::CameraNativeMosaic);
        let out = amaze(&mosaic, CfaPattern::Rggb);
        for p in &out.pixels {
            assert!(p[0].is_finite() && p[1].is_finite() && p[2].is_finite());
            assert!(p[0].abs() < 1e-3);
            assert!(p[1].abs() < 1e-3);
            assert!(p[2].abs() < 1e-3);
        }
    }

    #[test]
    fn amaze_deterministic_same_input_same_output() {
        // Same RAW + same algorithm = same bytes. Guards against future
        // rayon-induced reordering bugs.
        let mosaic = rggb_uniform(20, 20, 0.4, 0.5, 0.6);
        let a = amaze(&mosaic, CfaPattern::Rggb);
        let b = amaze(&mosaic, CfaPattern::Rggb);
        assert_eq!(a.width, b.width);
        assert_eq!(a.height, b.height);
        for (pa, pb) in a.pixels.iter().zip(b.pixels.iter()) {
            assert_eq!(pa, pb);
        }
    }
}
