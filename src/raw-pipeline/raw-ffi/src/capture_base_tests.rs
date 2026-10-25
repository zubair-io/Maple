use super::*;
use crate::capture_creative::maple_free_capture_buffer_f32;
use crate::capture_f32::maple_render_file_capture_sized_f32;
use raw_core::test_support::synth_chart::SyntheticColorChart;
use std::ffi::CString;

pub(crate) fn chart(dir: &tempfile::TempDir) -> CString {
    let path = dir.path().join("chart.dng");
    SyntheticColorChart::default().write_to(&path).unwrap();
    CString::new(path.to_str().unwrap()).unwrap()
}

pub(crate) fn xmp(dir: &tempfile::TempDir, name: &str, body: &str) -> CString {
    let path = dir.path().join(name);
    std::fs::write(
        &path,
        format!(
            "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\"><rdf:RDF \
             xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">\
             <rdf:Description xmlns:papp=\"http://ns.justmaple.app/1.0/\" {body}/>\
             </rdf:RDF></x:xmpmeta>"
        ),
    )
    .unwrap();
    CString::new(path.to_str().unwrap()).unwrap()
}

pub(crate) fn empty() -> MapleCaptureBufferF32 {
    MapleCaptureBufferF32 {
        scene: crate::buffers::MapleSceneLinearBufferF32::empty(),
        creative: crate::capture_creative::MapleCaptureCreative::ABSENT,
    }
}

pub(crate) fn pixels(buffer: &MapleCaptureBufferF32) -> Vec<f32> {
    let scene = &buffer.scene;
    unsafe { std::slice::from_raw_parts(scene.f32_rgba, scene.len_bytes / 4) }.to_vec()
}

#[test]
fn the_base_decode_writes_the_capture_decode_and_a_base() {
    let dir = tempfile::tempdir().unwrap();
    let raw = chart(&dir);
    let sidecar = xmp(
        &dir,
        "engaged.xmp",
        "papp:ChromaPrefilter=\"60\" papp:CaptureSharpeningAmount=\"80\"",
    );
    for edge in [0, 128] {
        let mut plain = empty();
        let mut with_base = empty();
        let mut base: *mut MapleCaptureBase = std::ptr::null_mut();
        unsafe {
            let rc = if edge == 0 {
                crate::capture_f32::maple_render_file_capture_f32(
                    raw.as_ptr(),
                    sidecar.as_ptr(),
                    0,
                    std::ptr::null(),
                    &mut plain,
                )
            } else {
                maple_render_file_capture_sized_f32(
                    raw.as_ptr(),
                    sidecar.as_ptr(),
                    edge,
                    0,
                    std::ptr::null(),
                    &mut plain,
                )
            };
            assert_eq!(rc, 0);
            let rc = maple_render_file_capture_base_f32(
                raw.as_ptr(),
                sidecar.as_ptr(),
                edge,
                0,
                std::ptr::null(),
                &mut with_base,
                &mut base,
            );
            assert_eq!(rc, 0);
            assert!(!base.is_null());
            assert_eq!(pixels(&with_base), pixels(&plain));
            assert_eq!(with_base.scene.iso, plain.scene.iso);
            assert_eq!(
                with_base.scene.camera_support_json.is_null(),
                plain.scene.camera_support_json.is_null()
            );
            assert!((with_base.creative.ae_gain - plain.creative.ae_gain).abs() < 1e-6);
            maple_free_capture_base(base);
            maple_free_capture_buffer_f32(&mut plain);
            maple_free_capture_buffer_f32(&mut with_base);
        }
    }
}

#[test]
fn a_missing_base_slot_is_refused_and_a_null_base_frees_as_a_no_op() {
    let dir = tempfile::tempdir().unwrap();
    let raw = chart(&dir);
    let mut out = empty();
    unsafe {
        let rc = maple_render_file_capture_base_f32(
            raw.as_ptr(),
            std::ptr::null(),
            64,
            0,
            std::ptr::null(),
            &mut out,
            std::ptr::null_mut(),
        );
        assert_eq!(rc, 1);
        maple_free_capture_base(std::ptr::null_mut());
    }
}
