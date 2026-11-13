//! Oklab secondary color curves stage (#5041, Stage 22b).
//!
//! Scene-linear stage computed in Oklab (`ColorSpace::SceneLinearRec2020`),
//! positioned immediately after `stages::hsl` (Stage 22) and before
//! `stages::clarity` (Stage 23). Evaluates six secondary curves:
//!
//! 1. **Hue vs Hue** (`color_curve_hue_vs_hue`): periodic over $u_H \in [0, 1)$,
//!    rotates Oklab hue by up to $\pm 60^\circ$ ($\pm \pi/3$ rad).
//! 2. **Hue vs Sat** (`color_curve_hue_vs_sat`): periodic over $u_H \in [0, 1)$,
//!    scales Oklab chroma $C$ by $[0\times, 2\times]$.
//! 3. **Hue vs Luma** (`color_curve_hue_vs_luma`): periodic over $u_H \in [0, 1)$,
//!    scales Oklab $L$ by $[0.7\times, 1.3\times]$.
//! 4. **Luma vs Sat** (`color_curve_luma_vs_sat`): clamped over scene-referred
//!    log-EV lightness $u_L \in [0, 1]$, scales Oklab chroma $C$ by $[0\times, 2\times]$.
//! 5. **Sat vs Sat** (`color_curve_sat_vs_sat`): clamped over normalized Oklab
//!    chroma $u_C = \text{clamp}(C / 0.32, 0, 1)$, scales $C$ by $[0\times, 2\times]$.
//! 6. **Sat vs Luma** (`color_curve_sat_vs_luma`): clamped over $u_C \in [0, 1]$,
//!    scales Oklab $L$ by $[0.7\times, 1.3\times]$.
//!
//! Uses the exact neutral-axis chroma gate from `stages::hsl`:
//! - Hard cutoff for $C < C_0$ (`CHROMA_GATE_C0 = 0.05`): returns `rgb` bit-for-bit.
//! - Smooth ramp `smoothstep(C_0, 2 C_0, C)` over $[0.05, 0.10]$.
//!
//! Out-of-gamut excursions after chroma scaling or hue rotation are bounded via
//! the same 24-step Rec.2020 gamut-hull bisection + Reinhard soft-knee as `stages::hsl`.

use crate::color::oklab::{oklab_to_rec2020, rec2020_to_oklab};
use crate::image::{ColorSpace, Image};
use crate::stages::hsl::{hsl_soft_compress, CHROMA_GATE_C0, HSL_GAMUT_KNEE_FRACTION};
use crate::types::adjustment::{AdjustmentModel, ToneCurve};

/// Shared authoring limits emitted to the platform editors; no per-pixel work.
pub const EDITOR_ANCHOR_SPREAD: f64 = 0.08;
pub const EDITOR_MIN_KNOT_GAP: f64 = 0.015;
pub const EDITOR_MAX_HUE_SLOPE: f64 = 2.5;

/// Quick-anchor calibration (id, label, Oklab hue degrees, RGB UI swatch),
/// emitted to each platform alongside the authoring limits.
pub const EDITOR_QUICK_HUE_ANCHORS: [(&str, &str, f64, u32); 6] = [
    ("red", "Red", 29.0, 0xc4493a),
    ("yellow", "Yellow", 110.0, 0xe3d24a),
    ("green", "Green", 142.0, 0x3fae6a),
    ("cyan", "Cyan", 195.0, 0x45b6c4),
    ("blue", "Blue", 264.0, 0x3b6fb0),
    ("magenta", "Magenta", 328.0, 0xc64fb0),
];
pub const EDITOR_SKIN_TONE_GUARD_DEG: [f64; 3] = [38.0, 55.0, 72.0];

#[path = "color_curve_lut.rs"]
mod lut;
pub use lut::{ColorCurveLut, COLOR_CURVE_LUT_LEN, EDITOR_MAX_KNOTS, NUM_COLOR_CURVES};

/// Full-scale Oklab chroma for the normalized `u_C = clamp(C / MAX_OKLAB_CHROMA, 0, 1)` axis.
pub const MAX_OKLAB_CHROMA: f32 = 0.32;

