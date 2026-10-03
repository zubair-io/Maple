use super::*;
use crate::capability_registry::{judge, BuildIdentity, Evidence, EvidenceRecord, RecordStatus};
use serde_json::json;

fn fixture(absolute: bool) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    for rel in EvidenceSource::ColorHarness.corpus() {
        let dest = dir.path().join(rel);
        std::fs::create_dir_all(dest.parent().unwrap()).unwrap();
        std::fs::copy(repo.join(rel), dest).unwrap();
    }
    let reference = dir.path().join("test-fixtures/references");
    std::fs::create_dir_all(&reference).unwrap();
    for (from, to) in [
        (
            "src/apple/MapleUITests/Fixtures/synthetic/grey-l018-rggb.dng",
            "raw.dng",
        ),
        (
            "src/apple/MapleUITests/Fixtures/synthetic/cases/default.xmp",
            "model.xmp",
        ),
        (
            "src/apple/MapleUITests/Goldens/.calibration/a.png",
            "reference.png",
        ),
    ] {
        std::fs::copy(repo.join(from), dir.path().join(to)).unwrap();
    }
    let locate = |name: &str| {
        if absolute {
            dir.path().join(name).to_string_lossy().into_owned()
        } else {
            name.into()
        }
    };
    let manifest = json!({"cases":[{"name":"grey/baseline", "raw":locate("raw.dng"), "xmp":locate("model.xmp"),
        "outputs":[{"resolution":"down","long_edge":1024,"png":locate("reference.png")}]}]});
    write_manifest(dir.path(), &manifest);
    dir
}
fn write_manifest(repo: &Path, manifest: &Value) {
    std::fs::write(
        repo.join("test-fixtures/references/manifest.json"),
        serde_json::to_vec(manifest).unwrap(),
    )
    .unwrap();
}
fn manifest(repo: &Path) -> Value {
    serde_json::from_slice(
        &std::fs::read(repo.join("test-fixtures/references/manifest.json")).unwrap(),
    )
    .unwrap()
}

#[test]
fn actual_relocated_inputs_have_the_same_identity() {
    let first = fixture(true);
    let second = fixture(false);
    assert_eq!(hash(first.path()).unwrap(), hash(second.path()).unwrap());
    std::fs::write(second.path().join("unmeasured.png"), b"unreferenced").unwrap();
    assert_eq!(hash(first.path()).unwrap(), hash(second.path()).unwrap());
}

#[test]
fn every_measured_file_and_calibration_input_invalidates_old_evidence() {
    for file in [
        "raw.dng",
        "model.xmp",
        "reference.png",
        "test-fixtures/budgets.json",
        "src/raw-pipeline/raw-core/src/color/profiles/profiles.bin",
    ] {
        let dir = fixture(false);
        let before = hash(dir.path()).unwrap();
        let path = dir.path().join(file);
        let mut bytes = std::fs::read(&path).unwrap();
        let last = bytes.len() - 1;
        bytes[last] ^= 1;
        std::fs::write(path, bytes).unwrap();
        assert_ne!(before, hash(dir.path()).unwrap(), "{file}");
    }
}

#[test]
fn protocol_changes_and_adobe_authoring_sidecars_count() {
    let dir = fixture(false);
    let before = hash(dir.path()).unwrap();
    let mut value = manifest(dir.path());
    value["cases"][0]["outputs"][0]["long_edge"] = json!(2048);
    write_manifest(dir.path(), &value);
    assert_ne!(before, hash(dir.path()).unwrap());
    value["cases"][0]["acr_xmp"] = json!("model.xmp");
    write_manifest(dir.path(), &value);
    let with_adobe = hash(dir.path()).unwrap();
    std::fs::write(
        dir.path().join("model.xmp"),
        b"<x:xmpmeta xmlns:x='adobe:ns:meta/'/>",
    )
    .unwrap();
    assert_ne!(with_adobe, hash(dir.path()).unwrap());
    std::fs::remove_file(dir.path().join("model.xmp")).unwrap();
    assert!(hash(dir.path()).is_err());
}

