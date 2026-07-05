//! WB slider-scale migration (#1780) — converts V1 (pre-#1756) stored
//! `crs:Temperature`/`crs:Tint` values into the V2 slider frame at develop
//! time, so sidecars authored under the old scale keep rendering the look
//! they were authored to.
//!
//! ## Why
//!
//! #1756 moved user WB from a post-DCP CAT16 adaptation in scene-linear
//! Rec.2020 (identity at 6500 K / tint 0 — `stages::white_balance::apply`)
//! to a camera-space diagonal gain interpreted in ACR's calibration frame
//! (identity at `SliderFrame::scene_cct` — `stages::wb_camera`). The same
//! stored numbers therefore MEAN something different before and after:
//! test_0002's Maple-authored `6282 / −44` was near-identity under the old
//! scale but reads as a ~+62-mired-warm + magenta shift in the new frame —
//! the reported pink cast. The sidecar is the contract, so the old meaning
//! must be preserved: `xmp::parse` tags every model with a
//! [`WbScaleVersion`], and this module re-expresses V1 values in the V2
//! frame before use.
//!
//! ## Conversion math (V1 → V2)
//!
//! Everything below is per-image, evaluated against the resolved (as-shot,
//! un-retargeted) render profile and slider frame:
//!
//! 1. `(T₁, t₁) = white_balance::resolve_wb(model)` — the exact effective
//!    pair the pre-#1756 develop chain fed `white_balance::apply`.
//!    `(6500, 0)` was that path's identity, so it maps straight to the V2
//!    identity `(frame.scene_cct, 0)`.
//! 2. `D = dcp::camera_to_rec2020_matrix(profile)` — the develop chain's
//!    linear camera→Rec.2020 rendering transform (FM or Bradford path,
//!    same dispatch `apply_colorimetry` uses). `w = D·(1,1,1)` is the
//!    rendered as-shot white.
//! 3. Old rendered white: `w_old = M_cat16(T₁, t₁) · w` (or
//!    `wb_gains(T₁, t₁) ⊙ w` for the legacy diagonal method) — where the
//!    pre-#1756 stage left a neutral patch.
//! 4. Equivalent camera-space gain: `g = D⁻¹ · w_old`. Applying `g` as a
//!    per-channel camera gain and rendering through `D` reproduces
//!    `w_old` exactly — the standard von-Kries-in-camera-space stand-in
//!    for the old Rec.2020 matrix (exact on the neutral axis, first-order
//!    elsewhere).
//! 5. Target camera neutral: `n₂ ∝ as_shot_neutral ⊘ g` (G-normalised) —
//!    since `camera_wb_gain` produces `G(asn) ⊘ G(n_target)`, choosing
//!    `n₂` this way makes the new stage apply exactly `G-norm(g)`.
//! 6. Invert the slider-frame parameterisation: find `(T₂, t₂)` with
//!    `G-norm(cm_for_cct(T₂) · target_xyz(T₂, t₂)) = n₂` — fixed-point on
//!    the frame CM (the same self-consistency `compute_as_shot_cct`
//!    iterates), nearest-point-on-locus for `T₂`, perpendicular uv
//!    projection (the `tint_sign_positive_v = false` axis
//!    `camera_wb_gain`'s forward map displaces along) for `t₂`. The tint
//!    is deliberately NOT clamped to the slider's ±100 UI range: a real
//!    camera's neutral can project beyond it (H2D-39 as-shot ≈ +144), and
//!    preserving the authored look wins over slider cosmetics.
//!
//! Only sidecars with an explicit authored Temperature/Tint component
//! convert (`temperature_seen || tint_seen`); everything else — As-Shot,
//! named presets, fresh models — resolves through
//! [`super::resolve_target`] unchanged. The `RawlerFallback` / LinearRaw
//! develop tiers never reach this module: they still run the post-DCP
//! CAT16 path, i.e. V1 semantics natively.

use crate::{
    color::dcp::{self, DcpProfile},
    xmp::{AdjustmentModel, WbMethod, WbScaleVersion},
};

use super::SliderFrame;
use crate::stages::white_balance::{
    self, cct_to_xy, tint_perpendicular_axis, xy_to_uv, TINT_UV_SCALE,
};

/// Version-aware wrapper over [`super::resolve_target`]: V2 models (and V1
/// models with no explicit authored WB) resolve exactly as before; V1
/// models with an explicit `crs:Temperature`/`crs:Tint` convert through
/// the module-doc pipeline. Falls back to the plain resolver if the
/// conversion hits a degenerate matrix (defensive; real profiles are
/// invertible).
pub fn resolve_target_versioned(
    model: &AdjustmentModel,
    frame: &SliderFrame,
    profile: &DcpProfile,
    as_shot_neutral: [f32; 3],
) -> (f32, f32) {
    let needs_conversion =
        model.wb_scale_version == WbScaleVersion::V1 && (model.temperature_seen || model.tint_seen);
    if !needs_conversion {
        return super::resolve_target(model, frame);
    }
    convert_v1_target(model, frame, profile, as_shot_neutral)
        .unwrap_or_else(|| super::resolve_target(model, frame))
}