/// Maximum hue rotation at curve extremes $y \in \{0, 1\}$ ($\pm 60^\circ = \pm \pi/3$ rad).
pub const COLOR_CURVE_HUE_MAX_DEG: f32 = 60.0;
pub const COLOR_CURVE_HUE_MAX_RAD: f32 = COLOR_CURVE_HUE_MAX_DEG * std::f32::consts::PI / 180.0;

/// Maximum Oklab $L$ modulation scale at curve extremes $y \in \{0, 1\}$ ($\pm 0.30$).
pub const COLOR_CURVE_LUMA_MAX_SCALE: f32 = 0.30;

/// Rec.2020 luminance coefficients for the scene-referred log-EV lightness axis.
const REC2020_LUMA_R: f32 = 0.26270021;
const REC2020_LUMA_G: f32 = 0.67799807;
const REC2020_LUMA_B: f32 = 0.05930172;

const GAMUT_EPS: f32 = 1e-5;
const GAMUT_BISECT_ITERS: usize = 24;

/// Hoisted per-render LUTs for all six Oklab secondary color curves.
#[derive(Clone, Copy, Debug, Default)]
pub struct ColorCurveParams {
    pub hue_vs_hue: ColorCurveLut,
    pub hue_vs_sat: ColorCurveLut,
    pub hue_vs_luma: ColorCurveLut,
    pub luma_vs_sat: ColorCurveLut,
    pub sat_vs_sat: ColorCurveLut,
    pub sat_vs_luma: ColorCurveLut,
    pub is_identity: bool,
}

impl ColorCurveParams {
    /// Build all 6 curve LUTs from point slices.
    pub fn from_slices(
        hue_vs_hue: &[(f32, f32)],
        hue_vs_sat: &[(f32, f32)],
        hue_vs_luma: &[(f32, f32)],
        luma_vs_sat: &[(f32, f32)],
        sat_vs_sat: &[(f32, f32)],
        sat_vs_luma: &[(f32, f32)],
    ) -> Self {
        let hvh = bake_curve_lut(hue_vs_hue, true);
        let hvs = bake_curve_lut(hue_vs_sat, true);
        let hvl = bake_curve_lut(hue_vs_luma, true);
        let lvs = bake_curve_lut(luma_vs_sat, false);
        let svs = bake_curve_lut(sat_vs_sat, false);
        let svl = bake_curve_lut(sat_vs_luma, false);
        let is_identity = hvh.is_identity
            && hvs.is_identity
            && hvl.is_identity
            && lvs.is_identity
            && svs.is_identity
            && svl.is_identity;
        Self {
            hue_vs_hue: hvh,
            hue_vs_sat: hvs,
            hue_vs_luma: hvl,
            luma_vs_sat: lvs,
            sat_vs_sat: svs,
            sat_vs_luma: svl,
            is_identity,
        }
    }

    /// Build all 6 curve LUTs from an [`AdjustmentModel`].
    pub fn from_model(model: &AdjustmentModel) -> Self {
        Self::from_slices(
            &model.color_curve_hue_vs_hue.points,
            &model.color_curve_hue_vs_sat.points,
            &model.color_curve_hue_vs_luma.points,
            &model.color_curve_luma_vs_sat.points,
            &model.color_curve_sat_vs_sat.points,
            &model.color_curve_sat_vs_luma.points,
        )
    }
}

/// Normalized Oklab hue coordinate $u_H \in [0, 1)$ from Oklab $(a, b)$.
#[inline]
pub fn oklab_hue_norm(a: f32, b: f32) -> f32 {
    let mut deg = b.atan2(a).to_degrees();
    if deg < 0.0 {
        deg += 360.0;
    }
    (deg / 360.0).rem_euclid(1.0)
}

/// Normalized Oklab chroma coordinate $u_C = \text{clamp}(C / 0.32, 0, 1)$.
#[inline]
pub fn oklab_chroma_norm(c: f32) -> f32 {
    (c / MAX_OKLAB_CHROMA).clamp(0.0, 1.0)
}

