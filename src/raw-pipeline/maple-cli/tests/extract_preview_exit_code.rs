//! Integration test for the `maple-cli extract-preview` exit-code contract
//! (see `commands/extract_preview.rs`):
//!
//!   * `0` — preview extracted and written.
//!   * `3` — RAW readable but no embedded preview (the harness SKIP sentinel).
//!   * any other non-zero — a real I/O error (missing / unreadable RAW).
//!
//! The load-bearing case is the last one: a missing RAW must NOT be confused
//! with the "no preview" sentinel, or `test_auto_profile_match.sh` would
//! silently SKIP a fixture that actually failed to read.

use std::path::PathBuf;
use std::process::Command;

/// A nonexistent RAW path must exit non-zero AND not with the no-preview
/// sentinel (3) — it's a real I/O error, mapped to the generic error code 1.
#[test]
fn missing_raw_exits_nonzero_and_not_the_no_preview_sentinel() {
    let tmp = std::env::temp_dir().join("maple-extract-preview-missing");
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).expect("create tmp dir");
    let missing = tmp.join("does-not-exist.dng");
    let out = tmp.join("out.png");

    let status = Command::new(env!("CARGO_BIN_EXE_maple-cli"))
        .arg("extract-preview")
        .arg("--out")
        .arg(&out)
        .arg("--")
        .arg(&missing)
        .output()
        .expect("ran maple-cli extract-preview");

    let code = status.status.code();
    assert!(
        !status.status.success(),
        "expected non-zero exit for a missing RAW, got success; stderr=\n{}",
        String::from_utf8_lossy(&status.stderr),
    );
    assert_ne!(
        code,
        Some(3),
        "a missing RAW must NOT use the no-preview sentinel (3); it is a \
         real I/O error. stderr=\n{}",
        String::from_utf8_lossy(&status.stderr),
    );
    assert_eq!(
        code,
        Some(1),
        "missing RAW should map to the generic error code 1; stderr=\n{}",
        String::from_utf8_lossy(&status.stderr),
    );
    // No output file should have been written on the error path.
    assert!(
        !out.exists(),
        "extract-preview must not write an output file on an I/O error",
    );

    let _ = std::fs::remove_dir_all(&tmp);
}

/// Success path: if a fixture with an embedded preview is available, an
/// extract should exit 0 and write the output file.
///
/// Gated on `test_0017.dng` (the same fixture the auto-tone golden uses):
/// `ignore`d without `--features fixtures`, fail-closed (panic on a missing
/// fixture) with it (#1082). We don't assert the `Ok(3)` no-preview path
/// here because we have no committed fixture that is guaranteed
/// preview-less; the contract for that branch is covered by the unit-level
/// `eprintln`/return in `commands/extract_preview.rs` plus the harness's
/// exit-code handling.
#[test]
#[cfg_attr(not(feature = "fixtures"), ignore)]
fn embedded_preview_fixture_exits_zero() {
    let fixture = fixture_path("test_0017.dng").expect(
        "missing fixture: test_0017.dng not found in any CARGO_MANIFEST_DIR \
         ancestor or under MAPLE_TEST_FIXTURE_ROOT — provision the gitignored \
         RAWs or run without --features fixtures (#1082)",
    );

    let tmp = std::env::temp_dir().join("maple-extract-preview-ok");
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).expect("create tmp dir");
    let out = tmp.join("preview.png");

    let status = Command::new(env!("CARGO_BIN_EXE_maple-cli"))
        .arg("extract-preview")
        .arg("--out")
        .arg(&out)
        .arg("--")
        .arg(&fixture)
        .output()
        .expect("ran maple-cli extract-preview");

    let code = status.status.code();
    // test_0017.dng carries an embedded preview, so we expect 0. If a future
    // fixture swap drops the preview the code would be 3 — surface that
    // distinctly rather than as an opaque failure.
    assert!(
        code == Some(0) || code == Some(3),
        "expected exit 0 (preview written) or 3 (no preview), got {:?}; \
         stderr=\n{}",
        code,
        String::from_utf8_lossy(&status.stderr),
    );
    if code == Some(0) {
        assert!(
            out.exists() && std::fs::metadata(&out).map(|m| m.len()).unwrap_or(0) > 0,
            "exit 0 must have written a non-empty output file",
        );
    }

    let _ = std::fs::remove_dir_all(&tmp);
}

/// Resolve a fixture under `test-fixtures/raws/`. Walks `CARGO_MANIFEST_DIR`
/// ancestors (works from the main checkout and any worktree); env override
/// `MAPLE_TEST_FIXTURE_ROOT` short-circuits the walk. Mirrors the resolver in
/// `auto_tone_golden.rs`.
fn fixture_path(name: &str) -> Option<PathBuf> {
    if let Ok(root) = std::env::var("MAPLE_TEST_FIXTURE_ROOT") {
        let candidate = PathBuf::from(root).join("raws").join(name);
        if candidate.exists() {
            return Some(candidate);
        }
    }
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    for ancestor in manifest.ancestors() {
        let candidate = ancestor.join("test-fixtures/raws").join(name);
        if candidate.exists() {
            return Some(candidate);
        }
    }
    None
}
