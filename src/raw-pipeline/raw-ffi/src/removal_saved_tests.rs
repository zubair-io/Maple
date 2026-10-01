use super::*;
use crate::handle::{maple_close_raw_handle, maple_open_raw_handle_bytes};
use std::ffi::CString;

#[path = "removal_saved_detail_tests.rs"]
mod detail;

const RAW: &[u8] = include_bytes!("../../../../test-fixtures/removal/calibration/source.dng");
const XMP: &str = include_str!("../../../../test-fixtures/removal/calibration/saved.xmp");
const MASK: &[u8] = include_bytes!("../../../../test-fixtures/removal/calibration/mask.mimf");
const PATCH: &[u8] = include_bytes!("../../../../test-fixtures/removal/calibration/patch.f16");

struct Handle(*mut MapleRawHandle);
impl Handle {
    fn open() -> Self {
        let mut handle = std::ptr::null_mut();
        let ext = CString::new("dng").unwrap();
        assert_eq!(
            unsafe {
                maple_open_raw_handle_bytes(
                    RAW.as_ptr(),
                    RAW.len(),
                    ext.as_ptr(),
                    std::ptr::null(),
                    &mut handle,
                )
            },
            0
        );
        Self(handle)
    }
}
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe { maple_close_raw_handle(self.0) }
    }
}
struct Owner(*mut MapleSavedRemovals);
impl Drop for Owner {
    fn drop(&mut self) {
        unsafe { maple_removal_saved_close(self.0) }
    }
}
struct Output(MapleRemovalBuffer);
impl Output {
    fn new() -> Self {
        Self(MapleRemovalBuffer::empty())
    }
    fn bytes(&self) -> &[u8] {
        assert!(!self.0.bytes.is_null());
        unsafe { std::slice::from_raw_parts(self.0.bytes, self.0.len) }
    }
    fn assert_empty(&self) {
        assert!(self.0.bytes.is_null());
        assert_eq!((self.0.len, self.0.width, self.0.height), (0, 0, 0));
    }
}
impl Drop for Output {
    fn drop(&mut self) {
        unsafe { maple_removal_saved_free_buffer(&mut self.0) }
    }
}
fn bundle() -> (String, Vec<u8>) {
    let manifest = serde_json::json!([
        {"name":format!("{}.mask", ContentDigest::for_bytes(MASK).hex()),"length":MASK.len()},
        {"name":format!("{}.f16", ContentDigest::for_bytes(PATCH).hex()),"length":PATCH.len()},
    ])
    .to_string();
    (manifest, [MASK, PATCH].concat())
}
fn prepare(handle: &Handle, manifest: &str, companions: &[u8], source: &[u8]) -> (i32, Owner) {
    prepare_xml(handle, XMP, manifest, companions, source)
}
fn prepare_xml(
    handle: &Handle,
    xml: &str,
    manifest: &str,
    companions: &[u8],
    source: &[u8],
) -> (i32, Owner) {
    let xmp = CString::new(xml).unwrap();
    let manifest = CString::new(manifest).unwrap();
    let ext = CString::new("dng").unwrap();
    let mut owner = std::ptr::null_mut();
    let rc = unsafe {
        maple_removal_saved_open(
            handle.0,
            xmp.as_ptr(),
            manifest.as_ptr(),
            companions.as_ptr(),
            companions.len(),
            source.as_ptr(),
            source.len(),
            ext.as_ptr(),
            &mut owner,
        )
    };
    (rc, Owner(owner))
}
fn owner(handle: &Handle) -> Owner {
    let (manifest, bytes) = bundle();
    let (rc, owner) = prepare(handle, &manifest, &bytes, RAW);
    assert_eq!(
        rc,
        0,
        "{}",
        unsafe { CStr::from_ptr(crate::maple_last_error()) }.to_string_lossy()
    );
    assert!(!owner.0.is_null());
    owner
}

#[test]
fn saved_native_preview_and_lossless_exports_match_shared_fixture_without_models() {
    let handle = Handle::open();
    let owner = owner(&handle);
    let xmp = CString::new(XMP).unwrap();
    for (cap, dimensions, expected) in [
        (
            4,
            (4, 2),
            include_bytes!("../../../../test-fixtures/removal/calibration/preview-4.rgb")
                .as_slice(),
        ),
        (
            64,
            (16, 8),
            include_bytes!("../../../../test-fixtures/removal/calibration/preview-64.rgb")
                .as_slice(),
        ),
    ] {
        let mut display = Output::new();
        assert_eq!(
            unsafe {
                maple_removal_saved_preview(
                    handle.0,
                    owner.0,
                    xmp.as_ptr(),
                    cap,
                    std::ptr::null(),
                    0,
                    &mut display.0,
                )
            },
            0
        );
        assert_eq!((display.0.width, display.0.height), dimensions);
        assert_eq!(display.bytes(), expected);
        for format in ["png", "tiff"] {
            let request = CString::new(serde_json::json!({"format":format,"quality":100,"color_space":"srgb","max_long_edge":cap}).to_string()).unwrap();
            let mut export = Output::new();
            assert_eq!(
                unsafe {
                    maple_removal_saved_export(
                        handle.0,
                        owner.0,
                        xmp.as_ptr(),
                        request.as_ptr(),
                        std::ptr::null(),
                        0,
                        &mut export.0,
                    )
                },
                0
            );
            assert_eq!((export.0.width, export.0.height), dimensions);
            let decoded = image::load_from_memory(export.bytes()).unwrap();
            if format == "png" {
                assert_eq!(decoded.to_rgb8().as_raw(), expected);
            } else {
                let pixels = decoded.to_rgb16();
                assert!(pixels.as_raw().iter().any(|v| v % 257 != 0));
                for (a, b) in expected.iter().zip(pixels.as_raw()) {
                    assert!((*a as f32 / 255.0 - *b as f32 / 65535.0).abs() <= 1.0 / 255.0);
                }
            }
            unsafe {
                maple_removal_saved_free_buffer(&mut export.0);
                maple_removal_saved_free_buffer(&mut export.0);
            }
            export.assert_empty();
        }
    }
    assert_eq!(
        RAW,
        include_bytes!("../../../../test-fixtures/removal/basic/source.dng")
    );
}

