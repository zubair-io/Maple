use super::*;
use std::path::Path;
use std::sync::{Arc, Mutex};

const XMP: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../test-fixtures/local-adjustments/lightroom-group-add.xmp"
));
const V1_SIDECAR: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../test-fixtures/workflow/v1-sidecar.xmp"
));

fn id(n: u64) -> String {
    format!("00000000-0000-0000-0000-{n:012x}")
}
fn now(n: u64) -> u64 {
    1_790_000_000_000 + n
}

/// What a host serializer does: set one modeled attribute, keeping every
/// other byte (the passthrough, including the Workflow record) as it was.
fn set(xml: &str, key: &str, value: &str) -> String {
    let needle = format!(" {key}=\"");
    match xml.find(&needle) {
        Some(at) => {
            let start = at + needle.len();
            let end = start + xml[start..].find('"').unwrap();
            format!("{}{value}{}", &xml[..start], &xml[end..])
        }
        None => xml.replacen(
            "crs:ProcessVersion=\"15.4\"",
            &format!("crs:ProcessVersion=\"15.4\" {key}=\"{value}\""),
            1,
        ),
    }
}

fn read(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap()
}

fn entry_json(n: u64, parent: &str, writer: &str, checkpoint: String) -> String {
    serde_json::to_string(&WorkflowHistoryEntry {
        id: id(n),
        created_at_ms: now(n),
        action: "adjustment".into(),
        label: format!("Edit {n}"),
        parent_id: parent.into(),
        writer: writer.into(),
        adjustment_xmp: checkpoint,
    })
    .unwrap()
}

/// A confirmed host save: reconcile onto the file, then commit the writer's
/// own entry based on the head it observed. The file is replaced atomically
/// by its caller's lock in the concurrent test.
fn save(path: &Path, base: &str, incoming: &str, n: u64, writer: &str) -> String {
    let current = read(path);
    let merged = SidecarWorkflow::reconcile_xmp(base, &current, incoming, now(n)).unwrap();
    let observed = SidecarWorkflow::from_xmp(base)
        .unwrap()
        .map(|record| record.head_id().to_owned())
        .unwrap_or_default();
    let checkpoint = SidecarWorkflow::checkpoint_xmp(&merged).unwrap();
    let published =
        SidecarWorkflow::commit_xmp(&merged, &entry_json(n, &observed, writer, checkpoint))
            .unwrap();
    std::fs::write(path, &published).unwrap();
    published
}

fn start(dir: &Path) -> (std::path::PathBuf, String) {
    let sidecar = dir.join("photo.xmp");
    let first = SidecarWorkflow::commit_xmp(
        XMP,
        &entry_json(
            1,
            "",
            "apple",
            SidecarWorkflow::checkpoint_xmp(XMP).unwrap(),
        ),
    )
    .unwrap();
    std::fs::write(&sidecar, &first).unwrap();
    (sidecar, first)
}

fn history(xml: &str) -> Vec<WorkflowHistoryEntry> {
    SidecarWorkflow::from_xmp(xml).unwrap().unwrap().history
}

#[test]
fn two_writers_from_one_base_keep_both_edits_as_consecutive_entries() {
    let dir = tempfile::tempdir().unwrap();
    let (sidecar, base) = start(dir.path());

    let a = save(
        &sidecar,
        &base,
        &set(&base, "crs:Exposure2012", "1.25"),
        2,
        "apple",
    );
    // Writer B read the same base and never saw A's edit.
    let b = save(
        &sidecar,
        &base,
        &set(&base, "crs:Contrast2012", "30"),
        3,
        "web",
    );

    let entries = history(&b);
    assert_eq!(
        entries.iter().map(|e| e.id.clone()).collect::<Vec<_>>(),
        [id(1), id(2), id(3)]
    );
    assert!(entries.iter().all(|e| e.action == "adjustment"));
    // Both edits name the head they saw; B's parent is not the entry before it.
    assert_eq!(entries[1].parent_id, id(1));
    assert_eq!(entries[2].parent_id, id(1));
    assert_eq!(entries[2].writer, "web");
    // The current document holds both edits; neither writer's change was lost.
    let model = crate::xmp::parse(&b).unwrap();
    assert_eq!(model.exposure, 1.25);
    assert_eq!(model.contrast, 30.0);
    // A's state stays recoverable on its own.
    let a_state = crate::xmp::parse(&entries[1].adjustment_xmp).unwrap();
    assert_eq!(a_state.exposure, 1.25);
    assert_eq!(a_state.contrast, 0.0);
    assert_eq!(read(&sidecar), b);
    assert_ne!(a, b);
}

