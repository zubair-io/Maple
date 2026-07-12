//! [`SliderFrame`] — the calibration frame the WB temperature/tint sliders
//! are interpreted in (#1727). Split from `wb_camera.rs` for the 600-line
//! file budget; `stages::wb_camera` re-exports [`SliderFrame`] so callers
//! keep addressing it as `wb_camera::SliderFrame`. See the `wb_camera`
//! module doc for the full design writeup.

use crate::{
    color::dcp::{self, DcpProfile},
    image::RawImage,
    math::Matrix3,
};

/// The calibration frame the WB temperature/tint sliders are interpreted in
/// (#1727).
///
/// ACR's slider scale is defined by the profile ACR itself renders with:
/// for DNGs that's the file's EMBEDDED `ColorMatrix1/2` pair; for vendor
/// RAWs it's the Adobe DCP for the body (Maple's bundle carries the same
/// matrices). Maple's RENDER profile can legitimately differ from that
/// frame — the resolver prefers the bundle even when the DNG ships its own
/// CMs (`BundleConfident` beats `EmbeddedCmOnly`) — and when the two frames
/// disagree about the scene illuminant, the slider VALUES still mean what
/// ACR means by them, because that is the scale the reference renders (and
/// any ACR-authored XMP) encoded.
///
/// Measured on test_0000 (DJI L3D-100c DNG): the bundle-frame as-shot CCT
/// is 7471.6 K but the embedded-frame as-shot is 5507.7 K — ACR's own
/// "Daylight" preset (5500 K) is a near-no-op for that image
/// (embedded-frame gain ≈ `[1.04, 1, 1.06]`). Interpreting 5500 K in the
/// bundle frame instead applied a spurious ~48-mired cool shift — the
/// `wb_daylight` 8.81 → 17.46 ΔE acceptance miss this frame fixes. The
/// pre-#1727 post-DCP CAT16 path's constant ≈28-mired error on the same
/// body (its fixed 6500 K anchor vs ACR's 5508 K) is the same phenomenon
/// from the other side.
///
/// ## Single embedded CM (#1894)
///
/// A DNG that ships exactly one non-identity embedded `ColorMatrix` IS now
/// accepted as its own slider frame (`endpoints: None`, `cm_as_shot` = the
/// single CM, `scene_cct` from the Robertson solve at that CM — see
/// [`Self::resolve`]'s single-CM arm). Before #1894 this case fell through
/// to the render-profile frame instead: the original measurement backing
/// that choice (test_0002, H2D-39 — single embedded CM read a 4539.8 K
/// as-shot vs the bundle's 5520.0 K, and anchoring on the embedded reading
/// moved AWAY from the ACR references on balance) was confounded by two
/// bugs fixed since: the tint scale was 3.33× too small (#1893, so any
/// off-locus embedded-CM as-shot railed toward the slider's clamp instead
/// of landing where ACR displays it), and the CCT solve was McCamy's
/// polynomial rather than Robertson (#1894, a different curve than the one
/// ACR itself derives its displayed CCT from). With both fixed,
/// `dcp::estimate_as_shot_cct_tint(test_0002)` in the single-CM embedded
/// frame measures 4522.4 K / −43.79 tint — within 100 K of ACR's displayed
/// 4450 K, but 9.2 tint units off ACR's displayed −53 (measured directly
/// against this fixture during #1894 development; NOT independently
/// re-verified against a fresh ACR reading here). The legacy
/// McCamy+Hernández-Andrés estimate on this SAME embedded-CM xy point
/// gives 4539.8 K / −53.1 — near-exact agreement with ACR's number — so
/// the residual gap is a real, measured divergence between the Robertson
/// and legacy curve fits at this specific (far off-locus) chromaticity,
/// not a bug in the glue code wiring this frame together: the Robertson
/// solve here is a self-consistent round trip (`temp_tint_to_xy` of the
/// result reproduces the measured xy to ~1e-4).
pub struct SliderFrame {
    /// Dual-illuminant endpoints `(m_cold, cct_cold, m_warm, cct_warm)`
    /// when the frame has two calibrations; `None` for a single-CM frame.
    pub(super) endpoints: Option<(Matrix3, f32, Matrix3, f32)>,
    /// CM at [`Self::scene_cct`] (endpoints interpolated there, or the
    /// single CM).
    pub(super) cm_as_shot: Matrix3,
    /// As-shot CCT in THIS frame — the temperature at which the slider is
    /// an identity for this image.
    pub scene_cct: f32,
    /// The RENDER PROFILE's camera→XYZ calibration (`profile.color_matrix`)
    /// — the basis the developed buffer actually lives in. Distinct from
    /// `cm_as_shot` (the VALUE frame, ACR's slider scale) for embedded-CM
    /// bodies whose value frame differs from the bundle render profile
    /// (#1894). The GPU-live post-DCP delta conjugates the camera-space
    /// gain through THIS, not the value frame — the physical as-shot white
    /// it Bradford-adapts from is frame-independent, so only the CM (the
    /// buffer's actual transform) must match the render profile (#1904
    /// GPU-live seam fix).
    pub(super) render_cm: Matrix3,
}

