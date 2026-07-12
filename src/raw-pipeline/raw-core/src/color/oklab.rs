//! Oklab color space (Björn Ottosson, 2020). Perceptually uniform and
//! gamut-invariant for chroma adjustments (spec § 3.7).
//!
//! Oklab is defined against linear sRGB D65 (a fixed linear-sRGB → LMS
//! transform), so a color's Oklab coordinate is primaries-independent — every
//! working space reaches Oklab by first rotating into linear sRGB. This module
//! provides one entry per working space, all sharing D65:
//!
//! - **Rec.2020** (raw-core's native working space): route via
//!   `M_REC2020_TO_SRGB` — `rec2020_to_oklab` / `oklab_to_rec2020`.
//! - **linear sRGB** (post-encode-matrix, the view tail): no extra rotation —
//!   `srgb_linear_to_oklab` / `oklab_to_srgb_linear`.
//! - **linear Display P3** (the P3 target of the display-encode tail, #1921):
//!   rotate P3 ↔ sRGB with `M_SRGB_TO_P3` and its inverse around the sRGB
//!   transform — `p3_linear_to_oklab` / `oklab_to_p3_linear`. This lets the P3
//!   gamut compression test the P3 hull rather than the sRGB one.

use crate::{
    color::matrices::{M_REC2020_TO_SRGB, M_SRGB_TO_P3},
    math::{Matrix3, Vec3},
};

/// Ottosson's M1: linear sRGB → LMS. Published in his 2020 paper.
///
/// `pub` so the cross-language codegen (`codegen` crate, epic #925 P2 /
/// #990) can read it and emit the matching WGSL `const` for the GPU Oklab
/// kernels. The single source of truth stays here — the WGSL emitter never
/// re-types these numbers, it formats *this* constant. Widened from private
/// in #990; no math changed.
pub const M1_SRGB_TO_LMS: Matrix3 = Matrix3([
    [0.412_221_47, 0.536_332_54, 0.051_445_99],
    [0.211_903_50, 0.680_699_55, 0.107_396_96],
    [0.088_302_46, 0.281_718_84, 0.629_978_70],
]);

/// Ottosson's M2: cube-rooted LMS → Lab. Published in his 2020 paper.
///
/// `pub` for the same reason as [`M1_SRGB_TO_LMS`] — the codegen WGSL
/// emitter (#990) single-sources the Oklab matrices from these consts.
pub const M2_LMS_TO_LAB: Matrix3 = Matrix3([
    [0.210_454_26, 0.793_617_79, -0.004_072_05],
    [1.977_998_50, -2.428_592_21, 0.450_593_71],
    [0.025_904_04, 0.782_771_77, -0.808_675_77],
]);

/// Cached inverses of the three forward matrices. Each inverse is a pure
/// function of `const` data, so computing it once at first call and
/// handing out references after is bit-for-bit identical to calling
/// `Matrix3::inverse()` at every pixel — just 25 Mpx × 3 = 75 million
/// times faster on a 100 MP half-res render.
///
/// Tuple order matches the order they're consumed inside
/// `oklab_to_rec2020`: (M2⁻¹, M1⁻¹, M_REC2020_TO_SRGB⁻¹).
fn oklab_inverse_matrices() -> &'static (Matrix3, Matrix3, Matrix3) {
    static CELL: std::sync::OnceLock<(Matrix3, Matrix3, Matrix3)> = std::sync::OnceLock::new();
    CELL.get_or_init(|| {
        (
            M2_LMS_TO_LAB.inverse().expect("M2 is invertible"),
            M1_SRGB_TO_LMS.inverse().expect("M1 is invertible"),
            M_REC2020_TO_SRGB
                .inverse()
                .expect("M_REC2020_TO_SRGB is invertible"),
        )
    })
}

/// Scene-linear Rec.2020 D65 → Oklab.
/// Per-pixel cost: two 3×3 matrix multiplies + three cube roots.
/// This direction uses only forward (const) matrices — no inverse hoist
/// needed here; the reverse direction does the heavy lifting.
pub fn rec2020_to_oklab(rgb: Vec3) -> Vec3 {
    // Rec.2020 → sRGB → LMS.
    let srgb = M_REC2020_TO_SRGB.mul_vec(rgb);
    let lms = M1_SRGB_TO_LMS.mul_vec(srgb);
    // Cube root — preserves sign on negatives (cbrt of a negative is negative).
    let lms_cube = [lms[0].cbrt(), lms[1].cbrt(), lms[2].cbrt()];
    M2_LMS_TO_LAB.mul_vec(lms_cube)
}

