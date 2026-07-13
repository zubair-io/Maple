//! [`WbFrameFlat`] + [`wb_frame_from_flat`] — the flat-float ↔
//! `raw_core::stages::wb_camera::SliderFrameExport` bridge shared by every
//! `wb_frame_*` FFI-tail consumer (#1781/#1967). Split out of
//! `scene_linear_chain.rs` per the 600-LOC budget: this bridge is used by
//! THREE call sites (the fp16 chain in `scene_linear_chain.rs`, the f32
//! chain in `scene_linear_chain_f32_entry.rs`, and the GPU-live params in
//! `gpu_live/params.rs`), so a standalone module is also the more honest
//! home for it than embedding it in one specific chain's file.

/// The flat `wb_frame_*` fields grouped for [`wb_frame_from_flat`] — the
/// matrices borrowed from the caller's C params struct (`[f32; 9]` tail
/// fields), the scalars by value. Grouping keeps the reconstruction under
/// the repo's ≤5-parameter rule (CONTRIBUTING.md) instead of a
/// `too_many_arguments` suppression.
pub(crate) struct WbFrameFlat<'a> {
    pub m_cold: &'a [f32; 9],
    pub cct_cold: f32,
    pub m_warm: &'a [f32; 9],
    pub cct_warm: f32,
    pub scene_cct: f32,
    pub as_shot_tint: f32,
    /// Render-profile CM (XYZ→camera) — the delta's conjugation basis
    /// (#1965) when the #1967 fields below are absent. All-zero ⇒ absent
    /// ⇒ `to_frame` falls back to the value frame.
    pub render_cm: &'a [f32; 9],
    /// #1967: render-profile linear-core detail — see
    /// `raw_core::stages::wb_camera::SliderFrameExport`'s `render_*`
    /// fields for the exact semantics each of these mirrors.
    pub render_forward_matrix: &'a [f32; 9],
    pub render_scene_white_xyz: &'a [f32; 3],
    pub render_wb_already_baked: f32,
    pub render_cm_cold: &'a [f32; 9],
    pub render_cct_cold: f32,
    pub render_cm_warm: &'a [f32; 9],
    pub render_cct_warm: f32,
    pub render_fm_cold: &'a [f32; 9],
    pub render_fm_warm: &'a [f32; 9],
}

/// Rebuild the raw-core [`raw_core::stages::wb_camera::SliderFrameExport`]
/// from the flat `wb_frame_*` fields (#1781). An absent frame
/// (`scene_cct <= 0` or non-finite, e.g. a zero-initialised stale host)
/// maps to `SliderFrameExport::ABSENT`, whose `is_present()` is false —
/// consumers then keep the legacy generic-CAT16 path, and no unchecked
/// host floats leak into the export.
pub(crate) fn wb_frame_from_flat(
    f: &WbFrameFlat,
) -> raw_core::stages::wb_camera::SliderFrameExport {
    if !(f.scene_cct.is_finite() && f.scene_cct > 0.0) {
        return raw_core::stages::wb_camera::SliderFrameExport::ABSENT;
    }
    let mat = |m: &[f32; 9]| {
        raw_core::math::Matrix3([[m[0], m[1], m[2]], [m[3], m[4], m[5]], [m[6], m[7], m[8]]])
    };
    raw_core::stages::wb_camera::SliderFrameExport {
        m_cold: mat(f.m_cold),
        cct_cold: f.cct_cold,
        m_warm: mat(f.m_warm),
        cct_warm: f.cct_warm,
        scene_cct: f.scene_cct,
        as_shot_tint: f.as_shot_tint,
        render_cm: mat(f.render_cm),
        render_forward_matrix: mat(f.render_forward_matrix),
        render_scene_white_xyz: *f.render_scene_white_xyz,
        render_wb_already_baked: f.render_wb_already_baked,
        render_cm_cold: mat(f.render_cm_cold),
        render_cct_cold: f.render_cct_cold,
        render_cm_warm: mat(f.render_cm_warm),
        render_cct_warm: f.render_cct_warm,
        render_fm_cold: mat(f.render_fm_cold),
        render_fm_warm: mat(f.render_fm_warm),
    }
}
