//! Golden test for `maple-cli auto-tone <RAW> --params <XMP>` (#813) —
//! pins the exposure recommendation when Auto Tone is computed against an
//! ALREADY-EDITED model (a real Custom WB + a +2.0 EV push), not
//! `AdjustmentModel::default()`. Sibling of `auto_tone_golden.rs`, same
//! `test_0017.dng` fixture, so a drift shows up whether or not `--params`
//! is passed.
//!
//! Fixture-gated (#1082): `#[cfg_attr(not(feature = "fixtures"), ignore)]`
//! — visibly ignored without the gitignored RAWs; with `--features
//! fixtures` a missing `test-fixtures/raws/test_0017.dng` panics
//! (fail-closed) instead of silently passing.

use std::path::PathBuf;
use std::process::Command;

/// Pinned exposure value for `test_0017.dng` develop against a sidecar that
/// already carries `crs:WhiteBalance="Custom"`, `crs:Temperature="6500"`,
/// `crs:Tint="0"`, `crs:Exposure2012="2.0"`.
///
/// Captured 2026-09-01 by running the same command this test issues. Note
/// this is close to `-(the sidecar's +2.0 EV) + auto_tone_golden.rs`'s
/// default-state `0.03521794`: re-auto on top of an already-pushed +2EV
/// recommends pulling most of it back, which is exactly the "re-auto on top
/// of current edits" contract #813 adds `--params` for. Update this
/// constant when the develop chain or the Auto Tone math intentionally
/// changes — and also re-check the default-state sanity floor below
/// (`DEFAULT_STATE_GOLDEN_EXPOSURE`, duplicated from `auto_tone_golden.rs`'s
/// own pinned constant) if THAT one is ever re-pinned.
const EXPECTED_EXPOSURE_TEST_0017_WITH_PARAMS: f64 = -1.9680367;

/// Duplicated from `auto_tone_golden.rs`'s `EXPECTED_EXPOSURE_TEST_0017` —
/// the two test binaries can't share a constant across separate `tests/*.rs`
/// compilation units. Used only as a "didn't silently ignore --params"
/// sanity floor below, not as a golden pin in its own right.
const DEFAULT_STATE_GOLDEN_EXPOSURE: f64 = 0.03521794;

/// Tolerance for the pinned value — same rationale as `auto_tone_golden.rs`.
const EXPOSURE_TOLERANCE: f64 = 0.05;

/// The sidecar `--params` develops against: a real, non-trivial edit
/// (Custom WB + a +2.0 EV push), not the As-Shot default — this is the
/// exact shape #813 exists to exercise (`resolve_target`-style Custom WB
/// plus a tone edit already applied).
const PARAMS_XMP: &str = r#"<?xml version="1.0"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
      crs:WhiteBalance="Custom"
      crs:Temperature="6500"
      crs:Tint="0"
      crs:Exposure2012="2.0"/>
  </rdf:RDF>
</x:xmpmeta>"#;

/// Same fixture-resolution walk as `auto_tone_golden.rs` — duplicated
/// rather than shared, matching this crate's existing per-file integration
/// test convention (see `extract_preview_exit_code.rs`).
fn fixture_path() -> Option<PathBuf> {
    if let Ok(root) = std::env::var("MAPLE_TEST_FIXTURE_ROOT") {
        let candidate = PathBuf::from(root).join("raws/test_0017.dng");
        if candidate.exists() {
            return Some(candidate);
        }
    }
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    for ancestor in manifest.ancestors() {
        let candidate = ancestor.join("test-fixtures/raws/test_0017.dng");
        if candidate.exists() {
            return Some(candidate);
        }
    }
    None
}

#[test]
#[cfg_attr(not(feature = "fixtures"), ignore)]
fn auto_tone_with_params_develops_against_the_edited_model() {
    let fixture = fixture_path().expect(
        "missing fixture: test_0017.dng not found in any CARGO_MANIFEST_DIR \
         ancestor or under MAPLE_TEST_FIXTURE_ROOT — provision the gitignored \
         RAWs or run without --features fixtures (#1082)",
    );

    // `tempfile::tempdir()` creates a securely-random, uniquely-named
    // directory (not a predictable PID-based path, which a symlink placed
    // ahead of creation could hijack — TOCTOU) and removes it on drop, so
    // two concurrent `cargo test` runs can never collide or leak.
    let tmp = tempfile::tempdir().expect("create tmp dir");
    let params_path = tmp.path().join("test_0017-edited.xmp");
    std::fs::write(&params_path, PARAMS_XMP).expect("write params xmp");

    let out = Command::new(env!("CARGO_BIN_EXE_maple-cli"))
        .arg("auto-tone")
        .arg("--params")
        .arg(&params_path)
        .arg("--")
        .arg(&fixture)
        .output()
        .expect("ran maple-cli auto-tone --params");

    assert!(
        out.status.success(),
        "maple-cli auto-tone --params exit status was {:?}; stderr=\n{}",
        out.status,
        String::from_utf8_lossy(&out.stderr),
    );

    let stdout = String::from_utf8(out.stdout).expect("utf-8 stdout");
    let json: serde_json::Value = serde_json::from_str(stdout.trim())
        .unwrap_or_else(|e| panic!("invalid JSON {:?}: {}", stdout, e));

    let exposure = json["exposure"]
        .as_f64()
        .unwrap_or_else(|| panic!("exposure not a number in {}", stdout));
    assert!(
        (exposure - EXPECTED_EXPOSURE_TEST_0017_WITH_PARAMS).abs() < EXPOSURE_TOLERANCE,
        "exposure drift: got {}, expected {} (tolerance ±{})",
        exposure,
        EXPECTED_EXPOSURE_TEST_0017_WITH_PARAMS,
        EXPOSURE_TOLERANCE,
    );

    // The whole point of #813: developing against the edited sidecar must
    // NOT silently fall back to the default-state recommendation — a
    // regression that ignored `--params` would still land there.
    assert!(
        (exposure - DEFAULT_STATE_GOLDEN_EXPOSURE).abs() > 0.5,
        "exposure {} is suspiciously close to the DEFAULT-state golden \
         ({}) — --params may not be reaching the develop chain",
        exposure,
        DEFAULT_STATE_GOLDEN_EXPOSURE,
    );
}
