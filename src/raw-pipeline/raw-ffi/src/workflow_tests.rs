use crate::workflow::*;
use raw_core::workflow::{SidecarWorkflow, WORKFLOW_MAX_BYTES};
const XMP: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../test-fixtures/local-adjustments/lightroom-group-add.xmp"
));
const CORPUS: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../test-fixtures/workflow/contract.json"
));

#[test]
fn sibling_paths_and_checkpoint_capture_match_core_and_keep_failure_buffers_unchanged() {
    let rows: Vec<SidecarWorkflow> = serde_json::from_str(CORPUS).unwrap();
    let record = &rows[1];
    let name = "photo.MOV.xmp";
    let mut out = vec![0; WORKFLOW_MAX_BYTES];
    let mut len = 0;
    assert_eq!(
        unsafe {
            maple_workflow_variant_filename(
                name.as_ptr(),
                name.len(),
                record.variant_id.as_ptr(),
                record.variant_id.len(),
                out.as_mut_ptr(),
                out.len(),
                &mut len,
            )
        },
        0
    );
    assert_eq!(
        &out[..len],
        raw_core::workflow::variant_filename(name, &record.variant_id)
            .unwrap()
            .as_bytes()
    );
    let embedded = record.embed_in_xmp(XMP).unwrap();
    assert_eq!(
        unsafe {
            maple_workflow_checkpoint_xmp(
                embedded.as_ptr(),
                embedded.len(),
                out.as_mut_ptr(),
                out.len(),
                &mut len,
            )
        },
        0
    );
    assert_eq!(
        &out[..len],
        SidecarWorkflow::checkpoint_xmp(&embedded)
            .unwrap()
            .as_bytes()
    );
    let future = embedded.replace("<papp:SchemaVersion>2", "<papp:SchemaVersion>3");
    for xml in [&future, &embedded, "bad XML"] {
        let mut out = [73; 1];
        let mut len = 42;
        assert_ne!(
            unsafe {
                maple_workflow_checkpoint_xmp(
                    xml.as_ptr(),
                    xml.len(),
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
    for id in ["../primary", &record.variant_id] {
        let mut out = [73; 1];
        let mut len = 42;
        assert_ne!(
            unsafe {
                maple_workflow_variant_filename(
                    name.as_ptr(),
                    name.len(),
                    id.as_ptr(),
                    id.len(),
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

#[test]
fn authoring_mutation_abi_matches_core_and_preserves_output_on_all_failures() {
    use raw_core::workflow::{WorkflowHistoryEntry, WorkflowSnapshot};
    type Mutation =
        unsafe extern "C" fn(*const u8, usize, *const u8, usize, *mut u8, usize, *mut usize) -> i32;
    let entry = WorkflowHistoryEntry {
        id: "00000000-0000-0000-0000-000000000001".into(),
        created_at_ms: 1,
        action: "adjustment".into(),
        label: "Exposure".into(),
        parent_id: String::new(),
        writer: String::new(),
        adjustment_xmp: XMP.into(),
    };
    let json = serde_json::to_string(&entry).unwrap();
    let committed = SidecarWorkflow::commit_xmp(XMP, &json).unwrap();
    let checkpoint = SidecarWorkflow::checkpoint_xmp(&committed).unwrap();
    let snapshot = serde_json::to_string(&WorkflowSnapshot {
        id: "00000000-0000-0000-0000-000000000100".into(),
        created_at_ms: 1,
        name: "Warm study".into(),
        adjustment_xmp: checkpoint.clone(),
    })
    .unwrap();
    let saved = SidecarWorkflow::snapshot_xmp(&committed, &snapshot).unwrap();
    let restore = serde_json::to_string(&WorkflowHistoryEntry {
        id: "00000000-0000-0000-0000-000000000002".into(),
        action: "snapshot-restore".into(),
        adjustment_xmp: checkpoint,
        ..entry
    })
    .unwrap();
    let cases: [(Mutation, &str, &str, String); 3] = [
        (maple_workflow_commit_xmp, XMP, &json, committed.clone()),
        (
            maple_workflow_snapshot_xmp,
            &committed,
            &snapshot,
            saved.clone(),
        ),
        (
            maple_workflow_restore_xmp,
            &saved,
            &restore,
            SidecarWorkflow::restore_xmp(&saved, &restore).unwrap(),
        ),
    ];
    for (operation, xml, json, expected) in cases {
        let mut out = vec![0; WORKFLOW_MAX_BYTES];
        let mut length = 0;
        assert_eq!(
            unsafe {
                operation(
                    xml.as_ptr(),
                    xml.len(),
                    json.as_ptr(),
                    json.len(),
                    out.as_mut_ptr(),
                    out.len(),
                    &mut length,
                )
            },
            0
        );
        assert_eq!(&out[..length], expected.as_bytes());
        for (input, json) in [(xml, json), (xml, "{}"), ("not XML", json)] {
            let mut out = [73; 1];
            let mut length = 42;
            assert_ne!(
                unsafe {
                    operation(
                        input.as_ptr(),
                        input.len(),
                        json.as_ptr(),
                        json.len(),
                        out.as_mut_ptr(),
                        out.len(),
                        &mut length,
                    )
                },
                0
            );
            assert_eq!(out, [73]);
            assert_eq!(length, 42);
        }
        assert_eq!(
            unsafe {
                operation(
                    xml.as_ptr(),
                    xml.len(),
                    json.as_ptr(),
                    json.len(),
                    std::ptr::null_mut(),
                    0,
                    &mut length,
                )
            },
            -1
        );
    }
}

#[test]
fn reconcile_and_cursor_abi_match_core_and_preserve_output_on_failure() {
    let rows: Vec<SidecarWorkflow> = serde_json::from_str(CORPUS).unwrap();
    let base = rows[0].embed_in_xmp(XMP).unwrap();
    let current = base.replace(
        "crs:ProcessVersion=\"15.4\"",
        "crs:ProcessVersion=\"15.4\" crs:Tint=\"10\"",
    );
    let incoming = base.replace(
        "crs:ProcessVersion=\"15.4\"",
        "crs:ProcessVersion=\"15.4\" crs:Exposure2012=\"2\"",
    );
    let expected = SidecarWorkflow::reconcile_xmp(&base, &current, &incoming, 1).unwrap();
    let mut out = vec![0; WORKFLOW_MAX_BYTES];
    let mut len = 0;
    let call = |base: &str, out: &mut [u8], len: &mut usize| unsafe {
        maple_workflow_reconcile_xmp(
            base.as_ptr(),
            base.len(),
            current.as_ptr(),
            current.len(),
            incoming.as_ptr(),
            incoming.len(),
            1,
            out.as_mut_ptr(),
            out.len(),
            len,
        )
    };
    assert_eq!(call(&base, &mut out, &mut len), 0);
    assert_eq!(&out[..len], expected.as_bytes());
    for invalid in ["bad XML"] {
        let mut out = [73; 1];
        let mut len = 42;
        assert_ne!(call(invalid, &mut out, &mut len), 0);
        assert_eq!(out, [73]);
        assert_eq!(len, 42);
    }
    let mut out = vec![0; WORKFLOW_MAX_BYTES];
    assert_eq!(
        unsafe {
            maple_workflow_cursor_xmp(
                expected.as_ptr(),
                expected.len(),
                out.as_mut_ptr(),
                out.len(),
                &mut len,
            )
        },
        0
    );
    assert_eq!(
        &out[..len],
        SidecarWorkflow::cursor_xmp(&expected).unwrap().as_bytes()
    );
}
