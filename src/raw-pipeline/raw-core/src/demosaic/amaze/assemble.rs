//! AMaZE stage 5 F–G: split the colour-difference field into G−R / G−B, the
//! `(1.325, −0.175, −0.075)` directional chroma sharpening, and the final
//! per-pixel assembly into the tile's slice of the output frame. 1:1 port of
//! the scalar branch of `amaze_demosaic_RT.cc` (engine 1396–1559).

use super::nyquist::rb_coset_start;
use super::scratch::{hf, red_phase, Scratch, Tile, TS};
use crate::image::CfaPattern;

const EPS: f32 = 1e-5;

/// Runs F + G and writes the tile interior `[16, rr1−16) × [16, cc1−16)`
/// into `band` — the caller's exclusive slice of output rows starting at
/// global row `top + 16` (so the band-local row is simply `rr − 16`).
pub(super) fn finish_tile(
    band: &mut [[f32; 3]],
    w: usize,
    s: &mut Scratch,
    t: &Tile,
    pattern: CfaPattern,
) {
    let v1 = TS as isize;
    let v2 = 2 * TS as isize;
    let p1 = -(TS as isize) + 1; // NE
    let p3 = -3 * (TS as isize) + 3;
    let m1 = TS as isize + 1; // SE
    let m3 = 3 * (TS as isize) + 3;
    let (ex, ey) = red_phase(pattern);

    // --- F1. Split out G−B from G−R (engine 1396–1400): every half-res cell
    // in the B-coset rows moves its value from dgrb0 to dgrb1. NB this
    // iterates *cells*, not sites.
    let mut rr = 13isize - ey as isize;
    while rr < t.rr1 as isize - 12 {
        let start = (rr as usize * TS + (13 - ex as usize)) >> 1;
        let end = (rr as usize * TS + (t.cc1 - 12)) >> 1;
        for k in start..end {
            s.dgrb1[k] = s.dgrb0[k];
            s.dgrb0[k] = 0.0;
        }
        rr += 2;
    }

    // --- F2. Directional sharpening that fills each row's *missing* chroma
    // field (engine 1426–1436): at an R site interpolate the absent G−B from
    // the B-row neighbours, at a B site the absent G−R from the R rows.
    for rr in 14..t.rr1 - 14 {
        let cc0 = rb_coset_start(pattern, rr, 14);
        for cc in (cc0..t.cc1 - 14).step_by(2) {
            let i = rr * TS + cc;
            let cidx = 1 - (pattern.color_at(cc as u32, rr as u32) as usize) / 2;
            let d: &[f32] = if cidx == 0 { &s.dgrb0 } else { &s.dgrb1 };

            let wtnw = 1.0
                / (EPS
                    + (d[hf(i, -m1)] - d[hf(i, m1)]).abs()
                    + (d[hf(i, -m1)] - d[hf(i, -m3)]).abs()
                    + (d[hf(i, m1)] - d[hf(i, -m3)]).abs());
            let wtne = 1.0
                / (EPS
                    + (d[hf(i, p1)] - d[hf(i, -p1)]).abs()
                    + (d[hf(i, p1)] - d[hf(i, p3)]).abs()
                    + (d[hf(i, -p1)] - d[hf(i, p3)]).abs());
            let wtsw = 1.0
                / (EPS
                    + (d[hf(i, -p1)] - d[hf(i, p1)]).abs()
                    + (d[hf(i, -p1)] - d[hf(i, m3)]).abs()
                    + (d[hf(i, p1)] - d[hf(i, -p3)]).abs());
            let wtse = 1.0
                / (EPS
                    + (d[hf(i, m1)] - d[hf(i, -m1)]).abs()
                    + (d[hf(i, m1)] - d[hf(i, -p3)]).abs()
                    + (d[hf(i, -m1)] - d[hf(i, m3)]).abs());

            let sharp = (wtnw
                * (1.325 * d[hf(i, -m1)]
                    - 0.175 * d[hf(i, -m3)]
                    - 0.075 * d[hf(i, -m1 - 2)]
                    - 0.075 * d[hf(i, -m1 - v2)])
                + wtne
                    * (1.325 * d[hf(i, p1)]
                        - 0.175 * d[hf(i, p3)]
                        - 0.075 * d[hf(i, p1 + 2)]
                        - 0.075 * d[hf(i, p1 + v2)])
                + wtsw
                    * (1.325 * d[hf(i, -p1)]
                        - 0.175 * d[hf(i, -p3)]
                        - 0.075 * d[hf(i, -p1 - 2)]
                        - 0.075 * d[hf(i, -p1 - v2)])
                + wtse
                    * (1.325 * d[hf(i, m1)]
                        - 0.175 * d[hf(i, m3)]
                        - 0.075 * d[hf(i, m1 + 2)]
                        - 0.075 * d[hf(i, m1 + v2)]))
                / (wtnw + wtne + wtsw + wtse);

            if cidx == 0 {
                s.dgrb0[i >> 1] = sharp;
            } else {
                s.dgrb1[i >> 1] = sharp;
            }
        }
    }

    // --- G. Final assembly (engine 1455–1559). R/B at a G site come from
    // the hvwt-weighted 4-cardinal Dgrb; at a chroma site the opposite
    // chroma comes directly from green − Dgrb.
    for rr in 16..t.rr1 - 16 {
        let band_row = (rr - 16) * w;
        for cc in 16..t.cc1 - 16 {
            let i = rr * TS + cc;
            let c = pattern.color_at(cc as u32, rr as u32) as usize;
            let g = s.rgbgreen[i];
            let mut px = [0.0_f32; 3];
            px[1] = g;

            if c == 1 {
                let temp = 1.0
                    / (s.hvwt[hf(i, -v1)] + 2.0 - s.hvwt[hf(i, 1)] - s.hvwt[hf(i, -1)]
                        + s.hvwt[hf(i, v1)]);
                let r = g
                    - (s.hvwt[hf(i, -v1)] * s.dgrb0[hf(i, -v1)]
                        + (1.0 - s.hvwt[hf(i, 1)]) * s.dgrb0[hf(i, 1)]
                        + (1.0 - s.hvwt[hf(i, -1)]) * s.dgrb0[hf(i, -1)]
                        + s.hvwt[hf(i, v1)] * s.dgrb0[hf(i, v1)])
                        * temp;
                let b = g
                    - (s.hvwt[hf(i, -v1)] * s.dgrb1[hf(i, -v1)]
                        + (1.0 - s.hvwt[hf(i, 1)]) * s.dgrb1[hf(i, 1)]
                        + (1.0 - s.hvwt[hf(i, -1)]) * s.dgrb1[hf(i, -1)]
                        + s.hvwt[hf(i, v1)] * s.dgrb1[hf(i, v1)])
                        * temp;
                px[0] = r.max(0.0);
                px[2] = b.max(0.0);
            } else {
                px[0] = (g - s.dgrb0[i >> 1]).max(0.0);
                px[2] = (g - s.dgrb1[i >> 1]).max(0.0);
                px[c] = s.cfa[i];
            }

            band[band_row + (t.left + cc as isize) as usize] = px;
        }
    }
}
