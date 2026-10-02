use super::*;
const XMP: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../test-fixtures/local-adjustments/lightroom-group-add.xmp"
));
fn id(n: u64) -> String {
    format!("00000000-0000-0000-0000-{n:012x}")
}
fn entry(xml: &str, n: u64, action: &str) -> String {
    serde_json::to_string(&WorkflowHistoryEntry {
        id: id(n),
        created_at_ms: n,
        action: action.into(),
        label: "Committed exposure".into(),
        adjustment_xmp: SidecarWorkflow::checkpoint_xmp(xml).unwrap(),
    })
    .unwrap()
}
fn snapshot(xml: &str) -> String {
    serde_json::to_string(&WorkflowSnapshot {
        id: id(100),
        name: "Warm study 🌅".into(),
        created_at_ms: 1,
        adjustment_xmp: SidecarWorkflow::checkpoint_xmp(xml).unwrap(),
    })
    .unwrap()
}
fn changed(xml: &str) -> String {
    xml.replace(
        r#"crs:ProcessVersion="15.4""#,
        r#"crs:ProcessVersion="15.4" crs:Exposure2012="1.25""#,
    )
}

#[test]
fn committed_snapshots_and_restore_survive_real_sidecars_with_exact_foreign_state() {
    let dir = tempfile::tempdir().unwrap();
    let original = dir.path().join("photo.dng");
    let sidecar = dir.path().join("photo.xmp");
    std::fs::write(&original, [1, 0, 255, 42]).unwrap();
    let first = SidecarWorkflow::commit_xmp(XMP, &entry(XMP, 1, "adjustment")).unwrap();
    let captured = SidecarWorkflow::checkpoint_xmp(&first).unwrap();
    let saved = SidecarWorkflow::snapshot_xmp(&first, &snapshot(&first)).unwrap();
    let edited = changed(&saved);
    assert_ne!(
        crate::xmp::parse(&edited).unwrap(),
        crate::xmp::parse(&saved).unwrap()
    );
    let second = SidecarWorkflow::commit_xmp(&edited, &entry(&edited, 2, "adjustment")).unwrap();
    std::fs::write(&sidecar, &second).unwrap();
    let reopened = std::fs::read_to_string(&sidecar).unwrap();
    let restored =
        SidecarWorkflow::restore_xmp(&reopened, &entry(&captured, 3, "snapshot-restore")).unwrap();
    let record = SidecarWorkflow::from_xmp(&restored).unwrap().unwrap();
    assert_eq!(record.snapshots[0].adjustment_xmp, captured);
    assert_eq!(record.history.len(), 3);
    assert_eq!(record.history.last().unwrap().action, "snapshot-restore");
    assert_eq!(
        crate::xmp::parse(&restored).unwrap(),
        crate::xmp::parse(&saved).unwrap()
    );
    assert_eq!(
        SidecarWorkflow::checkpoint_xmp(&restored).unwrap(),
        captured
    );
    assert_eq!(std::fs::read(&original).unwrap(), [1, 0, 255, 42]);
    assert_eq!(std::fs::read_to_string(&sidecar).unwrap(), second);
}

#[test]
fn history_restore_retains_variant_identity_and_current_named_snapshots() {
    let record = SidecarWorkflow {
        variant_id: id(90),
        variant_name: "Alternate".into(),
        ..SidecarWorkflow::primary()
    };
    let first = record.embed_in_xmp(XMP).unwrap();
    let committed =
        SidecarWorkflow::commit_xmp(&first, &entry(&first, 1, "variant-create")).unwrap();
    let original = SidecarWorkflow::checkpoint_xmp(&committed).unwrap();
    let edited = changed(&committed);
    let saved = SidecarWorkflow::snapshot_xmp(&edited, &snapshot(&edited)).unwrap();
    let next = SidecarWorkflow::commit_xmp(&saved, &entry(&saved, 2, "adjustment")).unwrap();
    let restored =
        SidecarWorkflow::restore_xmp(&next, &entry(&original, 3, "history-restore")).unwrap();
    let before = SidecarWorkflow::from_xmp(&next).unwrap().unwrap();
    let after = SidecarWorkflow::from_xmp(&restored).unwrap().unwrap();
    assert_eq!(after.variant_id, record.variant_id);
    assert_eq!(after.variant_name, record.variant_name);
    assert_eq!(after.snapshots, before.snapshots);
    assert_eq!(after.history.last().unwrap().adjustment_xmp, original);
}

