use super::*;

const XMP: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../test-fixtures/tone-exposure/test_0017/exposure_p1.xmp"
));

fn id(n: u64) -> String {
    format!("00000000-0000-0000-0000-{n:012x}")
}
fn state(exposure: u32) -> String {
    XMP.replace("+1.00", &format!("+{exposure}.00"))
}
fn entry(n: u64, action: &str, exposure: u32) -> WorkflowHistoryEntry {
    WorkflowHistoryEntry {
        id: id(n),
        created_at_ms: n,
        action: action.into(),
        label: format!("{action} {n}"),
        parent_id: String::new(),
        writer: "apple".into(),
        adjustment_xmp: state(exposure),
    }
}
fn record(entries: impl IntoIterator<Item = WorkflowHistoryEntry>) -> SidecarWorkflow {
    entries
        .into_iter()
        .fold(SidecarWorkflow::primary(), |record, entry| {
            record.committed(entry).unwrap()
        })
}
fn ids(values: &[u64]) -> Vec<String> {
    values.iter().map(|n| id(*n)).collect()
}

#[test]
fn edits_stack_up_and_undo_walks_back_through_them() {
    let value = record([
        entry(1, "adjustment", 1),
        entry(2, "adjustment", 2),
        entry(3, "adjustment", 3),
    ]);
    let cursor = value.cursor(&state(3)).unwrap();
    assert_eq!(cursor.undo, ids(&[1, 2]));
    assert!(cursor.redo.is_empty());
    assert!(cursor.synced);
}

#[test]
fn undo_and_redo_entries_move_the_head_between_the_stacks() {
    let value = record([
        entry(1, "adjustment", 1),
        entry(2, "adjustment", 2),
        entry(3, "adjustment", 3),
        entry(4, "undo", 2),
        entry(5, "undo", 1),
    ]);
    let cursor = value.cursor(&state(1)).unwrap();
    assert!(cursor.undo.is_empty());
    // Nearest first: the next redo returns to exposure 2.
    assert_eq!(cursor.redo, ids(&[4, 3]));

    let value = value.committed(entry(6, "redo", 2)).unwrap();
    let cursor = value.cursor(&state(2)).unwrap();
    assert_eq!(cursor.undo, ids(&[5]));
    assert_eq!(cursor.redo, ids(&[3]));
}

#[test]
fn a_new_edit_after_undo_clears_redo() {
    let value = record([
        entry(1, "adjustment", 1),
        entry(2, "adjustment", 2),
        entry(3, "undo", 1),
        entry(4, "adjustment", 5),
    ]);
    let cursor = value.cursor(&state(5)).unwrap();
    assert_eq!(cursor.undo, ids(&[3]));
    assert!(cursor.redo.is_empty());
}

#[test]
fn a_sidecar_that_differs_from_the_head_makes_the_head_the_next_undo() {
    let value = record([
        entry(1, "adjustment", 1),
        entry(2, "adjustment", 2),
        entry(3, "undo", 1),
    ]);
    // An outside edit after the undo: redo is no longer meaningful.
    let cursor = value.cursor(&state(9)).unwrap();
    assert!(!cursor.synced);
    assert_eq!(cursor.undo, ids(&[3]));
    assert!(cursor.redo.is_empty());
}

#[test]
fn a_record_without_history_has_nothing_to_undo() {
    let cursor = SidecarWorkflow::primary().cursor(XMP).unwrap();
    assert!(cursor.undo.is_empty() && cursor.redo.is_empty() && cursor.synced);
    assert_eq!(
        SidecarWorkflow::cursor_xmp(XMP).unwrap(),
        r#"{"undo":[],"redo":[],"synced":true}"#
    );
}

#[test]
fn the_stacks_survive_a_restart_and_the_cap() {
    let dir = tempfile::tempdir().unwrap();
    let sidecar = dir.path().join("photo.xmp");
    // 40 edits, then two undos: older entries fall out of the cap, the fold
    // runs over what is retained.
    let mut entries: Vec<_> = (1..=40u64)
        .map(|n| entry(n, "adjustment", (n % 5) as u32))
        .collect();
    entries.push(entry(41, "undo", 3));
    entries.push(entry(42, "undo", 2));
    let value = record(entries);
    assert_eq!(value.history.len(), HISTORY_LIMIT);
    let xml = value.embed_in_xmp(&state(2)).unwrap();
    std::fs::write(&sidecar, &xml).unwrap();

    // A new process reads the file back.
    let reopened = std::fs::read_to_string(&sidecar).unwrap();
    let json: serde_json::Value =
        serde_json::from_str(&SidecarWorkflow::cursor_xmp(&reopened).unwrap()).unwrap();
    assert_eq!(json["synced"], true);
    let undo = json["undo"].as_array().unwrap();
    let redo = json["redo"].as_array().unwrap();
    // Entries 11..=42 are retained; the two undos left 40 and 41 to redo.
    assert_eq!(
        redo,
        &[serde_json::json!(id(41)), serde_json::json!(id(40))]
    );
    assert_eq!(undo.len(), HISTORY_LIMIT - 1 - 2 - 2);
    assert_eq!(undo.last().unwrap(), &serde_json::json!(id(37)));
}

#[test]
fn undoing_the_first_edit_leaves_it_available_to_redo() {
    let value = record([entry(1, "adjustment", 1), entry(2, "undo", 0)]);
    let cursor = value.cursor(&state(0)).unwrap();
    assert!(cursor.undo.is_empty());
    assert_eq!(cursor.redo, ids(&[1]));
    assert!(cursor.synced);
}
