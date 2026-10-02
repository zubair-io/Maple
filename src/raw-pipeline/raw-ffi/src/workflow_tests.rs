use crate::workflow::*;
use raw_core::workflow::{SidecarWorkflow, WORKFLOW_MAX_BYTES};
const XMP: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../test-fixtures/local-adjustments/lightroom-group-add.xmp"
));
const CORPUS: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../test-fixtures/workflow/contract-v1.json"
));
#[test]
fn ffi_roundtrip_is_identical_to_core_and_keeps_absence_explicit() {
    let rows: Vec<SidecarWorkflow> = serde_json::from_str(CORPUS).unwrap();
    for record in rows {
        let json = record.to_json().unwrap();
        let mut out = vec![0; WORKFLOW_MAX_BYTES];
        let mut len = 0;
        let rc = unsafe {
            maple_workflow_embed_xmp(
                json.as_ptr(),
                json.len(),
                XMP.as_ptr(),
                XMP.len(),
                out.as_mut_ptr(),
                out.len(),
                &mut len,
            )
        };
        assert_eq!(rc, 0);
        let xml = String::from_utf8(out[..len].to_vec()).unwrap();
        assert_eq!(xml, record.embed_in_xmp(XMP).unwrap());
        let rc = unsafe {
            maple_workflow_read_xmp(
                xml.as_ptr(),
                xml.len(),
                out.as_mut_ptr(),
                out.len(),
                &mut len,
            )
        };
        assert_eq!(rc, 0);
        assert_eq!(&out[..len], json.as_bytes());
    }
    let mut out = [0; 4];
    let mut len = 0;
    assert_eq!(
        unsafe {
            maple_workflow_read_xmp(
                XMP.as_ptr(),
                XMP.len(),
                out.as_mut_ptr(),
                out.len(),
                &mut len,
            )
        },
        0
    );
    assert_eq!(&out[..len], b"null");
}
#[test]
fn invalid_input_short_buffer_and_future_records_never_mutate_output() {
    let rows: Vec<SidecarWorkflow> = serde_json::from_str(CORPUS).unwrap();
    let json = rows[0].to_json().unwrap();
    for input in ["{}", &json, "\0", "{\"schemaVersion\":2}"] {
        let mut out = [73; 1];
        let mut len = 42;
        assert_ne!(
            unsafe {
                maple_workflow_validate_json(
                    input.as_ptr(),
                    input.len(),
                    out.as_mut_ptr(),
                    out.len(),
                    &mut len,
                )
            },
            0
        );
        assert_eq!(out, [73]);
        assert_eq!(len, 42);
    }
}
#[test]
fn null_pointers_non_utf8_and_resource_limits_are_rejected() {
    let mut out = [71; 16];
    let mut len = 13;
    for (ptr, size) in [
        (std::ptr::null(), 0),
        ([255_u8].as_ptr(), 1),
        (XMP.as_ptr(), WORKFLOW_MAX_BYTES + 1),
    ] {
        assert_ne!(
            unsafe { maple_workflow_read_xmp(ptr, size, out.as_mut_ptr(), out.len(), &mut len) },
            0
        );
        assert_eq!(len, 13);
        assert_eq!(out, [71; 16]);
    }
    assert_eq!(
        unsafe {
            maple_workflow_read_xmp(XMP.as_ptr(), XMP.len(), std::ptr::null_mut(), 0, &mut len)
        },
        -1
    );
    assert_eq!(
        unsafe {
            maple_workflow_read_xmp(
                XMP.as_ptr(),
                XMP.len(),
                out.as_mut_ptr(),
                out.len(),
                std::ptr::null_mut(),
            )
        },
        -1
    );
}
