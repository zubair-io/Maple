use crate::{
    color::matrices::{CAT16, M_REC2020_TO_XYZ_D65, M_XYZ_D65_TO_REC2020, XYZ_D65},
    image::{ColorSpace, Image},
    math::{Matrix3, Vec3},
    types::WbMethod,
};
use std::sync::OnceLock;

/// Re-export the auto-WB estimators that live in the sibling
/// `white_balance_auto` module so existing call sites at
/// `crate::stages::white_balance::*` keep compiling unchanged.
pub use super::white_balance_auto::{estimate_cct_from_neutral, neutral_to_temp_tint};

/// Cached inverse of the constant CAT16 cone-response matrix.
///
/// `wb_cat16_matrix()` runs once per tile in the refine-stage pipeline.
/// `Matrix3::inverse()` is a determinant + cofactor solve; caching it
/// behind an `OnceLock` (same pattern as `color::oklab::cells()` and
/// `color::profile_loader::PROFILE_TABLE`) keeps the hot path to a
/// matrix-matrix multiply chain. The inverse is well-defined because
/// CAT16 is non-singular by construction.
static CAT16_INVERSE: OnceLock<Matrix3> = OnceLock::new();

fn cat16_inverse() -> &'static Matrix3 {
    CAT16_INVERSE.get_or_init(|| CAT16.inverse().expect("CAT16 is non-singular"))
}

/// CCT (Kelvin) → CIE xy chromaticity on the **Planckian (blackbody) locus**
/// via Hernández-Andrés et al. 1999, "Calculating correlated color
/// temperatures across the entire gamut of daylight and skylight
/// chromaticities" (Applied Optics 38(27), 5703–5709).
///
/// Valid range: 1667K – 25000K. Clamped to [2000K, 25000K] here because
/// (a) the reference renderer's slider exposes 2000K–50000K and (b) the polynomial is
/// not defined above 25000K — clamping the upper bound matches what
/// the reference renderer appears to do internally.
///
/// Earlier versions of this function used the Krystek 1985 D-illuminant
/// polynomial. That fits the daylight locus (~4000K–25000K) and
/// extrapolates poorly at the warm end: at 2000K it under-cooled
/// vs the reference renderer's slider. The slider-visual-matrix harness on test_0002
/// surfaced the magnitude error after the direction fix landed.
pub fn cct_to_xy(cct: f32) -> (f32, f32) {
    let t = cct.clamp(2000.0, 25000.0);
    let x = if t <= 4000.0 {
        0.179_910 + 0.877_695_6e3 / t - 0.234_358_9e6 / (t * t) - 0.266_123_9e9 / (t * t * t)
    } else {
        0.240_390 + 0.222_634_7e3 / t + 2.107_037_9e6 / (t * t) - 3.025_846_9e9 / (t * t * t)
    };
    let y = -3.000 * x * x + 2.870 * x - 0.275;
    (x, y)
}

pub fn xy_to_xyz(x: f32, y: f32, big_y: f32) -> Vec3 {
    let big_x = (x / y) * big_y;
    let big_z = ((1.0 - x - y) / y) * big_y;
    [big_x, big_y, big_z]
}