#[test]
fn failed_preparation_never_publishes_a_partial_owner() {
    let handle = Handle::open();
    let (manifest, bytes) = bundle();
    let mut corrupt = bytes.clone();
    corrupt[0] ^= 1;
    let mut trailing = bytes.clone();
    trailing.push(0);
    let entries: serde_json::Value = serde_json::from_str(&manifest).unwrap();
    let duplicate = serde_json::json!([entries[0], entries[0]]).to_string();
    for (manifest, bytes) in [
        (manifest.as_str(), corrupt.as_slice()),
        (manifest.as_str(), &bytes[..bytes.len() - 1]),
        (manifest.as_str(), trailing.as_slice()),
        (duplicate.as_str(), bytes.as_slice()),
    ] {
        let (rc, owner) = prepare(&handle, manifest, bytes, RAW);
        assert_eq!(rc, 5);
        assert!(owner.0.is_null());
    }
    let mut source = RAW.to_vec();
    source[0] ^= 1;
    let (rc, owner) = prepare(&handle, &manifest, &bytes, &source);
    assert_eq!(rc, 5);
    assert!(owner.0.is_null());
}

#[test]
fn stale_records_invalid_exports_and_null_owners_do_not_publish_pixels() {
    let handle = Handle::open();
    let owner = owner(&handle);
    let changed = CString::new(r#"<rdf:Description xmlns:rdf="x"/>"#).unwrap();
    let xmp = CString::new(XMP).unwrap();
    let request =
        CString::new(r#"{"format":"png","quality":100,"color_space":"srgb","max_long_edge":4}"#)
            .unwrap();
    let mut output = Output::new();
    assert_eq!(
        unsafe {
            maple_removal_saved_preview(
                handle.0,
                owner.0,
                changed.as_ptr(),
                4,
                std::ptr::null(),
                0,
                &mut output.0,
            )
        },
        5
    );
    output.assert_empty();
    assert_eq!(
        unsafe {
            maple_removal_saved_export(
                handle.0,
                owner.0,
                changed.as_ptr(),
                request.as_ptr(),
                std::ptr::null(),
                0,
                &mut output.0,
            )
        },
        5
    );
    output.assert_empty();
    assert_eq!(
        unsafe {
            maple_removal_saved_preview(
                handle.0,
                std::ptr::null(),
                xmp.as_ptr(),
                4,
                std::ptr::null(),
                0,
                &mut output.0,
            )
        },
        5
    );
    output.assert_empty();
    assert_eq!(
        unsafe {
            maple_removal_saved_preview(
                handle.0,
                owner.0,
                xmp.as_ptr(),
                4,
                std::ptr::null(),
                usize::MAX,
                &mut output.0,
            )
        },
        5
    );
    output.assert_empty();
    let request =
        CString::new(r#"{"format":"png","quality":100,"color_space":"untyped","max_long_edge":4}"#)
            .unwrap();
    assert_eq!(
        unsafe {
            maple_removal_saved_export(
                handle.0,
                owner.0,
                xmp.as_ptr(),
                request.as_ptr(),
                std::ptr::null(),
                0,
                &mut output.0,
            )
        },
        5
    );
    output.assert_empty();
}

#[test]
fn review_probe_preserves_short_buffers_and_returns_ordered_indices() {
    let handle = Handle::open();
    let owner = owner(&handle);
    let mut length = 99;
    assert_eq!(
        unsafe { maple_removal_saved_review_buf(owner.0, std::ptr::null_mut(), 0, &mut length) },
        100
    );
    assert_eq!(length, 2);
    let mut buffer = [42; 2];
    assert_eq!(
        unsafe { maple_removal_saved_review_buf(owner.0, buffer.as_mut_ptr(), 1, &mut length) },
        100
    );
    assert_eq!(buffer, [42; 2]);
    assert_eq!(
        unsafe { maple_removal_saved_review_buf(owner.0, buffer.as_mut_ptr(), 2, &mut length) },
        0
    );
    assert_eq!(&buffer, b"[]");
    assert_eq!(
        unsafe {
            maple_removal_saved_review_buf(owner.0, buffer.as_mut_ptr(), usize::MAX, &mut length)
        },
        5
    );
    assert_eq!(length, 0);
}
