use crate::buffers::MapleSceneLinearBufferF32;
use crate::scene_linear_f32::flatten_matrix;

/// f32 counterpart to `write_scene_linear_buf`. Boxes the `Vec<f32>` and hands the raw parts to
/// the caller in a [`MapleSceneLinearBufferF32`]. `noise_profile`/`iso` are forwarded so the
/// per-tick FFI chain (`maple_apply_scene_linear_chain_f32`) can use them for profile-aware NR
/// (PR #1709 review fix). `ae_gain` (#1167) is the scalar auto-exposure anchor gain
/// `auto_exposure` applied to `f32_rgba` — see `MapleSceneLinearBufferF32::ae_gain`'s doc.
/// `support_raw` is supplied only on full/sized decode exports. Tiles pass `None`
/// because callers already have decode-level support and do not consume it per tile.
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
    support_raw: Option<&raw_core::RawImage>,
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
            camera_support_json: support_raw
                .and_then(|raw| raw_core::support_tiers::RenderSupport::resolve(raw).ok())
                .map(|support| {
                    std::ffi::CString::new(support.to_json())
                        .expect("JSON escapes NUL")
                        .into_raw()
                })
                .unwrap_or(std::ptr::null_mut()),
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::buffers::maple_free_scene_linear_buffer_f32;
    use crate::handle::{
        maple_close_raw_handle, maple_open_raw_handle,
        maple_render_handle_scene_linear_tile_ae_f32, maple_render_handle_scene_linear_tile_f32,
    };
    use crate::scene_linear_f32::maple_render_file_scene_linear_sized_f32;
    use raw_core::test_support::synth_dng::SyntheticGreyDng;
    use std::ffi::{CStr, CString};

    #[test]
    fn support_json_escapes_camera_key_nul_for_ffi() {
        let support = raw_core::support_tiers::RenderSupport {
            camera_key: "Camera\0Body\n\t\"\\".into(),
            resolution: raw_core::support_tiers::ProfileResolution::RawlerFallback,
            lens: raw_core::support_tiers::LensSupport::NoCorrectionData,
        };
        let transport = CString::new(support.to_json()).unwrap();
        let recovered: serde_json::Value = serde_json::from_slice(transport.as_bytes()).unwrap();
        assert_eq!(recovered["cameraKey"], support.camera_key);
        assert!(transport
            .as_bytes()
            .windows(6)
            .any(|bytes| bytes == b"\\u0000"));
    }

    #[test]
    fn repeated_tiles_do_not_export_decode_level_camera_support() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("support-tile.dng");
        SyntheticGreyDng {
            width: 32,
            height: 32,
            ..Default::default()
        }
        .write_to(&path)
        .unwrap();
        let path = CString::new(path.to_str().unwrap()).unwrap();
        let mut handle = std::ptr::null_mut();
        unsafe {
            assert_eq!(
                maple_open_raw_handle(path.as_ptr(), std::ptr::null(), &mut handle),
                0
            );
            let mut previous = None;
            for ae_aware in [false, true, false, true] {
                let mut buffer = MapleSceneLinearBufferF32::empty();
                let rc = if ae_aware {
                    maple_render_handle_scene_linear_tile_ae_f32(
                        handle,
                        4,
                        4,
                        16,
                        16,
                        16,
                        16,
                        0,
                        0.0,
                        0.0,
                        1.0,
                        &mut buffer,
                    )
                } else {
                    maple_render_handle_scene_linear_tile_f32(
                        handle,
                        4,
                        4,
                        16,
                        16,
                        16,
                        16,
                        0,
                        0.0,
                        0.0,
                        &mut buffer,
                    )
                };
                assert_eq!(rc, 0);
                assert_eq!(
                    (buffer.width, buffer.height, buffer.len_bytes),
                    (16, 16, 4096)
                );
                let omitted = buffer.camera_support_json.is_null();
                let pixels = std::slice::from_raw_parts(buffer.f32_rgba, 1024).to_vec();
                maple_free_scene_linear_buffer_f32(&mut buffer);
                assert!(omitted, "tiles must not allocate camera-support metadata");
                if let Some(expected) = &previous {
                    assert_eq!(&pixels, expected, "AE=1 preserves tile pixels");
                }
                previous = Some(pixels);
            }
            maple_close_raw_handle(handle);
        }
    }

    #[test]
    fn decoded_support_is_owned_by_the_pixel_buffer_and_cleared_on_free() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("support-buffer.dng");
        SyntheticGreyDng {
            width: 32,
            height: 32,
            ..Default::default()
        }
        .write_to(&path)
        .unwrap();
        let path = CString::new(path.to_str().unwrap()).unwrap();
        let mut buffer = MapleSceneLinearBufferF32::empty();
        unsafe {
            let rc = maple_render_file_scene_linear_sized_f32(
                path.as_ptr(),
                std::ptr::null(),
                32,
                1,
                std::ptr::null(),
                &mut buffer,
            );
            assert_eq!(rc, 0);
            assert!(buffer.len_bytes > 0);
            assert!(!buffer.camera_support_json.is_null());
            let json = CStr::from_ptr(buffer.camera_support_json)
                .to_str()
                .unwrap()
                .to_owned();
            assert!(
                json.contains("\"resolution\":\"rawler_fallback\""),
                "{json}"
            );
            assert!(json.contains("\"lens\":\"no_correction_data\""), "{json}");
            maple_free_scene_linear_buffer_f32(&mut buffer);
            assert!(buffer.camera_support_json.is_null());
            assert!(buffer.f32_rgba.is_null());
            assert_eq!(buffer.len_bytes, 0);
            maple_free_scene_linear_buffer_f32(&mut buffer);
        }
    }
}
