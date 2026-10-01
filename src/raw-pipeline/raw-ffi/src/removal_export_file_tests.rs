//! Exercise actual encoded files through the two established cold host routes.
use super::{stage, FIXTURE};
use image::ImageDecoder;
use raw_core::{export_recipe::ExportRecipe, view::encode::TargetPrimaries};
use std::{ffi::CString, io::Cursor, path::Path};

fn recipe(format: &str, cap: u32, profile: &str) -> CString {
    CString::new(
        serde_json::to_string(&ExportRecipe {
            format: format.into(),
            quality: None,
            bit_depth: if format == "tiff" { 16 } else { 8 },
            max_long_edge: Some(cap),
            output_profile: profile.into(),
            ..ExportRecipe::default()
        })
        .unwrap(),
    )
    .unwrap()
}

unsafe fn export(
    raw: &CString,
    xmp: &CString,
    output: &Path,
    cap: u32,
    format: &str,
    profile: &str,
    legacy: bool,
) -> i32 {
    let output = CString::new(output.to_str().unwrap()).unwrap();
    if legacy {
        let format = CString::new(format).unwrap();
        let profile = CString::new(profile).unwrap();
        crate::export_file::maple_export_developed_to_file(
            raw.as_ptr(),
            xmp.as_ptr(),
            format.as_ptr(),
            0,
            profile.as_ptr(),
            cap,
            output.as_ptr(),
        )
    } else {
        let xml = CString::new(std::fs::read_to_string(xmp.to_str().unwrap()).unwrap()).unwrap();
        crate::export_recipe::maple_export_recipe_to_file(
            raw.as_ptr(),
            xml.as_ptr(),
            recipe(format, cap, profile).as_ptr(),
            std::ptr::null(),
            output.as_ptr(),
        )
    }
}

#[test]
fn recipe_and_legacy_exports_preserve_saved_pixels_size_and_originals() {
    let (directory, raw, xmp, source) = stage();
    let sidecar = std::fs::read(xmp.to_str().unwrap()).unwrap();
    for legacy in [false, true] {
        for cap in [4, 64] {
            let output = directory.path().join(format!("result-{legacy}-{cap}.png"));
            assert_eq!(
                unsafe { export(&raw, &xmp, &output, cap, "png", "srgb", legacy) },
                0
            );
            let bytes = std::fs::read(output).unwrap();
            let mut decoder = image::codecs::png::PngDecoder::new(Cursor::new(&bytes)).unwrap();
            assert_eq!(
                decoder.dimensions(),
                if cap == 4 { (4, 2) } else { (16, 8) }
            );
            assert_eq!(
                decoder.icc_profile().unwrap().unwrap(),
                raw_core::icc::profile_for(TargetPrimaries::Srgb)
            );
            let pixels = image::load_from_memory(&bytes)
                .unwrap()
                .to_rgb8()
                .into_raw();
            assert_eq!(
                pixels,
                std::fs::read(Path::new(FIXTURE).join(format!("preview-{cap}.rgb"))).unwrap()
            );
        }
    }
    assert_eq!(std::fs::read(raw.to_str().unwrap()).unwrap(), source);
    assert_eq!(std::fs::read(xmp.to_str().unwrap()).unwrap(), sidecar);
}

