use crate::buffers::MapleSceneLinearBufferF32;
use crate::scene_linear_f32::flatten_matrix;

/// f32 counterpart to `write_scene_linear_buf`. Boxes the `Vec<f32>` and hands the raw parts to
/// the caller in a [`MapleSceneLinearBufferF32`]. `noise_profile`/`iso` are forwarded so the
/// per-tick FFI chain (`maple_apply_scene_linear_chain_f32`) can use them for profile-aware NR
/// (PR #1709 review fix). `ae_gain` (#1167) is the scalar auto-exposure anchor gain
/// `auto_exposure` applied to `f32_rgba` — see `MapleSceneLinearBufferF32::ae_gain`'s doc.
pub(crate) fn write_scene_linear_buf_f32(
    out_ptr: usize,
    w: u32,
    h: u32,
    f32_rgba: Vec<f32>,
    noise_profile: Option<&[f32]>,
    iso: u32,
    wb_frame: &raw_core::stages::wb_camera::SliderFrameExport,
    ae_gain: f32,
    has_lens_corrections: bool,
    lens_correction_ca_inert: bool,
    lens_correction_distortion_inert: bool,
    raw: &raw_core::RawImage,
) {
    let (f32_ptr, _len_lanes, len_bytes) = raw_core::pipeline::stage("ffi_pack_f32", || {
        let mut boxed = f32_rgba.into_boxed_slice();
        let p = boxed.as_mut_ptr();
        let n = boxed.len();
        std::mem::forget(boxed);
        (p, n, n * std::mem::size_of::<f32>())
    });
    // Box the noise profile if present so it's heap-owned and can be freed
    // by `maple_free_scene_linear_buffer_f32`.
    let (np_ptr, np_len) = if let Some(profile) = noise_profile {
        let mut boxed = profile.to_vec().into_boxed_slice();
        let p = boxed.as_mut_ptr();
        let n = boxed.len();
        std::mem::forget(boxed);
        (p, n as u32)
    } else {
        (std::ptr::null_mut(), 0u32)
    };
    unsafe {
        *(out_ptr as *mut MapleSceneLinearBufferF32) = MapleSceneLinearBufferF32 {
            f32_rgba: f32_ptr,
            len_bytes,
            channels: 4,
            bytes_per_pixel: 16,
            width: w,
            height: h,
            noise_profile_data: np_ptr,
            noise_profile_len: np_len,
            iso,
            wb_frame_m_cold: flatten_matrix(wb_frame.m_cold),
            wb_frame_cct_cold: wb_frame.cct_cold,
            wb_frame_m_warm: flatten_matrix(wb_frame.m_warm),
            wb_frame_cct_warm: wb_frame.cct_warm,
            wb_frame_scene_cct: wb_frame.scene_cct,
            wb_frame_as_shot_tint: wb_frame.as_shot_tint,
            wb_frame_render_cm: flatten_matrix(wb_frame.render_cm),
            wb_frame_render_forward_matrix: flatten_matrix(wb_frame.render_forward_matrix),
            wb_frame_render_scene_white_xyz: wb_frame.render_scene_white_xyz,
            wb_frame_render_wb_already_baked: wb_frame.render_wb_already_baked,
            wb_frame_render_cm_cold: flatten_matrix(wb_frame.render_cm_cold),
            wb_frame_render_cct_cold: wb_frame.render_cct_cold,
            wb_frame_render_cm_warm: flatten_matrix(wb_frame.render_cm_warm),
            wb_frame_render_cct_warm: wb_frame.render_cct_warm,
            wb_frame_render_fm_cold: flatten_matrix(wb_frame.render_fm_cold),
            wb_frame_render_fm_warm: flatten_matrix(wb_frame.render_fm_warm),
            ae_gain,
            has_lens_corrections: has_lens_corrections as u32,
            lens_correction_ca_inert: lens_correction_ca_inert as u32,
            lens_correction_distortion_inert: lens_correction_distortion_inert as u32,
            camera_support_json: raw_core::support_tiers::RenderSupport::resolve(raw)
                .ok()
                .map(|support| {
                    std::ffi::CString::new(support.to_json())
                        .expect("JSON escapes NUL")
                        .into_raw()
                })
                .unwrap_or(std::ptr::null_mut()),
        };
    }
}
