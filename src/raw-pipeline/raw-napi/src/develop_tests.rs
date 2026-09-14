//! Tests for the RAW-develop export + thumbnail `Task`s (#3509 Task 6).
//! Calls each `Task::compute()` directly (napi has no host process to load
//! the addon into during `cargo test`), mirroring
//! `src/maple/test/maple.test.ts`'s "gracefully reports error when exporting
//! non-existent photo" case as the Rust-level equivalent, plus a genuine
//! success-path proof against the small `test_0018.dng` fixture when
//! `test-fixtures/raws/` is present in the checkout (it is gitignored, so
//! CI without it must skip rather than fail — same "no fixtures, skipping"
//! convention `src/scripts/test_color_pipeline.sh` and friends already use).
//!
//! Lives under `src/` (not `tests/`) for the same reason `filename_tests.rs`
//! does: this crate's `crate-type` is `["cdylib"]` only, so an integration
//! test under `tests/` cannot link `raw_napi` as an external crate.

use napi::Task;
use std::path::PathBuf;

use crate::develop_export::{ExportDevelopedToFileTask, ExportRecipeToFileTask};
use crate::develop_preview::{RenderDevelopJpegToFileTask, RenderThumbnailAvifToFileTask};

/// Path to a fixture under the gitignored `test-fixtures/raws/` directory,
/// or `None` when that directory (or this specific file) isn't present in
/// this checkout. Three `..` from `src/raw-pipeline/raw-napi` reaches the
/// repo root, matching `raw-core`'s own `tests/golden.rs` `repo_root()`
/// helper.
fn dng_fixture(name: &str) -> Option<PathBuf> {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../test-fixtures/raws")
        .join(name)
        .canonicalize()
        .ok()
}

/// `test_0018.dng` (~950 KB): a synthetic fixture with no embedded preview,
/// but it decodes fine — sufficient for the full-develop-chain proofs
/// (`export_developed_to_file`).
fn small_dng_fixture() -> Option<PathBuf> {
    dng_fixture("test_0018.dng")
}

/// `test_0015.dng` (~12 MB): the smallest fixture confirmed (by hand, via a
/// throwaway `raw_core::preview::extract_embedded_preview` probe) to carry a
/// real embedded JPEG preview — `test_0018.dng`/`test_0019.dng` are
/// synthetic and have none. Needed for the thumbnail-extraction proof,
/// which exercises that extraction rather than the full develop chain.
fn dng_fixture_with_embedded_preview() -> Option<PathBuf> {
    dng_fixture("test_0015.dng")
}

fn temp_out_path(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "raw-napi-develop-test-{}-{}",
        std::process::id(),
        name
    ))
}

#[test]
fn exporting_a_nonexistent_raw_path_reports_an_error_not_a_panic() {
    let out_path = temp_out_path("export-missing.jpg");
    let mut task = ExportDevelopedToFileTask {
        raw_path: "/definitely/does/not/exist/photo.dng".to_string(),
        xmp_path: None,
        format: "jpeg".to_string(),
        quality: 0,
        color_space: "srgb".to_string(),
        max_long_edge: 0,
        out_path: out_path.to_string_lossy().into_owned(),
    };
    let result = task.compute().expect("compute must not itself error");
    assert!(!result.ok);
    assert!(result.error.is_some(), "expected an error message");
    assert!(
        !out_path.exists(),
        "a failed export must not leave a file behind"
    );
}

#[test]
fn exporting_developed_with_an_unsupported_format_is_reported_as_an_error() {
    let mut task = ExportDevelopedToFileTask {
        raw_path: "/definitely/does/not/exist/photo.dng".to_string(),
        xmp_path: None,
        format: "heic".to_string(),
        quality: 0,
        color_space: "srgb".to_string(),
        max_long_edge: 0,
        out_path: temp_out_path("export-bad-format.jpg")
            .to_string_lossy()
            .into_owned(),
    };
    let result = task.compute().unwrap();
    assert!(!result.ok);
    let err = result.error.expect("expected an error message");
    assert!(
        err.contains("unsupported format"),
        "expected a format-specific message, got: {err}"
    );
}

#[test]
fn exporting_a_malformed_recipe_is_reported_as_an_error_not_a_panic() {
    let mut task = ExportRecipeToFileTask {
        raw_path: "/definitely/does/not/exist/photo.dng".to_string(),
        xmp_xml: String::new(),
        recipe_json: "{not json".to_string(),
        film_path: None,
        out_path: temp_out_path("export-recipe-bad-json.jpg")
            .to_string_lossy()
            .into_owned(),
    };
    let result = task.compute().unwrap();
    assert!(!result.ok);
    assert!(result.error.is_some());
}