#[test]
fn a_property_both_writers_changed_keeps_the_later_value_and_the_displaced_one_in_history() {
    let dir = tempfile::tempdir().unwrap();
    let (sidecar, base) = start(dir.path());
    save(
        &sidecar,
        &base,
        &set(&base, "crs:Exposure2012", "2"),
        2,
        "apple",
    );
    let b = save(
        &sidecar,
        &base,
        &set(&base, "crs:Exposure2012", "0.01"),
        3,
        "web",
    );
    assert_eq!(crate::xmp::parse(&b).unwrap().exposure, 0.01);
    let entries = history(&b);
    assert_eq!(
        crate::xmp::parse(&entries[1].adjustment_xmp)
            .unwrap()
            .exposure,
        2.0
    );
}

#[test]
fn a_change_made_outside_maple_is_captured_instead_of_overwritten_unrecorded() {
    let dir = tempfile::tempdir().unwrap();
    let (sidecar, base) = start(dir.path());
    // Another tool edits the file and keeps the Workflow record untouched.
    let external = set(&base, "crs:Tint", "10");
    std::fs::write(&sidecar, &external).unwrap();

    let published = save(
        &sidecar,
        &base,
        &set(&base, "crs:Exposure2012", "2"),
        2,
        "apple",
    );
    let entries = history(&published);
    assert_eq!(entries.len(), 3);
    let captured = &entries[1];
    assert_eq!(captured.action, "external");
    assert_eq!(captured.parent_id, id(1));
    assert_eq!(captured.writer, "");
    assert_eq!(captured.created_at_ms, now(2));
    assert_eq!(
        captured.adjustment_xmp,
        SidecarWorkflow::checkpoint_xmp(&external).unwrap()
    );
    assert_eq!(entries[2].parent_id, id(1));
    let model = crate::xmp::parse(&published).unwrap();
    assert_eq!(model.tint, 10.0);
    assert_eq!(model.exposure, 2.0);

    // The outside edit is one restore away.
    let restore = serde_json::to_string(&WorkflowHistoryEntry {
        id: id(9),
        created_at_ms: now(9),
        action: "history-restore".into(),
        label: "Restore outside change".into(),
        parent_id: String::new(),
        writer: "apple".into(),
        adjustment_xmp: captured.adjustment_xmp.clone(),
    })
    .unwrap();
    let restored = SidecarWorkflow::restore_xmp(&published, &restore).unwrap();
    let model = crate::xmp::parse(&restored).unwrap();
    assert_eq!(model.tint, 10.0);
    assert_eq!(model.exposure, 0.0);
}

#[test]
fn an_outside_change_is_recorded_once_whoever_reconciles_it() {
    let dir = tempfile::tempdir().unwrap();
    let (sidecar, base) = start(dir.path());
    let current = set(&base, "crs:Tint", "10");
    let incoming = set(&base, "crs:Exposure2012", "2");
    // The entry's identity comes from its content and parent, not from the clock.
    let first = SidecarWorkflow::reconcile_xmp(&base, &current, &incoming, now(2)).unwrap();
    let second = SidecarWorkflow::reconcile_xmp(&base, &current, &incoming, now(5)).unwrap();
    assert_eq!(history(&first)[1].id, history(&second)[1].id);
    assert_ne!(
        history(&first)[1].created_at_ms,
        history(&second)[1].created_at_ms
    );

    // Once a writer has committed on top, a later stale writer finds the
    // current document recorded and captures nothing more.
    std::fs::write(&sidecar, &current).unwrap();
    save(&sidecar, &base, &incoming, 2, "apple");
    let later = save(
        &sidecar,
        &base,
        &set(&base, "crs:Contrast2012", "5"),
        3,
        "web",
    );
    let actions: Vec<_> = history(&later).into_iter().map(|e| e.action).collect();
    assert_eq!(
        actions,
        ["adjustment", "external", "adjustment", "adjustment"]
    );
}

