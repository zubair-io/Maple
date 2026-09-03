//! Registry invariants + the release-state rule (#2430).

#![cfg(test)]

use std::collections::{BTreeMap, HashSet};
use std::path::Path;

use super::*;
use crate::types::{AdjustmentGroup, ADJUSTMENT_SCHEMA, NON_COPYABLE_FIELDS};

fn repo_root() -> &'static Path {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .expect("raw-core sits three levels below the repo root")
}

fn capability(id: &str) -> &'static Capability {
    CAPABILITY_REGISTRY
        .iter()
        .find(|c| c.id == id)
        .unwrap_or_else(|| panic!("no capability `{id}`"))
}

/// A synthetic Apple-only capability whose every declared source covers
/// Apple (or the shared core) — the shape that CAN reach `Released`. The
/// real table has no such entry today: everything surfaced on Web or
/// Windows lacks a covering qualification source, which is exactly the
/// gap the registry exists to report.
const APPLE_ONLY: Capability = Capability {
    id: "synthetic_apple_only",
    title: "synthetic",
    owner: "test",
    surfaces: &[Surface::Apple],
    storage_adapters: &[StorageAdapter::Filesystem],
    asset_classes: &[AssetClass::Raw],
    preview_paths: &[PreviewPath::GpuLive],
    export_paths: &[ExportPath::AppleFfi],
    groups: &[],
    fields: &[],
    integration: &[
        EvidenceSource::SidecarContractApple,
        EvidenceSource::GpuChainParityLavapipe,
    ],
    qualification: &[
        EvidenceSource::GreyAdjustments,
        EvidenceSource::ColorHarness,
        EvidenceSource::GpuChainParityMetal,
        EvidenceSource::AppleCanvasGolden,
    ],
};

/// A synthetic Web-only capability with integration evidence but no
/// qualification source declared at all.
const WEB_UNQUALIFIED: Capability = Capability {
    id: "synthetic_web_unqualified",
    title: "synthetic",
    owner: "test",
    surfaces: &[Surface::Web],
    storage_adapters: &[StorageAdapter::ApiFilesystem],
    asset_classes: &[AssetClass::Raw],
    preview_paths: &[PreviewPath::WasmCpu],
    export_paths: &[ExportPath::Wasm],
    groups: &[],
    fields: &[],
    integration: &[EvidenceSource::SidecarContractApi],
    qualification: &[],
};

/// A record that satisfies `source` under `evidence`'s build + corpus.
fn satisfied_record(source: EvidenceSource, evidence: &Evidence) -> EvidenceRecord {
    let build = evidence.build.expect("build identity");
    EvidenceRecord {
        source,
        backend: source.accepted_backends()[0].to_owned(),
        pipeline_version: build.pipeline_version,
        schema_version: build.schema_version,
        corpus_hash: evidence.corpus_hashes[&source].clone(),
        expected_cases: source.expected_cases(),
        executed_cases: source.expected_cases(),
        failed_cases: 0,
        skipped_cases: 0,
        git_sha: "0000000".into(),
        recorded_at: "2026-01-01T00:00:00Z".into(),
        command: "test".into(),
    }
}

/// Evidence with a synthetic corpus hash per source and no records.
fn empty_evidence() -> Evidence {
    Evidence {
        records: BTreeMap::new(),
        build: Some(BuildIdentity {
            pipeline_version: 7,
            schema_version: 3,
        }),
        corpus_hashes: EvidenceSource::ALL
            .iter()
            .map(|s| (*s, format!("blake3:{}", s.id())))
            .collect(),
    }
}

fn with_all_satisfied(cap: &Capability) -> Evidence {
    let mut evidence = empty_evidence();
    for source in cap.integration.iter().chain(cap.qualification) {
        evidence
            .records
            .insert(*source, satisfied_record(*source, &evidence));
    }
    evidence
}

// ── Registry invariants ────────────────────────────────────────────────────