#[test]
fn rendering_a_thumbnail_with_zero_max_px_is_rejected_before_touching_the_filesystem() {
    // An obviously-nonexistent raw_path proves the max_px==0 check runs
    // FIRST — if the code read the file before validating, the error
    // message here would be a "raw read" failure instead.
    let mut task = RenderThumbnailAvifToFileTask {
        raw_path: "/definitely/does/not/exist/photo.dng".to_string(),
        out_path: temp_out_path("thumb-zero-max-px.avif")
            .to_string_lossy()
            .into_owned(),
        max_px: 0,
        quality: 0,
    };
    let result = task.compute().unwrap();
    assert!(!result.ok);
    let err = result.error.expect("expected an error message");
    assert!(
        err.contains("max_px must be > 0"),
        "expected the max_px validation message, got: {err}"
    );
}

#[test]
fn rendering_a_thumbnail_for_a_nonexistent_raw_path_reports_an_error_not_a_panic() {
    let out_path = temp_out_path("thumb-missing.avif");
    let mut task = RenderThumbnailAvifToFileTask {
        raw_path: "/definitely/does/not/exist/photo.dng".to_string(),
        out_path: out_path.to_string_lossy().into_owned(),
        max_px: 256,
        quality: 0,
    };
    let result = task.compute().unwrap();
    assert!(!result.ok);
    assert!(result.error.is_some());
    assert!(!out_path.exists());
}

#[test]
fn developing_a_nonexistent_raw_path_reports_an_error_not_a_panic() {
    let out_path = temp_out_path("develop-missing.jpg");
    let mut task = RenderDevelopJpegToFileTask {
        raw_path: "/definitely/does/not/exist/photo.dng".to_string(),
        xmp_path: None,
        out_path: out_path.to_string_lossy().into_owned(),
        max_px: 1280,
        quality: 0,
    };
    let result = task.compute().unwrap();
    assert!(!result.ok);
    assert!(result.error.is_some());
    assert!(!out_path.exists());
}

// ---------------------------------------------------------------------
// Fixture-gated success-path proofs. Skip (print + return) rather than
// fail when `test-fixtures/raws/` isn't present, matching the repo-wide
// "no fixtures, skipping" convention.
// ---------------------------------------------------------------------

#[test]
fn exporting_a_real_dng_to_jpeg_succeeds_and_writes_a_real_jpeg() {
    let Some(fixture) = small_dng_fixture() else {
        eprintln!("skipping: test-fixtures/raws/test_0018.dng not present in this checkout");
        return;
    };
    let out_path = temp_out_path("export-real.jpg");
    let mut task = ExportDevelopedToFileTask {
        raw_path: fixture.to_string_lossy().into_owned(),
        xmp_path: None,
        format: "jpeg".to_string(),
        quality: 0,
        color_space: "srgb".to_string(),
        max_long_edge: 512,
        out_path: out_path.to_string_lossy().into_owned(),
    };
    let result = task.compute().expect("compute must not itself error");
    assert!(result.ok, "export failed: {:?}", result.error);
    let bytes = std::fs::read(&out_path).expect("exported file must exist");
    assert_eq!(&bytes[..2], &[0xFF, 0xD8], "expected a JPEG SOI marker");
    let _ = std::fs::remove_file(&out_path);
}

#[test]
fn rendering_a_real_dng_thumbnail_succeeds_and_writes_a_real_avif() {
    let Some(fixture) = dng_fixture_with_embedded_preview() else {
        eprintln!("skipping: test-fixtures/raws/test_0015.dng not present in this checkout");
        return;
    };
    let out_path = temp_out_path("thumb-real.avif");
    let mut task = RenderThumbnailAvifToFileTask {
        raw_path: fixture.to_string_lossy().into_owned(),
        out_path: out_path.to_string_lossy().into_owned(),
        max_px: 256,
        quality: 0,
    };
    let result = task.compute().expect("compute must not itself error");
    assert!(result.ok, "thumbnail render failed: {:?}", result.error);
    let bytes = std::fs::read(&out_path).expect("thumbnail file must exist");
    // AVIF is an ISOBMFF container: bytes 4..8 are "ftyp".
    assert_eq!(&bytes[4..8], b"ftyp", "expected an AVIF ftyp box");
    let _ = std::fs::remove_file(&out_path);
}
