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

/// The only `schema_version` this test suite (and, by extension, the #2633
/// cross-surface harness) currently understands. `cases.json` is about to be
/// a contract consumed independently by Swift, C#, and TypeScript runners —
/// a field renamed or reshaped there with nothing asserting the version
/// would silently desync all three at once instead of failing loudly here
/// first. Bump this alongside a deliberate, documented schema change; do NOT
/// bump it just to make a stale corpus compile again.
const EXPECTED_SCHEMA_VERSION: u32 = 1;

#[derive(Deserialize)]
struct Corpus {
    schema_version: u32,
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
fn fixture_corpus_schema_version_matches_expected() {
    // Deserialized and asserted explicitly (not just parsed and ignored) —
    // see EXPECTED_SCHEMA_VERSION's doc for why an unnoticed drift here
    // matters more than an ordinary field: this corpus is a cross-language
    // contract, not just this crate's own test data.
    let corpus: Corpus = serde_json::from_str(CASES_JSON).expect(
        "test-fixtures/filename-templates/cases.json must be valid JSON matching the Case schema",
    );
    assert_eq!(
        corpus.schema_version, EXPECTED_SCHEMA_VERSION,
        "cases.json's schema_version has changed — update EXPECTED_SCHEMA_VERSION \
         (and everything that consumes this corpus: raw-core's own deserializer above, \
         and eventually the #2633 Swift/C#/TypeScript harness runners) as a deliberate, \
         reviewed step, not by silently bumping this constant to unblock CI"
    );
}

#[test]
fn every_fixture_case_matches_the_reference_implementation() {
    let corpus: Corpus = serde_json::from_str(CASES_JSON).expect(
        "test-fixtures/filename-templates/cases.json must be valid JSON matching the Case schema",
    );
    assert_eq!(
        corpus.schema_version, EXPECTED_SCHEMA_VERSION,
        "schema_version mismatch — see fixture_corpus_schema_version_matches_expected"
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
