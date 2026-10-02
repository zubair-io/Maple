//! Real saved RAW/XMP/companions; float export must preserve the shared colour
//! terminal, source binding, geometry and precision (#1472).
use crate::display_f32::*;
use raw_core::{
    pipeline::{RawInput, RenderQuality},
    view::encode::TargetPrimaries,
};
use std::{ffi::CString, path::Path};

const FIXTURE: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../test-fixtures/removal/calibration"
);

fn stage() -> (tempfile::TempDir, CString, CString, Vec<u8>) {
    let directory = tempfile::tempdir().unwrap();
    let source = std::fs::read(Path::new(FIXTURE).join("source.dng")).unwrap();
    let raw = directory.path().join("photo.dng");
    let xmp = directory.path().join("snapshot.xmp");
    std::fs::write(&raw, &source).unwrap();
    std::fs::copy(Path::new(FIXTURE).join("saved.xmp"), &xmp).unwrap();
    let assets = directory.path().join(".maple/inpaint");
    std::fs::create_dir_all(&assets).unwrap();
    for (name, suffix) in [("mask.mimf", "mask"), ("patch.f16", "f16")] {
        let bytes = std::fs::read(Path::new(FIXTURE).join(name)).unwrap();
        let digest = raw_core::types::accepted_removal::ContentDigest::for_bytes(&bytes);
        std::fs::write(assets.join(format!("{}.{suffix}", digest.hex())), bytes).unwrap();
    }
    (
        directory,
        CString::new(raw.to_str().unwrap()).unwrap(),
        CString::new(xmp.to_str().unwrap()).unwrap(),
        source,
    )
}

unsafe fn render(raw: &CString, xmp: &CString, target: u32) -> MapleDisplayBufferF32 {
    let mut out = MapleDisplayBufferF32::empty();
    let rc = maple_render_file_display_f32(
        raw.as_ptr(),
        xmp.as_ptr(),
        2,
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
        std::ffi::CStr::from_ptr(crate::error::maple_last_error()).to_string_lossy()
    );
    out
}

#[test]
fn float_saved_export_matches_both_shared_primaries_and_keeps_sub_byte_precision() {
    let (_dir, raw_path, xmp, source) = stage();
    let raw = raw_core::decode_raw(&source, "dng").unwrap();
    let model =
        raw_core::xmp::parse(&std::fs::read_to_string(xmp.to_str().unwrap()).unwrap()).unwrap();
    let path = Path::new(raw_path.to_str().unwrap());
    let (stack, original) =
        crate::removal_file::prepare_saved(&raw, &source, &model, path.parent())
            .unwrap()
            .unwrap();
    for (wire, target) in [(0, TargetPrimaries::Srgb), (1, TargetPrimaries::P3)] {
        let expected = stack
            .render_export_f32(
                &raw,
                &original,
                &model,
                RenderQuality::Amaze,
                Some(RawInput::Bytes {
                    bytes: &source,
                    ext: "dng",
                }),
                target,
                None,
            )
            .unwrap();
        unsafe {
            let mut out = render(&raw_path, &xmp, wire);
            let lanes = std::slice::from_raw_parts(out.rgba, out.len);
            assert_eq!((out.width, out.height), (expected.0, expected.1));
            assert_eq!(lanes, expected.2);
            assert!(lanes.chunks_exact(4).all(|v| v[3] == 1.0));
            assert!(lanes
                .chunks_exact(4)
                .flat_map(|v| &v[..3])
                .any(|v| (v * 255.0 - (v * 255.0).round()).abs() > 0.05));
            maple_free_display_buffer_f32(&mut out);
            maple_free_display_buffer_f32(&mut out);
            assert!(out.rgba.is_null());
            assert_eq!(out.len, 0);
        }
    }
    assert_eq!(std::fs::read(path).unwrap(), source);
}

#[test]
fn float_export_missing_corrupt_or_changed_source_cannot_publish_partial_pixels() {
    for failure in ["missing", "corrupt", "changed"] {
        let (dir, raw, xmp, mut source) = stage();
        let mask = std::fs::read(Path::new(FIXTURE).join("mask.mimf")).unwrap();
        let digest = raw_core::types::accepted_removal::ContentDigest::for_bytes(&mask);
        let path = dir
            .path()
            .join(".maple/inpaint")
            .join(format!("{}.mask", digest.hex()));
        match failure {
            "missing" => std::fs::remove_file(path).unwrap(),
            "corrupt" => std::fs::write(path, b"corrupt").unwrap(),
            _ => {
                source.push(0);
                std::fs::write(raw.to_str().unwrap(), &source).unwrap();
            }
        }
        let mut out = MapleDisplayBufferF32::empty();
        let rc = unsafe {
            maple_render_file_display_f32(
                raw.as_ptr(),
                xmp.as_ptr(),
                2,
                0,
                std::ptr::null(),
                0,
                0,
                &mut out,
            )
        };
        assert_eq!(rc, 8, "{failure}");
        assert!(out.rgba.is_null());
        assert_eq!((out.len, out.width, out.height), (0, 0, 0));
    }
}

#[test]
fn float_export_rejects_bad_primaries_and_requested_film_before_reading_raw() {
    let raw = CString::new("/missing-float-export.dng").unwrap();
    let film = [f32::NAN; 24];
    for (target, pointer, length, size, expected) in [
        (2, std::ptr::null(), 0, 0, 9),
        (0, film.as_ptr(), film.len(), 2, 10),
        (0, film.as_ptr(), 1, 2, 10),
        (0, std::ptr::null(), 24, 2, 10),
    ] {
        let mut out = MapleDisplayBufferF32::empty();
        assert_eq!(
            unsafe {
                maple_render_file_display_f32(
                    raw.as_ptr(),
                    std::ptr::null(),
                    2,
                    target,
                    pointer,
                    length,
                    size,
                    &mut out,
                )
            },
            expected
        );
        assert!(out.rgba.is_null());
    }
}
