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
//!    iterates), reading BOTH `T₂` and `t₂` jointly off the implied
//!    chromaticity via `color::dng_temperature::xy_to_temp_tint` (#1894 —
//!    the Robertson isotherm solve, not a nearest-point-on-Hernández-Andrés-
//!    locus search) at each iterate, so the converged pair lands in the
//!    same V5 domain `target_xyz`'s forward map consumes. The tint is
//!    deliberately NOT clamped to the slider's UI range: preserving the
//!    authored look wins over slider cosmetics. (The H2D-39 as-shot
//!    projects to ≈ −53 at the ACR `kTintScale`, comfortably in range.)
//!
//! This module converts V1 sidecars into the V2 CAMERA-SPACE FRAME (step
//! 6's fixed point on `cm_for_cct`) — a coordinate-system migration,
//! independent of and upstream from the #1894 VALUE-MAPPING migration
//! (V4→V5, `white_balance::authored_pair_to_v5`) that
//! `resolve_target_versioned` applies afterward for every non-V1 pair,
//! including the `(T₂, t₂)` this module just produced when its own
//! `wb_scale_version` tag isn't already V5. Step 6 itself, though, targets
//! V5 directly (rather than V2-in-the-legacy-locus followed by a second
//! V2→V5 hop) because the physical target neutral `n₂` it inverts is
//! locus-agnostic — there is only one Robertson-consistent `(T₂, t₂)` that
//! projects to it, and finding that pair directly is both simpler and
//! avoids compounding two lossy round-trips.
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
use crate::stages::white_balance;

/// Version-aware wrapper over [`super::resolve_target`]: V5 models (and
/// older models with no explicit authored WB) resolve exactly as before;
/// V2/V3/V4 models with an explicit authored temperature and/or tint
/// re-express the PAIR jointly in the V5 Robertson mapping
/// ([`white_balance::authored_pair_to_v5`] (#1894) — the same conversion
/// the fallback tier's `resolve_wb` applies to its own legacy-locus scale,
/// so the two tiers can't drift); V1 models with an explicit
/// `crs:Temperature`/`crs:Tint` convert through the module-doc pipeline.
/// Falls back to the plain resolver if the conversion hits a degenerate
/// matrix (defensive; real profiles are invertible).
pub fn resolve_target_versioned(
    model: &AdjustmentModel,
    frame: &SliderFrame,
    profile: &DcpProfile,
    as_shot_neutral: [f32; 3],
) -> (f32, f32) {
    let needs_v1_conversion =
        model.wb_scale_version == WbScaleVersion::V1 && (model.temperature_seen || model.tint_seen);
    if needs_v1_conversion {
        return convert_v1_target(model, frame, profile, as_shot_neutral)
            .unwrap_or_else(|| super::resolve_target(model, frame));
    }
    let (t, tint) = super::resolve_target(model, frame);
    // Version-authored PAIR conversion (#1894): the camera-space tiers
    // convert temperature and tint jointly through physical chromaticity
    // (`authored_pair_to_v5`), not a tint-only magnitude rescale — the
    // legacy map's locus (Hernández-Andrés) differs from Robertson's
    // (blackbody), so even a temperature-only authored value can move
    // (see `authored_pair_to_v5`'s doc). Gated on EITHER flag — the
    // #1893-era gate (`tint_seen` alone) missed the temperature-only row.
    // The As-Shot sentinel and named presets never set either `_seen` flag
    // and are already V5-native, so they skip this branch untouched.
    if model.temperature_seen || model.tint_seen {
        return white_balance::authored_pair_to_v5(t, tint, model.wb_scale_version);
    }
    (t, tint)
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
            // The HISTORIC diagonal path interpreted tint on the `false`
            // axis (pre-#1875). Reconstructing the authored V1 look
            // requires that historic interpretation, so this branch keeps
            // its own legacy gains rather than the (now ACR-direction)
            // `wb_gains`. Negating tint reproduces the old axis exactly —
            // the two orientations are the same line with opposite sign.
            let g = white_balance::wb_gains(t1, -tint1);
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
/// `target_xyz` is [`super::target_xyz`]'s #1894 Robertson mapping
/// (`white_balance::slider_source_xy` — `color::dng_temperature`'s
/// isotherm table, the same table ACR's own displayed slider pair is
/// defined on). The inversion fixed-points on the frame CM
/// (dual-calibration frames re-interpolate at `T`): at each iterate,
/// `inv(cm_for_cct(T)) · n_target` gives the implied scene chromaticity
/// xy, and `dng_temperature::xy_to_temp_tint` reads BOTH the next `T` and
/// the `tint` off that xy jointly (Robertson's isotherm distance, not a
/// nearest-point-on-Hernández-Andrés-locus search) — so the fixed point's
/// `(T, tint)` is a V5-domain pair by construction, matching
/// `resolve_target_versioned`'s other conversion path
/// (`white_balance::authored_pair_to_v5`). Unclamped by design; see the
/// module doc.
fn invert_frame_target(frame: &SliderFrame, n_target: [f32; 3]) -> Option<(f32, f32)> {
    let xy_for = |cct: f32| -> Option<(f32, f32)> {
        let inv = frame.cm_for_cct(cct).inverse()?;
        let xyz = inv.mul_vec(n_target);
        let sum = xyz[0] + xyz[1] + xyz[2];
        if !sum.is_finite() || sum < 1e-6 {
            return None;
        }
        Some((xyz[0] / sum, xyz[1] / sum))
    };
    let mut cct = frame.scene_cct;
    let mut tint = 0.0_f32;
    for _ in 0..12 {
        let (x, y) = xy_for(cct)?;
        let (next_cct, next_tint) = crate::color::dng_temperature::xy_to_temp_tint(x, y);
        let converged = (next_cct - cct).abs() < 0.5;
        cct = next_cct;
        tint = next_tint;
        if converged {
            break;
        }
    }
    if !cct.is_finite() || !tint.is_finite() {
        return None;
    }
    Some((cct, tint))
}

/// Test-only forward map: the target camera neutral `camera_wb_gain`
/// projects through the frame CM, so the round-trip tests can exercise
/// [`invert_frame_target`] against the exact forward definition —
/// [`super::target_xyz`]'s #1894 Robertson mapping, matched here via
/// `white_balance::slider_source_xy` (the same function `target_xyz`
/// calls) rather than duplicating the isotherm math.
#[cfg(test)]
fn forward_frame_target(frame: &SliderFrame, temperature: f32, tint: f32) -> [f32; 3] {
    let (tx, ty) = white_balance::slider_source_xy(temperature, tint);
    let xyz = white_balance::xy_to_xyz(tx, ty, 1.0);
    frame.cm_for_cct(temperature).mul_vec(xyz)
}

#[cfg(test)]
#[path = "wb_camera_scale_tests.rs"]
mod tests;