#[test]
fn ids_are_unique_snake_case_and_owned() {
    let mut seen = HashSet::new();
    for cap in CAPABILITY_REGISTRY {
        assert!(seen.insert(cap.id), "duplicate capability id `{}`", cap.id);
        assert!(
            cap.id
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_'),
            "`{}` is not snake_case",
            cap.id
        );
        assert!(!cap.owner.is_empty(), "`{}` has no owner", cap.id);
        assert!(!cap.title.is_empty(), "`{}` has no title", cap.id);
    }
}

/// Every `AdjustmentModel` field is owned by exactly one capability: each
/// copy/paste group is claimed once, and each `NON_COPYABLE_FIELDS` entry
/// is claimed once directly. A new field lands in a group (or the
/// non-copyable list) via the schema's own coverage test, and this test
/// then forces a capability to own it.
#[test]
fn every_schema_field_is_owned_by_exactly_one_capability() {
    let mut group_owners: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    let mut field_owners: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for cap in CAPABILITY_REGISTRY {
        for g in cap.groups {
            group_owners.entry(g.id()).or_default().push(cap.id);
        }
        for f in cap.owned_fields() {
            field_owners.entry(f).or_default().push(cap.id);
        }
    }
    for g in AdjustmentGroup::ALL {
        assert_eq!(
            group_owners.get(g.id()).map(Vec::len),
            Some(1),
            "group `{}` must be owned by exactly one capability, owners: {:?}",
            g.id(),
            group_owners.get(g.id())
        );
    }
    for spec in ADJUSTMENT_SCHEMA {
        assert_eq!(
            field_owners.get(spec.name).map(Vec::len),
            Some(1),
            "field `{}` must be owned by exactly one capability, owners: {:?}",
            spec.name,
            field_owners.get(spec.name)
        );
    }
    for f in NON_COPYABLE_FIELDS {
        assert_eq!(
            field_owners.get(f).map(Vec::len),
            Some(1),
            "non-copyable field `{f}` must be owned by exactly one capability"
        );
    }
}

#[test]
fn evidence_source_ids_round_trip_and_declare_real_corpora() {
    for source in EvidenceSource::ALL {
        assert_eq!(EvidenceSource::from_id(source.id()), Some(*source));
        assert!(!source.accepted_backends().is_empty(), "{}", source.id());
        assert!(source.expected_cases() > 0, "{}", source.id());
        for rel in source.corpus() {
            assert!(
                repo_root().join(rel).exists(),
                "corpus path `{rel}` for `{}` does not exist",
                source.id()
            );
        }
    }
}

/// The colour harness's expected count is the number of budget cells in
/// `test-fixtures/budgets.json` — every cell is one ACR comparison across
/// the neutral / auto / detail passes.
#[test]
fn color_harness_expected_cases_match_budget_cells() {
    let text = std::fs::read_to_string(repo_root().join("test-fixtures/budgets.json"))
        .expect("budgets.json");
    let v: serde_json::Value = serde_json::from_str(&text).expect("budgets.json parses");
    let cells: usize = v["fixtures"]
        .as_object()
        .expect("fixtures object")
        .values()
        .map(|f| f.as_object().map_or(0, |o| o.len()))
        .sum();
    assert_eq!(
        EvidenceSource::ColorHarness.expected_cases() as usize,
        cells,
        "bump EvidenceSource::ColorHarness::expected_cases to the budgets.json cell count"
    );
}

#[test]
fn current_schema_version_is_the_default_wb_scale() {
    assert_eq!(current_schema_version(), 5);
    assert_eq!(
        BuildIdentity::current().pipeline_version,
        crate::PIPELINE_OUTPUT_VERSION
    );
}

// ── The release-state rule ────────────────────────────────────────────────

#[test]
fn no_evidence_means_core_for_every_capability() {
    let evidence = empty_evidence();
    for cap in CAPABILITY_REGISTRY {
        let c = classify(cap, &evidence);
        assert_eq!(c.state, ReleaseState::Core, "{}", cap.id);
        assert!(c
            .integration
            .iter()
            .chain(&c.qualification)
            .all(|f| f.status == RecordStatus::Missing));
    }
}

