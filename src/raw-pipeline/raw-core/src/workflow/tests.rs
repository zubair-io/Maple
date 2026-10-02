use super::*;
use serde_json::json;

const XMP: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../test-fixtures/tone-exposure/test_0017/exposure_p1.xmp"
));
const FOREIGN: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../test-fixtures/local-adjustments/lightroom-group-add.xmp"
));

fn id(n: u64) -> String {
    format!("00000000-0000-0000-0000-{n:012x}")
}
fn entry(n: u64) -> WorkflowHistoryEntry {
    WorkflowHistoryEntry {
        id: id(n),
        created_at_ms: n,
        action: "adjustment".into(),
        label: "Exposure +1".into(),
        adjustment_xmp: XMP.into(),
    }
}
fn snapshot() -> WorkflowSnapshot {
    WorkflowSnapshot {
        id: id(100),
        name: "Warm study 🌅".into(),
        created_at_ms: 1_790_000_000_000,
        adjustment_xmp: FOREIGN.into(),
    }
}

#[test]
fn complete_foreign_checkpoint_bytes_and_development_survive_round_trip() {
    let value = SidecarWorkflow::primary()
        .with_snapshot(snapshot())
        .unwrap()
        .committed(entry(1))
        .unwrap();
    let reopened = SidecarWorkflow::parse(&value.to_json().unwrap()).unwrap();
    assert_eq!(reopened, value);
    assert_eq!(reopened.snapshots[0].adjustment_xmp, FOREIGN);
    assert_eq!(reopened.history[0].adjustment_xmp, XMP);
    assert_eq!(
        crate::xmp::parse(&reopened.history[0].adjustment_xmp).unwrap(),
        crate::xmp::parse(XMP).unwrap()
    );
}

#[test]
fn compaction_retains_independent_exact_checkpoints_and_named_snapshots() {
    let initial = SidecarWorkflow::primary()
        .with_snapshot(snapshot())
        .unwrap();
    let value = (1..=64).fold(initial.clone(), |value, n| {
        value.committed(entry(n)).unwrap()
    });
    assert_eq!(value.history.len(), HISTORY_LIMIT);
    assert_eq!(value.history[0].id, id(33));
    assert_eq!(value.history[31].id, id(64));
    assert!(value
        .history
        .iter()
        .all(|entry| entry.adjustment_xmp == XMP));
    assert_eq!(value.snapshots, initial.snapshots);
    assert_eq!(
        SidecarWorkflow::parse(&value.to_json().unwrap()).unwrap(),
        value
    );
    assert!(initial.history.is_empty());
}

#[test]
fn invalid_commits_never_mutate_the_existing_workflow() {
    let value = SidecarWorkflow::primary().committed(entry(1)).unwrap();
    let before = value.clone();
    assert!(value.committed(entry(1)).is_err());
    for action in ["render", "refine", "cache", "decode"] {
        assert!(value
            .committed(WorkflowHistoryEntry {
                action: action.into(),
                ..entry(2)
            })
            .is_err());
    }
    assert_eq!(value, before);
}

#[test]
fn snapshots_reject_duplicate_identity_and_recursive_workflow_payload() {
    let value = SidecarWorkflow::primary()
        .with_snapshot(snapshot())
        .unwrap();
    assert!(value.with_snapshot(snapshot()).is_err());
    let recursive = XMP.replace("</rdf:Description>", "<papp:Workflow /></rdf:Description>");
    // Some canonical inputs use a self-closing Description; a full envelope
    // makes this malicious checkpoint independent of that formatting choice.
    let recursive = if recursive == XMP {
        "<x:xmpmeta><rdf:RDF><rdf:Description><papp:Workflow /></rdf:Description></rdf:RDF></x:xmpmeta>".into()
    } else {
        recursive
    };
    assert!(value
        .with_snapshot(WorkflowSnapshot {
            id: id(101),
            adjustment_xmp: recursive,
            ..snapshot()
        })
        .is_err());
}

#[test]
fn unsupported_versions_unknown_fields_and_missing_fields_cannot_be_silently_lost() {
    let value = serde_json::to_value(SidecarWorkflow::primary()).unwrap();
    for version in [0, 2, u32::MAX] {
        let mut invalid = value.clone();
        invalid["schemaVersion"] = json!(version);
        assert!(SidecarWorkflow::parse(&invalid.to_string()).is_err());
    }
    let mut unknown = value.clone();
    unknown["futureField"] = json!(true);
    assert!(SidecarWorkflow::parse(&unknown.to_string()).is_err());
    for field in WORKFLOW_FIELDS {
        let mut missing = value.clone();
        missing.as_object_mut().unwrap().remove(field.name);
        assert!(SidecarWorkflow::parse(&missing.to_string()).is_err());
    }
}