#[test]
fn an_unchanged_file_publishes_the_writers_document_as_is() {
    let dir = tempfile::tempdir().unwrap();
    let (_, base) = start(dir.path());
    let incoming = set(&base, "crs:Exposure2012", "1");
    let output = SidecarWorkflow::reconcile_xmp(&base, &base, &incoming, now(2)).unwrap();
    assert_eq!(output, incoming);
    assert_eq!(history(&output).len(), 1);
    // A first writer with no sidecar and no record at all.
    let plain =
        SidecarWorkflow::reconcile_xmp(XMP, XMP, &set(XMP, "crs:Tint", "3"), now(2)).unwrap();
    assert_eq!(plain, set(XMP, "crs:Tint", "3"));
    assert_eq!(SidecarWorkflow::from_xmp(&plain).unwrap(), None);
}

#[test]
fn unknown_attributes_and_elements_are_byte_for_byte_those_of_the_current_file() {
    let dir = tempfile::tempdir().unwrap();
    let (sidecar, _) = start(dir.path());
    let base = read(&sidecar);
    // Another tool adds a vendor attribute and an odd child with CRLFs.
    let foreign = "<vendor:Opaque xmlns:vendor=\"urn:vendor\">\r\n\t  keep   &amp; <b>exact</b>\r\n  </vendor:Opaque>";
    let external = set(&base, "crs:Tint", "10").replacen(
        "<crs:MaskGroupBasedCorrections>",
        &format!("{foreign}\n   <crs:MaskGroupBasedCorrections>"),
        1,
    );
    std::fs::write(&sidecar, &external).unwrap();

    let published = save(
        &sidecar,
        &base,
        &set(&base, "crs:Exposure2012", "2"),
        2,
        "apple",
    );

    assert!(published.contains(foreign));
    let mask_start = XMP.find("<crs:MaskGroupBasedCorrections>").unwrap();
    let mask_end = XMP.find("</crs:MaskGroupBasedCorrections>").unwrap();
    assert!(published.contains(&XMP[mask_start..mask_end]));
    // Outside the Description: the envelope is untouched.
    let description = XMP.find("<rdf:Description").unwrap();
    assert_eq!(&published[..description], &XMP[..description]);
    let tail = &XMP[XMP.rfind("</rdf:Description>").unwrap()..];
    assert!(published.ends_with(tail));
    // The foreign attribute-free read is still a valid sidecar for the renderer.
    assert_eq!(crate::xmp::parse(&published).unwrap().tint, 10.0);
}

#[test]
fn a_v1_sidecar_reads_as_v2_and_is_rewritten_on_its_next_commit() {
    let record = SidecarWorkflow::from_xmp(V1_SIDECAR).unwrap().unwrap();
    assert_eq!(record.schema_version, WORKFLOW_VERSION);
    assert!(!record.history.is_empty());
    assert_eq!(record.history[0].parent_id, "");
    for pair in record.history.windows(2) {
        assert_eq!(pair[1].parent_id, pair[0].id);
    }
    assert!(record.history.iter().all(|entry| entry.writer.is_empty()));

    let checkpoint = SidecarWorkflow::checkpoint_xmp(V1_SIDECAR).unwrap();
    let edited = set_any(&checkpoint, "crs:Exposure2012", "0.5");
    let candidate = record.embed_in_xmp(&edited).unwrap();
    let committed = SidecarWorkflow::commit_xmp(
        &candidate,
        &entry_json(
            500,
            record.head_id(),
            "apple",
            SidecarWorkflow::checkpoint_xmp(&edited).unwrap(),
        ),
    )
    .unwrap();
    assert!(committed.contains("<papp:SchemaVersion>2</papp:SchemaVersion>"));
    let after = history(&committed);
    assert_eq!(after.len(), record.history.len() + 1);
    // Every retained v1 checkpoint is carried over exactly.
    for (old, new) in record.history.iter().zip(&after) {
        assert_eq!(old.adjustment_xmp, new.adjustment_xmp);
    }
    assert_eq!(after.last().unwrap().parent_id, record.head_id());
    // A v1 record that already carries v2 fields is not a v1 record.
    let mixed = V1_SIDECAR.replacen(
        "<papp:Label>",
        "<papp:ParentId></papp:ParentId><papp:Label>",
        1,
    );
    assert!(SidecarWorkflow::from_xmp(&mixed).is_err());
}