/// Scene-referred log-EV lightness coordinate $u_L \in [0, 1]$ from scene-linear Rec.2020 RGB.
///
/// Maps 8 EV stops around 18% middle gray ($Y = 0.18 \mapsto u_L = 0.5$),
/// covering $[-4\text{ EV}, +4\text{ EV}]$ relative to mid-gray.
#[inline]
pub fn scene_log_luma_norm(rgb: [f32; 3]) -> f32 {
    let y = (REC2020_LUMA_R * rgb[0] + REC2020_LUMA_G * rgb[1] + REC2020_LUMA_B * rgb[2]).max(1e-6);
    (0.5 + 0.125 * (y / 0.18).log2()).clamp(0.0, 1.0)
}

/// Bake a user point list into a 256-sample [`ColorCurveLut`] of signed offsets $y(u) - 0.5$.
pub fn bake_curve_lut(points: &[(f32, f32)], periodic: bool) -> ColorCurveLut {
    lut::bake_curve_lut(points.iter().copied(), periodic)
}

/// Sample a periodic 256-entry LUT at $u \in [0, 1)$ with wrap-around linear interpolation.
#[inline]
pub fn sample_periodic(lut: &ColorCurveLut, u: f32) -> f32 {
    if lut.is_identity {
        return 0.0;
    }
    let pos = u.rem_euclid(1.0) * COLOR_CURVE_LUT_LEN as f32;
    let i0 = (pos.floor() as usize) & (COLOR_CURVE_LUT_LEN - 1);
    let i1 = (i0 + 1) & (COLOR_CURVE_LUT_LEN - 1);
    let frac = pos - pos.floor();
    lut.offsets[i0] * (1.0 - frac) + lut.offsets[i1] * frac
}

/// Sample a clamped 256-entry LUT at $u \in [0, 1]$ with linear interpolation.
#[inline]
pub fn sample_clamped(lut: &ColorCurveLut, u: f32) -> f32 {
    if lut.is_identity {
        return 0.0;
    }
    let pos = u.clamp(0.0, 1.0) * (COLOR_CURVE_LUT_LEN - 1) as f32;
    let i0 = (pos.floor() as usize).min(COLOR_CURVE_LUT_LEN - 1);
    let i1 = (i0 + 1).min(COLOR_CURVE_LUT_LEN - 1);
    let frac = pos - pos.floor();
    lut.offsets[i0] * (1.0 - frac) + lut.offsets[i1] * frac
}

/// Per-pixel Oklab secondary color curve evaluation in `SceneLinearRec2020`.
#[inline]
pub fn apply_pixel(rgb: [f32; 3], p: &ColorCurveParams) -> [f32; 3] {
    if p.is_identity {
        return rgb;
    }
    let lab = rec2020_to_oklab(rgb);
    let (mut l, a, b) = (lab[0], lab[1], lab[2]);
    let c = (a * a + b * b).sqrt();

    // Neutral-axis stability guarantee: exact bit-identical pass-through below C0.
    if c < CHROMA_GATE_C0 {
        return rgb;
    }
    let chroma_gate = smoothstep(CHROMA_GATE_C0, 2.0 * CHROMA_GATE_C0, c);

    let u_h = oklab_hue_norm(a, b);
    let u_c = oklab_chroma_norm(c);
    let u_l = scene_log_luma_norm(rgb);

    // 1. Hue rotation (Hue vs Hue: +/-60 deg full scale at y in {0, 1}).
    let d_hvh = sample_periodic(&p.hue_vs_hue, u_h);
    let delta_hue_rad = chroma_gate * d_hvh * 2.0 * COLOR_CURVE_HUE_MAX_RAD;

    // 2. Chroma scaling (Hue vs Sat, Luma vs Sat, Sat vs Sat: [0x, 2x] each).
    let d_hvs = sample_periodic(&p.hue_vs_sat, u_h);
    let d_lvs = sample_clamped(&p.luma_vs_sat, u_l);
    let d_svs = sample_clamped(&p.sat_vs_sat, u_c);
    let s_hvs = (1.0 + chroma_gate * 2.0 * d_hvs).max(0.0);
    let s_lvs = (1.0 + chroma_gate * 2.0 * d_lvs).max(0.0);
    let s_svs = (1.0 + chroma_gate * 2.0 * d_svs).max(0.0);
    let c_target = (c * s_hvs * s_lvs * s_svs).max(0.0);

    // 3. Lightness scaling (Hue vs Luma, Sat vs Luma: [0.7x, 1.3x] each).
    let d_hvl = sample_periodic(&p.hue_vs_luma, u_h);
    let d_svl = sample_clamped(&p.sat_vs_luma, u_c);
    let s_hvl = 1.0 + chroma_gate * 2.0 * COLOR_CURVE_LUMA_MAX_SCALE * d_hvl;
    let s_svl = 1.0 + chroma_gate * 2.0 * COLOR_CURVE_LUMA_MAX_SCALE * d_svl;
    // A globally active curve can leave this pixel untouched, including signed RGB.
    if delta_hue_rad == 0.0 && c_target == c && s_hvl * s_svl == 1.0 {
        return rgb;
    }
    l = (l * s_hvl * s_svl).max(0.0);

    // Rotate unit hue vector (a_hat, b_hat) by delta_hue_rad.
    let a_hat = a / c;
    let b_hat = b / c;
    let (sin_dh, cos_dh) = delta_hue_rad.sin_cos();
    let rot_a_hat = a_hat * cos_dh - b_hat * sin_dh;
    let rot_b_hat = a_hat * sin_dh + b_hat * cos_dh;

    // Probe beyond the shoulder so crossing the hull cannot switch operators.
    let c_probe = c_target / HSL_GAMUT_KNEE_FRACTION;
    let rgb_probe = oklab_to_rec2020([l, rot_a_hat * c_probe, rot_b_hat * c_probe]);
    if rgb_probe[0].min(rgb_probe[1]).min(rgb_probe[2]) >= -GAMUT_EPS {
        return oklab_to_rec2020([l, rot_a_hat * c_target, rot_b_hat * c_target]);
    }
    let c_hull = bisect_gamut_hull(l, rot_a_hat, rot_b_hat, c_probe);
    let geometry_distance =
        ((l - lab[0]).powi(2) + (rot_a_hat * c - a).powi(2) + (rot_b_hat * c - b).powi(2)).sqrt();
    let input_in_gamut = rgb[0].min(rgb[1]).min(rgb[2]) >= -GAMUT_EPS;
    let c_out = hsl_soft_compress(c_target, c_hull, c, geometry_distance, input_in_gamut);
    oklab_to_rec2020([l, rot_a_hat * c_out, rot_b_hat * c_out])
}

