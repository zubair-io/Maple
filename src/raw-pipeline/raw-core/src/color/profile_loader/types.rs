//! Data types for the bundled-profile lookup table.
//!
//! See the parent module ([`super`]) for the broader rationale —
//! this file holds just the two public types so the loader root and
//! the bundle parser can share them without depending on each other.

use std::collections::HashMap;

use crate::color::hsm::{HsmEncoding, HsmTable};
use crate::color::illuminant::Illuminant as CoreIlluminant;
use crate::math::Matrix3;

/// One bundled Maple profile — externally-DCP-derived, AgX-compatible (PTC/PLT
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
/// and the upstream tooling ships one DCP per such lens-tagged UCM. See the parent
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

/// One entry of the v3 split layout's **pool offset directory**.
///
/// The directory lives in the always-resident (uncompressed) index region, so
/// a client can compute the exact byte range of pool entry `N` — and later
/// range-fetch (#828) or slice (native) just that entry — without touching the
/// pool body at all. `offset`/`compressed_len` address the per-entry zlib
/// stream within the **pool region** (the `profiles.pool` asset); `dims` +
/// `encoding` let the decoder size and tag the inflated `HsmTable`. See the
/// v3 byte spec in [`super::writer`] and the design at PR #831.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PoolDirEntry {
    /// Byte offset of this entry's zlib stream within the pool region.
    pub offset: u32,
    /// Length in bytes of this entry's zlib stream within the pool region.
    pub compressed_len: u32,
    /// HSM grid dims `[hue, sat, val]`. The inflated f32 count is
    /// `dims[0] * dims[1] * dims[2] * 3`.
    pub dims: [u32; 3],
    /// HSM value encoding (Linear / sRGB).
    pub encoding: HsmEncoding,
}

/// One parsed v3 **index record** — matrices, illuminants, baseline-exposure
/// offset, and the *references* (`u32` pool indices) to this body's HSM
/// tables. Crucially carries NO HSM bytes: the index region is the ~263 KB
/// matrices-class part that resolves a body fully without inflating any pool
/// entry. The actual `HsmTable`s are materialized later, on demand, by reading
/// the referenced pool entries through the directory (the #828 lazy path; in
/// #829 the foundation only proves they are resolvable in isolation).
#[derive(Clone, Debug, PartialEq)]
pub struct IndexRecord {
    pub unique_camera_model: String,
    pub illum1: Option<CoreIlluminant>,
    pub illum2: Option<CoreIlluminant>,
    pub cm1: Option<Matrix3>,
    pub cm2: Option<Matrix3>,
    pub fm1: Option<Matrix3>,
    pub fm2: Option<Matrix3>,
    /// Pool index of `ProfileHueSatMapData1`, or `None` when this body ships
    /// no HSM1 (HSM flag bit clear).
    pub hsm1_pool_index: Option<u32>,
    /// Pool index of `ProfileHueSatMapData2`.
    pub hsm2_pool_index: Option<u32>,
    pub baseline_exposure_offset: f32,
}

/// The parsed v3 **index region**: every body's record plus the pool offset
/// directory — the always-resident part. Parsing this requires only the index
/// bytes (header + directory + records); the pool region is never touched.
/// This is the structural proof of correction #1 (index hoisted out of the
/// compressed region): a body's matrices + HSM pool indices resolve from this
/// struct alone.
#[derive(Clone, Debug, Default)]
pub struct ProfileIndex {
    pub records: HashMap<CameraKey, IndexRecord>,
    pub pool_dir: Vec<PoolDirEntry>,
}
