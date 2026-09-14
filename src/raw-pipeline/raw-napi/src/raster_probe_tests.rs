//! Tests for `raster_probe`'s probe/decode `Task`s (#3509 Task 3). Calls each
//! `Task::compute()` directly — the actual CPU-bound logic, with no
//! napi/JS-runtime scheduling involved — mirroring
//! `src/maple/test/maple.test.ts`'s "probes raster image metadata without
//! full decode" case, which reads the same fixture.
//!
//! Lives under `src/` (not `tests/`) for the same reason
//! `filename_tests.rs` does: this crate's `crate-type` is `["cdylib"]` only,
//! so an integration test under `tests/` cannot link `raw_napi` as an
//! external crate.

use napi::Task;

use crate::raster_probe::{RasterDecodeTask, RasterProbeBufTask, RasterProbeTask};

/// `src/apple/MapleUITests/Goldens/.calibration/a.png`, relative to the repo
/// root. `CARGO_MANIFEST_DIR` for `raw-napi` is `src/raw-pipeline/raw-napi`,
/// three levels below the repo root — `maple.test.ts`'s own `fixturePng`
/// resolves the identical file via `path.resolve(__dirname, '../../..')` +
/// that same relative path.
fn fixture_png_path() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../src/apple/MapleUITests/Goldens/.calibration/a.png")
}

#[test]
fn probes_raster_metadata_without_full_decode_from_a_path() {
    let path = fixture_png_path();
    let mut task = RasterProbeTask {
        path: path.to_string_lossy().into_owned(),
    };
    let result = task.compute().unwrap();
    assert!(result.ok, "probe failed: {:?}", result.error);
    let meta = result.metadata.expect("ok result carries metadata");
    assert_eq!(meta.width, 64);
    assert_eq!(meta.height, 64);
    assert_eq!(meta.channels, 3);
    assert_eq!(meta.format.as_deref(), Some("png"));
}

#[test]
fn probes_raster_metadata_without_full_decode_from_bytes() {
    let bytes = std::fs::read(fixture_png_path()).unwrap();
    let mut task = RasterProbeBufTask { bytes };
    let result = task.compute().unwrap();
    assert!(result.ok, "probe failed: {:?}", result.error);
    let meta = result.metadata.expect("ok result carries metadata");
    assert_eq!(meta.width, 64);
    assert_eq!(meta.height, 64);
    assert_eq!(meta.channels, 3);
    assert_eq!(meta.format.as_deref(), Some("png"));
}

#[test]
fn probe_from_path_reports_an_error_for_a_missing_file() {
    let mut task = RasterProbeTask {
        path: "/nonexistent/path/does-not-exist.png".to_string(),
    };
    let result = task.compute().unwrap();
    assert!(!result.ok);
    assert!(result.metadata.is_none());
    assert!(result.error.is_some());
}

#[test]
fn decode_rgb8_produces_the_expected_pixel_count() {
    let bytes = std::fs::read(fixture_png_path()).unwrap();
    let mut task = RasterDecodeTask {
        bytes,
        auto_orient: true,
    };
    let result = task.compute().unwrap();
    assert!(result.ok, "decode failed: {:?}", result.error);
    assert_eq!(result.width, Some(64));
    assert_eq!(result.height, Some(64));
    let buffer = result.buffer.expect("ok result carries a buffer");
    // Interleaved RGB8: width * height * 3 bytes, no alpha.
    assert_eq!(buffer.len(), 64 * 64 * 3);
}

#[test]
fn decode_rgb8_reports_an_error_for_garbage_input() {
    let mut task = RasterDecodeTask {
        bytes: b"not an image".to_vec(),
        auto_orient: false,
    };
    let result = task.compute().unwrap();
    assert!(!result.ok);
    assert!(result.buffer.is_none());
    assert!(result.error.is_some());
}
