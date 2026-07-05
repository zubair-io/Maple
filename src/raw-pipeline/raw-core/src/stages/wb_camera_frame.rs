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
}

impl SliderFrame {
    /// Resolve the slider frame for a source: the DNG's own embedded
    /// (non-identity — ticket #424's guarantee applies here too)
    /// dual-illuminant `ColorMatrix` PAIR when it ships one, else the
    /// resolved render profile's calibration.
    ///
    /// The dual-pair requirement is deliberate: ACR's slider→neutral
    /// mapping (`dng_color_spec.cpp::SetWhiteXY`) is built on the
    /// reciprocal-CCT interpolation BETWEEN two calibrations — that
    /// interpolation is what makes the scale camera-specific. A DNG that
    /// ships a single CM has no interpolation model to define a scale
    /// with, and empirically (test_0002, H2D-39, single embedded CM at a
    /// 4539.8 K frame reading vs the bundle's 5520.0 K) anchoring on it
    /// moves AWAY from the ACR references on balance — so single-CM
    /// sources stay on the render profile's frame. Vendor RAW formats
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
                }
            }
            // No usable embedded pair: the render profile IS the slider
            // frame (bundle for vendor RAW and single-CM DNGs, embedded
            // for the EmbeddedFull/EmbeddedCmOnly tiers — where profile
            // and frame coincide by construction).
            _ => SliderFrame {
                endpoints: profile
                    .cm_endpoints
                    .map(|e| (e.m_cold, e.cct_cold, e.m_warm, e.cct_warm)),
                cm_as_shot: profile.color_matrix,
                scene_cct: profile.scene_cct,
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
