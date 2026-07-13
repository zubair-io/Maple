//! [`SliderFrameExport`] — plain-data export of a resolved
//! [`SliderFrame`], plus the Rec.2020-space WB delta matrix derived from
//! it (#1781).
//!
//! ## Why this exists
//!
//! The develop chain interprets the temperature/tint sliders in the
//! camera-specific [`SliderFrame`] (#1727/#1756): a diagonal gain in
//! camera-native RGB, upstream of DCP. The post-DCP per-tick paths — the
//! GPU live chain (`raw-ffi::gpu_live`) and the CPU scene-linear chain
//! (`pipeline::apply_scene_linear_chain[_f32]`) — receive an
//! already-developed Rec.2020 buffer, where no `RawImage`/`DcpProfile`
//! exists to resolve the frame from. Before #1781 those paths fell back
//! to the generic Planckian CAT16 delta (`wb_cat16_matrix`), a DIFFERENT
//! interpretation of the same slider values — the live-vs-refine seam of
//! the ticket (mean ΔE00 ≈ 7 on test_0002 at its sidecar WB).
//!
//! The decode FFI therefore exports the resolved frame's data (this
//! struct) alongside the decoded buffer, and both per-tick paths derive
//! their WB matrix from it via [`SliderFrameExport::rec2020_delta_matrix`]
//! — the same `wb_camera` gain math the develop runs, conjugated into
//! Rec.2020.
//!
//! ## The conjugation (and its accuracy)
//!
//! A develop at slider target `T` differs from a develop at anchor `A`
//! (post-DCP, in Rec.2020) by
//!
//! ```text
//!   M = C(T) · diag(g(T) / g(A)) · C(A)⁻¹
//! ```
//!
//! where `g` is [`super::wb_camera::camera_wb_gain`] and `C(·)` the
//! camera→Rec.2020 colorimetric transform (ForwardMatrix re-interpolated
//! at the target per `retargeted_render_profile`). The frame export
//! cannot carry the render profile's FM endpoints, so this module holds
//! `C` FIXED at the frame's own Bradford-style transform
//!
//! ```text
//!   C_f = M_pro→rec2020 · M_pro→xyzD50⁻¹ · bradford(w_frame → D50) · CM_as_shot⁻¹
//! ```
//!
//! with `w_frame` reconstructed from `(scene_cct, as_shot_tint)`.
//! Measured against the true FM-retargeted delta on test_0002
//! (Hasselblad H2D-39 bundle profile, anchor 6500/0): max per-channel
//! relative error 0.16 % at the sidecar target (6282, −44) and ≤ 1.0 %
//! at a 1000 K + full-rail-tint excursion — versus the ≈ mean-ΔE00-7
//! frame-anchoring error of the generic CAT16 path this replaces.
//!
//! Two deliberate invariances make the frame data sufficient:
//! * `AsShotNeutral` cancels out of the gain RATIO (both gains divide by
//!   it), so `camera_wb_gain` is evaluated with a `[1, 1, 1]` neutral.
//! * any trailing diagonal factor of `C` (the pre-gain `1/AsShotNeutral`)
//!   commutes with the WB diagonal and cancels in `C · diag · C⁻¹`, so
//!   the conjugation needs no neutral either.

use crate::{
    color::{
        dcp::{self, DcpProfile},
        matrices::{bradford_adapt, m_pro_to_rec2020, M_PRO_TO_XYZ_D50, XYZ_D50},
    },
    image::{ColorSpace, Image, RawImage},
    math::Matrix3,
};

use super::{camera_wb_gain, SliderFrame};
use crate::stages::white_balance::{wb_cat16_matrix, xy_to_xyz};

/// Plain-data export of a resolved [`SliderFrame`] + the frame's as-shot
/// tint, shaped for flat-float FFI transport (#1781). All-zero (see
/// [`Self::ABSENT`]) means "no frame" — consumers fall back to the legacy
/// generic CAT16 behaviour, bit-identical to pre-#1781 output.
///
/// A single-calibration frame is encoded as `m_cold == m_warm` with
/// `cct_cold == cct_warm` (reconstruction treats a span `< 1 K` as
/// single-CM, mirroring [`SliderFrame::resolve`]'s `>= 1.0` dual gate).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SliderFrameExport {
    /// Cold calibration endpoint (XYZ→camera), row-major.
    pub m_cold: Matrix3,
    pub cct_cold: f32,
    /// Warm calibration endpoint (XYZ→camera), row-major.
    pub m_warm: Matrix3,
    pub cct_warm: f32,
    /// As-shot CCT in THIS frame — the slider's identity temperature.
    pub scene_cct: f32,
    /// As-shot tint in THIS frame (`estimate_tint_from_scene_xyz` at
    /// `scene_cct` — the same estimate `dcp::estimate_as_shot_cct_tint`
    /// hands the app for slider hydration), in the ACR convention
    /// (`tint_sign_positive_v = true` — the axis `camera_wb_gain`
    /// consumes, #1875). May sit at the ±150 rail for bodies whose
    /// as-shot chromaticity is extremely far off the locus (H2D-39
    /// as-shot ≈ −143.5).
    pub as_shot_tint: f32,
    /// The actual camera→Rec.2020 colorimetric transform of the render
    /// profile (#1967 seam fix). When `forward_matrix` is present and
    /// pre-gain is skipped (Bayer/LinearRaw DNGs), this correctly carries
    /// `M_pro_to_rec2020 * inv_pro * forward_matrix`, preventing the huge
    /// cyan mismatch caused by Bradford-adapting `ColorMatrix` instead.
    /// Zero ⇒ host predates the fix; `to_frame` falls back to the legacy path.
    pub cam_to_rec2020: Matrix3,
}

