//! AMaZE stage 5 A–D: the Nyquist texture mask, 13×13 area interpolation of
//! `hvwt` inside Nyquist regions, the green populate at R/B sites, and the
//! G-curvature Nyquist refinement. 1:1 port of the scalar branch of
//! `amaze_demosaic_RT.cc` (engine 836–1013), operating on one tile.

use super::scratch::{at, hf, Scratch, Tile, TS};
use crate::image::CfaPattern;

const EPS_SQ: f32 = 1e-10;

// Gaussian / threshold constants (engine 112–123).
const GAUSSODD: [f32; 4] = [0.146_597_28, 0.103_592_71, 0.073_203_61, 0.036_554_355];
const NYQTHRESH: f32 = 0.5;
const GAUSSGRAD: [f32; 6] = [
    NYQTHRESH * 0.073_844_12,
    NYQTHRESH * 0.062_075_12,
    NYQTHRESH * 0.052_181_82,
    NYQTHRESH * 0.036_874_194,
    NYQTHRESH * 0.030_997_323,
    NYQTHRESH * 0.018_413_194,
];
const GQUINC: [f32; 4] = [0.169_917, 0.108_947, 0.069_855, 0.028_718_2];

/// Row-coset start column: the first R/B site at or after `base` (which must
/// be even) on row `rr` — engine `base + (fc(rr, 2) & 1)`.
#[inline(always)]
pub(super) fn rb_coset_start(pattern: CfaPattern, rr: usize, base: usize) -> usize {
    base + (pattern.color_at(base as u32, rr as u32) as usize & 1)
}