impl SliderFrame {
    /// Resolve the slider frame for a source: the DNG's own embedded
    /// (non-identity — ticket #424's guarantee applies here too)
    /// dual-illuminant `ColorMatrix` PAIR when it ships one, a single
    /// embedded non-identity CM when it ships exactly that (#1894, see the
    /// struct doc's "Single embedded CM" section), else the resolved
    /// render profile's calibration.
    ///
    /// The dual-pair case additionally interpolates: ACR's slider→neutral
    /// mapping (`dng_color_spec.cpp::SetWhiteXY`) is built on the
    /// reciprocal-CCT interpolation BETWEEN two calibrations when a DNG
    /// ships two — that interpolation is what makes the scale
    /// camera-specific across the whole slider range. Vendor RAW formats
    /// never populate `raw.color_matrices` at all (decode.rs § 8 gates on
    /// DNG-shaped sources), so they always land on the profile branch —
    /// which is ACR's frame for them as well, since the bundle ships the
    /// same Adobe matrices ACR uses for non-DNG bodies.
    pub fn resolve(raw: &RawImage, profile: &DcpProfile) -> SliderFrame {
        let entries = {
            let mut entries: Vec<(f32, Matrix3)> = raw
                .color_matrices
                .iter()
                .filter(|(_, m)| !dcp::is_approx_identity(m))
                .map(|(i, m)| (i.cct(), *m))
                .collect();
            entries.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
            entries
        };
        // Render profile's conjugation basis — same for every branch. #1904.
        let render_cm = profile.color_matrix;
        match entries.as_slice() {
            // Dual embedded calibration with distinct illuminants: the DNG
            // spec frame — reciprocal-CCT interpolation between the pair,
            // as-shot CCT from the same iterative solve the render
            // resolver uses. (Sorted by CCT above, so first = coldest,
            // last = warmest.)
            [(cct_cold, m_cold), .., (cct_warm, m_warm)] if cct_warm - cct_cold >= 1.0 => {
                let scene_cct = dcp::compute_as_shot_cct(
                    raw.as_shot_neutral,
                    *m_cold,
                    *cct_cold,
                    *m_warm,
                    *cct_warm,
                );
                SliderFrame {
                    endpoints: Some((*m_cold, *cct_cold, *m_warm, *cct_warm)),
                    cm_as_shot: dcp::interpolate_cm(
                        *m_cold, *cct_cold, *m_warm, *cct_warm, scene_cct,
                    ),
                    scene_cct,
                    render_cm,
                }
            }
            // Single embedded non-identity CM (#1894): its own frame, no
            // interpolation model (nothing to interpolate between — a
            // single fixed CM needs no `compute_as_shot_cct` iteration,
            // and feeding it `interpolate_cm` with equal cold/warm
            // endpoints would divide by zero in the reciprocal-CCT `t`),
            // and `scene_cct` from a direct Robertson solve at that one
            // CM: `inv(m_single) · as_shot_neutral`, normalized to xy, fed
            // through `dng_temperature::xy_to_temp_tint`.
            [(_, m_single)] => {
                let scene_cct =
                    single_cm_robertson_cct(*m_single, raw.as_shot_neutral, profile.scene_cct);
                SliderFrame {
                    endpoints: None,
                    cm_as_shot: *m_single,
                    scene_cct,
                    render_cm,
                }
            }
            // No usable embedded calibration at all: the render profile IS
            // the slider frame (bundle for vendor RAW, embedded for the
            // EmbeddedFull/EmbeddedCmOnly tiers — where profile and frame
            // coincide by construction).
            _ => SliderFrame {
                endpoints: profile
                    .cm_endpoints
                    .map(|e| (e.m_cold, e.cct_cold, e.m_warm, e.cct_warm)),
                cm_as_shot: profile.color_matrix,
                scene_cct: profile.scene_cct,
                render_cm,
            },
        }
    }