#[test]
fn stale_forged_duplicate_and_future_mutations_leave_the_prior_state_unchanged() {
    let first = SidecarWorkflow::commit_xmp(XMP, &entry(XMP, 1, "adjustment")).unwrap();
    let saved = SidecarWorkflow::snapshot_xmp(&first, &snapshot(&first)).unwrap();
    let before = saved.clone();
    assert!(SidecarWorkflow::snapshot_xmp(&saved, &snapshot(&saved)).is_err());
    assert!(SidecarWorkflow::commit_xmp(&saved, &entry(&saved, 1, "adjustment")).is_err());
    assert!(
        SidecarWorkflow::commit_xmp(&changed(&saved), &entry(&saved, 2, "adjustment")).is_err()
    );
    assert!(SidecarWorkflow::snapshot_xmp(&changed(&saved), &snapshot(&saved)).is_err());
    assert!(
        SidecarWorkflow::restore_xmp(&saved, &entry(&changed(&saved), 2, "snapshot-restore"))
            .is_err()
    );
    assert!(SidecarWorkflow::restore_xmp(&saved, &entry(&saved, 2, "adjustment")).is_err());
    assert!(SidecarWorkflow::commit_xmp(&saved, &entry(&saved, 2, "snapshot-restore")).is_err());
    let future = saved.replace("<papp:SchemaVersion>1", "<papp:SchemaVersion>2");
    assert!(SidecarWorkflow::restore_xmp(&future, &entry(&saved, 2, "snapshot-restore")).is_err());
    assert!(SidecarWorkflow::snapshot_xmp(&future, &snapshot(&saved)).is_err());
    assert!(SidecarWorkflow::commit_xmp(&future, &entry(&saved, 2, "adjustment")).is_err());
    assert_eq!(saved, before);
}

#[test]
fn commit_compacts_against_final_escaped_xml_without_losing_named_snapshots() {
    let first = SidecarWorkflow::commit_xmp(XMP, &entry(XMP, 1, "adjustment")).unwrap();
    let saved = SidecarWorkflow::snapshot_xmp(&first, &snapshot(&first)).unwrap();
    let large = saved.replacen(
        "<rdf:Description",
        &format!("<!--{}--><rdf:Description", "<>&".repeat(10_000)),
        1,
    );
    let result = (2..=8).fold(large, |xml, n| {
        SidecarWorkflow::commit_xmp(&xml, &entry(&xml, n, "adjustment")).unwrap()
    });
    assert!(result.len() <= WORKFLOW_MAX_BYTES);
    let record = SidecarWorkflow::from_xmp(&result).unwrap().unwrap();
    assert!(record.history.len() < 8);
    assert_eq!(record.history.last().unwrap().id, id(8));
    assert_eq!(
        record.snapshots,
        SidecarWorkflow::from_xmp(&saved)
            .unwrap()
            .unwrap()
            .snapshots
    );
}

#[test]
fn oversized_newest_state_fails_instead_of_erasing_snapshots_or_publishing() {
    let first = SidecarWorkflow::commit_xmp(XMP, &entry(XMP, 1, "adjustment")).unwrap();
    let saved = SidecarWorkflow::snapshot_xmp(&first, &snapshot(&first)).unwrap();
    let huge = saved.replacen(
        "<rdf:Description",
        &format!("<!--{}--><rdf:Description", "<>&".repeat(30_000)),
        1,
    );
    assert!(huge.len() < WORKFLOW_MAX_BYTES);
    assert!(SidecarWorkflow::commit_xmp(&huge, &entry(&huge, 2, "adjustment")).is_err());
    assert!(SidecarWorkflow::snapshot_xmp(&huge, &snapshot(&huge)).is_err());
    assert_eq!(
        SidecarWorkflow::from_xmp(&saved)
            .unwrap()
            .unwrap()
            .history
            .len(),
        1
    );
}

#[test]
fn self_closing_partial_white_balance_checkpoint_keeps_authored_intent_on_restore() {
    let xml = r#"<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:Temperature="5100"/></rdf:RDF></x:xmpmeta>"#;
    let captured = snapshot(xml);
    let saved = SidecarWorkflow::snapshot_xmp(xml, &captured).unwrap();
    let changed = saved.replace(
        "crs:Temperature=\"5100\"",
        "crs:Temperature=\"7000\" crs:Tint=\"20\"",
    );
    let committed =
        SidecarWorkflow::commit_xmp(&changed, &entry(&changed, 1, "adjustment")).unwrap();
    let restored =
        SidecarWorkflow::restore_xmp(&committed, &entry(xml, 2, "snapshot-restore")).unwrap();
    assert_eq!(
        crate::xmp::parse(&restored).unwrap(),
        crate::xmp::parse(xml).unwrap()
    );
    let model = crate::xmp::parse(&restored).unwrap();
    assert!(model.temperature_seen);
    assert!(!model.tint_seen);
    let record = SidecarWorkflow::from_xmp(&restored).unwrap().unwrap();
    assert_eq!(record.snapshots[0].adjustment_xmp, xml);
    assert_eq!(record.history.last().unwrap().adjustment_xmp, xml);
}