#[test]
fn complete_evidence_releases_a_surfaced_capability() {
    let cap = &APPLE_ONLY;
    let c = classify(cap, &with_all_satisfied(cap));
    assert_eq!(c.state, ReleaseState::Released);
    assert!(c
        .integration
        .iter()
        .chain(&c.qualification)
        .all(|f| f.status.is_satisfied()));
}

#[test]
fn zero_executed_cases_cannot_release() {
    let cap = &APPLE_ONLY;
    let mut evidence = with_all_satisfied(cap);
    let vacuous = evidence
        .records
        .get_mut(&EvidenceSource::ColorHarness)
        .expect("record");
    vacuous.executed_cases = 0;
    let c = classify(cap, &evidence);
    assert_eq!(c.state, ReleaseState::Integrated);
    let finding = c
        .qualification
        .iter()
        .find(|f| f.source == EvidenceSource::ColorHarness)
        .expect("finding");
    assert_eq!(finding.status, RecordStatus::Vacuous);
}

#[test]
fn a_missing_required_contract_cannot_release() {
    let cap = &APPLE_ONLY;
    let mut evidence = with_all_satisfied(cap);
    evidence.records.remove(&EvidenceSource::AppleCanvasGolden);
    assert_eq!(classify(cap, &evidence).state, ReleaseState::Integrated);
    evidence
        .records
        .remove(&EvidenceSource::SidecarContractApple);
    assert_eq!(classify(cap, &evidence).state, ReleaseState::Core);
}

#[test]
fn skipped_failed_and_short_runs_do_not_count() {
    let cap = &APPLE_ONLY;
    let source = EvidenceSource::GreyAdjustments;
    let base = with_all_satisfied(cap);
    let variants: [(&str, Box<dyn Fn(&mut EvidenceRecord)>, RecordStatus); 4] = [
        (
            "skipped",
            Box::new(|r| r.skipped_cases = 1),
            RecordStatus::Skipped(1),
        ),
        (
            "failed",
            Box::new(|r| r.failed_cases = 2),
            RecordStatus::Failed(2),
        ),
        (
            "short",
            Box::new(|r| r.executed_cases -= 1),
            RecordStatus::CountMismatch {
                expected: source.expected_cases(),
                executed: source.expected_cases() - 1,
            },
        ),
        (
            "over-declared",
            Box::new(|r| r.expected_cases += 1),
            RecordStatus::CountMismatch {
                expected: source.expected_cases(),
                executed: source.expected_cases(),
            },
        ),
    ];
    for (label, mutate, expected_status) in variants {
        let mut evidence = base.clone();
        mutate(evidence.records.get_mut(&source).expect("record"));
        let c = classify(cap, &evidence);
        assert_eq!(c.state, ReleaseState::Integrated, "{label}");
        let f = c
            .qualification
            .iter()
            .find(|f| f.source == source)
            .expect("finding");
        assert_eq!(f.status, expected_status, "{label}");
    }
}

#[test]
fn evidence_loss_demotes_on_the_next_build() {
    let cap = &APPLE_ONLY;
    let satisfied = with_all_satisfied(cap);
    assert_eq!(classify(cap, &satisfied).state, ReleaseState::Released);

    // Pipeline bump: every record is now stale.
    let mut bumped = satisfied.clone();
    bumped.build = Some(BuildIdentity {
        pipeline_version: 8,
        schema_version: 3,
    });
    let c = classify(cap, &bumped);
    assert_eq!(c.state, ReleaseState::Core);
    assert!(c.integration.iter().all(|f| matches!(
        f.status,
        RecordStatus::StalePipeline {
            recorded: 7,
            current: 8
        }
    )));

    // Schema bump: same.
    let mut schema = satisfied.clone();
    schema.build = Some(BuildIdentity {
        pipeline_version: 7,
        schema_version: 4,
    });
    assert_eq!(classify(cap, &schema).state, ReleaseState::Core);

    // Corpus edit on one source: only that source goes stale.
    let mut corpus = satisfied.clone();
    corpus
        .corpus_hashes
        .insert(EvidenceSource::ColorHarness, "blake3:changed".into());
    let c = classify(cap, &corpus);
    assert_eq!(c.state, ReleaseState::Integrated);
    assert_eq!(
        c.qualification
            .iter()
            .find(|f| f.source == EvidenceSource::ColorHarness)
            .expect("finding")
            .status,
        RecordStatus::StaleCorpus
    );
}

