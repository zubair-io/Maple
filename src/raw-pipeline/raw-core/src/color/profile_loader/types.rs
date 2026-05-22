//! Data types for the bundled-profile lookup table.
//!
//! See the parent module ([`super`]) for the broader rationale —
//! this file holds just the two public types so the loader root and
//! the bundle parser can share them without depending on each other.

use crate::color::hsm::HsmTable;
use crate::color::illuminant::Illuminant as CoreIlluminant;
use crate::math::Matrix3;

/// One bundled Maple profile — Adobe-DCP-derived, AgX-compatible (PTC/PLT
/// dropped at conversion time). Stored as `'static` in `PROFILE_TABLE`.
#[derive(Clone, Debug)]
pub struct MapleProfile {
    /// Unique camera key from DCP `UniqueCameraModel` (tag 50708). Apple
    /// per-lens variants like `"iPhone13,3 back telephoto camera"` are
    /// distinct keys — the lens disambiguation happens at lookup time.
    pub unique_camera_model: String,
    /// DCP calibration illuminant 1 (typically StdA / 2856K). `None` when
    /// the source DCP omitted CM1.
    pub illum1: Option<CoreIlluminant>,
    /// DCP calibration illuminant 2 (typically D65 / 6504K). `None` when
    /// the source DCP omitted CM2.
    pub illum2: Option<CoreIlluminant>,
    /// `ColorMatrix1` (XYZ → camera at illuminant 1).
    pub cm1: Option<Matrix3>,
    /// `ColorMatrix2` (XYZ → camera at illuminant 2).
    pub cm2: Option<Matrix3>,
    /// `ForwardMatrix1` (camera → XYZ-D50). Absent in ~11/1447 bodies; DCP
    /// falls back to Bradford CA when missing.
    pub fm1: Option<Matrix3>,
    /// `ForwardMatrix2` (camera → XYZ-D50). Same shape as `fm1`.
    pub fm2: Option<Matrix3>,
    /// `ProfileHueSatMapData1` — pre-allocated `HsmTable`. `None` when the
    /// bundle was built without HSM (current default) or when the DCP omits
    /// HSM entirely (322/1447 bodies).
    pub hsm1: Option<HsmTable>,
    /// `ProfileHueSatMapData2`.
    pub hsm2: Option<HsmTable>,
    /// Per-image baseline-exposure offset from DCP tag 51109. Default 0.0.
    /// Composed additively with the DNG-level `BaselineExposure` tag at
    /// decode time (see `decode.rs` § 1b).
    pub baseline_exposure_offset: f32,
}

/// Resolved camera identity used as the lookup key. The DNG
/// `UniqueCameraModel` string is the full key — for multi-lens mobile
/// cameras the lens variant is already encoded in the UCM by the vendor
/// (e.g. `iPhone13,3 back camera` vs `iPhone13,3 back telephoto camera`),
/// and Adobe ships one DCP per such lens-tagged UCM. See the parent
/// module's docstring for the keying rationale.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct CameraKey {
    pub unique_camera_model: String,
}

impl CameraKey {
    pub fn new(unique_camera_model: impl Into<String>) -> Self {
        Self {
            unique_camera_model: unique_camera_model.into(),
        }
    }
}
