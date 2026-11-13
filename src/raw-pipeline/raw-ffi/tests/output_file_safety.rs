//! Exercise the real C ABI with real filesystem entries (no decode/sidecar mocks).
use std::{
    ffi::{c_char, CString},
    fs,
    path::Path,
    ptr,
};

extern "C" {
    fn maple_export_developed_to_file(
        raw: *const c_char,
        xmp: *const c_char,
        format: *const c_char,
        quality: u8,
        color: *const c_char,
        max: u32,
        out: *const c_char,
    ) -> i32;
    fn maple_render_thumbnail_preview_jpeg_to_file(
        raw: *const c_char,
        out: *const c_char,
        max: u32,
        quality: u8,
    ) -> i32;
    fn maple_render_thumbnail_avif_to_file(
        raw: *const c_char,
        out: *const c_char,
        max: u32,
        quality: u8,
    ) -> i32;
}

fn call(kind: usize, raw: &Path, xmp: &Path, out: &Path, format: &str) -> i32 {
    let strings = [raw, xmp, out].map(|p| CString::new(p.to_str().unwrap()).unwrap());
    let format = CString::new(format).unwrap();
    unsafe {
        match kind {
            0 => maple_export_developed_to_file(
                strings[0].as_ptr(),
                strings[1].as_ptr(),
                format.as_ptr(),
                92,
                ptr::null(),
                32,
                strings[2].as_ptr(),
            ),
            1 => raw_ffi::maple_render_develop_jpeg_to_file(
                strings[0].as_ptr(),
                strings[1].as_ptr(),
                32,
                82,
                strings[2].as_ptr(),
            ),
            2 => maple_render_thumbnail_preview_jpeg_to_file(
                strings[0].as_ptr(),
                strings[2].as_ptr(),
                32,
                85,
            ),
            _ => maple_render_thumbnail_avif_to_file(
                strings[0].as_ptr(),
                strings[2].as_ptr(),
                32,
                55,
            ),
        }
    }
}

#[test]
fn all_writers_refuse_protected_destinations_before_decoding() {
    let dir = tempfile::tempdir().unwrap();
    let raw = dir.path().join("input.jpg");
    let xmp = dir.path().join("input.xmp");
    image::RgbImage::from_pixel(4, 4, image::Rgb([80, 100, 120]))
        .save(&raw)
        .unwrap();
    let xml = raw_core::xmp::serialize(&raw_core::xmp::AdjustmentModel::default());
    fs::write(&xmp, &xml).unwrap();
    let original = fs::read(&raw).unwrap();
    let dng = dir.path().join("sensor.dng");
    raw_core::test_support::synth_dng::SyntheticGreyDng {
        width: 64,
        height: 48,
        ..Default::default()
    }
    .write_to(&dng)
    .unwrap();
    let sensor = fs::read(&dng).unwrap();
    for kind in 0..4 {
        for out in [raw.clone(), xmp.clone(), dir.path().join("out.DnG")] {
            assert_eq!(call(kind, &raw, &xmp, &out, "png"), 12);
        }
        #[cfg(unix)]
        {
            let alias = dir.path().join("alias.jpg");
            std::os::unix::fs::symlink(&raw, &alias).unwrap();
            assert_eq!(call(kind, &raw, &xmp, &alias, "png"), 12);
            fs::remove_file(&alias).unwrap();
            fs::hard_link(&raw, &alias).unwrap();
            assert_eq!(call(kind, &raw, &xmp, &alias, "png"), 12);
            fs::remove_file(alias).unwrap();
        }
    }
    for (kind, format, ext) in [
        (0, "png", "png"),
        (0, "jpeg", "jpg"),
        (0, "tiff", "tiff"),
        (1, "jpeg", "jpg"),
        (2, "jpeg", "jpg"),
        (3, "avif", "avif"),
    ] {
        let out = dir.path().join(format!("result-{kind}.{ext}"));
        #[cfg(unix)]
        std::os::unix::fs::symlink(&xmp, out.with_extension(format!("{ext}.tmp"))).unwrap();
        let input = if kind < 2 { &dng } else { &raw };
        assert_eq!(
            call(kind, input, &xmp, &out, format),
            0,
            "writer {kind}, format {format}"
        );
        if kind == 3 {
            let decoded = raw_core::avif_decode::decode_avif(&fs::read(&out).unwrap()).unwrap();
            assert_eq!((decoded.width, decoded.height), (4, 4));
        } else {
            let decoded = image::open(&out).unwrap();
            assert_eq!(
                (decoded.width(), decoded.height()),
                if kind < 2 { (32, 24) } else { (4, 4) }
            );
        }
        fs::remove_file(out).unwrap();
    }
    assert_eq!(fs::read(dng).unwrap(), sensor);
    assert_eq!(fs::read(raw).unwrap(), original);
    assert_eq!(fs::read(xmp).unwrap(), xml.as_bytes());
}

#[test]
fn missing_inputs_keep_writer_read_error_codes_when_output_exists() {
    let dir = tempfile::tempdir().unwrap();
    let output = dir.path().join("existing.png");
    fs::write(&output, b"old pixels").unwrap();
    let missing_raw = dir.path().join("missing.dng");
    let missing_xmp = dir.path().join("missing.xmp");
    let xmp = dir.path().join("input.xmp");
    fs::write(
        &xmp,
        raw_core::xmp::serialize(&raw_core::xmp::AdjustmentModel::default()),
    )
    .unwrap();
    for kind in 0..4 {
        assert_eq!(call(kind, &missing_raw, &xmp, &output, "png"), 6);
    }
    let raw = dir.path().join("input.jpg");
    image::RgbImage::from_pixel(4, 4, image::Rgb([80, 100, 120]))
        .save(&raw)
        .unwrap();
    for kind in 0..2 {
        assert_eq!(call(kind, &raw, &missing_xmp, &output, "png"), 5);
    }
    assert_eq!(fs::read(output).unwrap(), b"old pixels");
}
