//! sRGB <-> CIELAB (D65) <-> CIELCh, for the colour ops sharp performs in a
//! perceptual space: `tint` (reduce to luminance, then look each grey up in
//! a Lab table whose a*/b* are the tint colour's own, weighted by
//! `1 - 4*(l - 0.5)^2` so the chroma peaks at mid-grey and vanishes at black
//! and white), `modulate` (scale L* and C*, rotate h) and `normalise`
//! (stretch L*).
//!
//! This is the one place in the raster surface that genuinely linearises: Lab
//! is defined on linear-light tristimulus values, so the sRGB EOTF
//! (`view::gamma::srgb_degamma`) runs on the way in and the OETF on the way
//! out. `gamma` and `linear` do NOT come through here — libvips applies both
//! to the encoded samples, and Maple matches it (see the plan's decision D3).
//!
//! The sRGB <-> XYZ matrices are COMPOSED from the constants raw-core already
//! single-sources in `color::matrices` (sRGB -> Rec.2020 -> XYZ D65) rather
//! than pasted in as a fresh literal, so there is exactly one definition of
//! the sRGB primaries in the crate.

use crate::color::matrices::{
    M_REC2020_TO_SRGB, M_REC2020_TO_XYZ_D65, M_SRGB_TO_REC2020, M_XYZ_D65_TO_REC2020,
};
use crate::math::Matrix3;
use crate::view::encode::{srgb_degamma, srgb_gamma};

/// Linear sRGB -> XYZ D65, composed from the two matrices raw-core already
/// single-sources. Cheap enough to build per call site (one 3x3 multiply);
/// the pixel loops hoist it out of the loop themselves.
pub fn srgb_to_xyz_d65() -> Matrix3 {
    M_REC2020_TO_XYZ_D65.mul_mat(&M_SRGB_TO_REC2020)
}

/// XYZ D65 -> linear sRGB.
pub fn xyz_d65_to_srgb() -> Matrix3 {
    M_REC2020_TO_SRGB.mul_mat(&M_XYZ_D65_TO_REC2020)
}

/// The reference white the composed sRGB -> XYZ matrix actually realises.
///
/// Deliberately NOT the rounded [`XYZ_D65`] literal. Composing the two f32
/// matrices raw-core single-sources lands white at `Y = 0.99998593`, 1.4e-5
/// low, and L* is defined RELATIVE to the working space's own reference
/// white — so dividing by the realised white is both self-consistent and
/// what makes white come out at exactly `L* = 100`, which is what libvips
/// gives (measured: its L* for code 255 is 100.000000, and 0 and 255 are the
/// only two codes whose L* sits within 1e-3 of an integer).
///
/// `normalise` depends on that exactness: its histogram bin is `trunc(L*)`,
/// so an L* of 99.99945 for white drops every white pixel a bin low and
/// shifts the whole stretch. The shift for every other colour is 1.4e-5
/// relative, far below an 8-bit code.
fn lab_white() -> [f32; 3] {
    srgb_to_xyz_d65().mul_vec([1.0, 1.0, 1.0])
}

/// CIE L* companding function, the cube-root with its linear toe.
fn lab_f(t: f32) -> f32 {
    const DELTA: f32 = 6.0 / 29.0;
    if t > DELTA * DELTA * DELTA {
        t.cbrt()
    } else {
        t / (3.0 * DELTA * DELTA) + 4.0 / 29.0
    }
}

fn lab_f_inv(t: f32) -> f32 {
    const DELTA: f32 = 6.0 / 29.0;
    if t > DELTA {
        t * t * t
    } else {
        3.0 * DELTA * DELTA * (t - 4.0 / 29.0)
    }
}

/// Encoded 8-bit sRGB -> CIELAB with a D65 reference white.
pub fn srgb_to_lab(rgb: [u8; 3]) -> [f32; 3] {
    let linear = [0, 1, 2].map(|i| srgb_degamma(rgb[i] as f32 / 255.0));
    let xyz = srgb_to_xyz_d65().mul_vec(linear);
    let white = lab_white();
    let f = [0, 1, 2].map(|i| lab_f(xyz[i] / white[i]));
    [
        116.0 * f[1] - 16.0,
        500.0 * (f[0] - f[1]),
        200.0 * (f[1] - f[2]),
    ]
}

/// CIELAB (D65) -> encoded 8-bit sRGB, clamped into gamut.
pub fn lab_to_srgb(lab: [f32; 3]) -> [u8; 3] {
    let fy = (lab[0] + 16.0) / 116.0;
    let fx = fy + lab[1] / 500.0;
    let fz = fy - lab[2] / 200.0;
    let white = lab_white();
    let xyz = [
        white[0] * lab_f_inv(fx),
        white[1] * lab_f_inv(fy),
        white[2] * lab_f_inv(fz),
    ];
    let linear = xyz_d65_to_srgb().mul_vec(xyz);
    [0, 1, 2].map(|i| (srgb_gamma(linear[i]) * 255.0).round().clamp(0.0, 255.0) as u8)
}

