//! AMaZE stages 0.5–4: directional weights, Hamilton-Adams/adaptive-ratio
//! green interpolation with colour differences, variance-based selection,
//! median bounding, and the adaptive H/V direction weight. 1:1 port of the
//! scalar branch of `amaze_demosaic_RT.cc` (engine lines 368–784), operating
//! on one tile.

use super::scratch::{Scratch, Tile, TS};
use crate::image::CfaPattern;

const EPS: f32 = 1e-5;
const EPS_SQ: f32 = 1e-10;
const ARTHRESH: f32 = 0.75;
// 0.8 / initialGain; initialGain == 1.0 for the normalised [0, 1] data
// produced by `sensor_linearize`.
const CLIP_PT8: f32 = 0.8;
const CLIP_PT: f32 = 1.0;

/// Stage 0.5: `dirwts0` (vertical roughness), `dirwts1` (horizontal), and
/// `delhvsqsum` (sum of squared H/V first differences — the Nyquist test's
/// gradient term). Engine 368–377.
pub(super) fn compute_dirwts_delhv(s: &mut Scratch, t: &Tile) {
    for rr in 2..t.rr1 - 2 {
        for cc in 2..t.cc1 - 2 {
            let i = rr * TS + cc;
            let v = s.cfa[i];
            let delh = (s.cfa[i + 1] - s.cfa[i - 1]).abs();
            let delv = (s.cfa[i + TS] - s.cfa[i - TS]).abs();
            s.dirwts0[i] =
                EPS + (s.cfa[i + 2 * TS] - v).abs() + (v - s.cfa[i - 2 * TS]).abs() + delv;
            s.dirwts1[i] = EPS + (s.cfa[i + 2] - v).abs() + (v - s.cfa[i - 2]).abs() + delh;
            s.delhvsqsum[i] = delh * delh + delv * delv;
        }
    }
}

