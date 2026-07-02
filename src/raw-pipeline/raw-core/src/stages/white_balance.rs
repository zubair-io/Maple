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

// Tests live in the sibling `white_balance_tests.rs` so this file stays under the
// 600-LOC budget (same `#[path]` split pattern as `stages/nlm.rs`).
#[cfg(test)]
#[path = "white_balance_tests.rs"]
mod tests;
