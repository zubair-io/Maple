//! Real original + XMP + immutable companion files, using ordinary C renders.
use crate::{
    buffers::{maple_free_buffer, MapleImageBuffer},
    render::{maple_render_bytes, maple_render_file},
};
use std::{ffi::CString, path::Path};

const FIXTURE: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../test-fixtures/removal/calibration"
);

fn stage() -> (tempfile::TempDir, CString, CString, Vec<u8>) {
    let directory = tempfile::tempdir().unwrap();
    let fixture = Path::new(FIXTURE);
    let source = std::fs::read(fixture.join("source.dng")).unwrap();
    let raw = directory.path().join("photo.dng");
    let xmp = directory.path().join("photo.xmp");
    std::fs::write(&raw, &source).unwrap();
    std::fs::copy(fixture.join("saved.xmp"), &xmp).unwrap();
    let assets = directory.path().join(".maple/inpaint");
    std::fs::create_dir_all(&assets).unwrap();
    for (file, suffix) in [("mask.mimf", "mask"), ("patch.f16", "f16")] {
        let data = std::fs::read(fixture.join(file)).unwrap();
        let digest = raw_core::types::accepted_removal::ContentDigest::for_bytes(&data);
        std::fs::write(assets.join(format!("{}.{suffix}", digest.hex())), data).unwrap();
    }
    (
        directory,
        CString::new(raw.to_str().unwrap()).unwrap(),
        CString::new(xmp.to_str().unwrap()).unwrap(),
        source,
    )
}

fn output() -> MapleImageBuffer {
    MapleImageBuffer {
        rgb: std::ptr::null_mut(),
        len: 0,
        width: 0,
        height: 0,
    }
}

#[test]
fn ordinary_file_and_bytes_render_the_complete_saved_calibration_edit_without_inference() {
    let (_directory, raw, xmp, source) = stage();
    let expected = std::fs::read(Path::new(FIXTURE).join("preview-64.rgb")).unwrap();
    let ext = CString::new("dng").unwrap();
    for bytes in [false, true] {
        let mut result = output();
        unsafe {
            let rc = if bytes {
                maple_render_bytes(
                    source.as_ptr(),
                    source.len(),
                    ext.as_ptr(),
                    xmp.as_ptr(),
                    3,
                    &mut result,
                )
            } else {
                maple_render_file(raw.as_ptr(), xmp.as_ptr(), 3, &mut result)
            };
            assert_eq!(
                rc,
                0,
                "{}",
                std::ffi::CStr::from_ptr(crate::error::maple_last_error()).to_string_lossy()
            );
            assert_eq!((result.width, result.height), (16, 8));
            assert_eq!(std::slice::from_raw_parts(result.rgb, result.len), expected);
            maple_free_buffer(&mut result);
        }
    }
    assert_eq!(std::fs::read(raw.to_str().unwrap()).unwrap(), source);
}

#[test]
fn missing_corrupt_or_changed_source_cannot_return_a_successful_partial_image() {
    for failure in ["missing", "corrupt", "changed"] {
        let (directory, raw, xmp, source) = stage();
        let assets = directory.path().join(".maple/inpaint");
        let mask = raw_core::types::accepted_removal::ContentDigest::for_bytes(
            &std::fs::read(Path::new(FIXTURE).join("mask.mimf")).unwrap(),
        );
        let mask_path = assets.join(format!("{}.mask", mask.hex()));
        match failure {
            "missing" => std::fs::remove_file(mask_path).unwrap(),
            "corrupt" => std::fs::write(mask_path, b"corrupt").unwrap(),
            _ => {
                let mut changed = source.clone();
                changed.push(0);
                std::fs::write(raw.to_str().unwrap(), changed).unwrap();
            }
        }
        let mut result = output();
        let rc = unsafe { maple_render_file(raw.as_ptr(), xmp.as_ptr(), 3, &mut result) };
        assert_eq!(rc, 8, "{failure}");
        assert!(result.rgb.is_null());
        assert_eq!(result.len, 0);
    }
}

#[test]
fn file_histogram_counts_saved_pixels_and_unlocated_bytes_histogram_refuses_the_stack() {
    let (_directory, raw, xmp, source) = stage();
    let mut image = output();
    unsafe {
        assert_eq!(
            maple_render_file(raw.as_ptr(), xmp.as_ptr(), 2, &mut image),
            0
        );
        let expected = crate::render::bin_rgb888(std::slice::from_raw_parts(image.rgb, image.len));
        let mut bins = [42u32; 768];
        assert_eq!(
            crate::render::maple_histogram_file(raw.as_ptr(), xmp.as_ptr(), bins.as_mut_ptr()),
            0
        );
        assert_eq!(bins, expected);
        maple_free_buffer(&mut image);
        let document =
            CString::new(std::fs::read_to_string(xmp.to_str().unwrap()).unwrap()).unwrap();
        let ext = CString::new("dng").unwrap();
        bins.fill(42);
        assert_eq!(
            crate::render::maple_histogram_bytes(
                source.as_ptr(),
                source.len(),
                ext.as_ptr(),
                document.as_ptr(),
                3,
                bins.as_mut_ptr()
            ),
            8
        );
        assert_eq!(bins, [42; 768]);
    }
}

#[test]
fn file_render_resolves_companions_from_original_directory_with_temporary_parameters() {
    let (_directory, raw, xmp, _) = stage();
    let temporary = tempfile::tempdir().unwrap();
    let parameters = temporary.path().join("export.xmp");
    std::fs::copy(xmp.to_str().unwrap(), &parameters).unwrap();
    let parameters = CString::new(parameters.to_str().unwrap()).unwrap();
    let mut image = output();
    unsafe {
        assert_eq!(
            maple_render_file(raw.as_ptr(), parameters.as_ptr(), 3, &mut image),
            0
        );
        assert_eq!(
            std::slice::from_raw_parts(image.rgb, image.len),
            std::fs::read(Path::new(FIXTURE).join("preview-64.rgb")).unwrap()
        );
        maple_free_buffer(&mut image);
    }
}
