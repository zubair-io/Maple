//! Golden test for `maple-cli auto-tone <RAW>` — pins the exposure value
//! against `test_0017.dng` so any drift in the post-WB scene-linear
//! development chain or the [`compute_auto_tone_from_rgba`] inversion math
//! shows up as a test failure rather than a silent change in slider
//! recommendations.
//!
//! Fixture-gated: when `test-fixtures/raws/test_0017.dng` is absent (CI
//! without the gitignored RAWs), the test soft-passes with a `skipping`
//! message, mirroring the `test_color_pipeline.sh` "no fixtures, skipping"
//! pattern.
//!
//! [`compute_auto_tone_from_rgba`]: raw_core::stages::auto_tone::compute_auto_tone_from_rgba

use std::path::PathBuf;
use std::process::Command;

/// Pinned exposure value for `test_0017.dng` under the Phase 1a algorithm
/// (post-WB scene-linear Rec.2020 luma p50 → `log2(0.18 / p50)`, clamped
/// to `[-5, +5]`).
///
/// Captured 2026-05-26 by running:
///
/// ```sh
/// cargo run --release -p maple-cli -- auto-tone \
///     test-fixtures/raws/test_0017.dng
/// ```
///
/// Update this constant — and only this constant — when the develop chain
/// or the Auto Tone math intentionally changes. A drift outside the ±0.05
/// tolerance below is a regression that needs investigation, not a
/// re-pin.
const EXPECTED_EXPOSURE_TEST_0017: f64 = 0.03521794;

/// Tolerance for the pinned value. Tight enough to catch any meaningful
/// drift in the develop chain (1/20th of a stop is well below the
/// per-slider 0.05 EV step the UI exposes) but loose enough to absorb the
/// last-bit f32 noise different LLVM versions can introduce in the
/// histogram bin walk.
const EXPOSURE_TOLERANCE: f64 = 0.05;

/// Resolve the path to `test_0017.dng`. Walks `CARGO_MANIFEST_DIR`
/// ancestors looking for `test-fixtures/raws/test_0017.dng` so the test
/// works from both the main checkout (`src/raw-pipeline/maple-cli/../../..`)
/// and from any worktree where the fixtures live at the repo root. Env
/// override `MAPLE_TEST_FIXTURE_ROOT` short-circuits the walk for CI
/// configurations that mount the fixtures at a non-standard location.
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
fn auto_tone_against_test_0017_is_stable() {
    let fixture = match fixture_path() {
        Some(p) => p,
        None => {
            eprintln!(
                "test_0017.dng not found in any CARGO_MANIFEST_DIR ancestor \
                 or under MAPLE_TEST_FIXTURE_ROOT — skipping (matches the \
                 test_color_pipeline.sh skip-pattern)"
            );
            return;
        }
    };

    let out = Command::new(env!("CARGO_BIN_EXE_maple-cli"))
        .args(["auto-tone"])
        .arg(&fixture)
        .output()
        .expect("ran maple-cli auto-tone");

    assert!(
        out.status.success(),
        "maple-cli auto-tone exit status was {:?}; stderr=\n{}",
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
        (exposure - EXPECTED_EXPOSURE_TEST_0017).abs() < EXPOSURE_TOLERANCE,
        "exposure drift: got {}, expected {} (tolerance ±{})",
        exposure,
        EXPECTED_EXPOSURE_TEST_0017,
        EXPOSURE_TOLERANCE,
    );

    // Phase 1a contract: every other field is slider rest position. If
    // these stop being zero, Phase 1b or 1c shipped and the golden value
    // above needs revisiting.
    for field in ["contrast", "whites", "blacks", "highlights", "shadows"] {
        let v = json[field]
            .as_f64()
            .unwrap_or_else(|| panic!("{} not a number in {}", field, stdout));
        assert_eq!(v, 0.0, "{} expected 0.0 in Phase 1a, got {}", field, v);
    }
}