/// Stage 1: Hamilton-Adams green + dirwts-weighted colour differences
/// (engine 449–532). Runs at EVERY site — G sites too, with the sign
/// flipped, because stage 4's directional variances and stage 3's median
/// bounding read `vcd`/`hcd` at the green neighbours of each R/B site
/// (the #1561 port gap).
pub(super) fn interpolate_green_diffs(s: &mut Scratch, t: &Tile, pattern: CfaPattern) {
    for rr in 4..t.rr1 - 4 {
        for cc in 4..t.cc1 - 4 {
            let i = rr * TS + cc;
            let c = pattern.color_at(cc as u32, rr as u32) as usize;
            let cf = s.cfa[i];

            // Cardinal ratios from dirwts (engine 455–458).
            let cru = s.cfa[i - TS] * (s.dirwts0[i - 2 * TS] + s.dirwts0[i])
                / (s.dirwts0[i - 2 * TS] * (EPS + cf) + s.dirwts0[i] * (EPS + s.cfa[i - 2 * TS]));
            let crd = s.cfa[i + TS] * (s.dirwts0[i + 2 * TS] + s.dirwts0[i])
                / (s.dirwts0[i + 2 * TS] * (EPS + cf) + s.dirwts0[i] * (EPS + s.cfa[i + 2 * TS]));
            let crl = s.cfa[i - 1] * (s.dirwts1[i - 2] + s.dirwts1[i])
                / (s.dirwts1[i - 2] * (EPS + cf) + s.dirwts1[i] * (EPS + s.cfa[i - 2]));
            let crr = s.cfa[i + 1] * (s.dirwts1[i + 2] + s.dirwts1[i])
                / (s.dirwts1[i + 2] * (EPS + cf) + s.dirwts1[i] * (EPS + s.cfa[i + 2]));

            // Hamilton-Adams cardinal G estimates (engine 461–464).
            let guha = s.cfa[i - TS] + 0.5 * (cf - s.cfa[i - 2 * TS]);
            let gdha = s.cfa[i + TS] + 0.5 * (cf - s.cfa[i + 2 * TS]);
            let glha = s.cfa[i - 1] + 0.5 * (cf - s.cfa[i - 2]);
            let grha = s.cfa[i + 1] + 0.5 * (cf - s.cfa[i + 2]);

            // Adaptive-ratio cardinal G estimates (engine 469–491).
            let mut guar = if (1.0 - cru).abs() < ARTHRESH {
                cf * cru
            } else {
                guha
            };
            let mut gdar = if (1.0 - crd).abs() < ARTHRESH {
                cf * crd
            } else {
                gdha
            };
            let mut glar = if (1.0 - crl).abs() < ARTHRESH {
                cf * crl
            } else {
                glha
            };
            let mut grar = if (1.0 - crr).abs() < ARTHRESH {
                cf * crr
            } else {
                grha
            };

            // dirwts-weighted V/H blends (engine 494–499). The numerator on
            // the up-side (`dirwts0[N]`) means a strong gradient ABOVE
            // down-weights the up estimate.
            let hwt = s.dirwts1[i - 1] / (s.dirwts1[i - 1] + s.dirwts1[i + 1]);
            let vwt = s.dirwts0[i - TS] / (s.dirwts0[i + TS] + s.dirwts0[i - TS]);

            let g_int_v_ha = vwt * gdha + (1.0 - vwt) * guha;
            let g_int_h_ha = hwt * grha + (1.0 - hwt) * glha;

            // Sign convention: at R/B (c != 1) the colour difference is
            // G_est − cfa = G − chroma; at G sites it is negated so both
            // orientations store G − chroma consistently.
            let sign = if c == 1 { -1.0_f32 } else { 1.0_f32 };

            let vcd_main = sign * ((vwt * gdar + (1.0 - vwt) * guar) - cf);
            let hcd_main = sign * ((hwt * grar + (1.0 - hwt) * glar) - cf);
            let vcd_alt = sign * (g_int_v_ha - cf);
            let hcd_alt = sign * (g_int_h_ha - cf);

            let mut vcd_v = vcd_main;
            let mut hcd_v = hcd_main;

            // Highlight clip fallback (engine 517–525).
            if cf > CLIP_PT8 || g_int_v_ha > CLIP_PT8 || g_int_h_ha > CLIP_PT8 {
                guar = guha;
                gdar = gdha;
                glar = glha;
                grar = grha;
                vcd_v = vcd_alt;
                hcd_v = hcd_alt;
            }

            s.vcd[i] = vcd_v;
            s.hcd[i] = hcd_v;
            s.vcdalt[i] = vcd_alt;
            s.hcdalt[i] = hcd_alt;

            // Interpolation-fluctuation fields (engine 528–529), computed
            // after the clip override so the clipped guar/… are used.
            s.dgintv[i] = (guha - gdha).powi(2).min((guar - gdar).powi(2));
            s.dginth[i] = (glha - grha).powi(2).min((glar - grar).powi(2));
        }
    }
}

/// Stage 2: pick the smoother colour difference between vcd/vcdalt and
/// hcd/hcdalt via the cheap 3-sample variance (engine 601–609). Split from
/// stage 3 (upstream fuses them in-place; its SIMD branch already breaks
/// that sequential dependency, so the split is behaviour-equivalent).
pub(super) fn refine_by_variance(s: &mut Scratch, t: &Tile) {
    let var3 =
        |a: f32, b: f32, c: f32| -> f32 { 3.0 * (a * a + b * b + c * c) - (a + b + c).powi(2) };
    for rr in 4..t.rr1 - 4 {
        for cc in 4..t.cc1 - 4 {
            let i = rr * TS + cc;
            let hcd_var = var3(s.hcd[i - 2], s.hcd[i], s.hcd[i + 2]);
            let hcd_alt_var = var3(s.hcdalt[i - 2], s.hcdalt[i], s.hcdalt[i + 2]);
            if hcd_alt_var < hcd_var {
                s.hcd[i] = s.hcdalt[i];
            }
            let vcd_var = var3(s.vcd[i - 2 * TS], s.vcd[i], s.vcd[i + 2 * TS]);
            let vcd_alt_var = var3(s.vcdalt[i - 2 * TS], s.vcdalt[i], s.vcdalt[i + 2 * TS]);
            if vcd_alt_var < vcd_var {
                s.vcd[i] = s.vcdalt[i];
            }
        }
    }
}

