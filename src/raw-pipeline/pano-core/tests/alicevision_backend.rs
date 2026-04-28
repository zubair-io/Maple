//! Integration tests for the AliceVision subprocess backend.
//!
//! Tests are skip-passed if the binaries can't be located (e.g. in CI
//! without an AliceVision install). Mirrors the test_pano_pipeline.sh
//! "no fixtures, skipping" pattern.

use pano_core::backends::alicevision::{locate_binaries, AlicevisionBackend};

#[test]
fn locate_binaries_skips_when_absent() {
    // If MAPLE_ALICEVISION_BIN points at a nonsense path, we should
    // get a clear error rather than panicking.
    std::env::set_var("MAPLE_ALICEVISION_BIN", "/nonexistent/av/bin");
    let result = locate_binaries(None);
    assert!(result.is_err(), "expected error for missing dir");
    let msg = format!("{}", result.unwrap_err());
    assert!(msg.contains("does not exist"), "msg={msg}");
    std::env::remove_var("MAPLE_ALICEVISION_BIN");
}

#[test]
fn backend_from_env_skips_cleanly_when_unset() {
    // With no env + no default install, expect a clear error not panic.
    std::env::remove_var("MAPLE_ALICEVISION_BIN");
    if std::path::PathBuf::from(format!(
        "{}/opt/alicevision/bin",
        std::env::var("HOME").unwrap_or_default()
    ))
    .exists()
    {
        // Skip — engineer has AV installed; the happy-path test covers this.
        return;
    }
    let result = AlicevisionBackend::from_env();
    assert!(result.is_err(), "expected error when AV is not installed");
}
