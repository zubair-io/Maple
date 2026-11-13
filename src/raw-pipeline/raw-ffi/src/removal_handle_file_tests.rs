//! Real retained owner: file/bytes opens verify once, pans do not reread assets.
use super::stage;
use crate::{
    buffers::{
        maple_free_scene_linear_buffer, maple_free_scene_linear_buffer_f32, MapleSceneLinearBuffer,
        MapleSceneLinearBufferF32,
    },
    handle::{
        maple_close_raw_handle, maple_open_raw_handle, maple_open_raw_handle_bytes,
        maple_render_handle_scene_linear_tile, maple_render_handle_scene_linear_tile_ae_f32,
        maple_render_handle_scene_linear_tile_f32,
    },
};
use std::ffi::CString;

#[test]
fn retained_file_and_bytes_handles_preserve_saved_scene_at_both_depths_without_asset_io() {
    for bytes in [false, true] {
        let (directory, raw_path, xmp_path, source) = stage();
        let xml = std::fs::read_to_string(xmp_path.to_str().unwrap()).unwrap();
        let model = raw_core::xmp::parse(&xml).unwrap();
        let raw = raw_core::decode_raw(&source, "dng").unwrap();
        let (saved, original) =
            crate::removal_file::prepare_saved(&raw, &source, &model, Some(directory.path()))
                .unwrap()
                .unwrap();
        let ext = CString::new("dng").unwrap();
        let mut handle = std::ptr::null_mut();
        unsafe {
            let rc = if bytes {
                maple_open_raw_handle_bytes(
                    source.as_ptr(),
                    source.len(),
                    ext.as_ptr(),
                    xmp_path.as_ptr(),
                    &mut handle,
                )
            } else {
                // Model snapshots need not sit beside immutable companions.
                let temp = tempfile::NamedTempFile::new().unwrap();
                std::fs::write(temp.path(), &xml).unwrap();
                let parameters = CString::new(temp.path().to_str().unwrap()).unwrap();
                maple_open_raw_handle(raw_path.as_ptr(), parameters.as_ptr(), &mut handle)
            };
            assert_eq!(rc, 0);
            std::fs::remove_dir_all(directory.path().join(".maple/inpaint")).unwrap();
            std::fs::remove_file(xmp_path.to_str().unwrap()).unwrap();
            for x in [0, 3] {
                let rect = raw_core::pipeline::TileRect {
                    src_x: x,
                    src_y: 2,
                    src_w: 8,
                    src_h: 4,
                    out_w: 8,
                    out_h: 4,
                };
                for gain in [1.0, 1.75] {
                    let expected = saved
                        .render_scene_linear_tile_f32(
                            &raw,
                            &original,
                            &model,
                            rect,
                            raw_core::pipeline::RenderQuality::Full,
                            None,
                            gain,
                        )
                        .unwrap();
                    let mut output = MapleSceneLinearBufferF32::empty();
                    let rc = if gain == 1.0 {
                        maple_render_handle_scene_linear_tile_f32(
                            handle,
                            x,
                            2,
                            8,
                            4,
                            8,
                            4,
                            0,
                            0.0,
                            0.0,
                            &mut output,
                        )
                    } else {
                        maple_render_handle_scene_linear_tile_ae_f32(
                            handle,
                            x,
                            2,
                            8,
                            4,
                            8,
                            4,
                            0,
                            0.0,
                            0.0,
                            gain,
                            &mut output,
                        )
                    };
                    assert_eq!(rc, 0);
                    assert_eq!((output.width, output.height), (expected.0, expected.1));
                    assert_eq!(
                        std::slice::from_raw_parts(output.f32_rgba, output.len_bytes / 4),
                        expected.2
                    );
                    assert_eq!(output.ae_gain, gain);
                    assert!(
                        output.whites_anchor_ev.is_nan(),
                        "Tiles cannot measure a Whites anchor"
                    );
                    maple_free_scene_linear_buffer_f32(&mut output);
                    if gain == 1.0 {
                        let mut half = MapleSceneLinearBuffer {
                            fp16_rgba: std::ptr::null_mut(),
                            len_bytes: 0,
                            width: 0,
                            height: 0,
                            channels: 0,
                            bytes_per_pixel: 0,
                        };
                        assert_eq!(
                            maple_render_handle_scene_linear_tile(
                                handle, x, 2, 8, 4, 8, 4, 0, 0.0, 0.0, &mut half
                            ),
                            0
                        );
                        assert_eq!(
                            std::slice::from_raw_parts(half.fp16_rgba, half.len_bytes / 2),
                            expected
                                .2
                                .iter()
                                .map(|value| raw_core::pipeline::f32_to_f16_bits(*value))
                                .collect::<Vec<_>>()
                        );
                        maple_free_scene_linear_buffer(&mut half);
                    }
                }
            }
            maple_close_raw_handle(handle);
        }
        assert_eq!(std::fs::read(raw_path.to_str().unwrap()).unwrap(), source);
    }
}

#[test]
fn incomplete_or_wrong_source_saved_handles_fail_open_without_a_partial_owner() {
    for bytes in [false, true] {
        let ext = CString::new("dng").unwrap();
        for changed in [false, true] {
            let (directory, raw, xmp, mut source) = stage();
            if changed {
                source.push(0);
                std::fs::write(raw.to_str().unwrap(), &source).unwrap();
            } else {
                std::fs::remove_dir_all(directory.path().join(".maple/inpaint")).unwrap();
            }
            let mut handle = std::ptr::null_mut();
            let rc = unsafe {
                if bytes {
                    maple_open_raw_handle_bytes(
                        source.as_ptr(),
                        source.len(),
                        ext.as_ptr(),
                        xmp.as_ptr(),
                        &mut handle,
                    )
                } else {
                    maple_open_raw_handle(raw.as_ptr(), xmp.as_ptr(), &mut handle)
                }
            };
            assert_ne!(rc, 0);
            assert!(handle.is_null());
        }
    }
}