fn set_any(xml: &str, key: &str, value: &str) -> String {
    let needle = format!("{key}=\"");
    let start = xml.find(&needle).unwrap() + needle.len();
    let end = start + xml[start..].find('"').unwrap();
    format!("{}{value}{}", &xml[..start], &xml[end..])
}

#[test]
fn the_history_stays_bounded_and_keeps_its_head_through_many_reconciled_saves() {
    let dir = tempfile::tempdir().unwrap();
    let (sidecar, mut base) = start(dir.path());
    for n in 2..=60 {
        base = save(
            &sidecar,
            &base,
            &set(&base, "crs:Exposure2012", &format!("{}", n % 7)),
            n,
            "apple",
        );
    }
    let entries = history(&read(&sidecar));
    assert_eq!(entries.len(), HISTORY_LIMIT);
    assert_eq!(entries.last().unwrap().id, id(60));
    assert!(read(&sidecar).len() <= WORKFLOW_MAX_BYTES);
}

#[test]
fn concurrent_writers_never_lose_an_edit() {
    let dir = tempfile::tempdir().unwrap();
    let (sidecar, base) = start(dir.path());
    // Every writer opened the file at the same base. A per-sidecar lock stands
    // in for the host's write serialization (file coordination, Web Locks,
    // the server's per-path barrier); reconcile does the rest.
    let lock = Arc::new(Mutex::new(()));
    let writers: Vec<_> = (0..8u64)
        .map(|w| {
            let (lock, sidecar, base) = (lock.clone(), sidecar.clone(), base.clone());
            std::thread::spawn(move || {
                let incoming = set(&base, "crs:Exposure2012", "0").replacen(
                    "crs:ProcessVersion=\"15.4\"",
                    &format!("crs:ProcessVersion=\"15.4\" vendor:Edit{w}=\"{w}\""),
                    1,
                );
                let incoming = incoming.replacen(
                    "<rdf:Description",
                    "<rdf:Description xmlns:vendor=\"urn:vendor\"",
                    1,
                );
                let _guard = lock.lock().unwrap();
                save(&sidecar, &base, &incoming, 10 + w, &format!("writer-{w}"));
            })
        })
        .collect();
    for writer in writers {
        writer.join().unwrap();
    }
    let published = read(&sidecar);
    let entries = history(&published);
    assert_eq!(entries.len(), 9);
    for w in 0..8u64 {
        assert!(
            published.contains(&format!("vendor:Edit{w}=\"{w}\"")),
            "writer {w}'s edit is in the current document"
        );
        assert!(entries.iter().any(|e| e.id == id(10 + w)));
    }
    // Every entry is its writer's own change on the head it saw.
    assert!(entries[1..].iter().all(|e| e.parent_id == id(1)));
    assert!(entries.iter().all(|e| e.action != "external"));
}

#[test]
fn unusable_input_fails_without_a_partial_result() {
    let dir = tempfile::tempdir().unwrap();
    let (_, base) = start(dir.path());
    let incoming = set(&base, "crs:Exposure2012", "1");
    let current = set(&base, "crs:Tint", "5");
    let future = current.replace("<papp:SchemaVersion>2", "<papp:SchemaVersion>3");
    assert!(SidecarWorkflow::reconcile_xmp(&base, &future, &incoming, now(2)).is_err());
    assert!(SidecarWorkflow::reconcile_xmp("not xml", &current, &incoming, now(2)).is_err());
    assert!(SidecarWorkflow::reconcile_xmp(&base, &current, "not xml", now(2)).is_err());
    assert!(
        SidecarWorkflow::reconcile_xmp(&base, &current, &incoming, MAX_TIMESTAMP_MS + 1).is_err()
    );
}
