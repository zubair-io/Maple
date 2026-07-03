use crate::{
    color::matrices::{CAT16, M_REC2020_TO_XYZ_D65, M_XYZ_D65_TO_REC2020, XYZ_D65},
    image::{ColorSpace, Image},
    math::{Matrix3, Vec3},
    types::WbMethod,
};
use std::sync::OnceLock;

/// Scale factor (uv units per tint unit) for the perpendicular-to-locus
/// tint displacement.
///
/// **Derivation.** The available ACR tint references (test_0000, test_0006,
/// test_0013 tint_max/tint_min) set `crs:Tint` without `crs:Temperature`, so
/// ACR renders at the DNG's as-shot CCT. With the #1729 anchoring fix, Maple
/// now correctly uses as-shot CCT for tint-only XMPs. However, empirical
/// investigation reveals that ACR's tint_max and tint_min renders are
/// effectively IDENTICAL (≤1 LSB difference at 8-bit per channel) for all
/// three tint fixtures — these references carry no usable tint-scale signal.
/// A sweep over 0.5e-4 to 3e-4 is therefore still monotone-increasing in ΔE
/// (any non-zero tint moves Maple away from the identical tint_max/tint_min
/// references, which differ from the baseline only in their CCT processing):
///
///   5.00e-05 → avg ΔE 11.48  ← monotone minimum, tint effect invisible
///   8.00e-05 → avg ΔE 13.11
///   1.00e-04 → avg ΔE 14.24  ← analytically derived value (retained)
///   1.20e-04 → avg ΔE 15.34
///   2.00e-04 → avg ΔE 19.28
///   3.00e-04 → avg ΔE 23.50
///
/// Scale=0 is not acceptable (tint becomes a no-op). The scale is therefore
/// kept at the analytically derived value: tint ±150 should span ±0.015 uv
/// perpendicular to the locus, which covers ~19 % of the 2 000–25 000 K locus
/// range in uv and matches the rawpy / LibRaw convention (perpendicular
/// distance in uv divided by 0.0001 per tint unit).
/// TINT_UV_SCALE = 0.015 / 150 = 1e-4.
///
/// To re-fit empirically: generate tint references where both temperature AND
/// tint are set in the XMP, so the tint effect is genuinely different from the
/// baseline. Track in #1725.
const TINT_UV_SCALE: f32 = 1e-4;

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

/// CIE xy → CIE 1960 UCS (u, v) chromaticity.
///
/// Standard formulæ (Robertson 1968 / Wyszecki & Stiles):
///   u = 4x / (−2x + 12y + 3)
///   v = 6y / (−2x + 12y + 3)
#[inline]
fn xy_to_uv(x: f32, y: f32) -> (f32, f32) {
    let denom = -2.0 * x + 12.0 * y + 3.0;
    (4.0 * x / denom, 6.0 * y / denom)
}

/// CIE 1960 UCS (u, v) → CIE xy chromaticity.
///
/// Derivation: invert the forward formulæ u=4x/D, v=6y/D where D=−2x+12y+3.
/// This gives x/y = 3u/(2v), and substituting back yields:
///   x = 3u / (2u − 8v + 4)
///   y = 2v / (2u − 8v + 4)
///
/// Note: `9u/(6u−16v+12)` and `4v/(6u−16v+12)` are the CIE **1976** (u',v')
/// formulæ and must NOT be used here — that space has v' = 1.5v relative to
/// the 1960 coordinates.
#[inline]
fn uv_to_xy(u: f32, v: f32) -> (f32, f32) {
    let denom = 2.0 * u - 8.0 * v + 4.0;
    (3.0 * u / denom, 2.0 * v / denom)
}