/// Inverse of `rec2020_to_oklab`. Per-pixel cost: three 3×3 matrix
/// multiplies + three cubes. Inverse matrices are cached in a module-level
/// `OnceLock` — calling `Matrix3::inverse()` per pixel (as the previous
/// implementation did) was ~7.5 s on a 25 Mpx half-res image.
pub fn oklab_to_rec2020(lab: Vec3) -> Vec3 {
    let (m2_inv, m1_inv, m_srgb_to_rec2020) = oklab_inverse_matrices();
    let lms_cube = m2_inv.mul_vec(lab);
    // Cube (inverse of cbrt) — sign-preserving.
    let lms = [
        lms_cube[0] * lms_cube[0] * lms_cube[0],
        lms_cube[1] * lms_cube[1] * lms_cube[1],
        lms_cube[2] * lms_cube[2] * lms_cube[2],
    ];
    let srgb = m1_inv.mul_vec(lms);
    m_srgb_to_rec2020.mul_vec(srgb)
}

/// Linear sRGB D65 → Oklab. Use when the input is already in linear sRGB
/// (e.g. post-encode-matrix at the view-transform tail), so the inner
/// `M_REC2020_TO_SRGB` multiply that `rec2020_to_oklab` performs would
/// double-apply. Two 3×3 matrix multiplies + three cube roots per pixel.
pub fn srgb_linear_to_oklab(rgb: Vec3) -> Vec3 {
    let lms = M1_SRGB_TO_LMS.mul_vec(rgb);
    let lms_cube = [lms[0].cbrt(), lms[1].cbrt(), lms[2].cbrt()];
    M2_LMS_TO_LAB.mul_vec(lms_cube)
}

/// Inverse of `srgb_linear_to_oklab`. Lands in linear sRGB D65 — no
/// Rec.2020 step. Two cached inverse-matrix multiplies + three cubes.
pub fn oklab_to_srgb_linear(lab: Vec3) -> Vec3 {
    let (m2_inv, m1_inv, _m_srgb_to_rec2020) = oklab_inverse_matrices();
    let lms_cube = m2_inv.mul_vec(lab);
    let lms = [
        lms_cube[0] * lms_cube[0] * lms_cube[0],
        lms_cube[1] * lms_cube[1] * lms_cube[1],
        lms_cube[2] * lms_cube[2] * lms_cube[2],
    ];
    m1_inv.mul_vec(lms)
}

/// Cached inverse of `M_SRGB_TO_P3` (i.e. linear Display P3 → linear sRGB).
/// Same rationale as [`oklab_inverse_matrices`]: computing the inverse once
/// and handing out a reference is bit-for-bit identical to calling
/// `Matrix3::inverse()` per pixel but avoids the cost on the hot view-tail.
fn m_p3_to_srgb() -> &'static Matrix3 {
    static CELL: std::sync::OnceLock<Matrix3> = std::sync::OnceLock::new();
    CELL.get_or_init(|| M_SRGB_TO_P3.inverse().expect("M_SRGB_TO_P3 is invertible"))
}

/// Linear Display P3 D65 → Oklab. Use when the input is already in linear
/// Display P3 (the P3 target of the `display_encode` view-tail, #1921), so the
/// gamut compression can test the **P3** unit cube rather than the sRGB one.
///
/// Oklab itself is primaries-independent (it is defined via a fixed
/// linear-sRGB → LMS transform); representing a color's Oklab from a linear-P3
/// triple simply requires first rotating P3 → sRGB, then reusing the sRGB
/// LMS transform. So this is `srgb_linear_to_oklab(M_P3_TO_SRGB · rgb)`.
pub fn p3_linear_to_oklab(rgb: Vec3) -> Vec3 {
    srgb_linear_to_oklab(m_p3_to_srgb().mul_vec(rgb))
}

