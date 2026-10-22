//! `maple_render_file_display_f32` returns exactly what `render_export_f32`
//! computes for the same RAW + sidecar, owns its buffer until freed, and
//! rejects bad inputs before touching the RAW.
use crate::display_f32::*;
use raw_core::{
    pipeline::{render_export_f32, RawInput, RenderQuality},
    test_support::synth_dng::SyntheticGreyDng,
    types::{Crop, Profile},
    view::encode::TargetPrimaries,
    xmp::{self, AdjustmentModel},
};
use std::{
    ffi::{CStr, CString},
    path::Path,
};

fn c_path(path: &Path) -> CString {
    CString::new(path.to_str().unwrap()).unwrap()
}

/// Exposure, a tilted crop and a neutral profile: every step of the geometry
/// tail fires, and the develop is deterministic without an embedded preview.
fn sidecar_model() -> AdjustmentModel {
    AdjustmentModel {
        profile: Profile::Neutral,
        exposure: 0.5,
        crop: Crop {
            top: 0.1,
            left: 0.2,
            bottom: 0.9,
            right: 0.8,
            angle: 3.0,
        },
        ..AdjustmentModel::default()
    }
}

/// A synthetic RAW whose orientation swaps the axes, beside the sidecar.
fn stage() -> (tempfile::TempDir, CString, CString) {
    let dir = tempfile::tempdir().unwrap();
    let raw = dir.path().join("synthetic.dng");
    SyntheticGreyDng {
        width: 48,
        height: 32,
        orientation: Some(6),
        ..Default::default()
    }
    .write_to(&raw)
    .unwrap();
    let sidecar = dir.path().join("synthetic.xmp");
    // `xmp::serialize` emits the attribute fragment; wrap it in the document
    // shell a sidecar on disk carries.
    let document = format!(
        r#"<?xml version="1.0"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" xmlns:papp="http://ns.justmaple.app/photo/1.0/"{}/></rdf:RDF></x:xmpmeta>"#,
        xmp::serialize(&sidecar_model())
    );
    std::fs::write(&sidecar, document).unwrap();
    (dir, c_path(&raw), c_path(&sidecar))
}

unsafe fn render(raw: &CString, xmp: &CString, target: u32) -> MapleDisplayBufferF32 {
    let mut out = MapleDisplayBufferF32::empty();
    let rc = maple_render_file_display_f32(
        raw.as_ptr(),
        xmp.as_ptr(),
        0,
        target,
        std::ptr::null(),
        0,
        0,
        &mut out,
    );
    assert_eq!(
        rc,
        0,
        "{}",
        CStr::from_ptr(crate::error::maple_last_error()).to_string_lossy()
    );
    out
}

#[test]
fn preview_wire_quality_cannot_reduce_native_export_resolution() {
    let (_dir, raw, xmp) = stage();
    unsafe {
        let mut expected = render(&raw, &xmp, 1);
        let mut actual = MapleDisplayBufferF32::empty();
        let rc = maple_render_file_display_f32(
            raw.as_ptr(),
            xmp.as_ptr(),
            1,
            1,
            std::ptr::null(),
            0,
            0,
            &mut actual,
        );
        assert_eq!(rc, 0);
        assert_eq!(
            (actual.width, actual.height, actual.len),
            (expected.width, expected.height, expected.len)
        );
        assert_eq!(
            std::slice::from_raw_parts(actual.rgba, actual.len),
            std::slice::from_raw_parts(expected.rgba, expected.len)
        );
        maple_free_display_buffer_f32(&mut expected);
        maple_free_display_buffer_f32(&mut actual);
    }
}

