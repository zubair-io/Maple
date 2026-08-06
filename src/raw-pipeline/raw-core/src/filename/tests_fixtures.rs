//! Cross-checks the committed golden fixture corpus at
//! `test-fixtures/filename-templates/cases.json` against this crate's own
//! [`super::render_filename`] — the Rust reference implementation the
//! corpus is meant to pin. This is what keeps the corpus honest: every case
//! in the JSON is asserted here, not just hand-verified once and left to
//! drift. The cross-surface outcome-parity harness (#2633) replays the same
//! JSON against the Swift, TypeScript/WASM, and C# bindings.
//!
//! `include_str!` pulls the fixture in at COMPILE time (a fixed, checked-in
//! relative path), not via a runtime filesystem read — this test still
//! respects the module's "pure function, no filesystem access" contract for
//! the code under test; only the test harness itself needs the bytes, and
//! it gets them the same way any other `include_str!`-based fixture in this
//! codebase would.

use super::*;
use serde::Deserialize;

const CASES_JSON: &str = include_str!("../../../../../test-fixtures/filename-templates/cases.json");

#[derive(Deserialize)]
struct Corpus {
    cases: Vec<Case>,
}

#[derive(Deserialize)]
struct Case {
    name: String,
    template: String,
    original_stem: String,
    ext: String,
    sequence_start: u64,
    sequence_index: u64,
    sequence_pad_width: usize,
    captured_at: Option<String>,
    expected: Expected,
}

#[derive(Deserialize)]
struct Expected {
    ok: Option<String>,
    error: Option<String>,
}

#[test]
fn every_fixture_case_matches_the_reference_implementation() {
    let corpus: Corpus = serde_json::from_str(CASES_JSON).expect(
        "test-fixtures/filename-templates/cases.json must be valid JSON matching the Case schema",
    );
    assert!(!corpus.cases.is_empty(), "fixture corpus must not be empty");

    let mut failures = Vec::new();
    for case in &corpus.cases {
        let inputs = RenderInputs {
            original_stem: &case.original_stem,
            ext: &case.ext,
            index: case.sequence_index,
            captured_at: case.captured_at.as_deref(),
        };
        let sequence = SequenceOptions {
            start: case.sequence_start,
            pad_width: case.sequence_pad_width,
        };
        let actual = render_filename(&case.template, &inputs, &sequence);

        match (&case.expected.ok, &case.expected.error, actual) {
            (Some(want), None, Ok(got)) if *want == got => {}
            (Some(want), None, Ok(got)) => failures.push(format!(
                "{}: expected ok {want:?}, got ok {got:?}",
                case.name
            )),
            (Some(want), None, Err(e)) => failures.push(format!(
                "{}: expected ok {want:?}, got error {:?} ({})",
                case.name,
                e.kind(),
                e
            )),
            (None, Some(want_kind), Err(e)) if *want_kind == e.kind() => {}
            (None, Some(want_kind), Err(e)) => failures.push(format!(
                "{}: expected error {want_kind:?}, got error {:?} ({})",
                case.name,
                e.kind(),
                e
            )),
            (None, Some(want_kind), Ok(got)) => failures.push(format!(
                "{}: expected error {want_kind:?}, got ok {got:?}",
                case.name
            )),
            (None, None, _) => failures.push(format!(
                "{}: fixture has neither `ok` nor `error`",
                case.name
            )),
            (Some(_), Some(_), _) => failures.push(format!(
                "{}: fixture has BOTH `ok` and `error` — ambiguous",
                case.name
            )),
        }
    }

    assert!(
        failures.is_empty(),
        "fixture corpus mismatches:\n{}",
        failures.join("\n")
    );
}
