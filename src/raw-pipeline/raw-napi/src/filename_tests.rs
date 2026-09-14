//! Tests for `filename::render_filename_template` / `filename::validate_filename`
//! (#3509 Task 2). Calls the `#[napi]` functions directly as plain Rust
//! functions — proving the logic before involving Node/napi loading at all.
//! Mirrors the same cases `src/maple/test/maple.test.ts` asserts against the
//! `bun:ffi` backend ("renders filename template correctly", "validates
//! filenames according to cross-platform rules") — the cross-binding parity
//! check for this slice.
//!
//! Lives under `src/` and is wired in via `#[cfg(test)] mod filename_tests;`
//! in `lib.rs`, the same layout `raw-ffi/src/filename_tests.rs` uses, rather
//! than a `tests/filename_tests.rs` integration test: this crate's
//! `crate-type` is `["cdylib"]` only (see the manifest's comment — no `rlib`
//! is produced, since nothing in-tree links `raw_napi` as a Rust library), so
//! an integration test that does `use raw_napi::{...}` as an external crate
//! cannot link. A unit-test module compiled directly into the crate's own
//! test harness has no such requirement.

use crate::filename::{render_filename_template, validate_filename, FilenameTemplateArgs};

#[test]
fn renders_a_sequence_number_into_the_template() {
    let result = render_filename_template(FilenameTemplateArgs {
        template: "{original}_{n}.{ext}".to_string(),
        original_stem: "IMG_1234".to_string(),
        ext: "jpg".to_string(),
        captured_at: Some("2026:09:09 12:00:00".to_string()),
        sequence_start: 1,
        sequence_index: 0,
        sequence_pad_width: 3,
    })
    .unwrap();
    assert!(result.ok);
    assert_eq!(result.name.as_deref(), Some("IMG_1234_001.jpg"));
    assert_eq!(result.code, None);
    assert_eq!(result.error, None);
}

#[test]
fn validates_an_ordinary_name_as_valid() {
    let result = validate_filename("valid-photo_01.jpg".to_string());
    assert!(result.ok);
    assert_eq!(result.code, None);
    assert_eq!(result.error, None);
}

#[test]
fn validates_a_path_separator_as_invalid() {
    let result = validate_filename("path/separator.jpg".to_string());
    assert!(!result.ok);
    // FilenameError::PathSeparator -> code 4, matching raw-ffi's error_code().
    assert_eq!(result.code, Some(4));
    assert!(result.error.is_some());
}

#[test]
fn validates_a_leading_dot_as_invalid() {
    let result = validate_filename(".hidden.jpg".to_string());
    assert!(!result.ok);
    // FilenameError::LeadingDot -> code 5.
    assert_eq!(result.code, Some(5));
}

#[test]
fn validates_a_windows_reserved_name_as_invalid() {
    let result = validate_filename("CON.jpg".to_string());
    assert!(!result.ok);
    // FilenameError::ReservedName -> code 7.
    assert_eq!(result.code, Some(7));
}

#[test]
fn render_rejects_an_unknown_template_token_with_the_matching_code() {
    let result = render_filename_template(FilenameTemplateArgs {
        template: "{bogus}".to_string(),
        original_stem: "IMG_0001".to_string(),
        ext: "dng".to_string(),
        captured_at: None,
        sequence_start: 0,
        sequence_index: 0,
        sequence_pad_width: 0,
    })
    .unwrap();
    assert!(!result.ok);
    // FilenameError::UnknownToken -> code 2.
    assert_eq!(result.code, Some(2));
    assert_eq!(result.name, None);
}

#[test]
fn render_rejects_a_sequence_pad_width_above_the_maximum() {
    let result = render_filename_template(FilenameTemplateArgs {
        template: "{n}".to_string(),
        original_stem: "IMG_0001".to_string(),
        ext: "dng".to_string(),
        captured_at: None,
        sequence_start: 0,
        sequence_index: 0,
        sequence_pad_width: 33,
    })
    .unwrap();
    assert!(!result.ok);
    // FilenameError::SequencePadWidthTooLarge -> code 8.
    assert_eq!(result.code, Some(8));
}

#[test]
fn render_rejects_a_negative_sequence_value_as_an_invalid_argument() {
    let result = render_filename_template(FilenameTemplateArgs {
        template: "{n}".to_string(),
        original_stem: "IMG_0001".to_string(),
        ext: "dng".to_string(),
        captured_at: None,
        sequence_start: -1,
        sequence_index: 0,
        sequence_pad_width: 0,
    });
    assert!(result.is_err());
}

#[test]
fn matches_raw_core_directly() {
    let inputs = raw_core::filename::RenderInputs {
        original_stem: "IMG_0042",
        ext: "cr3",
        index: 7,
        captured_at: Some("2023:11:02 08:15:00"),
    };
    let sequence = raw_core::filename::SequenceOptions {
        start: 1,
        pad_width: 4,
    };
    let expected = raw_core::filename::render_filename(
        "{date:%Y%m%d}_{original}_{n}.{ext}",
        &inputs,
        &sequence,
    )
    .unwrap();

    let got = render_filename_template(FilenameTemplateArgs {
        template: "{date:%Y%m%d}_{original}_{n}.{ext}".to_string(),
        original_stem: "IMG_0042".to_string(),
        ext: "cr3".to_string(),
        captured_at: Some("2023:11:02 08:15:00".to_string()),
        sequence_start: 1,
        sequence_index: 7,
        sequence_pad_width: 4,
    })
    .unwrap();
    assert_eq!(got.name.as_deref(), Some(expected.as_str()));
}