/// Stage 3: median-bound the colour differences on saturated edges (engine
/// 619–682) and emit `cddiffsq = (vcd − hcd)²` at R/B sites (the Nyquist
/// texture term; every tap of the Nyquist gaussian lands on an R/B site, so
/// G cells are never read).
pub(super) fn median_bound(s: &mut Scratch, t: &Tile, pattern: CfaPattern) {
    use super::scratch::median3;
    for rr in 4..t.rr1 - 4 {
        for cc in 4..t.cc1 - 4 {
            let i = rr * TS + cc;
            let c = pattern.color_at(cc as u32, rr as u32) as usize;
            let v = s.cfa[i];
            if c != 1 {
                // R/B-site branch (engine 650+).
                let g_int_h = s.hcd[i] + v;
                let g_int_v = s.vcd[i] + v;
                if s.hcd[i] < 0.0 {
                    if 3.0 * s.hcd[i] < -(g_int_h + v) {
                        s.hcd[i] = median3(g_int_h, s.cfa[i - 1], s.cfa[i + 1]) - v;
                    } else {
                        let hwt = 1.0 + 3.0 * s.hcd[i] / (EPS + g_int_h + v);
                        s.hcd[i] = hwt * s.hcd[i]
                            + (1.0 - hwt) * (median3(g_int_h, s.cfa[i - 1], s.cfa[i + 1]) - v);
                    }
                }
                if s.vcd[i] < 0.0 {
                    if 3.0 * s.vcd[i] < -(g_int_v + v) {
                        s.vcd[i] = median3(g_int_v, s.cfa[i - TS], s.cfa[i + TS]) - v;
                    } else {
                        let vwt = 1.0 + 3.0 * s.vcd[i] / (EPS + g_int_v + v);
                        s.vcd[i] = vwt * s.vcd[i]
                            + (1.0 - vwt) * (median3(g_int_v, s.cfa[i - TS], s.cfa[i + TS]) - v);
                    }
                }
                if g_int_h > CLIP_PT {
                    s.hcd[i] = median3(g_int_h, s.cfa[i - 1], s.cfa[i + 1]) - v;
                }
                if g_int_v > CLIP_PT {
                    s.vcd[i] = median3(g_int_v, s.cfa[i - TS], s.cfa[i + TS]) - v;
                }
                s.cddiffsq[i] = (s.vcd[i] - s.hcd[i]).powi(2);
            } else {
                // G-site branch (engine 619–647).
                let g_int_h = -s.hcd[i] + v;
                let g_int_v = -s.vcd[i] + v;
                if s.hcd[i] > 0.0 {
                    if 3.0 * s.hcd[i] > (g_int_h + v) {
                        s.hcd[i] = -median3(g_int_h, s.cfa[i - 1], s.cfa[i + 1]) + v;
                    } else {
                        let hwt = 1.0 - 3.0 * s.hcd[i] / (EPS + g_int_h + v);
                        s.hcd[i] = hwt * s.hcd[i]
                            + (1.0 - hwt) * (-median3(g_int_h, s.cfa[i - 1], s.cfa[i + 1]) + v);
                    }
                }
                if s.vcd[i] > 0.0 {
                    if 3.0 * s.vcd[i] > (g_int_v + v) {
                        s.vcd[i] = -median3(g_int_v, s.cfa[i - TS], s.cfa[i + TS]) + v;
                    } else {
                        let vwt = 1.0 - 3.0 * s.vcd[i] / (EPS + g_int_v + v);
                        s.vcd[i] = vwt * s.vcd[i]
                            + (1.0 - vwt) * (-median3(g_int_v, s.cfa[i - TS], s.cfa[i + TS]) + v);
                    }
                }
                if g_int_h > CLIP_PT {
                    s.hcd[i] = -median3(g_int_h, s.cfa[i - 1], s.cfa[i + 1]) + v;
                }
                if g_int_v > CLIP_PT {
                    s.vcd[i] = -median3(g_int_v, s.cfa[i - TS], s.cfa[i + TS]) + v;
                }
            }
        }
    }
}

