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

/// The borrowed HueSatMap-endpoint wire (#5099) from a host `(ptr, len)`.
/// Null, empty or malformed ⇒ `None` ⇒ the plain 3×3 delta. Kept only for
/// the hosts still on the scene-linear decode — Windows, Web and
/// Android/Linux — and removed when they take the capture decode (#5378,
/// #5379, #5380); Apple runs the creative stage instead (#5377).
///
/// # Safety
/// `ptr` must be valid for `len` `f32` reads for `'a`, or null.
pub(crate) unsafe fn wb_hsm_from_flat<'a>(
    ptr: *const f32,
    len: usize,
    as_shot_cct: f32,
    exposure_gain: f32,
) -> Option<raw_core::stages::wb_camera::HsmRetargetView<'a>> {
    if ptr.is_null() || len == 0 {
        return None;
    }
    raw_core::stages::wb_camera::HsmRetargetView::from_wire(
        std::slice::from_raw_parts(ptr, len),
        as_shot_cct,
        exposure_gain,
    )
}

/// The GPU WB pass's retargeted HueSatMap (#5099) for the GPU-live params,
/// borrowing the host's wire for the call; `None` without a valid wire or
/// inside the identity band. Callers engage it only on the frame-anchored
/// delta, whose Rec.2020 matrix is `wb_matrix`.
#[cfg(feature = "gpu")]
pub(crate) fn gpu_hsm_inputs<'a>(
    p: &'a crate::gpu_live::MapleGpuLiveParams,
    wb_frame: &raw_core::stages::wb_camera::SliderFrameExport,
    wb_matrix: [[f32; 3]; 3],
) -> Option<raw_gpu::WbHsmInputs<'a>> {
    // SAFETY: the host keeps `wb_hsm_ptr` valid for `wb_hsm_len` f32s for
    // the synchronous render call that owns `p`.
    let view = unsafe {
        wb_hsm_from_flat(
            p.wb_hsm_ptr,
            p.wb_hsm_len,
            p.wb_hsm_as_shot_cct,
            p.wb_hsm_exposure_gain,
        )
    }?;
    let tick = view.live_delta(
        wb_frame,
        raw_core::math::Matrix3(wb_matrix),
        (p.temperature, p.tint),
        (p.decoded_temperature, p.decoded_tint),
    )?;
    let tables = raw_gpu::WbHsmTables::Borrowed(view.tables);
    Some(raw_core::gpu_host::white_balance::wb_hsm_inputs(
        &view, tables, &tick,
    ))
}

/// The process-lifetime copy of a profile's table wire — the HueSatMap
/// endpoint wire (#5099) or the capture-first creative tables (#5377) —
/// shared by every decode of a body with the same profile tables. The decode
/// buffer hands hosts this pointer and never frees it, so a host stores it
/// with its decode and passes it back per tick without copying or pinning,
/// and no render can outlive it. One entry per distinct wire, so the set
/// stays as small as the set of camera profiles opened.
pub(crate) fn intern_table_wire(wire: &[f32]) -> &'static [f32] {
    static INTERNED: std::sync::Mutex<Vec<&'static [f32]>> = std::sync::Mutex::new(Vec::new());
    let mut interned = INTERNED
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    // Bitwise, so a table holding a NaN still finds its earlier copy.
    let same_bits = |known: &[f32]| {
        known.len() == wire.len()
            && known
                .iter()
                .zip(wire)
                .all(|(a, b)| a.to_bits() == b.to_bits())
    };
    if let Some(existing) = interned.iter().find(|known| same_bits(known)) {
        return existing;
    }
    let leaked: &'static [f32] = Box::leak(wire.to_vec().into_boxed_slice());
    interned.push(leaked);
    leaked
}

#[cfg(test)]
mod tests {
    #[test]
    fn interning_shares_one_copy_per_distinct_wire() {
        let a = super::intern_table_wire(&[1.0, 2.0, 3.0]);
        let b = super::intern_table_wire(&[1.0, 2.0, 3.0]);
        let c = super::intern_table_wire(&[1.0, 2.0, 4.0]);
        assert_eq!(a.as_ptr(), b.as_ptr());
        assert_ne!(a.as_ptr(), c.as_ptr());
        assert_eq!(c, &[1.0, 2.0, 4.0]);
        let nan = super::intern_table_wire(&[f32::NAN, 9.0]);
        assert_eq!(
            nan.as_ptr(),
            super::intern_table_wire(&[f32::NAN, 9.0]).as_ptr()
        );
    }
}