#[test]
fn wrong_backend_is_not_evidence() {
    let cap = &APPLE_ONLY;
    let mut evidence = with_all_satisfied(cap);
    evidence
        .records
        .get_mut(&EvidenceSource::GpuChainParityMetal)
        .expect("record")
        .backend = "vulkan-lavapipe".into();
    let c = classify(cap, &evidence);
    assert_eq!(c.state, ReleaseState::Integrated);
    assert_eq!(
        c.qualification
            .iter()
            .find(|f| f.source == EvidenceSource::GpuChainParityMetal)
            .expect("finding")
            .status,
        RecordStatus::UnacceptedBackend("vulkan-lavapipe".into())
    );
}

/// A surface with no source covering it blocks integration even when
/// every declared source is green — Windows today has no evidence source
/// at all, so nothing shipped there can leave `Core`.
#[test]
fn an_uncovered_surface_blocks_integration() {
    let cap = capability("tone");
    assert!(cap.surfaces.contains(&Surface::Windows));
    assert!(cap
        .integration
        .iter()
        .all(|s| !s.covers().contains(&Surface::Windows)));
    let c = classify(cap, &with_all_satisfied(cap));
    assert_eq!(c.state, ReleaseState::Core);
    assert!(c.integration.iter().all(|f| f.status.is_satisfied()));
}

#[test]
fn a_capability_with_no_qualification_sources_can_never_release() {
    let cap = &WEB_UNQUALIFIED;
    let c = classify(cap, &with_all_satisfied(cap));
    assert_eq!(c.state, ReleaseState::Integrated);
    assert!(c.qualification.is_empty());
}

/// The real table, with every declared source satisfied: no capability
/// surfaced on Web or Windows can read `Released`, because no
/// qualification source covers either surface yet — the registry reports
/// the gap instead of papering over it.
#[test]
fn no_shipped_web_or_windows_capability_can_release_today() {
    for cap in CAPABILITY_REGISTRY {
        let ships_uncovered = cap
            .surfaces
            .iter()
            .any(|s| matches!(s, Surface::Web | Surface::Windows));
        if !ships_uncovered {
            continue;
        }
        let c = classify(cap, &with_all_satisfied(cap));
        assert_ne!(c.state, ReleaseState::Released, "{}", cap.id);
    }
}

#[test]
fn an_unsurfaced_capability_stays_core() {
    let cap = capability("local_adjustments");
    assert!(cap.surfaces.is_empty());
    assert_eq!(
        classify(cap, &with_all_satisfied(cap)).state,
        ReleaseState::Core
    );
}

// ── Records on disk ───────────────────────────────────────────────────────

