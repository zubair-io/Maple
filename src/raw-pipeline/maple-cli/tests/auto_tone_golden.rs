//! Golden integration test for `maple-cli auto-tone`.
//!
//! Pins the recommended exposure value for `test_0017.dng` so any
//! pipeline change that perturbs the post-WB histogram surfaces here.
//! The budget is loose (`±0.05` stops, i.e. ~half a slider tick) — this
//! is a stability sentinel, not a precision gate.
//!
//! Skips when `test-fixtures/raws/test_0017.dng` is absent (the canonical
//! "no fixtures, skipping" pattern shared by every other RAW-touching
//! integration test in this workspace; see `raw-core/tests/golden.rs`
//! and `raw-wasm/src/lib.rs` for prior art). The skip-pass keeps CI
//! green on hosts without the gitignored RAW corpus.

use std::path::PathBuf;
use std::process::Command;

/// Pinned expected exposure for `test_0017.dng` under the default
/// `AdjustmentModel` (no XMP), at `RenderQuality::Full`. The buffer
/// the CLI analyses is the post-WB scene-linear Rec.2020 frame the
/// UI's "Auto" button will see (default `AutoExposureMode::On`), so
/// this is a "fine-tune on top of the scene anchor" rather than the
/// raw mid-gray compensation.
///
/// **Update this when Phase 1b/1c expands the algorithm** — the
/// recommended exposure will change as the heuristic incorporates
/// whites/blacks tail-percentile corrections.
const EXPECTED_TEST_0017_EXPOSURE: f64 = 0.0;
const TOLERANCE: f64 = 0.05;

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .expect("canonicalize repo root")
}

#[test]
fn auto_tone_against_test_0017_is_stable() {
    let root = repo_root();
    let raw = root.join("test-fixtures/raws/test_0017.dng");
    if !raw.exists() {
        eprintln!(
            "skip: fixture missing at {} — run with the test-fixtures/raws/ corpus to enable",
            raw.display()
        );
        return;
    }

    let out = Command::new(env!("CARGO_BIN_EXE_maple-cli"))
        .args(["auto-tone"])
        .arg(&raw)
        .output()
        .expect("spawn maple-cli auto-tone");

    assert!(
        out.status.success(),
        "maple-cli auto-tone exited non-zero: stdout={:?} stderr={:?}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr),
    );

    let stdout = String::from_utf8(out.stdout).expect("stdout utf-8");
    let json: serde_json::Value =
        serde_json::from_str(stdout.trim()).expect("parse JSON stdout");

    // Schema check: every field the FFI/WASM struct carries must be present
    // and numeric. The CLI is the only surface where a typo in a serde
    // derive would surface as a missing JSON key rather than a Swift /
    // TypeScript compile error — keep the schema gate here.
    for field in ["exposure", "contrast", "whites", "blacks", "highlights", "shadows"] {
        assert!(
            json[field].is_f64(),
            "field {} missing or non-numeric in {}",
            field,
            stdout
        );
    }

    let exposure = json["exposure"].as_f64().unwrap();
    assert!(
        (exposure - EXPECTED_TEST_0017_EXPOSURE).abs() < TOLERANCE,
        "exposure drifted: got {}, expected {} ± {}",
        exposure,
        EXPECTED_TEST_0017_EXPOSURE,
        TOLERANCE
    );

    // Phase 1a invariant: every non-exposure field is the slider rest
    // position. When Phase 1b/1c fills them in, expand or delete this
    // block in the same commit that ratchets the algorithm.
    for field in ["contrast", "whites", "blacks", "highlights", "shadows"] {
        let v = json[field].as_f64().unwrap();
        assert_eq!(v, 0.0, "phase 1a expects {} == 0.0, got {}", field, v);
    }
}