#[test]
fn both_hosts_export_true_sixteen_bit_p3_with_the_same_saved_patch() {
    let (directory, raw, xmp, _) = stage();
    let mut results = Vec::new();
    for legacy in [false, true] {
        let output = directory.path().join(format!("result-{legacy}.tif"));
        assert_eq!(
            unsafe { export(&raw, &xmp, &output, 64, "tiff", "display-p3", legacy) },
            0
        );
        let bytes = std::fs::read(output).unwrap();
        let mut decoder = image::codecs::tiff::TiffDecoder::new(Cursor::new(&bytes)).unwrap();
        assert_eq!(decoder.dimensions(), (16, 8));
        assert_eq!(decoder.color_type(), image::ColorType::Rgb16);
        assert_eq!(
            decoder.icc_profile().unwrap().unwrap(),
            raw_core::icc::profile_for(TargetPrimaries::P3)
        );
        let image = image::load_from_memory(&bytes).unwrap().to_rgb16();
        assert!(
            image.as_raw().iter().any(|value| value % 257 != 0),
            "16-bit export must not widen an 8-bit preview"
        );
        results.push(image.into_raw());
    }
    assert_eq!(results[0], results[1]);
    // The saved patch must also survive this terminal, not just the file renderer.
    let xml = std::fs::read_to_string(xmp.to_str().unwrap()).unwrap();
    // Use the canonical serializer to remove only the accepted stack.
    let mut model = raw_core::xmp::parse(&xml).unwrap();
    model.inpaint_removals.clear();
    std::fs::write(xmp.to_str().unwrap(), raw_core::xmp::serialize(&model)).unwrap();
    let output = directory.path().join("unremoved.tif");
    assert_eq!(
        unsafe { export(&raw, &xmp, &output, 64, "tiff", "display-p3", false) },
        0
    );
    let unremoved = image::open(output).unwrap().to_rgb16().into_raw();
    assert_ne!(results[0], unremoved);
}

#[test]
fn export_failure_never_creates_a_partial_deliverable_or_changes_the_sidecar() {
    for legacy in [false, true] {
        for failure in ["missing", "corrupt", "changed", "unsupported"] {
            let (directory, raw, xmp, source) = stage();
            let sidecar = std::fs::read(xmp.to_str().unwrap()).unwrap();
            let mask = raw_core::types::accepted_removal::ContentDigest::for_bytes(
                &std::fs::read(Path::new(FIXTURE).join("mask.mimf")).unwrap(),
            );
            let path = directory
                .path()
                .join(format!(".maple/inpaint/{}.mask", mask.hex()));
            match failure {
                "missing" => std::fs::remove_file(path).unwrap(),
                "corrupt" => std::fs::write(path, b"corrupt").unwrap(),
                "changed" => {
                    let mut bytes = source.clone();
                    bytes.push(0);
                    std::fs::write(raw.to_str().unwrap(), bytes).unwrap();
                }
                _ => {}
            }
            let output = directory.path().join("output.png");
            assert_ne!(
                unsafe {
                    export(
                        &raw,
                        &xmp,
                        &output,
                        64,
                        if failure == "unsupported" {
                            "heic"
                        } else {
                            "png"
                        },
                        "srgb",
                        legacy,
                    )
                },
                0,
                "{failure}"
            );
            assert!(!output.exists());
            assert!(!directory.path().join("output.png.tmp").exists());
            assert_eq!(std::fs::read(xmp.to_str().unwrap()).unwrap(), sidecar);
            if failure != "changed" {
                assert_eq!(std::fs::read(raw.to_str().unwrap()).unwrap(), source);
            }
        }
    }
}

#[test]
fn developed_jpeg_uses_the_saved_pixels_and_refuses_missing_companions() {
    let (directory, raw, xmp, source) = stage();
    let output = directory.path().join("developed.jpg");
    let output_c = CString::new(output.to_str().unwrap()).unwrap();
    assert_eq!(
        unsafe {
            crate::render_develop::maple_render_develop_jpeg_to_file(
                raw.as_ptr(),
                xmp.as_ptr(),
                64,
                92,
                output_c.as_ptr(),
            )
        },
        0
    );
    let expected = std::fs::read(Path::new(FIXTURE).join("preview-64.rgb")).unwrap();
    assert_eq!(
        std::fs::read(&output).unwrap(),
        raw_core::jpeg::encode(16, 8, &expected, 92).unwrap()
    );
    std::fs::remove_file(&output).unwrap();
    std::fs::remove_dir_all(directory.path().join(".maple/inpaint")).unwrap();
    assert_eq!(
        unsafe {
            crate::render_develop::maple_render_develop_jpeg_to_file(
                raw.as_ptr(),
                xmp.as_ptr(),
                64,
                92,
                output_c.as_ptr(),
            )
        },
        8
    );
    assert!(!output.exists());
    assert!(!directory.path().join("developed.jpg.tmp").exists());
    assert_eq!(std::fs::read(raw.to_str().unwrap()).unwrap(), source);
}
