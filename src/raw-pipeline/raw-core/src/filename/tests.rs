//! Token-rendering coverage for [`super::render_filename`]: every token in
//! isolation, literal text, sequence start/padding, and template-parse
//! errors (unknown/unterminated token). Validation-rejection coverage lives
//! in `tests_validation.rs`; date-directive coverage lives in
//! `tests_date.rs`; end-to-end golden-corpus coverage lives in
//! `tests_fixtures.rs`.

use super::*;

fn inputs<'a>(original_stem: &'a str, ext: &'a str, index: u64) -> RenderInputs<'a> {
    RenderInputs {
        original_stem,
        ext,
        index,
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
fn renders_original_token_alone() {
    let got = render_filename("{original}", &inputs("IMG_0001", "dng", 0), &no_sequence()).unwrap();
    assert_eq!(got, "IMG_0001");
}

#[test]
fn renders_ext_token_alone() {
    let got = render_filename("{ext}", &inputs("IMG_0001", "dng", 0), &no_sequence()).unwrap();
    assert_eq!(got, "dng");
}

#[test]
fn renders_pure_literal_template() {
    let got = render_filename(
        "renamed_photo",
        &inputs("IMG_0001", "dng", 0),
        &no_sequence(),
    )
    .unwrap();
    assert_eq!(got, "renamed_photo");
}

#[test]
fn renders_original_plus_literal_plus_ext() {
    let got = render_filename(
        "{original}.{ext}",
        &inputs("IMG_0001", "dng", 0),
        &no_sequence(),
    )
    .unwrap();
    assert_eq!(got, "IMG_0001.dng");
}

#[test]
fn sequence_with_no_padding() {
    let seq = SequenceOptions {
        start: 1,
        pad_width: 0,
    };
    let got = render_filename("{n}", &inputs("x", "dng", 0), &seq).unwrap();
    assert_eq!(got, "1");
}

#[test]
fn sequence_with_padding() {
    let seq = SequenceOptions {
        start: 1,
        pad_width: 3,
    };
    let got = render_filename("{n}", &inputs("x", "dng", 0), &seq).unwrap();
    assert_eq!(got, "001");
}

#[test]
fn sequence_start_offsets_every_index() {
    let seq = SequenceOptions {
        start: 100,
        pad_width: 3,
    };
    assert_eq!(
        render_filename("{n}", &inputs("x", "dng", 0), &seq).unwrap(),
        "100"
    );
    assert_eq!(
        render_filename("{n}", &inputs("x", "dng", 5), &seq).unwrap(),
        "105"
    );
}

#[test]
fn sequence_padding_never_truncates_wider_numbers() {
    // pad_width is a floor, not a cap — a 5-digit number with pad_width=2
    // still renders all 5 digits.
    let seq = SequenceOptions {
        start: 0,
        pad_width: 2,
    };
    let got = render_filename("{n}", &inputs("x", "dng", 12_345), &seq).unwrap();
    assert_eq!(got, "12345");
}

#[test]
fn repeated_sequence_token_renders_the_same_value_twice() {
    let seq = SequenceOptions {
        start: 5,
        pad_width: 0,
    };
    let got = render_filename("{n}-{n}", &inputs("x", "dng", 0), &seq).unwrap();
    assert_eq!(got, "5-5");
}

#[test]
fn combined_template_all_tokens() {
    let seq = SequenceOptions {
        start: 10,
        pad_width: 3,
    };
    let in_ = RenderInputs {
        original_stem: "IMG_0001",
        ext: "dng",
        index: 2,
        captured_at: Some("2023:01:15 08:09:10"),
    };
    let got = render_filename("{date:%Y%m%d}_{original}_{n}.{ext}", &in_, &seq).unwrap();
    assert_eq!(got, "20230115_IMG_0001_012.dng");
}

#[test]
fn unknown_token_is_rejected() {
    let err = render_filename("{bogus}", &inputs("x", "dng", 0), &no_sequence()).unwrap_err();
    assert_eq!(err, FilenameError::UnknownToken("bogus".to_string()));
    assert_eq!(err.kind(), "unknown_token");
}

#[test]
fn unterminated_token_is_rejected() {
    let err =
        render_filename("prefix_{original", &inputs("x", "dng", 0), &no_sequence()).unwrap_err();
    assert_eq!(err, FilenameError::UnterminatedToken { at: 7 });
    assert_eq!(err.kind(), "unterminated_token");
}

#[test]
fn bare_closing_brace_is_treated_as_literal_text() {
    // No matching '{' precedes it, so it's not a token delimiter.
    let got = render_filename("weird}name", &inputs("x", "dng", 0), &no_sequence()).unwrap();
    assert_eq!(got, "weird}name");
}

#[test]
fn every_error_kind_is_a_stable_distinct_tag() {
    let kinds = [
        FilenameError::UnterminatedToken { at: 0 }.kind(),
        FilenameError::UnknownToken("x".into()).kind(),
        FilenameError::Empty.kind(),
        FilenameError::PathSeparator("x".into()).kind(),
        FilenameError::LeadingDot("x".into()).kind(),
        FilenameError::TrailingDotOrSpace("x".into()).kind(),
        FilenameError::ReservedName("x".into()).kind(),
    ];
    let mut unique = kinds.to_vec();
    unique.sort_unstable();
    unique.dedup();
    assert_eq!(
        unique.len(),
        kinds.len(),
        "kind() tags must all be distinct"
    );
}
