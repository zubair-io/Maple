//! Tests for [`super::maple_raster_analyze_buf`] (#3507, Task G4): the C
//! ABI mechanics (size probe, buffer-too-small, bad-request rc, panic
//! barrier is exercised implicitly by every call going through it) over a
//! handful of real containers built with `raw_core`'s own public encoders.

use super::*;
use std::ffi::CString;

fn png() -> Vec<u8> {
    raw_core::png::encode(4, 2, &vec![90u8; 4 * 2 * 3]).unwrap()
}

/// A baseline JPEG with a hand-spliced APP1 EXIF and APP2 ICC segment, same
/// shape as `raw-core`'s own `raster_analyze` tests — kept local since that
/// crate's fixture helpers are private to its own test tree.
fn jpeg_with_exif_and_icc() -> Vec<u8> {
    fn jpeg_segment(marker: u8, payload: &[u8]) -> Vec<u8> {
        let length = (payload.len() + 2) as u16;
        let mut seg = vec![0xFF, marker];
        seg.extend_from_slice(&length.to_be_bytes());
        seg.extend_from_slice(payload);
        seg
    }
    let base = raw_core::jpeg::encode(4, 2, &vec![128u8; 4 * 2 * 3], 90).unwrap();
    let icc = raw_core::icc::profile_for(raw_core::view::encode::TargetPrimaries::Srgb);

    let mut exif_payload = b"Exif\0\0".to_vec();
    exif_payload.extend_from_slice(b"II\x2a\x00\x08\x00\x00\x00\x00\x00");

    let mut icc_payload = b"ICC_PROFILE\0".to_vec();
    icc_payload.push(1); // sequence number
    icc_payload.push(1); // chunk count
    icc_payload.extend_from_slice(&icc);

    let mut out = base[..2].to_vec();
    out.extend(jpeg_segment(0xE1, &exif_payload));
    out.extend(jpeg_segment(0xE2, &icc_payload));
    out.extend_from_slice(&base[2..]);
    out
}

fn call(input: &[u8], request: &str, out: Option<&mut [u8]>) -> (i32, usize) {
    let request = CString::new(request).unwrap();
    let mut out_len = 0usize;
    let (ptr, cap) = match out {
        Some(buf) => (buf.as_mut_ptr(), buf.len()),
        None => (std::ptr::null_mut(), 0),
    };
    // SAFETY: every pointer borrows a live local for the duration.
    let rc = unsafe {
        maple_raster_analyze_buf(
            input.as_ptr(),
            input.len(),
            request.as_ptr(),
            ptr,
            cap,
            &mut out_len,
        )
    };
    (rc, out_len)
}

#[test]
fn a_null_buffer_call_sizes_the_reply() {
    let (rc, len) = call(&png(), r#"{"v":1,"what":["metadata"]}"#, None);
    assert_eq!(rc, NEED_LARGER_BUFFER);
    assert!(len > 16);
}

#[test]
fn a_sized_buffer_receives_the_json() {
    let file = png();
    let (_, len) = call(&file, r#"{"v":1,"what":["metadata","stats"]}"#, None);
    let mut out = vec![0u8; len];
    let (rc, written) = call(
        &file,
        r#"{"v":1,"what":["metadata","stats"]}"#,
        Some(&mut out),
    );
    assert_eq!((rc, written), (0, len));
    let text = std::str::from_utf8(&out).unwrap();
    assert!(text.contains("\"width\":4"), "{text}");
    assert!(text.contains("\"isOpaque\":true"), "{text}");
}

#[test]
fn a_too_small_buffer_reports_rc_100_and_still_sets_out_len() {
    let file = png();
    let (_, len) = call(&file, r#"{"v":1,"what":["metadata"]}"#, None);
    let mut out = vec![0u8; len - 1];
    let (rc, reported) = call(&file, r#"{"v":1,"what":["metadata"]}"#, Some(&mut out));
    assert_eq!(rc, NEED_LARGER_BUFFER);
    assert_eq!(reported, len);
}

#[test]
fn stats_can_be_asked_for_alone_without_the_metadata_key() {
    let file = png();
    let (_, len) = call(&file, r#"{"v":1,"what":["stats"]}"#, None);
    let mut out = vec![0u8; len];
    let (rc, _) = call(&file, r#"{"v":1,"what":["stats"]}"#, Some(&mut out));
    assert_eq!(rc, 0);
    let text = std::str::from_utf8(&out).unwrap();
    assert!(text.contains("\"stats\""), "{text}");
    assert!(!text.contains("\"metadata\""), "{text}");
}

#[test]
fn a_jpeg_with_exif_and_icc_reports_hasprofile_through_the_c_abi() {
    let file = jpeg_with_exif_and_icc();
    let (_, len) = call(&file, r#"{"v":1,"what":["metadata"]}"#, None);
    let mut out = vec![0u8; len];
    let (rc, _) = call(&file, r#"{"v":1,"what":["metadata"]}"#, Some(&mut out));
    assert_eq!(rc, 0);
    let text = std::str::from_utf8(&out).unwrap();
    assert!(text.contains("\"format\":\"jpeg\""), "{text}");
    assert!(text.contains("\"hasProfile\":true"), "{text}");
}

#[test]
fn a_bad_request_reports_rc_5() {
    assert_eq!(call(&png(), "{nope", None).0, 5);
    assert_eq!(call(&png(), r#"{"v":1,"what":["vibes"]}"#, None).0, 5);
}

#[test]
fn a_corrupt_buffer_reports_rc_3() {
    let (rc, _) = call(b"not an image", r#"{"v":1,"what":["metadata"]}"#, None);
    assert_eq!(rc, 3);
}

#[test]
fn a_null_out_len_pointer_is_rejected() {
    let file = png();
    let request = CString::new(r#"{"v":1,"what":["metadata"]}"#).unwrap();
    // SAFETY: `out_len` is deliberately null to exercise the null-argument
    // guard; every other pointer borrows a live local.
    let rc = unsafe {
        maple_raster_analyze_buf(
            file.as_ptr(),
            file.len(),
            request.as_ptr(),
            std::ptr::null_mut(),
            0,
            std::ptr::null_mut(),
        )
    };
    assert_eq!(rc, 1);
}
