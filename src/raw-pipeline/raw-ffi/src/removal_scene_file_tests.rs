//! Existing native scene-linear boundaries preserve saved edits at both depths.
use super::stage;
use crate::buffers::{
    maple_free_scene_linear_buffer, maple_free_scene_linear_buffer_f32, MapleSceneLinearBuffer,
    MapleSceneLinearBufferF32,
};
use std::ffi::CString;

#[test]
fn all_scene_handoffs_match_verified_full_and_sized_core_without_display_clipping() {
    let (directory, raw_path, xmp_path, source) = stage();
    let xml = std::fs::read_to_string(xmp_path.to_str().unwrap()).unwrap();
    let xml = xml.replace("papp:InpaintRemovals=", "xmlns:crs=\"http://ns.adobe.com/camera-raw-settings/1.0/\" crs:Exposure2012=\"3\" papp:InpaintRemovals=");
    std::fs::write(xmp_path.to_str().unwrap(), &xml).unwrap();
    let model = raw_core::xmp::parse(&xml).unwrap();
    let raw = raw_core::decode_raw(&source, "dng").unwrap();
    let (saved, original) =
        crate::removal_file::prepare_saved(&raw, &source, &model, Some(directory.path()))
            .unwrap()
            .unwrap();
    let ext = CString::new("dng").unwrap();
    for cap in [None, Some(4)] {
        let (w, h, expected, gain, whites) = saved
            .render_scene_linear_f32_with_anchors(
                &raw,
                &original,
                &model,
                raw_core::pipeline::RenderQuality::Auto,
                cap,
                raw_core::CancelToken::never(),
            )
            .unwrap();
        assert!(
            expected.iter().any(|value| *value > 1.0),
            "HDR scene samples must survive the handoff"
        );
        for bytes in [false, true] {
            unsafe {
                let mut image = MapleSceneLinearBufferF32::empty();
                let rc = match (bytes, cap) {
                    (false, None) => crate::scene_linear_f32::maple_render_file_scene_linear_f32(
                        raw_path.as_ptr(),
                        xmp_path.as_ptr(),
                        3,
                        std::ptr::null(),
                        &mut image,
                    ),
                    (false, Some(cap)) => {
                        crate::scene_linear_f32::maple_render_file_scene_linear_sized_f32(
                            raw_path.as_ptr(),
                            xmp_path.as_ptr(),
                            cap,
                            3,
                            std::ptr::null(),
                            &mut image,
                        )
                    }
                    (true, None) => crate::scene_linear_f32::maple_render_bytes_scene_linear_f32(
                        source.as_ptr(),
                        source.len(),
                        ext.as_ptr(),
                        xmp_path.as_ptr(),
                        3,
                        std::ptr::null(),
                        &mut image,
                    ),
                    (true, Some(cap)) => {
                        crate::scene_linear_f32::maple_render_bytes_scene_linear_sized_f32(
                            source.as_ptr(),
                            source.len(),
                            ext.as_ptr(),
                            xmp_path.as_ptr(),
                            cap,
                            3,
                            std::ptr::null(),
                            &mut image,
                        )
                    }
                };
                assert_eq!(rc, 0);
                assert_eq!((image.width, image.height), (w, h));
                assert_eq!(image.ae_gain, gain);
                assert_eq!(image.whites_anchor_ev, whites);
                assert_eq!(
                    std::slice::from_raw_parts(image.f32_rgba, image.len_bytes / 4),
                    expected
                );
                maple_free_scene_linear_buffer_f32(&mut image);
                let mut image = MapleSceneLinearBuffer {
                    fp16_rgba: std::ptr::null_mut(),
                    len_bytes: 0,
                    width: 0,
                    height: 0,
                    channels: 0,
                    bytes_per_pixel: 0,
                };
                let rc = match (bytes, cap) {
                    (false, None) => crate::scene_linear::maple_render_file_scene_linear(
                        raw_path.as_ptr(),
                        xmp_path.as_ptr(),
                        3,
                        &mut image,
                    ),
                    (false, Some(cap)) => {
                        crate::scene_linear::maple_render_file_scene_linear_sized(
                            raw_path.as_ptr(),
                            xmp_path.as_ptr(),
                            cap,
                            3,
                            &mut image,
                        )
                    }
                    (true, None) => crate::scene_linear::maple_render_bytes_scene_linear(
                        source.as_ptr(),
                        source.len(),
                        ext.as_ptr(),
                        xmp_path.as_ptr(),
                        3,
                        &mut image,
                    ),
                    (true, Some(cap)) => {
                        crate::scene_linear::maple_render_bytes_scene_linear_sized(
                            source.as_ptr(),
                            source.len(),
                            ext.as_ptr(),
                            xmp_path.as_ptr(),
                            cap,
                            3,
                            &mut image,
                        )
                    }
                };
                assert_eq!(rc, 0);
                assert_eq!((image.width, image.height), (w, h));
                assert_eq!(
                    std::slice::from_raw_parts(image.fp16_rgba, image.len_bytes / 2),
                    expected
                        .iter()
                        .map(|value| raw_core::pipeline::f32_to_f16_bits(*value))
                        .collect::<Vec<_>>()
                );
                maple_free_scene_linear_buffer(&mut image);
            }
        }
    }
    assert_eq!(std::fs::read(raw_path.to_str().unwrap()).unwrap(), source);
    assert_ne!(model.inpaint_removals, Vec::new());
}

#[test]
fn scene_decode_refuses_missing_companions_and_changed_original_on_a_warm_mosaic() {
    for failure in ["missing", "changed"] {
        let (directory, raw, xmp, mut source) = stage();
        unsafe {
            let mut image = MapleSceneLinearBufferF32::empty();
            assert_eq!(
                crate::scene_linear_f32::maple_render_file_scene_linear_sized_f32(
                    raw.as_ptr(),
                    xmp.as_ptr(),
                    4,
                    3,
                    std::ptr::null(),
                    &mut image
                ),
                0
            );
            maple_free_scene_linear_buffer_f32(&mut image);
            if failure == "missing" {
                std::fs::remove_dir_all(directory.path().join(".maple/inpaint")).unwrap();
            } else {
                source.push(0);
                std::fs::write(raw.to_str().unwrap(), &source).unwrap();
            }
            assert_eq!(
                crate::scene_linear_f32::maple_render_file_scene_linear_sized_f32(
                    raw.as_ptr(),
                    xmp.as_ptr(),
                    4,
                    3,
                    std::ptr::null(),
                    &mut image
                ),
                8
            );
            assert!(image.f32_rgba.is_null());
            assert_eq!(image.len_bytes, 0);
        }
    }
}