impl SliderFrameExport {
    /// The "no frame" sentinel — what a zero-initialised FFI struct reads
    /// as. [`Self::is_present`] is `false`.
    pub const ABSENT: SliderFrameExport = SliderFrameExport {
        m_cold: Matrix3([[0.0; 3]; 3]),
        cct_cold: 0.0,
        m_warm: Matrix3([[0.0; 3]; 3]),
        cct_warm: 0.0,
        scene_cct: 0.0,
        as_shot_tint: 0.0,
        cam_to_rec2020: Matrix3([[0.0; 3]; 3]),
    };

    /// Resolve the export for a source: [`SliderFrame::resolve`] plus the
    /// in-frame as-shot tint estimate. Callers gate on the same tiers the
    /// develop chain gates `wb_camera` on (no `RawlerFallback`, no lossy
    /// LinearRaw) and use [`Self::ABSENT`] otherwise — see
    /// `raw-ffi::scene_linear_f32::wb_frame_export`.
    pub fn resolve(raw: &RawImage, profile: &DcpProfile) -> SliderFrameExport {
        let frame = SliderFrame::resolve(raw, profile);
        // #1894: the SAME Robertson mapping the frame's own `scene_cct`
        // now derives from (`dcp::compute_as_shot_cct` /
        // `SliderFrame::resolve`'s single-CM arm) — not the separate
        // Hernández-Andrés perpendicular-projection estimator this used
        // pre-#1894. `frame_to_rec2020` below reconstructs `w_frame` from
        // this SAME pair via `slider_source_xy`, so estimator and
        // reconstruction share one mapping (the #1870 invariant).
        let as_shot_tint = robertson_as_shot_tint(&frame, raw.as_shot_neutral);
        // #1967: compute the actual Rec.2020 transform used by the CPU path
        // for this render profile, instead of approximating it from ColorMatrix.
        let cam_to_rec2020 =
            crate::color::dcp::camera_to_rec2020_matrix(profile).unwrap_or(Matrix3::IDENTITY);
        match frame.endpoints {
            Some((m_cold, cct_cold, m_warm, cct_warm)) => SliderFrameExport {
                m_cold,
                cct_cold,
                m_warm,
                cct_warm,
                scene_cct: frame.scene_cct,
                as_shot_tint,
                cam_to_rec2020,
            },
            None => SliderFrameExport {
                m_cold: frame.cm_as_shot,
                cct_cold: frame.scene_cct,
                m_warm: frame.cm_as_shot,
                cct_warm: frame.scene_cct,
                scene_cct: frame.scene_cct,
                as_shot_tint,
                cam_to_rec2020,
            },
        }
    }

    /// Whether this export carries a real frame. A zero-initialised FFI
    /// struct (stale host, non-RAW input, `RawlerFallback` body) reads
    /// `scene_cct == 0` ⇒ absent ⇒ consumers keep the legacy generic
    /// path.
    pub fn is_present(&self) -> bool {
        self.scene_cct.is_finite() && self.scene_cct > 0.0
    }

    /// Reconstruct the working [`SliderFrame`] (endpoints + interpolated
    /// as-shot CM) from the flat data.
    fn to_frame(&self) -> SliderFrame {
        let dual = self.cct_warm - self.cct_cold >= 1.0;
        let endpoints = dual.then_some((self.m_cold, self.cct_cold, self.m_warm, self.cct_warm));
        let cm_as_shot = if dual {
            dcp::interpolate_cm(
                self.m_cold,
                self.cct_cold,
                self.m_warm,
                self.cct_warm,
                self.scene_cct,
            )
        } else {
            self.m_cold
        };
        SliderFrame {
            endpoints,
            cm_as_shot,
            scene_cct: self.scene_cct,
        }
    }