    /// The frame's ColorMatrix re-interpolated at an arbitrary CCT (the
    /// DNG-spec xy→neutral direction), mirroring
    /// `DcpProfile::color_matrix_for_cct`.
    pub(super) fn cm_for_cct(&self, cct: f32) -> Matrix3 {
        match self.endpoints {
            Some((m_cold, cct_cold, m_warm, cct_warm)) => {
                dcp::interpolate_cm(m_cold, cct_cold, m_warm, cct_warm, cct)
            }
            None => self.cm_as_shot,
        }
    }

    /// The scene illuminant's XYZ chromaticity in this frame:
    /// `normalize(inv(CM_as_shot) · as_shot_neutral)`. This is the same
    /// quantity `dcp::estimate_as_shot_cct_tint` derives in the render
    /// profile's frame — needed here for the frame-consistent tint half of
    /// the as-shot estimate.
    pub fn scene_illuminant_xyz(&self, as_shot_neutral: [f32; 3]) -> [f32; 3] {
        self.cm_as_shot
            .inverse()
            .map(|inv| {
                let xyz = inv.mul_vec(as_shot_neutral);
                if xyz[1].abs() < 1e-8 {
                    return crate::color::matrices::XYZ_D65;
                }
                let s = 1.0 / xyz[1];
                [xyz[0] * s, 1.0, xyz[2] * s]
            })
            .unwrap_or(crate::color::matrices::XYZ_D65)
    }
}

/// Direct (non-iterative) Robertson as-shot CCT for a single fixed
/// calibration matrix (#1894): `inv(cm) · as_shot_neutral`, normalized to
/// xy, fed through `dng_temperature::xy_to_temp_tint`. No fixed-point
/// iteration is needed here (unlike the dual-endpoint
/// `dcp::compute_as_shot_cct`) because a single CM's projection doesn't
/// depend on the CCT being solved for. Falls back to `fallback` (the
/// render profile's own `scene_cct`) on a singular matrix or a degenerate
/// (non-finite / near-zero-sum) projected XYZ — defensive; a real
/// embedded calibration is invertible and produces a physically valid
/// neutral.
fn single_cm_robertson_cct(cm: Matrix3, as_shot_neutral: [f32; 3], fallback: f32) -> f32 {
    let Some(inv) = cm.inverse() else {
        return fallback;
    };
    let xyz = inv.mul_vec(as_shot_neutral);
    let sum = xyz[0] + xyz[1] + xyz[2];
    if !sum.is_finite() || sum < 1e-6 {
        return fallback;
    }
    crate::color::dng_temperature::xy_to_temp_tint(xyz[0] / sum, xyz[1] / sum).0
}