/// Stages A–D. On return `rgbgreen` holds AMaZE green at every interior R/B
/// site, `dgrb0` the matching G − chroma field, and `hvwt` the (possibly
/// area-interpolated) direction weight.
pub(super) fn reconstruct_green(s: &mut Scratch, t: &Tile, pattern: CfaPattern) {
    let v1 = TS as isize;
    let v2 = 2 * TS as isize;
    let p1 = -(TS as isize) + 1; // NE
    let p2 = -2 * (TS as isize) + 2;
    let m1 = TS as isize + 1; // SE
    let m2 = 2 * (TS as isize) + 2;

    // --- A. Nyquist test (engine 836–890): texture vs gradient gaussians,
    // flag positives, and track the flagged bounding box.
    let mut nystartrow = 0usize;
    let mut nyendrow = 0usize;
    let mut nystartcol = TS + 1;
    let mut nyendcol = 0usize;
    let mut any_nyq = false;
    for rr in 6..t.rr1 - 6 {
        let cc0 = rb_coset_start(pattern, rr, 6);
        for cc in (cc0..t.cc1 - 6).step_by(2) {
            let i = rr * TS + cc;
            let tex = GAUSSODD[0] * s.cddiffsq[i]
                + GAUSSODD[1]
                    * (s.cddiffsq[at(i, -m1)]
                        + s.cddiffsq[at(i, p1)]
                        + s.cddiffsq[at(i, -p1)]
                        + s.cddiffsq[at(i, m1)])
                + GAUSSODD[2]
                    * (s.cddiffsq[at(i, -v2)]
                        + s.cddiffsq[at(i, -2)]
                        + s.cddiffsq[at(i, 2)]
                        + s.cddiffsq[at(i, v2)])
                + GAUSSODD[3]
                    * (s.cddiffsq[at(i, -m2)]
                        + s.cddiffsq[at(i, p2)]
                        + s.cddiffsq[at(i, -p2)]
                        + s.cddiffsq[at(i, m2)]);
            let grad = GAUSSGRAD[0] * s.delhvsqsum[i]
                + GAUSSGRAD[1]
                    * (s.delhvsqsum[at(i, -v1)]
                        + s.delhvsqsum[at(i, 1)]
                        + s.delhvsqsum[at(i, -1)]
                        + s.delhvsqsum[at(i, v1)])
                + GAUSSGRAD[2]
                    * (s.delhvsqsum[at(i, -m1)]
                        + s.delhvsqsum[at(i, p1)]
                        + s.delhvsqsum[at(i, -p1)]
                        + s.delhvsqsum[at(i, m1)])
                + GAUSSGRAD[3]
                    * (s.delhvsqsum[at(i, -v2)]
                        + s.delhvsqsum[at(i, -2)]
                        + s.delhvsqsum[at(i, 2)]
                        + s.delhvsqsum[at(i, v2)])
                + GAUSSGRAD[4]
                    * (s.delhvsqsum[at(i, -v2 - 1)]
                        + s.delhvsqsum[at(i, -v2 + 1)]
                        + s.delhvsqsum[at(i, -v1 - 2)]
                        + s.delhvsqsum[at(i, -v1 + 2)]
                        + s.delhvsqsum[at(i, v1 - 2)]
                        + s.delhvsqsum[at(i, v1 + 2)]
                        + s.delhvsqsum[at(i, v2 - 1)]
                        + s.delhvsqsum[at(i, v2 + 1)])
                + GAUSSGRAD[5]
                    * (s.delhvsqsum[at(i, -m2)]
                        + s.delhvsqsum[at(i, p2)]
                        + s.delhvsqsum[at(i, -p2)]
                        + s.delhvsqsum[at(i, m2)]);
            if tex - grad > 0.0 {
                s.nyquist[i >> 1] = 1;
                if !any_nyq {
                    nystartrow = rr;
                    any_nyq = true;
                }
                nyendrow = rr;
                nystartcol = nystartcol.min(cc);
                nyendcol = nyendcol.max(cc);
            }
        }
    }

    // Only treat the region as Nyquist texture if it is two-dimensional.
    let do_nyquist = any_nyq && nystartrow != nyendrow && nystartcol != nyendcol;
    if do_nyquist {
        nyendrow += 1;
        nyendcol += 1;
        nystartcol -= nystartcol & 1;
        nystartrow = nystartrow.max(8);
        nyendrow = nyendrow.min(t.rr1 - 8);
        nystartcol = nystartcol.max(8);
        nyendcol = nyendcol.min(t.cc1 - 8);

        // Dilate by majority of the 8 same-coset neighbours (engine 918–924).
        for rr in nystartrow..nyendrow {
            let cc0 = rb_coset_start(pattern, rr, nystartcol);
            for cc in (cc0..nyendcol).step_by(2) {
                let i = rr * TS + cc;
                let n = s.nyquist[hf(i, -v2)] as u32
                    + s.nyquist[hf(i, -m1)] as u32
                    + s.nyquist[hf(i, p1)] as u32
                    + s.nyquist[hf(i, -2)] as u32
                    + s.nyquist[hf(i, 2)] as u32
                    + s.nyquist[hf(i, -p1)] as u32
                    + s.nyquist[hf(i, m1)] as u32
                    + s.nyquist[hf(i, v2)] as u32;
                s.nyquist2[i >> 1] = match n {
                    0..=3 => 0,
                    4 => s.nyquist[i >> 1],
                    _ => 1,
                };
            }
        }

        // --- B. Area interpolation of hvwt in Nyquist regions (engine
        // 932–967): local H/V variance over the flagged 13×13 quincunx.
        for rr in nystartrow..nyendrow {
            let cc0 = rb_coset_start(pattern, rr, nystartcol);
            for cc in (cc0..nyendcol).step_by(2) {
                let i = rr * TS + cc;
                if s.nyquist2[i >> 1] == 0 {
                    continue;
                }
                let (mut sumcfa, mut sumh, mut sumv, mut sumsqh, mut sumsqv, mut areawt) =
                    (0.0_f32, 0.0_f32, 0.0_f32, 0.0_f32, 0.0_f32, 0.0_f32);
                let mut row_off = -6_isize;
                while row_off < 7 {
                    let mut i1 = at(i, row_off * v1 - 6);
                    let mut col_off = -6_isize;
                    while col_off < 7 {
                        if s.nyquist2[i1 >> 1] != 0 {
                            let cfatemp = s.cfa[i1];
                            sumcfa += cfatemp;
                            sumh += s.cfa[i1 - 1] + s.cfa[i1 + 1];
                            sumv += s.cfa[at(i1, -v1)] + s.cfa[at(i1, v1)];
                            sumsqh += (cfatemp - s.cfa[i1 - 1]).powi(2)
                                + (cfatemp - s.cfa[i1 + 1]).powi(2);
                            sumsqv += (cfatemp - s.cfa[at(i1, -v1)]).powi(2)
                                + (cfatemp - s.cfa[at(i1, v1)]).powi(2);
                            areawt += 1.0;
                        }
                        i1 += 2;
                        col_off += 2;
                    }
                    row_off += 2;
                }
                sumh = sumcfa - 0.5 * sumh;
                sumv = sumcfa - 0.5 * sumv;
                areawt *= 0.5;
                let hcdvar = EPS_SQ + (areawt * sumsqh - sumh * sumh).abs();
                let vcdvar = EPS_SQ + (areawt * sumsqv - sumv * sumv).abs();
                s.hvwt[i >> 1] = hcdvar / (vcdvar + hcdvar);
            }
        }
    }

    // --- C. Populate G at R/B sites (engine 972–988).
    for rr in 8..t.rr1 - 8 {
        let cc0 = rb_coset_start(pattern, rr, 8);
        for cc in (cc0..t.cc1 - 8).step_by(2) {
            let i = rr * TS + cc;
            // Prefer the diagonal-neighbour hvwt when it discriminates more
            // strongly than the local one.
            let hvwtalt = 0.25
                * (s.hvwt[hf(i, -m1)] + s.hvwt[hf(i, p1)] + s.hvwt[hf(i, -p1)] + s.hvwt[hf(i, m1)]);
            if (0.5 - s.hvwt[i >> 1]).abs() < (0.5 - hvwtalt).abs() {
                s.hvwt[i >> 1] = hvwtalt;
            }
            s.dgrb0[i >> 1] = s.hvwt[i >> 1] * s.vcd[i] + (1.0 - s.hvwt[i >> 1]) * s.hcd[i];
            s.rgbgreen[i] = s.cfa[i] + s.dgrb0[i >> 1];

            // Local G curvature² (prep for the Nyquist refinement step).
            if s.nyquist2[i >> 1] != 0 {
                s.dgrb2h[i >> 1] =
                    (s.rgbgreen[i] - 0.5 * (s.rgbgreen[i - 1] + s.rgbgreen[i + 1])).powi(2);
                s.dgrb2v[i >> 1] = (s.rgbgreen[i]
                    - 0.5 * (s.rgbgreen[at(i, -v1)] + s.rgbgreen[at(i, v1)]))
                .powi(2);
            }
        }
    }

    // --- D. Refine Nyquist areas using the G curvatures (engine 994–1013).
    if do_nyquist {
        for rr in nystartrow..nyendrow {
            let cc0 = rb_coset_start(pattern, rr, nystartcol);
            for cc in (cc0..nyendcol).step_by(2) {
                let i = rr * TS + cc;
                if s.nyquist2[i >> 1] == 0 {
                    continue;
                }
                let gvarh = EPS_SQ
                    + GQUINC[0] * s.dgrb2h[i >> 1]
                    + GQUINC[1]
                        * (s.dgrb2h[hf(i, -m1)]
                            + s.dgrb2h[hf(i, p1)]
                            + s.dgrb2h[hf(i, -p1)]
                            + s.dgrb2h[hf(i, m1)])
                    + GQUINC[2]
                        * (s.dgrb2h[hf(i, -v2)]
                            + s.dgrb2h[hf(i, -2)]
                            + s.dgrb2h[hf(i, 2)]
                            + s.dgrb2h[hf(i, v2)])
                    + GQUINC[3]
                        * (s.dgrb2h[hf(i, -m2)]
                            + s.dgrb2h[hf(i, p2)]
                            + s.dgrb2h[hf(i, -p2)]
                            + s.dgrb2h[hf(i, m2)]);
                let gvarv = EPS_SQ
                    + GQUINC[0] * s.dgrb2v[i >> 1]
                    + GQUINC[1]
                        * (s.dgrb2v[hf(i, -m1)]
                            + s.dgrb2v[hf(i, p1)]
                            + s.dgrb2v[hf(i, -p1)]
                            + s.dgrb2v[hf(i, m1)])
                    + GQUINC[2]
                        * (s.dgrb2v[hf(i, -v2)]
                            + s.dgrb2v[hf(i, -2)]
                            + s.dgrb2v[hf(i, 2)]
                            + s.dgrb2v[hf(i, v2)])
                    + GQUINC[3]
                        * (s.dgrb2v[hf(i, -m2)]
                            + s.dgrb2v[hf(i, p2)]
                            + s.dgrb2v[hf(i, -p2)]
                            + s.dgrb2v[hf(i, m2)]);
                s.dgrb0[i >> 1] = (s.hcd[i] * gvarv + s.vcd[i] * gvarh) / (gvarv + gvarh);
                s.rgbgreen[i] = s.cfa[i] + s.dgrb0[i >> 1];
            }
        }
    }
}