/// Compute per-channel gains in linear Rec.2020 for a SOURCE-LIGHT
/// (temperature, tint). Tint in [-100, 100] with 0.001 per-unit scaling
/// (spec § 3.5).
///
/// The reference renderer's convention: the temperature slider value is the COLOR TEMPERATURE
/// OF THE LIGHT THE PHOTO WAS TAKEN UNDER. To render the scene as
/// neutral D65 we apply the INVERSE of the source-light chromaticity:
///   gain = D65_rec2020 / source_rec2020
///
/// At source = 2000K (tungsten), `source_rec2020` has high R and low B,
/// so `gain = D65/source` gives low R and high B — cooling the image,
/// which is the correct reference-renderer direction for "compensate warm tungsten".
///
/// The previous code computed `target / D65` which made warm-CCT
/// sliders WARM the image (the opposite of the reference renderer). The slider-visual-
/// matrix harness on test_0002 surfaced this immediately:
/// temperature_min (2000K) rendered red/magenta on Maple where the reference renderer
/// produced blue. Fix flipped the ratio direction.
pub fn wb_gains(temperature: f32, tint: f32) -> Vec3 {
    // The reference renderer's tint semantics differ from temperature: the slider VALUE is the
    // image-direction shift the user wants (positive = add green, negative
    // = add magenta), NOT the source-light direction. To produce that
    // image shift via a "source / D65" gain, the source must be in the
    // OPPOSITE chromaticity direction. Subtract (rather than add) tint
    // from y so positive tint moves source DOWN (toward magenta) → gain
    // = D65/source pushes image UP (toward green) → image gets greener.
    // Matches the reference renderer's "drag right = greener" UI affordance.
    let (x, mut y) = cct_to_xy(temperature);
    y -= tint * 0.001;
    let xyz_source = xy_to_xyz(x, y, 1.0);
    let source_rec2020 = M_XYZ_D65_TO_REC2020.mul_vec(xyz_source);
    let d65_rec2020 = M_XYZ_D65_TO_REC2020.mul_vec(XYZ_D65);
    let gain = [
        d65_rec2020[0] / source_rec2020[0],
        d65_rec2020[1] / source_rec2020[1],
        d65_rec2020[2] / source_rec2020[2],
    ];
    // Normalize so green = 1.
    let g = gain[1].max(1e-6);
    [gain[0] / g, 1.0, gain[2] / g]
}

/// Compute the linear-Rec.2020 → linear-Rec.2020 chromatic-adaptation
/// matrix for a SOURCE-LIGHT (temperature, tint) using CAT16 (ticket #431).
///
/// Reference: Li, Ronnier, Pointer, Hellwig, Melgosa, Cui (2017),
/// "Comprehensive color solutions: CAM16, CAT16, and CAM16-UCS",
/// *Color Research & Application*, 42(6): 703–718. CAT16 is Darktable's
/// modern default for chromatic adaptation in
/// `iop/channelmixerrgb.c` and replaces the older Bradford/CAT02
/// transforms.
///
/// The matrix is:
///
/// ```text
///   M = M_xyz_to_rec2020 · CAT16⁻¹ · diag(LMS_dst / LMS_src) · CAT16 · M_rec2020_to_xyz
/// ```
///
/// where `LMS_src = CAT16 · xyz_source(T, tint)` and
/// `LMS_dst = CAT16 · D65_XYZ`. The matrix maps the configured
/// `(temperature, tint)` source whitepoint to D65 in linear Rec.2020.
/// A neutral patch under the configured source whitepoint becomes
/// D65-neutral after adaptation; a neutral patch under a different
/// illuminant will shift in proportion to the `(CCT, tint)` delta —
/// that's the whole point of chromatic adaptation, and exactly what
/// the CAT16 unit tests below assert.
///
/// **Tint sign convention.** The reference renderer treats tint+ as
/// "magenta image / green light", tint- as "green image / magenta
/// light". To produce a magenta IMAGE shift via this chromatic
/// adaptation, the source must be GREENER (higher y). So `tint > 0`
/// moves source `y` UP — the OPPOSITE of the legacy diagonal-gain path
/// in `wb_gains` (which historically subtracted tint from y). The
/// closed-form `tint_plus_pushes_magenta` predictor in
/// `tests/grey_adjustments.rs` is the contract; the corresponding
/// diagonal-path unit tests below are flipped to match.
pub fn wb_cat16_matrix(temperature: f32, tint: f32) -> Matrix3 {
    let (x, mut y) = cct_to_xy(temperature);
    // tint > 0 = magenta image = greener source = y goes UP.
    y += tint * 0.001;
    let xyz_source = xy_to_xyz(x, y, 1.0);
    let lms_src = CAT16.mul_vec(xyz_source);
    let lms_dst = CAT16.mul_vec(XYZ_D65);
    let scale = Matrix3([
        [lms_dst[0] / lms_src[0].max(1e-6), 0.0, 0.0],
        [0.0, lms_dst[1] / lms_src[1].max(1e-6), 0.0],
        [0.0, 0.0, lms_dst[2] / lms_src[2].max(1e-6)],
    ]);
    let cat16_inv = cat16_inverse();
    // Compose right-to-left: Rec2020 → XYZ → LMS → scale → XYZ → Rec2020.
    M_XYZ_D65_TO_REC2020
        .mul_mat(cat16_inv)
        .mul_mat(&scale)
        .mul_mat(&CAT16)
        .mul_mat(&M_REC2020_TO_XYZ_D65)
}