/// CIELAB -> CIELCh: chroma is the a*/b* magnitude, hue the angle in degrees.
pub fn lab_to_lch(lab: [f32; 3]) -> [f32; 3] {
    let chroma = (lab[1] * lab[1] + lab[2] * lab[2]).sqrt();
    let hue = lab[2].atan2(lab[1]).to_degrees().rem_euclid(360.0);
    [lab[0], chroma, hue]
}

/// CIELCh -> CIELAB. The hue wraps, so 370 and 10 are the same angle.
pub fn lch_to_lab(lch: [f32; 3]) -> [f32; 3] {
    let hue = lch[2].rem_euclid(360.0).to_radians();
    [lch[0], lch[1] * hue.cos(), lch[1] * hue.sin()]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: f32, b: f32, tol: f32) -> bool {
        (a - b).abs() <= tol
    }

    #[test]
    fn white_is_l_100_with_no_chroma() {
        let lab = srgb_to_lab([255, 255, 255]);
        assert!(close(lab[0], 100.0, 0.05), "L* was {}", lab[0]);
        assert!(
            close(lab[1], 0.0, 0.05) && close(lab[2], 0.0, 0.05),
            "{lab:?}"
        );
    }

    #[test]
    fn black_is_l_zero() {
        let lab = srgb_to_lab([0, 0, 0]);
        assert!(close(lab[0], 0.0, 0.01), "L* was {}", lab[0]);
    }

    #[test]
    fn mid_grey_matches_the_published_l_star() {
        // sRGB 128 -> L* ~ 53.6 (the canonical "middle grey is L*53.6" value).
        let lab = srgb_to_lab([128, 128, 128]);
        assert!(close(lab[0], 53.59, 0.2), "L* was {}", lab[0]);
    }

    #[test]
    fn pure_red_lands_on_its_published_lab_coordinates() {
        // sRGB #FF0000 is L* 53.24, a* 80.09, b* 67.20.
        let lab = srgb_to_lab([255, 0, 0]);
        assert!(close(lab[0], 53.24, 0.3), "L* {}", lab[0]);
        assert!(close(lab[1], 80.09, 0.5), "a* {}", lab[1]);
        assert!(close(lab[2], 67.20, 0.5), "b* {}", lab[2]);
    }

    #[test]
    fn lab_round_trips_every_channel_within_one_code_value() {
        for v in [0u8, 1, 17, 64, 128, 200, 254, 255] {
            for rgb in [[v, 0, 0], [0, v, 0], [0, 0, v], [v, v, v]] {
                let back = lab_to_srgb(srgb_to_lab(rgb));
                for c in 0..3 {
                    assert!(
                        (back[c] as i32 - rgb[c] as i32).abs() <= 1,
                        "{rgb:?} -> {back:?}"
                    );
                }
            }
        }
    }

    #[test]
    fn grey_round_trips_are_exact() {
        // Every 8-bit grey value round-trips with no rounding drift: R=G=B
        // collapses to a* = b* = 0 exactly (the matrix product of a scalar
        // times the reference white stays on the neutral axis to float
        // precision), so
        // the inverse companding recovers the same 8-bit code exactly.
        for v in 0u8..=255 {
            let back = lab_to_srgb(srgb_to_lab([v, v, v]));
            assert_eq!(back, [v, v, v], "grey {v} round-trip drifted to {back:?}");
        }
    }

    #[test]
    fn lch_is_the_polar_form_of_lab() {
        let lab = [50.0, 3.0, 4.0];
        let lch = lab_to_lch(lab);
        assert!(close(lch[1], 5.0, 1e-4), "C* was {}", lch[1]);
        assert!(close(lch[2], 53.130_1, 1e-2), "h was {}", lch[2]);
        let back = lch_to_lab(lch);
        assert!(
            close(back[1], 3.0, 1e-3) && close(back[2], 4.0, 1e-3),
            "{back:?}"
        );
    }

    #[test]
    fn hue_wraps_into_zero_to_three_sixty() {
        assert!(lab_to_lch([50.0, -1.0, -1.0])[2] > 180.0);
        assert!(close(
            lch_to_lab([50.0, 5.0, 370.0])[1],
            lch_to_lab([50.0, 5.0, 10.0])[1],
            1e-4
        ));
    }

    #[test]
    fn neutral_colour_has_hue_zero() {
        // a* = b* = 0 -> atan2(0, 0) = 0 by convention: neutral hue is 0.
        let lch = lab_to_lch([50.0, 0.0, 0.0]);
        assert_eq!(lch[2], 0.0, "{lch:?}");
    }
}
