//! `{date:FORMAT}` coverage: every supported strftime directive, unknown
//! directive passthrough, and the missing/unparseable-EXIF-date fallback.

use super::*;

fn inputs_with_date<'a>(captured_at: Option<&'a str>) -> RenderInputs<'a> {
    RenderInputs {
        original_stem: "IMG_0001",
        ext: "dng",
        index: 0,
        captured_at,
    }
}

fn no_sequence() -> SequenceOptions {
    SequenceOptions {
        start: 0,
        pad_width: 0,
    }
}

const SAMPLE_DATE: &str = "2024:06:01 09:05:07";

#[test]
fn directive_year_4digit() {
    let got = render_filename(
        "{date:%Y}",
        &inputs_with_date(Some(SAMPLE_DATE)),
        &no_sequence(),
    )
    .unwrap();
    assert_eq!(got, "2024");
}

#[test]
fn directive_year_2digit() {
    let got = render_filename(
        "{date:%y}",
        &inputs_with_date(Some("1999:12:31 23:59:59")),
        &no_sequence(),
    )
    .unwrap();
    assert_eq!(got, "99");
}

#[test]
fn directive_month_day_zero_padded() {
    let got = render_filename(
        "{date:%m}-{date:%d}",
        &inputs_with_date(Some(SAMPLE_DATE)),
        &no_sequence(),
    )
    .unwrap();
    assert_eq!(got, "06-01");
}

#[test]
fn directive_time_zero_padded() {
    let got = render_filename(
        "{date:%H}:{date:%M}:{date:%S}",
        &inputs_with_date(Some(SAMPLE_DATE)),
        &no_sequence(),
    )
    .unwrap();
    assert_eq!(got, "09:05:07");
}

#[test]
fn directive_combined_compact_stamp() {
    let got = render_filename(
        "{date:%Y%m%d_%H%M%S}",
        &inputs_with_date(Some(SAMPLE_DATE)),
        &no_sequence(),
    )
    .unwrap();
    assert_eq!(got, "20240601_090507");
}

#[test]
fn directive_percent_literal() {
    let got = render_filename(
        "{date:100%% done}",
        &inputs_with_date(Some(SAMPLE_DATE)),
        &no_sequence(),
    )
    .unwrap();
    assert_eq!(got, "100% done");
}

#[test]
fn unknown_directive_passes_through_verbatim() {
    let got = render_filename(
        "{date:%q}",
        &inputs_with_date(Some(SAMPLE_DATE)),
        &no_sequence(),
    )
    .unwrap();
    assert_eq!(got, "%q");
}

#[test]
fn trailing_bare_percent_passes_through() {
    let got = render_filename(
        "{date:done%}",
        &inputs_with_date(Some(SAMPLE_DATE)),
        &no_sequence(),
    )
    .unwrap();
    assert_eq!(got, "done%");
}

#[test]
fn empty_format_spec_renders_nothing_for_a_present_date() {
    let got = render_filename(
        "{date:}{original}",
        &inputs_with_date(Some(SAMPLE_DATE)),
        &no_sequence(),
    )
    .unwrap();
    assert_eq!(got, "IMG_0001");
}

#[test]
fn missing_exif_date_falls_back_to_sentinel_text() {
    let got = render_filename(
        "{date:%Y}-{original}",
        &inputs_with_date(None),
        &no_sequence(),
    )
    .unwrap();
    assert_eq!(got, "unknown-date-IMG_0001");
}

#[test]
fn unparseable_exif_date_falls_back_same_as_missing() {
    let cases = [
        "not-a-date",
        "",
        "2024-06-01 09:05:07",  // wrong separators (hyphens, not colons)
        "2024:06:01T09:05:07",  // wrong date/time separator
        "2024:06:01 09:05:0",   // too short
        "2024:06:01 09:05:007", // too long
    ];
    for bad in cases {
        let got =
            render_filename("{date:%Y}", &inputs_with_date(Some(bad)), &no_sequence()).unwrap();
        assert_eq!(got, "unknown-date", "input {bad:?} should fall back");
    }
}

#[test]
fn fallback_sentinel_itself_is_a_valid_filename() {
    // The fallback text must never itself trip validate_filename — a
    // dateless file in a batch should still render, not fail differently
    // from every other file in the same batch.
    assert!(validate_filename(super::date::FALLBACK_DATE_TEXT).is_ok());
}