#[test]
fn float_export_matches_the_core_terminal_in_both_primaries_and_frees_once() {
    let (_dir, raw_path, xmp_path) = stage();
    let path = Path::new(raw_path.to_str().unwrap());
    let source = std::fs::read(path).unwrap();
    let raw = raw_core::decode::decode_bytes(&source, "dng").unwrap();
    let model = xmp::parse(&std::fs::read_to_string(xmp_path.to_str().unwrap()).unwrap()).unwrap();
    assert_eq!(model.crop, sidecar_model().crop);
    assert_eq!(model.profile, Profile::Neutral);
    for (wire, target) in [(0, TargetPrimaries::Srgb), (1, TargetPrimaries::P3)] {
        let (width, height, expected) = render_export_f32(
            &raw,
            &model,
            RenderQuality::Full,
            Some(RawInput::Path(path)),
            target,
            None,
        )
        .unwrap();
        // The swapped orientation (48×32 sensor → portrait) plus the sidecar
        // crop must have changed the framing, or this would only prove the
        // identity tail.
        assert!(width < height);
        assert_ne!((width, height), (32, 48));
        unsafe {
            let mut out = render(&raw_path, &xmp_path, wire);
            let lanes = std::slice::from_raw_parts(out.rgba, out.len);
            assert_eq!((out.width, out.height), (width, height));
            assert_eq!(lanes.len(), (width * height * 4) as usize);
            assert_eq!(lanes, expected);
            assert!(lanes.chunks_exact(4).all(|px| (px[3] - 1.0).abs() < 1e-5));
            maple_free_display_buffer_f32(&mut out);
            assert!(out.rgba.is_null());
            assert_eq!((out.len, out.width, out.height), (0, 0, 0));
            maple_free_display_buffer_f32(&mut out);
            maple_free_display_buffer_f32(std::ptr::null_mut());
        }
    }
    assert_eq!(std::fs::read(path).unwrap(), source);
}

#[test]
fn float_export_rejects_bad_primaries_and_film_before_reading_the_raw() {
    let missing = CString::new("/nonexistent/maple-float-export.dng").unwrap();
    let bad_film = [f32::NAN; 24];
    let identity = [0.0_f32; 24];
    for (target, pointer, length, size, expected) in [
        (2, std::ptr::null(), 0, 0, 9),
        (0, bad_film.as_ptr(), bad_film.len(), 2, 10),
        (0, identity.as_ptr(), 1, 2, 10),
        (0, std::ptr::null(), 24, 2, 10),
        (0, identity.as_ptr(), identity.len(), 1, 10),
        (0, identity.as_ptr(), identity.len(), 2, 6),
        (1, std::ptr::null(), 0, 0, 6),
    ] {
        let mut out = MapleDisplayBufferF32 {
            rgba: std::ptr::NonNull::dangling().as_ptr(),
            len: 1,
            width: 1,
            height: 1,
        };
        let rc = unsafe {
            maple_render_file_display_f32(
                missing.as_ptr(),
                std::ptr::null(),
                0,
                target,
                pointer,
                length,
                size,
                &mut out,
            )
        };
        assert_eq!(rc, expected, "target={target} len={length} size={size}");
        assert!(out.rgba.is_null());
        assert_eq!((out.len, out.width, out.height), (0, 0, 0));
    }
}

#[test]
fn null_arguments_undecodable_bytes_and_a_missing_sidecar_report_their_codes() {
    let dir = tempfile::tempdir().unwrap();
    let garbage = dir.path().join("garbage.dng");
    std::fs::write(&garbage, b"not a raw file").unwrap();
    let garbage = c_path(&garbage);
    let good = dir.path().join("good.dng");
    SyntheticGreyDng::default().write_to(&good).unwrap();
    let good = c_path(&good);
    let absent_xmp = c_path(&dir.path().join("absent.xmp"));
    let mut out = MapleDisplayBufferF32::empty();
    unsafe {
        let null_out = maple_render_file_display_f32(
            good.as_ptr(),
            std::ptr::null(),
            0,
            0,
            std::ptr::null(),
            0,
            0,
            std::ptr::null_mut(),
        );
        assert_eq!(null_out, 1);
        let null_raw = maple_render_file_display_f32(
            std::ptr::null(),
            std::ptr::null(),
            0,
            0,
            std::ptr::null(),
            0,
            0,
            &mut out,
        );
        assert_eq!(null_raw, 1);
        let undecodable = maple_render_file_display_f32(
            garbage.as_ptr(),
            std::ptr::null(),
            0,
            0,
            std::ptr::null(),
            0,
            0,
            &mut out,
        );
        assert_eq!(undecodable, 7);
        assert!(out.rgba.is_null());
        let missing_sidecar = maple_render_file_display_f32(
            good.as_ptr(),
            absent_xmp.as_ptr(),
            0,
            0,
            std::ptr::null(),
            0,
            0,
            &mut out,
        );
        assert_eq!(missing_sidecar, 5);
        assert!(out.rgba.is_null());
    }
}