/// Apply a tint displacement perpendicular to the Planckian locus in CIE 1960
/// uv space, matching the DNG / ACR convention.
///
/// # Convention
///
/// The Planckian locus tangent at the working CCT is estimated by
/// finite-differencing `cct_to_xy` at ±50 K and converting to uv. The
/// perpendicular is the tangent rotated 90°. Two 90° rotations exist
/// `(−dv, +du)` and `(+dv, −du)`; we pick the one whose v-component has the
/// same sign as `tint_sign_convention_v_positive` (caller-supplied), so each
/// path preserves its documented user-facing direction:
///
/// - **CAT16 path**: `tint > 0` must move the source GREENER (v↑ in uv ≈
///   greenish direction at 6500 K), producing a MAGENTA image after
///   adaptation. Pass `tint_sign_positive_v = true`.
/// - **Diagonal path**: `tint > 0` moves source in the GREEN direction, so
///   gain = D65/source pushes image GREEN. This path has an inverted sign:
///   subtract tint from y historically, which at 6500 K moves uv v downward
///   for positive tint (toward magenta source / green image). Pass
///   `tint_sign_positive_v = false`.
///
/// The scale constant `TINT_UV_SCALE` was fitted to ACR references; see its
/// declaration above.
pub fn apply_tint_perpendicular(
    x: f32,
    y: f32,
    cct: f32,
    tint: f32,
    tint_sign_positive_v: bool,
) -> (f32, f32) {
    // Finite-difference tangent of the locus in uv at this CCT.
    let delta_k = 50.0_f32;
    let (xp, yp) = cct_to_xy((cct + delta_k).min(25000.0));
    let (xm, ym) = cct_to_xy((cct - delta_k).max(2000.0));
    let (up, vp) = xy_to_uv(xp, yp);
    let (um, vm) = xy_to_uv(xm, ym);
    let mut du = up - um;
    let mut dv = vp - vm;
    // Normalise tangent.
    let len = (du * du + dv * dv).sqrt().max(1e-10);
    du /= len;
    dv /= len;
    // Perpendicular candidates (rotate tangent ±90°):
    //   candidate A: (−dv, +du)  — v-component = +du
    //   candidate B: (+dv, −du)  — v-component = −du
    //
    // At 6500 K the Planckian locus runs in the (−u, −v) direction as T
    // increases, so the normalised tangent has du < 0 and dv < 0.
    //   candidate A v-component = +du < 0  → magenta direction (lower v)
    //   candidate B v-component = −du > 0  → green direction (higher v)
    //
    // Pick the one whose v-component is positive when `tint_sign_positive_v`
    // is true (CAT16: tint+ = greener source = higher v), or negative when
    // false (diagonal: tint+ = magenta source = lower v, image goes green).
    let (perp_u, perp_v) = if tint_sign_positive_v {
        // Green direction: candidate B (+dv, −du), v-component = −du > 0.
        (dv, -du)
    } else {
        // Magenta direction: candidate A (−dv, +du), v-component = +du < 0.
        (-dv, du)
    };

    let (u0, v0) = xy_to_uv(x, y);
    let displacement = tint * TINT_UV_SCALE;
    let u1 = u0 + displacement * perp_u;
    let v1 = v0 + displacement * perp_v;
    uv_to_xy(u1, v1)
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
    // The reference renderer's tint semantics: positive tint = GREEN image,
    // negative tint = MAGENTA image. To produce a green image shift via the
    // gain path (gain = D65/source), the source must be displaced toward
    // MAGENTA (i.e. the v-component of the perpendicular displacement must be
    // negative for positive tint). Pass `tint_sign_positive_v = false` so the
    // perpendicular direction has a negative v-component, moving the source
    // toward lower v (≈magenta), which makes gain = D65/source push the image
    // greener.
    let (x, y) = cct_to_xy(temperature);
    let (sx, sy) = apply_tint_perpendicular(x, y, temperature, tint, false);
    let xyz_source = xy_to_xyz(sx, sy, 1.0);
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
    // tint > 0 = magenta image = greener source: the perpendicular displacement
    // must move toward higher v (≈green direction in uv) for positive tint.
    // Pass `tint_sign_positive_v = true` so the chosen perpendicular has a
    // positive v-component, displacing the source toward green.
    let (x, y) = cct_to_xy(temperature);
    let (sx, sy) = apply_tint_perpendicular(x, y, temperature, tint, true);
    let xyz_source = xy_to_xyz(sx, sy, 1.0);
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

/// Resolve the (temperature, tint) pair the develop chain should pass to
/// `white_balance::apply`, honouring the #1729 ACR anchoring semantics.
///
/// ## Exhaustive resolution table
///
/// ```text
/// temperature_seen | tint_seen | effective_temperature  | effective_tint | Source
/// ─────────────────┼───────────┼────────────────────────┼────────────────┼──────────────────────────────────────
/// true             | true      | model.temperature       | model.tint     | XMP: Custom with both T and tint
/// true             | false     | model.temperature       | 0.0            | XMP: temperature-only Custom WB
/// false            | true      | 6500.0 (D65 neutral)   | model.tint     | XMP: tint-only Custom WB
/// false            | false     | model.temperature       | model.tint     | No XMP / named preset / FFI / Default
/// ─────────────────┴───────────┴────────────────────────┴────────────────┴──────────────────────────────────────
/// ```
///
/// ## Why 6500 K when only tint is set
///
/// After `apply_pre_gain` + DCP the scene buffer is in scene-linear Rec.2020
/// D65: the camera's `AsShotNeutral` was divided out (pre-gain) and the DCP
/// `ForwardMatrix` mapped `(1,1,1)` camera neutral → D65 white. In that
/// post-DCP space `white_balance::apply(6500, 0)` is the identity — "as-shot"
/// ≡ 6500 K from the WB slider's perspective. Using `raw.as_shot_cct` instead
/// would double-correct: pre-gain + DCP already neutralised the illuminant CCT;
/// applying it again shifts the image away from as-shot rather than keeping it
/// there.
///
/// ## Why the neither-seen case uses `model.temperature` / `model.tint`
///
/// **Default model (no sidecar):** both flags are false and both values carry
/// the `AdjustmentModel::default()` values (6500 / 0) — a no-op by the
/// `white_balance::apply` short-circuit. The Apple app overrides
/// `model.temperature` with the DNG's as-shot CCT before calling FFI, so the
/// result is correct as-shot WB.
///
/// **Named WB preset (Tungsten, Daylight, …):** the XMP parser populates
/// `model.temperature` and `model.tint` from `wb_preset()` but does NOT set
/// the seen flags (presets are resolved to a `(temp, tint)` pair at parse time,
/// not authored as explicit numeric fields). The neither-seen fall-through
/// preserves the preset's resolved values — critical for e.g. Tungsten
/// (2850 K, 0 tint) to reach the WB stage correctly.
///
/// **FFI-supplied values (Apple CPU develop, WASM fresh-open with as-shot
/// temperature injected):** both flags are forced to `true` by the FFI
/// conversion (`raw-ffi::scene_linear_chain` / `raw-ffi::render`), so
/// explicit user values always survive. This function's neither-seen branch
/// is therefore exercised only by the Default model and preset paths, both
/// of which are correct to pass `model.temperature`/`model.tint` through.
///
/// ## Shared use
///
/// All three develop sites call this function so the semantics cannot drift:
/// `develop::develop_scene_linear_from_raw_with_quality_cancellable`,
/// `develop_sized::develop_scene_linear_sized_from_raw_with_quality_cancellable`,
/// and `tile::develop::develop_scene_linear_from_padded_mosaic`. (#1725)
pub fn resolve_wb(model: &crate::xmp::AdjustmentModel) -> (f32, f32) {
    let effective_temperature = if model.temperature_seen {
        model.temperature
    } else if model.tint_seen {
        // Tint-only Custom WB: anchor absent temperature to 6500 K (D65).
        // See the doc-comment above for the derivation.
        6500.0
    } else {
        // No Custom WB authored, or a named WB preset (Tungsten, Daylight, …),
        // or a Default model (no sidecar): use model.temperature as-is.
        model.temperature
    };
    // Absent tint → 0.  When neither flag is set, model.tint is already 0
    // for the Default model or a preset-resolved value — both pass through
    // correctly. When temperature-only Custom WB is set, tint defaults to 0
    // (the neutral value) per the resolution table.
    let effective_tint = if model.tint_seen { model.tint } else { 0.0 };
    (effective_temperature, effective_tint)
}

// Tests live in the sibling `white_balance_tests.rs` so this file stays under the
// 600-LOC budget (same `#[path]` split pattern as `stages/nlm.rs`).
#[cfg(test)]
#[path = "white_balance_tests.rs"]
mod tests;