#[test]
fn missing_inputs_empty_cases_and_ambiguous_protocols_fail_explicitly() {
    for file in ["raw.dng", "model.xmp", "reference.png"] {
        let dir = fixture(false);
        std::fs::remove_file(dir.path().join(file)).unwrap();
        assert!(hash(dir.path()).unwrap_err().contains(file));
    }
    let dir = fixture(false);
    let initial = manifest(dir.path());
    let mut duplicate = initial.clone();
    let case = duplicate["cases"][0].clone();
    duplicate["cases"].as_array_mut().unwrap().push(case);
    write_manifest(dir.path(), &duplicate);
    assert!(hash(dir.path())
        .unwrap_err()
        .contains("duplicate colour case"));
    let mut bad = initial.clone();
    bad["cases"][0]["outputs"][0]["long_edge"] = json!(-1);
    write_manifest(dir.path(), &bad);
    assert!(hash(dir.path()).unwrap_err().contains("long_edge"));
    write_manifest(dir.path(), &json!({"cases":[]}));
    assert!(hash(dir.path()).unwrap_err().contains("nonempty cases"));
    std::fs::write(
        dir.path().join("test-fixtures/references/manifest.json"),
        "{",
    )
    .unwrap();
    assert!(hash(dir.path()).is_err());
}

#[test]
fn real_record_loading_demotes_changed_pixels_with_unchanged_budgets_and_counts() {
    let dir = fixture(false);
    let source = EvidenceSource::ColorHarness;
    let build = BuildIdentity::current();
    let record = EvidenceRecord {
        source,
        backend: "cpu-reference".into(),
        pipeline_version: build.pipeline_version,
        schema_version: build.schema_version,
        corpus_hash: source.corpus_hash(dir.path()).unwrap(),
        expected_cases: source.expected_cases(),
        executed_cases: source.expected_cases(),
        failed_cases: 0,
        skipped_cases: 0,
        git_sha: "0123456789012345678901234567890123456789".into(),
        recorded_at: String::new(),
        command: String::new(),
    };
    let records = dir.path().join("test-fixtures/qualification");
    std::fs::create_dir_all(&records).unwrap();
    std::fs::write(
        records.join("color_harness.json"),
        record.to_json().to_string(),
    )
    .unwrap();
    assert_eq!(
        judge(source, &Evidence::load(dir.path(), &records).unwrap()),
        RecordStatus::Satisfied
    );
    std::fs::copy(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../src/apple/MapleUITests/Goldens/.calibration/b.png"),
        dir.path().join("reference.png"),
    )
    .unwrap();
    assert_eq!(
        judge(source, &Evidence::load(dir.path(), &records).unwrap()),
        RecordStatus::StaleCorpus
    );
}

#[test]
fn alternate_manifest_hashes_actual_inputs_instead_of_the_default_manifest() {
    let dir = fixture(false);
    let default = hash(dir.path()).unwrap();
    let mut selected = manifest(dir.path());
    selected["cases"][0]["outputs"][0]["long_edge"] = json!(2048);
    let alternate = dir.path().join("alternate.json");
    std::fs::write(&alternate, selected.to_string()).unwrap();
    assert_ne!(
        default,
        super::hash_manifest(dir.path(), &alternate).unwrap()
    );
    assert_eq!(default, hash(dir.path()).unwrap());
}

#[test]
fn decoder_extension_changes_identity_but_directory_locations_do_not() {
    let dir = fixture(false);
    let before = hash(dir.path()).unwrap();
    std::fs::copy(dir.path().join("raw.dng"), dir.path().join("raw.jpg")).unwrap();
    let mut value = manifest(dir.path());
    value["cases"][0]["raw"] = json!("raw.jpg");
    write_manifest(dir.path(), &value);
    assert_ne!(before, hash(dir.path()).unwrap());
}