#[test]
fn unsafe_ids_invalid_xml_nonfinite_adjustments_and_lossy_times_are_rejected() {
    for variant_id in ["../other", "UPPERCASE", "", "a/b.xmp"] {
        let value = SidecarWorkflow {
            variant_id: variant_id.into(),
            ..SidecarWorkflow::primary()
        };
        assert!(value.validate().is_err());
    }
    for xml in [
        "",
        "not XML",
        "<rdf:Description />",
        "<x:xmpmeta><rdf:Description /></x:xmpmeta>",
        "<rdf:RDF><foreign><rdf:Description /></foreign></rdf:RDF>",
        "<![CDATA[garbage]]><rdf:RDF><rdf:Description /></rdf:RDF>",
        "<x:xmpmeta><rdf:Description>",
        "<x:xmpmeta><rdf:Description crs:Exposure2012=\"NaN\" /></x:xmpmeta>",
    ] {
        assert!(
            SidecarWorkflow::primary()
                .committed(WorkflowHistoryEntry {
                    adjustment_xmp: xml.into(),
                    ..entry(1)
                })
                .is_err(),
            "{xml}"
        );
    }
    assert!(SidecarWorkflow::primary()
        .committed(WorkflowHistoryEntry {
            created_at_ms: 9_007_199_254_740_992,
            ..entry(1)
        })
        .is_err());
}

#[test]
fn oversize_payloads_and_overlong_imported_history_are_rejected() {
    assert!(SidecarWorkflow::parse(&" ".repeat(WORKFLOW_MAX_BYTES + 1)).is_err());
    let value = SidecarWorkflow {
        history: (1..=33).map(entry).collect(),
        ..SidecarWorkflow::primary()
    };
    assert!(value.validate().is_err());
}

#[test]
fn byte_compaction_retains_latest_checkpoint_and_never_drops_named_snapshots() {
    let xml = XMP.replace(
        "<rdf:Description",
        &format!("<!-- {} --><rdf:Description", "x".repeat(70_000)),
    );
    let initial = SidecarWorkflow::primary()
        .with_snapshot(snapshot())
        .unwrap();
    let value = (1..=8).fold(initial.clone(), |value, n| {
        value
            .committed(WorkflowHistoryEntry {
                adjustment_xmp: xml.clone(),
                ..entry(n)
            })
            .unwrap()
    });
    assert!(value.history.len() < HISTORY_LIMIT);
    assert_eq!(value.history.last().unwrap().id, id(8));
    assert!(value.history.iter().all(|e| e.adjustment_xmp == xml));
    assert_eq!(value.snapshots, initial.snapshots);
    assert!(value.to_json().unwrap().len() <= WORKFLOW_MAX_BYTES);
    let too_large = XMP.replace(
        "<rdf:Description",
        &format!(
            "<!-- {} --><rdf:Description",
            "x".repeat(WORKFLOW_MAX_BYTES)
        ),
    );
    let before = value.clone();
    assert!(value
        .committed(WorkflowHistoryEntry {
            adjustment_xmp: too_large,
            ..entry(9)
        })
        .is_err());
    assert_eq!(value, before);
}

#[test]
fn shared_contract_corpus_preserves_foreign_masks_and_authored_wb_states() {
    let json = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../test-fixtures/workflow/contract-v1.json"
    ));
    let rows: Vec<serde_json::Value> = serde_json::from_str(json).unwrap();
    let workflows: Vec<_> = rows
        .iter()
        .map(|row| SidecarWorkflow::parse(&row.to_string()).unwrap())
        .collect();
    assert_eq!(workflows[0].variant_id, PRIMARY_VARIANT_ID);
    assert_ne!(workflows[1].variant_id, PRIMARY_VARIANT_ID);
    assert_eq!(workflows[0].snapshots[0].adjustment_xmp, FOREIGN);
    let partial = crate::xmp::parse(&workflows[0].history[1].adjustment_xmp).unwrap();
    let complete = crate::xmp::parse(&workflows[1].history[0].adjustment_xmp).unwrap();
    assert!(partial.temperature_seen);
    assert!(!partial.tint_seen);
    assert!(complete.temperature_seen && complete.tint_seen);
    assert_eq!(complete.temperature, 5100.0);
    assert_eq!(complete.tint, -7.0);
    for value in workflows {
        assert_eq!(
            SidecarWorkflow::parse(&value.to_json().unwrap()).unwrap(),
            value
        );
    }
}