/// Steps 1–5 of the module-doc conversion: effective V1 pair → old
/// rendered white → equivalent camera gain → target camera neutral →
/// frame inversion. `None` only on degenerate inputs (singular D,
/// non-finite gain components).
fn convert_v1_target(
    model: &AdjustmentModel,
    frame: &SliderFrame,
    profile: &DcpProfile,
    as_shot_neutral: [f32; 3],
) -> Option<(f32, f32)> {
    let (t1, tint1) = white_balance::resolve_wb(model);
    // The pre-#1756 stage's identity short-circuit: (6500, 0) rendered
    // as-shot. Map it to the V2 as-shot reference so `wb_camera::apply`'s
    // own short-circuit keeps unedited-WB renders bit-identical.
    if (t1 - 6500.0).abs() < 0.5 && tint1.abs() < 0.5 {
        return Some((frame.scene_cct, 0.0));
    }
    let d = dcp::camera_to_rec2020_matrix(profile).ok()?;
    let d_inv = d.inverse()?;
    let w = d.mul_vec([1.0, 1.0, 1.0]);
    let w_old = match model.wb_method {
        WbMethod::Cat16 => white_balance::wb_cat16_matrix(t1, tint1).mul_vec(w),
        WbMethod::DiagonalRec2020 => {
            let g = white_balance::wb_gains(t1, tint1);
            [w[0] * g[0], w[1] * g[1], w[2] * g[2]]
        }
    };
    let g_cam = d_inv.mul_vec(w_old);
    if g_cam.iter().any(|c| !c.is_finite() || *c <= 1e-6) {
        return None;
    }
    // G-normalisation happens inside the inversion (chromaticity is
    // scale-free), so the plain component-wise ratio suffices here.
    let n_target = [
        as_shot_neutral[0] / g_cam[0],
        as_shot_neutral[1] / g_cam[1],
        as_shot_neutral[2] / g_cam[2],
    ];
    if n_target.iter().any(|c| !c.is_finite() || *c <= 1e-6) {
        return None;
    }
    invert_frame_target(frame, n_target)
}

/// Step 6: invert `camera_wb_gain`'s forward map — find the `(T, tint)`
/// whose frame-projected target neutral is `n_target` (up to scale).
///
/// Forward: `n(T, tint) = cm_for_cct(T) · target_xyz(T, tint)`, where
/// `target_xyz` is the Hernández-Andrés locus point at `T` displaced by
/// `tint · TINT_UV_SCALE` along the perpendicular axis
/// (`tint_sign_positive_v = false`). The inversion fixed-points on the
/// frame CM (dual-calibration frames re-interpolate at `T`), takes `T` as
/// the nearest-locus parameter of the implied chromaticity (where the
/// residual is purely perpendicular — the same condition the forward
/// displacement satisfies), and reads `tint` off the perpendicular
/// projection. Unclamped by design; see the module doc.
fn invert_frame_target(frame: &SliderFrame, n_target: [f32; 3]) -> Option<(f32, f32)> {
    let uv_for = |cct: f32| -> Option<(f32, f32)> {
        let inv = frame.cm_for_cct(cct).inverse()?;
        let xyz = inv.mul_vec(n_target);
        let sum = xyz[0] + xyz[1] + xyz[2];
        if !sum.is_finite() || sum < 1e-6 {
            return None;
        }
        Some(xy_to_uv(xyz[0] / sum, xyz[1] / sum))
    };
    let mut cct = frame.scene_cct;
    for _ in 0..12 {
        let (u, v) = uv_for(cct)?;
        let next = nearest_locus_cct(u, v);
        let converged = (next - cct).abs() < 0.5;
        cct = next;
        if converged {
            break;
        }
    }
    let (u, v) = uv_for(cct)?;
    let (cx, cy) = cct_to_xy(cct);
    let (cu, cv) = xy_to_uv(cx, cy);
    let (perp_u, perp_v) = tint_perpendicular_axis(cct, false);
    let tint = ((u - cu) * perp_u + (v - cv) * perp_v) / TINT_UV_SCALE;
    if !cct.is_finite() || !tint.is_finite() {
        return None;
    }
    Some((cct, tint))
}

/// Nearest-point-on-Planckian-locus CCT for a CIE 1960 uv chromaticity —
/// ternary search over reciprocal CCT (mired; the locus is traversed
/// near-uniformly there) on the squared uv distance, over the same
/// [2000 K, 25000 K] domain `cct_to_xy` clamps to.
fn nearest_locus_cct(u: f32, v: f32) -> f32 {
    let dist2 = |cct: f32| {
        let (x, y) = cct_to_xy(cct);
        let (lu, lv) = xy_to_uv(x, y);
        (u - lu) * (u - lu) + (v - lv) * (v - lv)
    };
    let mut lo = 1.0e6 / 25000.0;
    let mut hi = 1.0e6 / 2000.0;
    for _ in 0..60 {
        let m1 = lo + (hi - lo) / 3.0;
        let m2 = hi - (hi - lo) / 3.0;
        if dist2(1.0e6 / m1) <= dist2(1.0e6 / m2) {
            hi = m2;
        } else {
            lo = m1;
        }
    }
    1.0e6 / ((lo + hi) * 0.5)
}

/// Test-only forward map: the target camera neutral `camera_wb_gain`
/// projects through the frame CM, so the round-trip tests can exercise
/// [`invert_frame_target`] against the exact forward definition.
#[cfg(test)]
fn forward_frame_target(frame: &SliderFrame, temperature: f32, tint: f32) -> [f32; 3] {
    let (x, y) = cct_to_xy(temperature);
    let (tx, ty) = white_balance::apply_tint_perpendicular(x, y, temperature, tint, false);
    let xyz = white_balance::xy_to_xyz(tx, ty, 1.0);
    frame.cm_for_cct(temperature).mul_vec(xyz)
}

#[cfg(test)]
#[path = "wb_camera_scale_tests.rs"]
mod tests;