fn apply_matrix_inplace(img: &mut Image, m: &Matrix3) {
    for p in &mut img.pixels {
        let out = m.mul_vec(*p);
        *p = out;
    }
}

pub fn apply(img: &mut Image, temperature: f32, tint: f32, method: WbMethod) {
    img.assert_space(ColorSpace::SceneLinearRec2020);
    if (temperature - 6500.0).abs() < 0.5 && tint.abs() < 0.5 {
        return; // identity short-circuit
    }
    match method {
        WbMethod::Cat16 => {
            let m = wb_cat16_matrix(temperature, tint);
            apply_matrix_inplace(img, &m);
        }
        WbMethod::DiagonalRec2020 => {
            let g = wb_gains(temperature, tint);
            for p in &mut img.pixels {
                p[0] *= g[0];
                p[1] *= g[1];
                p[2] *= g[2];
            }
        }
    }
}

/// DNG-spec WB pre-gain in camera-native linear RGB space (DNG 1.4 § 1.4.4.5
/// step 4): divide each channel by `AsShotNeutral` so a neutral scene patch
/// reads as `(1, 1, 1)` going into DCP. Identity short-circuit when neutral
/// is already `(1, 1, 1)` (e.g. wb-baked LinearRaw paths after
/// `linearize::linearraw_to_camera_rgb` undid the bake).
///
/// This is the canonical pre-DCP white-balance step. After this call, the
/// downstream DCP path MUST run with `wb_already_baked=true` so the
/// scene_white_xyz derivation uses `inv(CM) · (1, 1, 1)` instead of
/// `inv(CM) · AsShotNeutral` (otherwise it double-applies WB).
///
/// Per spec, AsShotNeutral has G normalized to 1.0, so dividing by it gives
/// gain = (1/n_r, 1.0, 1/n_b). For typical daylight `AsShotNeutral ≈
/// [0.5, 1.0, 0.7]`, the R and B channels get amplified ~2× and ~1.4×
/// respectively — same shape as the WB multipliers rawler exposes via
/// `wb_coeffs` (rawler reports the reciprocals).
pub fn apply_pre_gain(img: &mut Image, neutral: [f32; 3]) {
    img.assert_space(ColorSpace::CameraNativeLinearRgb);
    let n = neutral;
    if (n[0] - 1.0).abs() < 1e-4 && (n[1] - 1.0).abs() < 1e-4 && (n[2] - 1.0).abs() < 1e-4 {
        return; // identity short-circuit (neutral patch already reads (1,1,1))
    }
    // Clamp denominators away from zero — a degenerate AsShotNeutral
    // shouldn't crash decode.
    let g = [
        if n[0].abs() > 1e-6 { 1.0 / n[0] } else { 1.0 },
        if n[1].abs() > 1e-6 { 1.0 / n[1] } else { 1.0 },
        if n[2].abs() > 1e-6 { 1.0 / n[2] } else { 1.0 },
    ];
    for p in &mut img.pixels {
        p[0] *= g[0];
        p[1] *= g[1];
        p[2] *= g[2];
    }
}

