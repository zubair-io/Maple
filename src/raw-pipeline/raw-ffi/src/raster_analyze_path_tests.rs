//! Real-file C ABI regression tests for #3621: JSON parity, rc 100 sizing,
//! read-only input, error codes, and the legacy path probe's dimensions.

use super::*;
use std::ffi::CString;
use std::io::Write;

fn image_file(bytes: &[u8]) -> tempfile::NamedTempFile {
    let mut file = tempfile::NamedTempFile::new().unwrap();
    file.write_all(bytes).unwrap();
    file
}

fn call(path: &str, request: &str, out: Option<&mut [u8]>) -> (i32, usize) {
    let path = CString::new(path).unwrap();
    let request = CString::new(request).unwrap();
    let mut length = 0;
    let (ptr, cap) = out.map_or((std::ptr::null_mut(), 0), |out| {
        (out.as_mut_ptr(), out.len())
    });
    let code = unsafe {
        maple_raster_analyze_path(path.as_ptr(), request.as_ptr(), ptr, cap, &mut length)
    };
    (code, length)
}

fn reply(path: &str, request: &str) -> Vec<u8> {
    let (code, length) = call(path, request, None);
    assert_eq!(code, NEED_LARGER_BUFFER);
    let mut bytes = vec![0; length];
    assert_eq!(call(path, request, Some(&mut bytes)), (0, length));
    bytes
}

fn last_error() -> String {
    crate::error::LAST_ERROR.with(|error| {
        error
            .borrow()
            .as_ref()
            .unwrap()
            .to_string_lossy()
            .into_owned()
    })
}

#[test]
fn analyze_path_matches_byte_reply_for_metadata_stats_and_both() {
    let png = raw_core::png::encode(4, 2, &vec![90u8; 4 * 2 * 3]).unwrap();
    let jpeg = raw_core::jpeg::encode(4, 2, &vec![128u8; 4 * 2 * 3], 90).unwrap();
    for bytes in [png, jpeg] {
        let file = image_file(&bytes);
        let path = file.path().to_str().unwrap();
        let modified = file.as_file().metadata().unwrap().modified().unwrap();
        for what in [
            "metadata",
            "stats",
            "metadata\",\"stats",
            "stats\",\"metadata",
        ] {
            let request = format!(r#"{{"v":1,"what":["{what}"]}}"#);
            assert_eq!(
                reply(path, &request),
                analyze(&bytes, &request).unwrap().as_bytes()
            );
        }
        assert_eq!(std::fs::read(path).unwrap(), bytes);
        assert_eq!(
            file.as_file().metadata().unwrap().modified().unwrap(),
            modified
        );
    }
}

#[test]
fn analyze_path_preserves_size_probes_small_buffers_and_no_partial_write() {
    let bytes = raw_core::png::encode(4, 2, &vec![90u8; 24]).unwrap();
    let file = image_file(&bytes);
    let path = file.path().to_str().unwrap();
    let request = r#"{"v":1,"what":["metadata"]}"#;
    let (code, length) = call(path, request, None);
    assert_eq!(code, NEED_LARGER_BUFFER);
    let mut short = vec![0x5a; length - 1];
    assert_eq!(
        call(path, request, Some(&mut short)),
        (NEED_LARGER_BUFFER, length)
    );
    assert!(short.iter().all(|&byte| byte == 0x5a));
    assert_eq!(
        call(path, request, Some(&mut [])),
        (NEED_LARGER_BUFFER, length)
    );
}

#[test]
fn analyze_path_reports_file_request_and_container_errors() {
    let dir = tempfile::tempdir().unwrap();
    let missing = dir.path().join("missing.png");
    assert_eq!(
        call(
            missing.to_str().unwrap(),
            r#"{"v":1,"what":["metadata"]}"#,
            None
        )
        .0,
        3
    );
    assert!(last_error().contains("failed to read file"));
    let bytes = raw_core::png::encode(4, 2, &vec![90u8; 24]).unwrap();
    let file = image_file(&bytes);
    for request in [
        "broken",
        "{}",
        r#"{"v":2,"what":[]}"#,
        r#"{"v":1,"what":["wrong"]}"#,
    ] {
        assert_eq!(call(file.path().to_str().unwrap(), request, None).0, 5);
        assert!(last_error().contains("request"));
    }
    let corrupt = image_file(b"not an image");
    assert_eq!(
        call(
            corrupt.path().to_str().unwrap(),
            r#"{"v":1,"what":["metadata"]}"#,
            None
        )
        .0,
        3
    );
    assert!(last_error().contains("unsupported"));
}

#[test]
fn analyze_path_rejects_null_pointers_and_invalid_utf8() {
    let path = CString::new("unused").unwrap();
    let request = CString::new(r#"{"v":1,"what":["metadata"]}"#).unwrap();
    let invalid = [0xffu8, 0];
    let mut length = 0;
    for (path, request, length) in [
        (
            std::ptr::null(),
            request.as_ptr(),
            &mut length as *mut usize,
        ),
        (path.as_ptr(), std::ptr::null(), &mut length as *mut usize),
        (path.as_ptr(), request.as_ptr(), std::ptr::null_mut()),
        (
            invalid.as_ptr().cast(),
            request.as_ptr(),
            &mut length as *mut usize,
        ),
    ] {
        assert_eq!(
            unsafe { maple_raster_analyze_path(path, request, std::ptr::null_mut(), 0, length) },
            1
        );
    }
    assert_eq!(
        unsafe {
            maple_raster_analyze_path(
                path.as_ptr(),
                invalid.as_ptr().cast(),
                std::ptr::null_mut(),
                0,
                &mut length,
            )
        },
        5
    );
}

#[test]
fn legacy_path_probe_matches_the_buffer_probe_and_keeps_original_bytes() {
    let bytes = raw_core::jpeg::encode(4, 2, &vec![128u8; 24], 90).unwrap();
    let file = image_file(&bytes);
    let path = CString::new(file.path().to_str().unwrap()).unwrap();
    let mut actual = [0u32; 4];
    let mut expected = [0u32; 4];
    unsafe {
        let [width, height, channels, orientation] = &mut actual;
        assert_eq!(
            crate::raster::maple_raster_probe_metadata(
                path.as_ptr(),
                width,
                height,
                channels,
                orientation
            ),
            0
        );
        let [width, height, channels, orientation] = &mut expected;
        assert_eq!(
            crate::raster::maple_raster_probe_metadata_buf(
                bytes.as_ptr(),
                bytes.len(),
                width,
                height,
                channels,
                orientation,
                std::ptr::null_mut(),
                0
            ),
            0
        );
        assert_eq!(
            crate::raster::maple_raster_probe_metadata(
                path.as_ptr(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut()
            ),
            0
        );
    }
    assert_eq!(actual, expected);
    assert_eq!(std::fs::read(file.path()).unwrap(), bytes);
}