/// Inverse of [`p3_linear_to_oklab`]. Lands in linear Display P3 D65:
/// `M_SRGB_TO_P3 · oklab_to_srgb_linear(lab)`. Pairs with `p3_linear_to_oklab`
/// as a true round-trip on the neutral axis (both matrices map `[1,1,1]` to
/// `[1,1,1]`, so `R = G = B` in → `R = G = B` out within fp precision), which
/// is the precondition `compress_to_unit_cube_oklab` requires of its transform
/// pair.
pub fn oklab_to_p3_linear(lab: Vec3) -> Vec3 {
    M_SRGB_TO_P3.mul_vec(oklab_to_srgb_linear(lab))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn approx(a: Vec3, b: Vec3, eps: f32) -> bool {
        (a[0] - b[0]).abs() < eps && (a[1] - b[1]).abs() < eps && (a[2] - b[2]).abs() < eps
    }

    #[test]
    fn round_trip_preserves_neutral_gray() {
        let rgb = [0.18, 0.18, 0.18];
        let lab = rec2020_to_oklab(rgb);
        let back = oklab_to_rec2020(lab);
        assert!(
            approx(rgb, back, 1e-4),
            "round trip drifted: {:?} -> {:?}",
            rgb,
            back
        );
    }

    #[test]
    fn round_trip_preserves_saturated_red() {
        let rgb = [0.8, 0.1, 0.1];
        let lab = rec2020_to_oklab(rgb);
        let back = oklab_to_rec2020(lab);
        assert!(
            approx(rgb, back, 1e-4),
            "round trip drifted: {:?} -> {:?}",
            rgb,
            back
        );
    }

    #[test]
    fn round_trip_preserves_scene_headroom_values() {
        // Scene-linear values can exceed 1.0; Oklab must survive.
        let rgb = [5.0, 3.0, 1.5];
        let lab = rec2020_to_oklab(rgb);
        let back = oklab_to_rec2020(lab);
        assert!(
            approx(rgb, back, 1e-3),
            "round trip drifted: {:?} -> {:?}",
            rgb,
            back
        );
    }

    #[test]
    fn neutral_gray_has_zero_ab() {
        // Any R=G=B input should have no chroma in Oklab (a=b=0).
        let lab = rec2020_to_oklab([0.5, 0.5, 0.5]);
        assert!(lab[1].abs() < 1e-3, "a = {}", lab[1]);
        assert!(lab[2].abs() < 1e-3, "b = {}", lab[2]);
    }

    #[test]
    fn negative_inputs_do_not_produce_nan() {
        // Scene-referred values can be slightly negative (from DCP).
        let rgb = [-0.01, 0.1, 0.2];
        let lab = rec2020_to_oklab(rgb);
        for &c in &lab {
            assert!(c.is_finite(), "NaN in Oklab from negative input");
        }
    }

    #[test]
    fn srgb_linear_round_trip_preserves_neutral_gray() {
        let rgb = [0.18, 0.18, 0.18];
        let lab = srgb_linear_to_oklab(rgb);
        let back = oklab_to_srgb_linear(lab);
        assert!(
            approx(rgb, back, 1e-5),
            "srgb-linear round trip drifted: {:?} -> {:?}",
            rgb,
            back
        );
    }

    #[test]
    fn srgb_linear_round_trip_preserves_saturated_red() {
        let rgb = [0.9, 0.05, 0.05];
        let lab = srgb_linear_to_oklab(rgb);
        let back = oklab_to_srgb_linear(lab);
        assert!(
            approx(rgb, back, 1e-4),
            "srgb-linear round trip drifted: {:?} -> {:?}",
            rgb,
            back
        );
    }

    #[test]
    fn srgb_linear_neutral_axis_round_trips_bit_stable() {
        // Pre-condition for the encode-step gamut compression: in-gamut
        // neutrals must round-trip through Oklab without drifting off the
        // R=G=B axis. The bisection's "scale=1" branch passes through this
        // path, so any drift here would break byte-identity for in-gamut
        // input.
        for v in [0.0f32, 0.05, 0.18, 0.5, 0.9, 1.0] {
            let rgb = [v, v, v];
            let lab = srgb_linear_to_oklab(rgb);
            let back = oklab_to_srgb_linear(lab);
            assert!(
                (back[0] - back[1]).abs() < 1e-5,
                "neutral drift on G: {:?}",
                back
            );
            assert!(
                (back[1] - back[2]).abs() < 1e-5,
                "neutral drift on B: {:?}",
                back
            );
        }
    }

    #[test]
    fn srgb_linear_neutral_has_zero_ab() {
        // Any R=G=B input must land on the neutral Oklab axis (a=b=0).
        let lab = srgb_linear_to_oklab([0.5, 0.5, 0.5]);
        assert!(lab[1].abs() < 1e-3, "a = {}", lab[1]);
        assert!(lab[2].abs() < 1e-3, "b = {}", lab[2]);
    }

    #[test]
    fn p3_linear_round_trip_preserves_neutral_gray() {
        // Precondition for the P3-hull gamut compression (#1921): neutrals must
        // round-trip through Oklab in P3 working space without drifting off the
        // R=G=B axis. `compress_to_unit_cube_oklab` requires this of its pair.
        for v in [0.0f32, 0.05, 0.18, 0.5, 0.9, 1.0] {
            let rgb = [v, v, v];
            let lab = p3_linear_to_oklab(rgb);
            let back = oklab_to_p3_linear(lab);
            assert!(
                approx(rgb, back, 1e-4),
                "p3-linear neutral round trip drifted: {:?} -> {:?}",
                rgb,
                back
            );
            // Stays on the neutral axis.
            assert!((back[0] - back[1]).abs() < 1e-4, "neutral drift G: {back:?}");
            assert!((back[1] - back[2]).abs() < 1e-4, "neutral drift B: {back:?}");
        }
    }

    #[test]
    fn p3_linear_round_trip_preserves_saturated_color() {
        // A saturated in-P3-gamut triple must survive the Oklab round-trip.
        let rgb = [0.9f32, 0.05, 0.1];
        let lab = p3_linear_to_oklab(rgb);
        let back = oklab_to_p3_linear(lab);
        assert!(
            approx(rgb, back, 1e-4),
            "p3-linear saturated round trip drifted: {:?} -> {:?}",
            rgb,
            back
        );
    }

    #[test]
    fn p3_linear_and_srgb_linear_oklab_agree_on_the_same_absolute_color() {
        // Oklab is primaries-independent: a single absolute color expressed as
        // a linear-sRGB triple and as the matching linear-P3 triple must land
        // on the same Oklab coordinate. (This is what lets the P3 path reuse
        // the sRGB-defined Oklab helpers via a primary rotation.)
        use crate::color::matrices::M_SRGB_TO_P3;
        let srgb = [0.6f32, 0.3, 0.15];
        let p3 = M_SRGB_TO_P3.mul_vec(srgb);
        let lab_via_srgb = srgb_linear_to_oklab(srgb);
        let lab_via_p3 = p3_linear_to_oklab(p3);
        assert!(
            approx(lab_via_srgb, lab_via_p3, 1e-4),
            "Oklab differs by representation: sRGB->{:?} vs P3->{:?}",
            lab_via_srgb,
            lab_via_p3
        );
    }

    /// Lock down the matrix-inverse hoist: the cached inverses returned by
    /// `oklab_inverse_matrices()` must be bit-for-bit identical to what
    /// `Matrix3::inverse()` produces on the same const inputs. This is the
    /// only thing that guarantees the perf change is zero-parity-risk.
    #[test]
    fn cached_inverses_match_matrix3_inverse_bit_exact() {
        let (m2_inv, m1_inv, m_srgb_to_rec2020) = oklab_inverse_matrices();
        assert_eq!(
            *m2_inv,
            M2_LMS_TO_LAB.inverse().expect("M2 invertible"),
            "cached M2⁻¹ drifted from Matrix3::inverse(M2)"
        );
        assert_eq!(
            *m1_inv,
            M1_SRGB_TO_LMS.inverse().expect("M1 invertible"),
            "cached M1⁻¹ drifted from Matrix3::inverse(M1)"
        );
        assert_eq!(
            *m_srgb_to_rec2020,
            M_REC2020_TO_SRGB
                .inverse()
                .expect("M_REC2020_TO_SRGB invertible"),
            "cached M_REC2020_TO_SRGB⁻¹ drifted from Matrix3::inverse(…)"
        );
    }
}
