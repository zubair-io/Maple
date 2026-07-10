//! AMaZE stage 5 E: the ±45° diagonal R+B interpolation — `delp`/`delm`
//! gradients, `rbm`/`rbp` colour ratios with saturation bounding, the `pmwt`
//! diagonal weight, `rbint`, and the green re-interpolation where the
//! diagonal discriminates better than H/V. 1:1 port of the scalar branch of
//! `amaze_demosaic_RT.cc` (engine 1044–1388), operating on one tile.

use super::nyquist::rb_coset_start;
use super::scratch::{at, hf, median3, Scratch, Tile, TS};
use crate::image::CfaPattern;

const EPS: f32 = 1e-5;
const EPS_SQ: f32 = 1e-10;
const ARTHRESH: f32 = 0.75;
const CLIP_PT: f32 = 1.0;

// Gaussian on the 5×5 alt quincunx, sigma = 1.5 (engine 121).
const GAUSSEVEN: [f32; 2] = [0.137_194_94, 0.056_402_53];

pub(super) fn diagonal_refine(s: &mut Scratch, t: &Tile, pattern: CfaPattern) {
    let v1 = TS as isize;
    let p1 = -(TS as isize) + 1; // NE
    let p2 = -2 * (TS as isize) + 2;
    let m1 = TS as isize + 1; // SE
    let m2 = 2 * (TS as isize) + 2;

    // delp/delm + Dgrbsq1p/m (engine 1044–1060). Iterates the even-column
    // coset; in BOTH branches the diagonal gradients `delp`/`delm` are
    // sampled at the R/B site and the squared diagonal colour differences
    // `Dgrbsq1p/m` at the G site of the pair (the pre-#1887 port had them
    // swapped by one column on rows whose R/B site sits at odd columns).
    for rr in 6..t.rr1 - 6 {
        let even_is_rb = pattern.color_at(6, rr as u32) as usize & 1 == 0;
        for cc in (6..t.cc1 - 6).step_by(2) {
            let i = rr * TS + cc;
            if even_is_rb {
                s.delp[i >> 1] = (s.cfa[at(i, p1)] - s.cfa[at(i, -p1)]).abs();
                s.delm[i >> 1] = (s.cfa[at(i, m1)] - s.cfa[at(i, -m1)]).abs();
                s.dgrbsq1p[i >> 1] = (s.cfa[i + 1] - s.cfa[at(i + 1, -p1)]).powi(2)
                    + (s.cfa[i + 1] - s.cfa[at(i + 1, p1)]).powi(2);
                s.dgrbsq1m[i >> 1] = (s.cfa[i + 1] - s.cfa[at(i + 1, -m1)]).powi(2)
                    + (s.cfa[i + 1] - s.cfa[at(i + 1, m1)]).powi(2);
            } else {
                s.dgrbsq1p[i >> 1] =
                    (s.cfa[i] - s.cfa[at(i, -p1)]).powi(2) + (s.cfa[i] - s.cfa[at(i, p1)]).powi(2);
                s.dgrbsq1m[i >> 1] =
                    (s.cfa[i] - s.cfa[at(i, -m1)]).powi(2) + (s.cfa[i] - s.cfa[at(i, m1)]).powi(2);
                s.delp[i >> 1] = (s.cfa[at(i + 1, p1)] - s.cfa[at(i + 1, -p1)]).abs();
                s.delm[i >> 1] = (s.cfa[at(i + 1, m1)] - s.cfa[at(i + 1, -m1)]).abs();
            }
        }
    }

    // Diagonal colour ratios → rbm/rbp and the pmwt ±45° weight, with the
    // high-saturation bounding (engine 1139–1217).
    for rr in 8..t.rr1 - 8 {
        let cc0 = rb_coset_start(pattern, rr, 8);
        for cc in (cc0..t.cc1 - 8).step_by(2) {
            let i = rr * TS + cc;
            let cfi = s.cfa[i];

            let ratio_or_ha = |num_off: isize, far_off: isize| -> f32 {
                let cr = 2.0 * s.cfa[at(i, num_off)] / (EPS + cfi + s.cfa[at(i, far_off)]);
                if (1.0 - cr).abs() < ARTHRESH {
                    cfi * cr
                } else {
                    s.cfa[at(i, num_off)] + 0.5 * (cfi - s.cfa[at(i, far_off)])
                }
            };
            let rbse = ratio_or_ha(m1, m2);
            let rbnw = ratio_or_ha(-m1, -m2);
            let rbne = ratio_or_ha(p1, p2);
            let rbsw = ratio_or_ha(-p1, -p2);

            let wtse = EPS + s.delm[i >> 1] + s.delm[hf(i, m1)] + s.delm[hf(i, m2)];
            let wtnw = EPS + s.delm[i >> 1] + s.delm[hf(i, -m1)] + s.delm[hf(i, -m2)];
            let wtne = EPS + s.delp[i >> 1] + s.delp[hf(i, p1)] + s.delp[hf(i, p2)];
            let wtsw = EPS + s.delp[i >> 1] + s.delp[hf(i, -p1)] + s.delp[hf(i, -p2)];

            let mut rbm_v = (wtse * rbnw + wtnw * rbse) / (wtse + wtnw);
            let mut rbp_v = (wtne * rbsw + wtsw * rbne) / (wtne + wtsw);

            // pmwt: relative R−B variance in the ± diagonals (engine
            // 1184–1189).
            let rbvarm = EPS_SQ
                + GAUSSEVEN[0]
                    * (s.dgrbsq1m[hf(i, -v1)]
                        + s.dgrbsq1m[hf(i, -1)]
                        + s.dgrbsq1m[hf(i, 1)]
                        + s.dgrbsq1m[hf(i, v1)])
                + GAUSSEVEN[1]
                    * (s.dgrbsq1m[hf(i, -2 * v1 - 1)]
                        + s.dgrbsq1m[hf(i, -2 * v1 + 1)]
                        + s.dgrbsq1m[hf(i, -2 - v1)]
                        + s.dgrbsq1m[hf(i, 2 - v1)]
                        + s.dgrbsq1m[hf(i, -2 + v1)]
                        + s.dgrbsq1m[hf(i, 2 + v1)]
                        + s.dgrbsq1m[hf(i, 2 * v1 - 1)]
                        + s.dgrbsq1m[hf(i, 2 * v1 + 1)]);
            let rbvarp = GAUSSEVEN[0]
                * (s.dgrbsq1p[hf(i, -v1)]
                    + s.dgrbsq1p[hf(i, -1)]
                    + s.dgrbsq1p[hf(i, 1)]
                    + s.dgrbsq1p[hf(i, v1)])
                + GAUSSEVEN[1]
                    * (s.dgrbsq1p[hf(i, -2 * v1 - 1)]
                        + s.dgrbsq1p[hf(i, -2 * v1 + 1)]
                        + s.dgrbsq1p[hf(i, -2 - v1)]
                        + s.dgrbsq1p[hf(i, 2 - v1)]
                        + s.dgrbsq1p[hf(i, -2 + v1)]
                        + s.dgrbsq1p[hf(i, 2 + v1)]
                        + s.dgrbsq1p[hf(i, 2 * v1 - 1)]
                        + s.dgrbsq1p[hf(i, 2 * v1 + 1)]);
            s.pmwt[i >> 1] = rbvarm / (EPS_SQ + rbvarp + rbvarm);

            // Bound the interpolation in high-saturation regions
            // (engine 1193–1217).
            if rbp_v < cfi {
                if 2.0 * rbp_v < cfi {
                    rbp_v = median3(rbp_v, s.cfa[at(i, -p1)], s.cfa[at(i, p1)]);
                } else {
                    let pwt = 2.0 * (cfi - rbp_v) / (EPS + rbp_v + cfi);
                    rbp_v = pwt * rbp_v
                        + (1.0 - pwt) * median3(rbp_v, s.cfa[at(i, -p1)], s.cfa[at(i, p1)]);
                }
            }
            if rbm_v < cfi {
                if 2.0 * rbm_v < cfi {
                    rbm_v = median3(rbm_v, s.cfa[at(i, -m1)], s.cfa[at(i, m1)]);
                } else {
                    let mwt = 2.0 * (cfi - rbm_v) / (EPS + rbm_v + cfi);
                    rbm_v = mwt * rbm_v
                        + (1.0 - mwt) * median3(rbm_v, s.cfa[at(i, -m1)], s.cfa[at(i, m1)]);
                }
            }
            if rbp_v > CLIP_PT {
                rbp_v = median3(rbp_v, s.cfa[at(i, -p1)], s.cfa[at(i, p1)]);
            }
            if rbm_v > CLIP_PT {
                rbm_v = median3(rbm_v, s.cfa[at(i, -m1)], s.cfa[at(i, m1)]);
            }
            s.rbm[i >> 1] = rbm_v;
            s.rbp[i >> 1] = rbp_v;
        }
    }

    // rbint = interpolated R+B, blending the ± diagonals by the
    // neighbour-refined pmwt (engine 1241–1251).
    for rr in 10..t.rr1 - 10 {
        let cc0 = rb_coset_start(pattern, rr, 10);
        for cc in (cc0..t.cc1 - 10).step_by(2) {
            let i = rr * TS + cc;
            let pmwtalt = 0.25
                * (s.pmwt[hf(i, -m1)] + s.pmwt[hf(i, p1)] + s.pmwt[hf(i, -p1)] + s.pmwt[hf(i, m1)]);
            if (0.5 - s.pmwt[i >> 1]).abs() < (0.5 - pmwtalt).abs() {
                s.pmwt[i >> 1] = pmwtalt;
            }
            s.rbint[i >> 1] = 0.5
                * (s.cfa[i]
                    + s.rbm[i >> 1] * (1.0 - s.pmwt[i >> 1])
                    + s.rbp[i >> 1] * s.pmwt[i >> 1]);
        }
    }

    // Where the diagonal discriminates better than H/V, re-interpolate G
    // from the R+B values (engine 1312–1388).
    for rr in 12..t.rr1 - 12 {
        let cc0 = rb_coset_start(pattern, rr, 12);
        for cc in (cc0..t.cc1 - 12).step_by(2) {
            let i = rr * TS + cc;
            if (0.5 - s.pmwt[i >> 1]).abs() < (0.5 - s.hvwt[i >> 1]).abs() {
                continue;
            }

            // `cfa_off` is the immediate G neighbour (±v1 / ±1); `rb_off` the
            // next same-phase R/B site where `rbint` is defined — two
            // full-res steps away. Upstream addresses the latter with
            // half-res strides (`rbint[indx1 ± v1]`), which equal
            // `rbint[(i ± 2·v1) >> 1]` here.
            let g_ratio_or_ha = |cfa_off: isize, rb_off: isize| -> f32 {
                let cr =
                    s.cfa[at(i, cfa_off)] * 2.0 / (EPS + s.rbint[i >> 1] + s.rbint[hf(i, rb_off)]);
                if (1.0 - cr).abs() < ARTHRESH {
                    s.rbint[i >> 1] * cr
                } else {
                    s.cfa[at(i, cfa_off)] + 0.5 * (s.rbint[i >> 1] - s.rbint[hf(i, rb_off)])
                }
            };
            let gu = g_ratio_or_ha(-v1, -2 * v1);
            let gd = g_ratio_or_ha(v1, 2 * v1);
            let gl = g_ratio_or_ha(-1, -2);
            let gr = g_ratio_or_ha(1, 2);

            let mut gintv = (s.dirwts0[at(i, -v1)] * gd + s.dirwts0[at(i, v1)] * gu)
                / (s.dirwts0[at(i, v1)] + s.dirwts0[at(i, -v1)]);
            let mut ginth = (s.dirwts1[i - 1] * gr + s.dirwts1[i + 1] * gl)
                / (s.dirwts1[i - 1] + s.dirwts1[i + 1]);

            let rbi = s.rbint[i >> 1];
            if gintv < rbi {
                if 2.0 * gintv < rbi {
                    gintv = median3(gintv, s.cfa[at(i, -v1)], s.cfa[at(i, v1)]);
                } else {
                    let vwt = 2.0 * (rbi - gintv) / (EPS + gintv + rbi);
                    gintv = vwt * gintv
                        + (1.0 - vwt) * median3(gintv, s.cfa[at(i, -v1)], s.cfa[at(i, v1)]);
                }
            }
            if ginth < rbi {
                if 2.0 * ginth < rbi {
                    ginth = median3(ginth, s.cfa[i - 1], s.cfa[i + 1]);
                } else {
                    let hwt = 2.0 * (rbi - ginth) / (EPS + ginth + rbi);
                    ginth = hwt * ginth + (1.0 - hwt) * median3(ginth, s.cfa[i - 1], s.cfa[i + 1]);
                }
            }
            if ginth > CLIP_PT {
                ginth = median3(ginth, s.cfa[i - 1], s.cfa[i + 1]);
            }
            if gintv > CLIP_PT {
                gintv = median3(gintv, s.cfa[at(i, -v1)], s.cfa[at(i, v1)]);
            }
            s.rgbgreen[i] = ginth * (1.0 - s.hvwt[i >> 1]) + gintv * s.hvwt[i >> 1];
            s.dgrb0[i >> 1] = s.rgbgreen[i] - s.cfa[i];
        }
    }
}