#[test]
fn record_json_round_trips_and_rejects_malformed_input() {
    let evidence = empty_evidence();
    let record = satisfied_record(EvidenceSource::GreyDcp, &evidence);
    let text = serde_json::to_string_pretty(&record.to_json()).unwrap();
    assert_eq!(EvidenceRecord::from_json(&text).unwrap(), record);

    assert!(EvidenceRecord::from_json("{").is_err());
    assert!(EvidenceRecord::from_json(r#"{"source":"nope"}"#)
        .unwrap_err()
        .contains("unknown evidence source"));
    let missing = text.replace("\"executed_cases\"", "\"executed\"");
    assert!(EvidenceRecord::from_json(&missing)
        .unwrap_err()
        .contains("executed_cases"));
    // Informational fields: absent or null is fine, a wrong type is not.
    let nulled = text.replace("\"git_sha\": \"0000000\"", "\"git_sha\": null");
    assert_eq!(EvidenceRecord::from_json(&nulled).unwrap().git_sha, "");
    let typed = text.replace("\"git_sha\": \"0000000\"", "\"git_sha\": 123");
    assert!(EvidenceRecord::from_json(&typed)
        .unwrap_err()
        .contains("git_sha"));
}

#[test]
fn corpus_hash_is_deterministic_and_crlf_insensitive() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("c")).unwrap();
    std::fs::write(dir.path().join("a.txt"), "one\ntwo\n").unwrap();
    std::fs::write(dir.path().join("c/b.txt"), "three\n").unwrap();
    let lf = hash_corpus(dir.path(), &["a.txt", "c"]).unwrap();
    assert!(lf.starts_with("blake3:"));
    assert_eq!(lf, hash_corpus(dir.path(), &["a.txt", "c"]).unwrap());

    std::fs::write(dir.path().join("a.txt"), "one\r\ntwo\r\n").unwrap();
    assert_eq!(lf, hash_corpus(dir.path(), &["a.txt", "c"]).unwrap());

    std::fs::write(dir.path().join("c/b.txt"), "changed\n").unwrap();
    assert_ne!(lf, hash_corpus(dir.path(), &["a.txt", "c"]).unwrap());

    assert!(hash_corpus(dir.path(), &["missing.txt"]).is_err());
}

/// A binary fixture is hashed byte for byte: a 0x0D inside it is data, and
/// flipping it must change the hash (the CR strip applies to text only).
#[test]
fn corpus_hash_keeps_carriage_returns_in_binary_files() {
    let dir = tempfile::tempdir().unwrap();
    let bin = dir.path().join("fixture.dng");
    std::fs::write(&bin, [0x49, 0x49, 0x2a, 0x00, 0x0d, 0x0a, 0x01]).unwrap();
    let with_cr = hash_corpus(dir.path(), &["fixture.dng"]).unwrap();
    std::fs::write(&bin, [0x49, 0x49, 0x2a, 0x00, 0x0a, 0x01]).unwrap();
    let without_cr = hash_corpus(dir.path(), &["fixture.dng"]).unwrap();
    assert_ne!(with_cr, without_cr);
}

#[test]
fn evidence_load_reads_records_and_hashes_their_corpora() {
    let dir = tempfile::tempdir().unwrap();
    let root = repo_root();
    let hash = hash_corpus(root, EvidenceSource::GreyDcp.corpus()).unwrap();
    let record = EvidenceRecord {
        source: EvidenceSource::GreyDcp,
        backend: "cpu-reference".into(),
        pipeline_version: crate::PIPELINE_OUTPUT_VERSION,
        schema_version: current_schema_version(),
        corpus_hash: hash,
        expected_cases: EvidenceSource::GreyDcp.expected_cases(),
        executed_cases: EvidenceSource::GreyDcp.expected_cases(),
        failed_cases: 0,
        skipped_cases: 0,
        git_sha: String::new(),
        recorded_at: String::new(),
        command: String::new(),
    };
    std::fs::write(
        dir.path().join("grey_dcp.json"),
        serde_json::to_string_pretty(&record.to_json()).unwrap(),
    )
    .unwrap();
    let evidence = Evidence::load(root, dir.path()).unwrap();
    assert_eq!(evidence.records.len(), 1);
    // Only the recorded source's corpus is hashed — a hash is only ever
    // compared against a record.
    assert_eq!(evidence.corpus_hashes.len(), 1);
    assert!(evidence
        .corpus_hashes
        .contains_key(&EvidenceSource::GreyDcp));
    assert_eq!(
        judge(EvidenceSource::GreyDcp, &evidence),
        RecordStatus::Satisfied
    );
    assert_eq!(
        judge(EvidenceSource::ColorChart, &evidence),
        RecordStatus::Missing
    );

    // A record filed under the wrong name is an error, not a silent miss.
    std::fs::write(
        dir.path().join("color_chart.json"),
        serde_json::to_string_pretty(&record.to_json()).unwrap(),
    )
    .unwrap();
    assert!(Evidence::load(root, dir.path())
        .unwrap_err()
        .contains("names source"));
}