/// Apply only the **delta** between the live WB and the WB the cached
/// decode was rendered at. Mirrors the (now-retired) Apple
/// `WhiteBalance.metal` kernel — net gain =
/// `wb_gains(live) / wb_gains(decoded)`, identity short-circuit when
/// `live == decoded`.
///
/// Used by the per-tick FFI entry (`apply_scene_linear_chain`) so the
/// Apple side can hand us a buffer that was decoded at one WB and have
/// us apply the slider's delta on top, without double-counting the
/// decoded WB. When the caller passes `decoded == 6500/0`, the
/// `g_decoded` term is the identity gain and the ratio collapses to
/// `g_live` — equivalent to calling `apply(img, live_temp, live_tint)`
/// directly.
pub fn apply_delta(
    img: &mut Image,
    live_temp: f32,
    live_tint: f32,
    decoded_temp: f32,
    decoded_tint: f32,
    method: WbMethod,
) {
    img.assert_space(ColorSpace::SceneLinearRec2020);
    if (live_temp - decoded_temp).abs() < 0.5 && (live_tint - decoded_tint).abs() < 0.5 {
        return; // identity short-circuit when live == decoded
    }
    match method {
        WbMethod::Cat16 => {
            // Net = M_live · M_decoded⁻¹. One matmul per pixel,
            // identical to applying M_live to a buffer that already
            // had M_decoded applied to it from the neutral starting
            // point.
            let m_live = wb_cat16_matrix(live_temp, live_tint);
            let m_decoded = wb_cat16_matrix(decoded_temp, decoded_tint);
            let m_decoded_inv = m_decoded
                .inverse()
                .expect("CAT16 user-WB matrix is non-singular for valid (T, tint)");
            let m_net = m_live.mul_mat(&m_decoded_inv);
            apply_matrix_inplace(img, &m_net);
        }
        WbMethod::DiagonalRec2020 => {
            let g_live = wb_gains(live_temp, live_tint);
            let g_decoded = wb_gains(decoded_temp, decoded_tint);
            let ratio = [
                g_live[0] / g_decoded[0].max(1e-6),
                g_live[1] / g_decoded[1].max(1e-6),
                g_live[2] / g_decoded[2].max(1e-6),
            ];
            for p in &mut img.pixels {
                p[0] *= ratio[0];
                p[1] *= ratio[1];
                p[2] *= ratio[2];
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn d65_reference_at_6500k_tint_0() {
        let gains = wb_gains(6500.0, 0.0);
        // Gains should be close to (1, 1, 1) at the pipeline's native white.
        assert!((gains[0] - 1.0).abs() < 0.05, "R gain {}", gains[0]);
        assert!((gains[1] - 1.0).abs() < 1e-6, "G gain {}", gains[1]);
        assert!((gains[2] - 1.0).abs() < 0.05, "B gain {}", gains[2]);
    }

    #[test]
    fn warm_source_cools_image() {
        // The reference renderer's convention: temp slider value = source-light CCT. A warm
        // source (3000K, tungsten) means we apply COOLING to compensate
        // — gain[R] < 1, gain[B] > 1. Reversed in the previous version.
        let gains = wb_gains(3000.0, 0.0);
        assert!(
            gains[0] < 0.85,
            "R should cut to cool a warm-source scene, got {}",
            gains[0]
        );
        assert!(
            gains[2] > 1.20,
            "B should boost to cool a warm-source scene, got {}",
            gains[2]
        );
    }

    #[test]
    fn cool_source_warms_image() {
        // Cool source (10000K, overcast) → apply WARMING to compensate.
        let gains = wb_gains(10000.0, 0.0);
        assert!(
            gains[2] < 0.95,
            "B should cut to warm a cool-source scene, got {}",
            gains[2]
        );
        assert!(
            gains[0] > 1.05,
            "R should boost to warm a cool-source scene, got {}",
            gains[0]
        );
    }

    #[test]
    fn default_is_identity_on_image() {
        let mut img = Image::new(2, 2, ColorSpace::SceneLinearRec2020);
        for p in &mut img.pixels {
            *p = [0.3, 0.4, 0.5];
        }
        apply(&mut img, 6500.0, 0.0, WbMethod::Cat16);
        for p in &img.pixels {
            assert_eq!(p, &[0.3, 0.4, 0.5]);
        }
    }

    #[test]
    fn non_default_mutates_pixels() {
        // Warm source = 3000K → cooling correction → R cut, B boost.
        let mut img = Image::new(2, 2, ColorSpace::SceneLinearRec2020);
        for p in &mut img.pixels {
            *p = [0.3, 0.3, 0.3];
        }
        apply(&mut img, 3000.0, 0.0, WbMethod::DiagonalRec2020);
        for p in &img.pixels {
            assert!(
                p[0] < 0.3,
                "R should cut for warm-source cooling, got {}",
                p[0]
            );
            assert!(
                p[2] > 0.3,
                "B should boost for warm-source cooling, got {}",
                p[2]
            );
        }
    }

    #[test]
    fn legacy_diagonal_negative_tint_adds_magenta() {
        // Legacy `DiagonalRec2020` path: tint sign was inverted vs the
        // reference renderer, so tint=-100 produces a magenta image.
        // The CAT16 default flips this — see `cat16_tint_plus_adds_magenta`
        // below for the corrected convention.
        let mut img = Image::new(2, 2, ColorSpace::SceneLinearRec2020);
        for p in &mut img.pixels {
            *p = [0.3, 0.3, 0.3];
        }
        apply(&mut img, 6500.0, -100.0, WbMethod::DiagonalRec2020);
        for p in &img.pixels {
            assert!(
                p[0] > p[1],
                "R should exceed G for legacy-diagonal magenta tint, got R={} G={}",
                p[0],
                p[1]
            );
            assert!(
                p[2] > p[1],
                "B should exceed G for legacy-diagonal magenta tint, got B={} G={}",
                p[2],
                p[1]
            );
        }
    }

    #[test]
    fn extreme_warm_2000k_cools_strongly() {
        // The reference renderer exposes 2000K at the cool end of the Temperature slider.
        // Krystek's daylight polynomial under-cools at 2000K vs the reference renderer;
        // Hernández-Andrés's Planckian polynomial cools much harder
        // (R drops to ~0.41, B rises to ~5.34 at 2000K).
        let gains = wb_gains(2000.0, 0.0);
        assert!(
            gains[0] < 0.6,
            "R should fall below 0.6 to deeply cool a 2000K source, got {}",
            gains[0]
        );
        assert!(
            gains[2] > 3.0,
            "B should exceed 3.0 to deeply cool a 2000K source, got {}",
            gains[2]
        );
    }

    #[test]
    fn extreme_cool_50000k_warms_strongly() {
        // The reference renderer exposes 50000K at the warm end of the Temperature slider.
        // Hernández-Andrés is defined only to 25000K, so the polynomial
        // clamps above that — matches the reference renderer's apparent behaviour. At the
        // 25000K clamp R~1.18 (warming) and B~0.57 (cool-source kill).
        let gains = wb_gains(50000.0, 0.0);
        assert!(
            gains[0] > 1.15,
            "R should boost above 1.15 to warm a 50000K (clamped 25000K) source, got {}",
            gains[0]
        );
        assert!(
            gains[2] < 0.6,
            "B should fall below 0.6 to warm a 50000K source, got {}",
            gains[2]
        );
    }

    #[test]
    fn legacy_diagonal_positive_tint_adds_green() {
        // Legacy `DiagonalRec2020` path: tint+100 (sign-inverted vs the
        // reference renderer) drops R and B below G, producing a green image.
        let mut img = Image::new(2, 2, ColorSpace::SceneLinearRec2020);
        for p in &mut img.pixels {
            *p = [0.3, 0.3, 0.3];
        }
        apply(&mut img, 6500.0, 100.0, WbMethod::DiagonalRec2020);
        for p in &img.pixels {
            assert!(
                p[1] > p[0],
                "G should exceed R for legacy-diagonal green tint, got G={} R={}",
                p[1],
                p[0]
            );
            assert!(
                p[1] > p[2],
                "G should exceed B for legacy-diagonal green tint, got G={} B={}",
                p[1],
                p[2]
            );
        }
    }

    #[test]
    fn apply_delta_identity_when_live_equals_decoded() {
        let mut img = Image::new(2, 2, ColorSpace::SceneLinearRec2020);
        for p in &mut img.pixels {
            *p = [0.3, 0.4, 0.5];
        }
        apply_delta(&mut img, 5000.0, 10.0, 5000.0, 10.0, WbMethod::Cat16);
        for p in &img.pixels {
            assert_eq!(p, &[0.3, 0.4, 0.5]);
        }
    }

    #[test]
    fn apply_delta_decoded_at_default_matches_apply() {
        for method in [WbMethod::Cat16, WbMethod::DiagonalRec2020] {
            let mut img_a = Image::new(2, 2, ColorSpace::SceneLinearRec2020);
            let mut img_b = Image::new(2, 2, ColorSpace::SceneLinearRec2020);
            for (a, b) in img_a.pixels.iter_mut().zip(img_b.pixels.iter_mut()) {
                *a = [0.4, 0.4, 0.4];
                *b = [0.4, 0.4, 0.4];
            }
            apply(&mut img_a, 3000.0, -50.0, method);
            apply_delta(&mut img_b, 3000.0, -50.0, 6500.0, 0.0, method);
            for (a, b) in img_a.pixels.iter().zip(img_b.pixels.iter()) {
                for c in 0..3 {
                    let rel_err = (a[c] - b[c]).abs() / a[c].max(1e-6);
                    assert!(
                        rel_err < 0.01,
                        "method {:?} channel {} apply={} apply_delta={} rel_err={}",
                        method,
                        c,
                        a[c],
                        b[c],
                        rel_err
                    );
                }
            }
        }
    }

    #[test]
    fn apply_delta_round_trip_undoes_decoded() {
        for method in [WbMethod::Cat16, WbMethod::DiagonalRec2020] {
            let mut img = Image::new(2, 2, ColorSpace::SceneLinearRec2020);
            for p in &mut img.pixels {
                *p = [0.4, 0.4, 0.4];
            }
            apply(&mut img, 3000.0, 0.0, method);
            apply_delta(&mut img, 6500.0, 0.0, 3000.0, 0.0, method);
            for p in &img.pixels {
                for c in 0..3 {
                    let err = (p[c] - 0.4).abs();
                    assert!(
                        err < 0.005,
                        "method {:?} round-trip channel {}: got {}, expected ~0.4 (err={})",
                        method,
                        c,
                        p[c],
                        err
                    );
                }
            }
        }
    }

    // ---- CAT16 path (ticket #431) ----

    #[test]
    fn cat16_neutral_at_default_is_identity() {
        // At the slider default (6500, 0) the matrix collapses to
        // identity via the short-circuit, so a neutral patch passes
        // through unchanged. (CAT, like every chromatic adaptation
        // `D65 → source(T)`, intentionally shifts neutrals away from
        // R=G=B once `source ≠ D65`; that's what the WB slider *does*.
        // See `cat16_warm_source_cools_image` etc. for that direction.)
        let mut img = Image::new(2, 2, ColorSpace::SceneLinearRec2020);
        for p in &mut img.pixels {
            *p = [0.4, 0.4, 0.4];
        }
        apply(&mut img, 6500.0, 0.0, WbMethod::Cat16);
        for p in &img.pixels {
            assert_eq!(p, &[0.4, 0.4, 0.4]);
        }
    }

    #[test]
    fn cat16_warm_source_cools_image() {
        // 3000K source (tungsten) → cooling correction → R cut, B boost
        // on a neutral patch.
        let mut img = Image::new(2, 2, ColorSpace::SceneLinearRec2020);
        for p in &mut img.pixels {
            *p = [0.3, 0.3, 0.3];
        }
        apply(&mut img, 3000.0, 0.0, WbMethod::Cat16);
        for p in &img.pixels {
            assert!(
                p[0] < 0.3,
                "CAT16: R should cut to cool a warm-source patch, got {}",
                p[0]
            );
            assert!(
                p[2] > 0.3,
                "CAT16: B should boost to cool a warm-source patch, got {}",
                p[2]
            );
        }
    }

    #[test]
    fn cat16_cool_source_warms_image() {
        let mut img = Image::new(2, 2, ColorSpace::SceneLinearRec2020);
        for p in &mut img.pixels {
            *p = [0.3, 0.3, 0.3];
        }
        apply(&mut img, 10000.0, 0.0, WbMethod::Cat16);
        for p in &img.pixels {
            assert!(
                p[0] > 0.3,
                "CAT16: R should boost to warm a cool-source patch, got {}",
                p[0]
            );
            assert!(
                p[2] < 0.3,
                "CAT16: B should cut to warm a cool-source patch, got {}",
                p[2]
            );
        }
    }

    #[test]
    fn cat16_tint_plus_adds_magenta() {
        // Reference-renderer convention: tint+ = magenta image (R+B up vs G).
        let mut img = Image::new(2, 2, ColorSpace::SceneLinearRec2020);
        for p in &mut img.pixels {
            *p = [0.3, 0.3, 0.3];
        }
        apply(&mut img, 6500.0, 50.0, WbMethod::Cat16);
        for p in &img.pixels {
            let rb_minus_2g = (p[0] + p[2]) - 2.0 * p[1];
            assert!(
                rb_minus_2g > 0.0,
                "CAT16: tint+50 should push (R+B) > 2G (magenta), got R={} G={} B={}",
                p[0],
                p[1],
                p[2]
            );
        }
    }

    #[test]
    fn cat16_tint_minus_adds_green() {
        let mut img = Image::new(2, 2, ColorSpace::SceneLinearRec2020);
        for p in &mut img.pixels {
            *p = [0.3, 0.3, 0.3];
        }
        apply(&mut img, 6500.0, -50.0, WbMethod::Cat16);
        for p in &img.pixels {
            let rb_minus_2g = (p[0] + p[2]) - 2.0 * p[1];
            assert!(
                rb_minus_2g < 0.0,
                "CAT16: tint-50 should push (R+B) < 2G (green), got R={} G={} B={}",
                p[0],
                p[1],
                p[2]
            );
        }
    }

    #[test]
    fn cat16_temperature_pm_1000k_is_symmetric() {
        // The legacy diagonal path produced a ~9x asymmetry between +1000K
        // and -1000K relative to the 6500K reference: warm |R-B| of 0.013
        // vs cool |R-B| of 0.115 (test_grey_adjustments `temp_symmetric`).
        // CAT16 collapses this to ~1.0 within ~10%.
        let mut warm = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
        let mut cool = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
        warm.pixels[0] = [0.18, 0.18, 0.18];
        cool.pixels[0] = [0.18, 0.18, 0.18];
        apply(&mut warm, 7500.0, 0.0, WbMethod::Cat16);
        apply(&mut cool, 5500.0, 0.0, WbMethod::Cat16);
        let warm_d = (warm.pixels[0][0] - warm.pixels[0][2]).abs();
        let cool_d = (cool.pixels[0][0] - cool.pixels[0][2]).abs();
        let ratio = warm_d / cool_d.max(1e-6);
        // The grey-adjustment `temp_symmetric` predictor gates `0.3 < ratio < 3.0`.
        // Main's diagonal path produces 8.98; CAT16 lands near 0.6 (order-of-
        // magnitude tighter). Local tolerance gives margin without overclaiming.
        assert!(
            ratio > 0.4 && ratio < 2.5,
            "CAT16 +/-1000K asymmetry too large: warm |R-B|={}, cool |R-B|={}, ratio={}",
            warm_d,
            cool_d,
            ratio
        );
    }

    #[test]
    fn cached_cat16_inverse_matches_fresh_inverse() {
        // Sanity: the OnceLock-cached CAT16 inverse used on the hot path
        // is bit-equivalent to a freshly computed inverse. If this ever
        // drifts, every CAT16 WB tile silently shifts.
        let fresh = CAT16.inverse().expect("CAT16 is non-singular");
        let cached = cat16_inverse();
        for r in 0..3 {
            for c in 0..3 {
                assert!(
                    (cached.0[r][c] - fresh.0[r][c]).abs() < 1e-12,
                    "cached CAT16 inverse [{r}][{c}]={} != fresh={}",
                    cached.0[r][c],
                    fresh.0[r][c]
                );
            }
        }
        // And the cache is sticky — second call returns the same pointer.
        assert!(std::ptr::eq(cat16_inverse(), cached));
    }
}
