//! Invalid-output rejection coverage for [`super::validate_filename`] (and,
//! end-to-end, [`super::render_filename`]): path separators, leading/
//! trailing dots, trailing spaces, empty output, and every Windows-reserved
//! device name.

use super::*;

fn inputs<'a>(original_stem: &'a str, ext: &'a str) -> RenderInputs<'a> {
    RenderInputs {
        original_stem,
        ext,
        index: 0,
        captured_at: None,
    }
}

fn no_sequence() -> SequenceOptions {
    SequenceOptions {
        start: 0,
        pad_width: 0,
    }
}

#[test]
fn empty_name_is_rejected() {
    let err = validate_filename("").unwrap_err();
    assert_eq!(err, FilenameError::Empty);
}

#[test]
fn empty_render_output_is_rejected_end_to_end() {
    // A template that's syntactically fine (no tokens, no literal text at
    // all) renders to the empty string and must still be caught, not just
    // a manually-typed empty name via `validate_filename` directly.
    let err = render_filename("", &inputs("", ""), &no_sequence()).unwrap_err();
    assert_eq!(err, FilenameError::Empty);
}

#[test]
fn forward_slash_is_rejected() {
    let err = validate_filename("sub/name").unwrap_err();
    assert_eq!(err, FilenameError::PathSeparator("sub/name".to_string()));
    assert_eq!(err.kind(), "path_separator");
}

#[test]
fn backslash_is_rejected() {
    let err = validate_filename("sub\\name").unwrap_err();
    assert_eq!(err, FilenameError::PathSeparator("sub\\name".to_string()));
}

#[test]
fn leading_dot_is_rejected() {
    let err = validate_filename(".hidden").unwrap_err();
    assert_eq!(err, FilenameError::LeadingDot(".hidden".to_string()));
    assert_eq!(err.kind(), "leading_dot");
}

#[test]
fn trailing_dot_is_rejected() {
    let err = validate_filename("name.").unwrap_err();
    assert_eq!(err, FilenameError::TrailingDotOrSpace("name.".to_string()));
    assert_eq!(err.kind(), "trailing_dot_or_space");
}

#[test]
fn trailing_space_is_rejected() {
    let err = validate_filename("name ").unwrap_err();
    assert_eq!(err, FilenameError::TrailingDotOrSpace("name ".to_string()));
}

#[test]
fn every_reserved_windows_device_name_is_rejected_bare() {
    for reserved in RESERVED_WINDOWS_NAMES {
        let err = validate_filename(reserved).unwrap_err();
        assert_eq!(
            err,
            FilenameError::ReservedName(reserved.to_string()),
            "expected {reserved} to be rejected"
        );
        assert_eq!(err.kind(), "reserved_name");
    }
}

#[test]
fn reserved_name_check_is_case_insensitive() {
    for name in ["con", "Con", "CoN", "NUL", "nul", "Lpt1", "com9"] {
        assert!(
            validate_filename(name).is_err(),
            "expected {name:?} to be rejected"
        );
    }
}

#[test]
fn reserved_name_check_applies_to_the_stem_before_the_extension() {
    assert!(matches!(
        validate_filename("CON.txt"),
        Err(FilenameError::ReservedName(_))
    ));
    assert!(matches!(
        validate_filename("con.tar.gz"),
        Err(FilenameError::ReservedName(_))
    ));
}

#[test]
fn names_that_merely_start_with_a_reserved_word_are_accepted() {
    // The stem must EXACTLY match a reserved word, not merely start with
    // one — "Console" is a real, common word and must not be rejected.
    assert!(validate_filename("Console.dng").is_ok());
    assert!(validate_filename("Contact.jpg").is_ok());
    assert!(validate_filename("NULLABLE").is_ok());
}

#[test]
fn ordinary_names_are_accepted() {
    assert!(validate_filename("IMG_0001.dng").is_ok());
    assert!(validate_filename("vacation photo 2024.jpg").is_ok());
    assert!(validate_filename("a").is_ok());
}

#[test]
fn reserved_name_is_rejected_end_to_end_through_render() {
    let err = render_filename("CON.{ext}", &inputs("whatever", "txt"), &no_sequence()).unwrap_err();
    assert_eq!(err, FilenameError::ReservedName("CON.txt".to_string()));
}

#[test]
fn path_separator_is_rejected_end_to_end_through_render() {
    let err =
        render_filename("sub/{original}", &inputs("whatever", "txt"), &no_sequence()).unwrap_err();
    assert_eq!(err.kind(), "path_separator");
}