    /// The Rec.2020-space WB matrix that moves a buffer developed at
    /// slider `decoded` to the develop of slider `target`, both
    /// interpreted IN THIS FRAME (module doc). Exact [`Matrix3::IDENTITY`]
    /// inside the same half-Kelvin/half-tint band `apply_delta`
    /// short-circuits on, so a `target == decoded` render is bit-exact
    /// through a GPU matrix multiply. Falls back to the generic CAT16
    /// delta if the frame's calibration is singular (defensive — a real
    /// CM never is).
    pub fn rec2020_delta_matrix(&self, target: (f32, f32), decoded: (f32, f32)) -> Matrix3 {
        if (target.0 - decoded.0).abs() < 0.5 && (target.1 - decoded.1).abs() < 0.5 {
            return Matrix3::IDENTITY;
        }
        let frame = self.to_frame();
        // AsShotNeutral cancels in the ratio (module doc) — evaluate both
        // gains with the unit neutral. Green is exactly 1.0 in both, so
        // the ratio's green is exactly 1.0 too.
        let g_target = camera_wb_gain(&frame, [1.0, 1.0, 1.0], target.0, target.1);
        let g_decoded = camera_wb_gain(&frame, [1.0, 1.0, 1.0], decoded.0, decoded.1);
        let g_net = Matrix3([
            [g_target[0] / g_decoded[0].max(1e-6), 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, g_target[2] / g_decoded[2].max(1e-6)],
        ]);
        let cam_to_rec2020_absent = self.cam_to_rec2020.0.iter().flatten().all(|v| *v == 0.0);
        let c = if cam_to_rec2020_absent {
            frame_to_rec2020_legacy(&frame, self.scene_cct, self.as_shot_tint)
        } else {
            Some(self.cam_to_rec2020)
        };
        let conjugated = c
            .and_then(|c_mat| c_mat.inverse().map(|c_inv| c_mat.mul_mat(&g_net).mul_mat(&c_inv)));
        match conjugated {
            Some(m) => m,
            // Defensive: a singular calibration carries no usable frame —
            // behave exactly like the frame-absent legacy path.
            None => generic_cat16_delta(target, decoded),
        }
    }

    /// Apply [`Self::rec2020_delta_matrix`] in place to a scene-linear
    /// Rec.2020 image — the frame-aware sibling of
    /// `white_balance::apply_delta`, with the same bit-exact identity
    /// short-circuit at `target == decoded`.
    pub fn apply_delta_rec2020(&self, img: &mut Image, target: (f32, f32), decoded: (f32, f32)) {
        img.assert_space(ColorSpace::SceneLinearRec2020);
        if (target.0 - decoded.0).abs() < 0.5 && (target.1 - decoded.1).abs() < 0.5 {
            return; // identity short-circuit: live == decoded
        }
        let m = self.rec2020_delta_matrix(target, decoded);
        for p in &mut img.pixels {
            *p = m.mul_vec(*p);
        }
    }
}

/// The legacy generic Planckian CAT16 delta — `wb_cat16_matrix(target) ·
/// wb_cat16_matrix(decoded)⁻¹`, exactly the pre-#1781 GPU-live/chain
/// composition. Used as the singular-frame fallback above.
fn generic_cat16_delta(target: (f32, f32), decoded: (f32, f32)) -> Matrix3 {
    let m_target = wb_cat16_matrix(target.0, target.1);
    match wb_cat16_matrix(decoded.0, decoded.1).inverse() {
        Some(m_decoded_inv) => m_target.mul_mat(&m_decoded_inv),
        None => m_target,
    }
}

/// #1894: the same Robertson mapping [`SliderFrameExport::resolve`] reads
/// `as_shot_tint` off of (`dng_temperature::xy_to_temp_tint`), applied to
/// the frame's own scene-illuminant xy — the estimator half of the #1870
/// invariant this module's `frame_to_rec2020` must invert exactly.
fn robertson_as_shot_tint(frame: &SliderFrame, as_shot_neutral: [f32; 3]) -> f32 {
    let xyz = frame.scene_illuminant_xyz(as_shot_neutral);
    let sum = xyz[0] + xyz[1] + xyz[2];
    if !sum.is_finite() || sum < 1e-6 {
        return 0.0;
    }
    crate::color::dng_temperature::xy_to_temp_tint(xyz[0] / sum, xyz[1] / sum).1
}

/// The frame's camera→Rec.2020 transform legacy fallback: the DCP Bradford
/// fallback shape, built entirely from frame data. `w_frame` reconstructs
/// the frame's as-shot white from `(scene_cct, as_shot_tint)` via
/// [`crate::stages::white_balance::slider_source_xy`] (#1894, Robertson) —
/// the SAME mapping [`robertson_as_shot_tint`] read `as_shot_tint` off of,
/// so this is the exact inverse of the estimator half above (the #1870
/// estimator/render invariant).
/// Used only when the host passes an all-zero `cam_to_rec2020` (back-compat).
fn frame_to_rec2020_legacy(frame: &SliderFrame, scene_cct: f32, as_shot_tint: f32) -> Option<Matrix3> {
    let (wx, wy) = crate::stages::white_balance::slider_source_xy(scene_cct, as_shot_tint);
    let w_frame = xy_to_xyz(wx, wy, 1.0);
    let inv_pro = M_PRO_TO_XYZ_D50.inverse()?;
    let cam_to_xyz = frame.cm_as_shot.inverse()?;
    Some(
        m_pro_to_rec2020()
            .mul_mat(&inv_pro)
            .mul_mat(&bradford_adapt(w_frame, XYZ_D50))
            .mul_mat(&cam_to_xyz),
    )
}

#[cfg(test)]
#[path = "wb_frame_delta_tests.rs"]
mod tests;
