use super::*;
use crate::{buffers::maple_free_scene_linear_buffer_f32, cancel::*};
use std::ffi::CString;

#[test]
fn raster_base_is_owned_cancellable_and_unmodified_by_user_edits() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("source.jpg");
    let mut bytes = Vec::new();
    image::codecs::jpeg::JpegEncoder::new(&mut bytes)
        .encode(&[64; 32 * 24 * 3], 32, 24, image::ExtendedColorType::Rgb8)
        .unwrap();
    std::fs::write(&path, &bytes).unwrap();
    let path_c = CString::new(path.to_str().unwrap()).unwrap();
    unsafe {
        let mut buffer: MapleSceneLinearBufferF32 = std::mem::zeroed();
        assert_eq!(
            maple_decode_raster_base_file_f32(path_c.as_ptr(), 16, std::ptr::null(), &mut buffer),
            0
        );
        assert_eq!((buffer.width, buffer.height, buffer.channels), (16, 12, 4));
        assert!(buffer.wb_frame_scene_cct <= 0.0);
        assert!(buffer.camera_support_json.is_null());
        let pixels = std::slice::from_raw_parts(buffer.f32_rgba, 16 * 12 * 4);
        assert!(pixels
            .chunks_exact(4)
            .all(|p| (p[0] - 0.0513).abs() < 0.001 && p[3] == 1.0));
        maple_free_scene_linear_buffer_f32(&mut buffer);
        let flag = maple_cancel_flag_new();
        maple_cancel_flag_set(flag);
        let mut cancelled: MapleSceneLinearBufferF32 = std::mem::zeroed();
        assert_eq!(
            maple_decode_raster_base_file_f32(path_c.as_ptr(), 16, flag, &mut cancelled),
            4
        );
        assert!(cancelled.f32_rgba.is_null());
        maple_cancel_flag_free(flag);
    }
    assert_eq!(std::fs::read(path).unwrap(), bytes);
}

#[test]
fn shared_raster_validation_rejects_unsupported_settings_and_bad_arguments() {
    unsafe {
        assert_eq!(maple_validate_raster_adjustments(std::ptr::null()), 1);
        let defaults = CString::new("").unwrap();
        assert_eq!(maple_validate_raster_adjustments(defaults.as_ptr()), 0);
        let xml = CString::new(r#"<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:Whites2012="20"/></rdf:RDF>"#).unwrap();
        assert_eq!(maple_validate_raster_adjustments(xml.as_ptr()), 1);
        let mut buffer: MapleSceneLinearBufferF32 = std::mem::zeroed();
        assert_eq!(
            maple_decode_raster_base_file_f32(std::ptr::null(), 16, std::ptr::null(), &mut buffer),
            1
        );
        assert!(buffer.f32_rgba.is_null());
    }
}
