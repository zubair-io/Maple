//! Exercise the actual recorder binary with real RAW, XMP and PNG files (#4074).
use raw_core::capability_registry::EvidenceSource;
use serde_json::json;
use std::path::Path;
use std::process::{Command, Output};

fn fixture() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    for rel in EvidenceSource::ColorHarness.corpus() {
        let destination = dir.path().join(rel);
        std::fs::create_dir_all(destination.parent().unwrap()).unwrap();
        std::fs::copy(repo.join(rel), destination).unwrap();
    }
    for (source, destination) in [
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
        std::fs::copy(repo.join(source), dir.path().join(destination)).unwrap();
    }
    std::fs::create_dir_all(dir.path().join("test-fixtures/references")).unwrap();
    let manifest = json!({"cases":[{"name":"grey/baseline", "raw":"raw.dng", "xmp":"model.xmp",
        "outputs":[{"resolution":"down","long_edge":1024,"png":"reference.png"}]}]});
    std::fs::write(
        dir.path().join("test-fixtures/references/manifest.json"),
        manifest.to_string(),
    )
    .unwrap();
    dir
}
fn record(repo: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_qualification-record"))
        .args([
            "--source",
            "color_harness",
            "--backend",
            "cpu-reference",
            "--executed",
            "1",
        ])
        .arg("--repo-root")
        .arg(repo)
        .arg("--out")
        .arg(repo.join("record.json"))
        .args(args)
        .output()
        .unwrap()
}
fn identity(repo: &Path) -> String {
    let result = record(repo, &["--print-corpus-hash"]);
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    String::from_utf8(result.stdout).unwrap().trim().into()
}

#[test]
fn preflight_creates_no_record_and_changed_inputs_cannot_write_or_replace_evidence() {
    let dir = fixture();
    let before = identity(dir.path());
    let target = dir.path().join("record.json");
    assert!(!target.exists());
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    std::fs::copy(
        repo.join("src/apple/MapleUITests/Goldens/.calibration/b.png"),
        dir.path().join("reference.png"),
    )
    .unwrap();
    let failed = record(dir.path(), &["--expected-corpus-hash", &before]);
    assert_eq!(failed.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&failed.stderr).contains("corpus changed during the run"));
    assert!(!target.exists());
    std::fs::write(&target, "previous immutable evidence").unwrap();
    assert!(!record(dir.path(), &["--expected-corpus-hash", &before])
        .status
        .success());
    assert_eq!(
        std::fs::read_to_string(target).unwrap(),
        "previous immutable evidence"
    );
}

#[test]
fn selected_manifest_is_stamped_and_unchanged_inputs_record_successfully() {
    let dir = fixture();
    let before = identity(dir.path());
    assert!(record(dir.path(), &["--expected-corpus-hash", &before])
        .status
        .success());
    let written: serde_json::Value =
        serde_json::from_slice(&std::fs::read(dir.path().join("record.json")).unwrap()).unwrap();
    assert_eq!(written["corpus_hash"], before);
    let mut manifest: serde_json::Value = serde_json::from_slice(
        &std::fs::read(dir.path().join("test-fixtures/references/manifest.json")).unwrap(),
    )
    .unwrap();
    manifest["cases"][0]["outputs"][0]["long_edge"] = json!(512);
    let alternate = dir.path().join("alternate.json");
    std::fs::write(&alternate, manifest.to_string()).unwrap();
    assert!(record(
        dir.path(),
        &["--color-manifest", alternate.to_str().unwrap()]
    )
    .status
    .success());
    let alternate_record: serde_json::Value =
        serde_json::from_slice(&std::fs::read(dir.path().join("record.json")).unwrap()).unwrap();
    assert_ne!(alternate_record["corpus_hash"], before);
}