#[inline]
fn bisect_gamut_hull(l: f32, a_hat: f32, b_hat: f32, c_high: f32) -> f32 {
    let mut lo = 0.0f32;
    let mut hi = c_high;
    for _ in 0..GAMUT_BISECT_ITERS {
        let mid = 0.5 * (lo + hi);
        let rgb = oklab_to_rec2020([l, a_hat * mid, b_hat * mid]);
        if rgb[0].min(rgb[1]).min(rgb[2]) >= -GAMUT_EPS {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    lo
}

#[inline]
fn smoothstep(e0: f32, e1: f32, x: f32) -> f32 {
    let t = ((x - e0) / (e1 - e0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// Apply the six Oklab secondary color curves to `img`.
pub fn apply(
    img: &mut Image,
    hue_vs_hue: &ToneCurve,
    hue_vs_sat: &ToneCurve,
    hue_vs_luma: &ToneCurve,
    luma_vs_sat: &ToneCurve,
    sat_vs_sat: &ToneCurve,
    sat_vs_luma: &ToneCurve,
) {
    img.assert_space(ColorSpace::SceneLinearRec2020);
    let params = ColorCurveParams::from_slices(
        &hue_vs_hue.points,
        &hue_vs_sat.points,
        &hue_vs_luma.points,
        &luma_vs_sat.points,
        &sat_vs_sat.points,
        &sat_vs_luma.points,
    );
    if params.is_identity {
        return;
    }
    for px in &mut img.pixels {
        *px = apply_pixel(*px, &params);
    }
}

/// Convenience wrapper reading the six `color_curve_*` fields off [`AdjustmentModel`].
pub fn apply_model(img: &mut Image, model: &AdjustmentModel) {
    apply(
        img,
        &model.color_curve_hue_vs_hue,
        &model.color_curve_hue_vs_sat,
        &model.color_curve_hue_vs_luma,
        &model.color_curve_luma_vs_sat,
        &model.color_curve_sat_vs_sat,
        &model.color_curve_sat_vs_luma,
    );
}

#[cfg(test)]
#[path = "color_curves_tests.rs"]
mod tests;