/// Stage 4: adaptive H/V direction weight per R/B site (engine 741–784).
/// `hvwt` is half-resolution (one cell per CFA pair); a larger value weights
/// the vertical colour difference more in `intp(hvwt, vcd, hcd)`.
pub(super) fn adaptive_hvwt(s: &mut Scratch, t: &Tile, pattern: CfaPattern) {
    let v1 = TS;
    let v2 = 2 * TS;
    let v3 = 3 * TS;
    for rr in 6..t.rr1 - 6 {
        // R/B coset of this row (engine `cc = 6 + (fc(rr, 2) & 1)`).
        let cc0 = 6 + (pattern.color_at(6, rr as u32) as usize & 1);
        for cc in (cc0..t.cc1 - 6).step_by(2) {
            let i = rr * TS + cc;

            // Colour-difference "variances" in the cardinal directions.
            // NB: `uave`… are 4-tap *sums* used verbatim as the centre the
            // squared deviations subtract from — 1:1 with engine 746–755.
            let uave = s.vcd[i] + s.vcd[i - v1] + s.vcd[i - v2] + s.vcd[i - v3];
            let dave = s.vcd[i] + s.vcd[i + v1] + s.vcd[i + v2] + s.vcd[i + v3];
            let lave = s.hcd[i] + s.hcd[i - 1] + s.hcd[i - 2] + s.hcd[i - 3];
            let rave = s.hcd[i] + s.hcd[i + 1] + s.hcd[i + 2] + s.hcd[i + 3];

            let dgrbvvaru = (s.vcd[i] - uave).powi(2)
                + (s.vcd[i - v1] - uave).powi(2)
                + (s.vcd[i - v2] - uave).powi(2)
                + (s.vcd[i - v3] - uave).powi(2);
            let dgrbvvard = (s.vcd[i] - dave).powi(2)
                + (s.vcd[i + v1] - dave).powi(2)
                + (s.vcd[i + v2] - dave).powi(2)
                + (s.vcd[i + v3] - dave).powi(2);
            let dgrbhvarl = (s.hcd[i] - lave).powi(2)
                + (s.hcd[i - 1] - lave).powi(2)
                + (s.hcd[i - 2] - lave).powi(2)
                + (s.hcd[i - 3] - lave).powi(2);
            let dgrbhvarr = (s.hcd[i] - rave).powi(2)
                + (s.hcd[i + 1] - rave).powi(2)
                + (s.hcd[i + 2] - rave).powi(2)
                + (s.hcd[i + 3] - rave).powi(2);

            let hwt = s.dirwts1[i - 1] / (s.dirwts1[i - 1] + s.dirwts1[i + 1]);
            let vwt = s.dirwts0[i - v1] / (s.dirwts0[i + v1] + s.dirwts0[i - v1]);

            let vcdvar = EPS_SQ + vwt * dgrbvvard + (1.0 - vwt) * dgrbvvaru;
            let hcdvar = EPS_SQ + hwt * dgrbhvarr + (1.0 - hwt) * dgrbhvarl;

            // Up/down and left/right interpolation fluctuations (engine
            // 764–770) — the centre tap is shared by both sums.
            let f_vvaru = s.dgintv[i] + s.dgintv[i - v1] + s.dgintv[i - v2];
            let f_vvard = s.dgintv[i] + s.dgintv[i + v1] + s.dgintv[i + v2];
            let f_hvarl = s.dginth[i] + s.dginth[i - 1] + s.dginth[i - 2];
            let f_hvarr = s.dginth[i] + s.dginth[i + 1] + s.dginth[i + 2];

            let vcdvar1 = EPS_SQ + vwt * f_vvard + (1.0 - vwt) * f_vvaru;
            let hcdvar1 = EPS_SQ + hwt * f_hvarr + (1.0 - hwt) * f_hvarl;

            let varwt = hcdvar / (vcdvar + hcdvar);
            let diffwt = hcdvar1 / (vcdvar1 + hcdvar1);

            // If both agree on direction, take the strongest discriminator;
            // otherwise the fluctuation weight (engine 778–782).
            s.hvwt[i >> 1] = if (0.5 - varwt) * (0.5 - diffwt) > 0.0
                && (0.5 - diffwt).abs() < (0.5 - varwt).abs()
            {
                varwt
            } else {
                diffwt
            };
        }
    }
}
