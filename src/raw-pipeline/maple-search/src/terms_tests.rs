//! The `toTextFilter` cases from `src/api/src/db/repos/search.fts.test.ts`,
//! asserted against the very same FTS5 expression strings. `fts5_expression`
//! renders a parsed query exactly the way `toTextFilter` does, so a parse that
//! drifts from the TypeScript one fails here with a readable diff.

use super::*;

fn quote(text: &str) -> String {
    format!("\"{}\"", text.replace('"', "\"\""))
}

fn fts5_expression(raw: &str) -> Option<String> {
    let TextQuery::Terms {
        required_phrases,
        optional_terms,
        excluded,
    } = parse_text_query(raw)
    else {
        return None;
    };
    let optional_group = (!optional_terms.is_empty()).then(|| {
        let quoted: Vec<String> = optional_terms.iter().map(|t| quote(t)).collect();
        format!("({})", quoted.join(" OR "))
    });
    let positive: Vec<String> = required_phrases
        .iter()
        .map(|t| quote(t))
        .chain(optional_group)
        .collect();
    let included = format!("({})", positive.join(" AND "));
    let excluded: Vec<String> = excluded.iter().map(|t| quote(t)).collect();
    Some(if excluded.is_empty() {
        included
    } else {
        format!("{included} NOT ({})", excluded.join(" OR "))
    })
}

fn expr(raw: &str) -> String {
    fts5_expression(raw).unwrap_or_else(|| panic!("{raw:?} produced no expression"))
}

#[test]
fn ors_bare_terms() {
    assert_eq!(expr("harbour lantern"), r#"(("harbour" OR "lantern"))"#);
}

#[test]
fn requires_a_quoted_phrase() {
    assert_eq!(expr(r#""paper lanterns""#), r#"("paper lanterns")"#);
}

#[test]
fn ands_a_phrase_with_the_or_group() {
    assert_eq!(
        expr(r#""paper lanterns" kyoto street"#),
        r#"("paper lanterns" AND ("kyoto" OR "street"))"#
    );
}

#[test]
fn excludes_a_negated_term() {
    assert_eq!(expr("harbour -boat"), r#"(("harbour")) NOT ("boat")"#);
}

#[test]
fn excludes_a_negated_phrase() {
    assert_eq!(
        expr(r#"kyoto -"paper lanterns""#),
        r#"(("kyoto")) NOT ("paper lanterns")"#
    );
}

#[test]
fn an_unterminated_quote_runs_to_the_end() {
    assert_eq!(expr(r#"say "hi"#), r#"("hi" AND ("say"))"#);
}

#[test]
fn a_bare_term_splits_on_punctuation() {
    assert_eq!(expr("harbour.dng"), r#"(("harbour" OR "dng"))"#);
    assert_eq!(expr("well-lit room"), r#"(("well" OR "lit" OR "room"))"#);
}

#[test]
fn a_quoted_phrase_is_not_split() {
    assert_eq!(expr(r#""harbour.dng""#), r#"("harbour.dng")"#);
}

#[test]
fn only_a_blank_query_carries_no_text_filter() {
    assert_eq!(parse_text_query(""), TextQuery::Blank);
    assert_eq!(parse_text_query("   "), TextQuery::Blank);
}

#[test]
fn a_query_with_no_positive_term_matches_nothing() {
    for raw in ["???", "((((", "\"", "-", "+++", "-boat", "-boat -lanterns"] {
        assert_eq!(parse_text_query(raw), TextQuery::Unmatchable, "{raw:?}");
    }
}

#[test]
fn drops_bare_stopwords_from_the_or_group() {
    assert_eq!(
        expr("scenic shots featuring vibrant orange and red autumn foliage"),
        r#"(("scenic" OR "shots" OR "featuring" OR "vibrant" OR "orange" OR "red" OR "autumn" OR "foliage"))"#
    );
    assert_eq!(expr("The Harbour at Dawn"), r#"(("Harbour" OR "Dawn"))"#);
}

#[test]
fn keeps_stopwords_when_they_are_the_whole_positive_query() {
    assert_eq!(expr("and"), r#"(("and"))"#);
    assert_eq!(
        expr("to be or not to be"),
        r#"(("to" OR "be" OR "or" OR "not" OR "to" OR "be"))"#
    );
    assert_eq!(expr("the -boat"), r#"(("the")) NOT ("boat")"#);
}

#[test]
fn a_quoted_phrase_keeps_its_stopwords() {
    assert_eq!(expr(r#""bread and butter""#), r#"("bread and butter")"#);
    assert_eq!(
        expr(r#""paper lanterns" in the street"#),
        r#"("paper lanterns" AND ("street"))"#
    );
    assert_eq!(expr(r#""paper lanterns" the"#), r#"("paper lanterns")"#);
}

#[test]
fn a_negated_stopword_is_still_excluded() {
    assert_eq!(expr("harbour -the"), r#"(("harbour")) NOT ("the")"#);
}

#[test]
fn stopwords_do_not_count_against_the_term_cap() {
    let wordy: Vec<String> = (0..30).map(|i| format!("the term{i}")).collect();
    let expression = expr(&wordy.join(" "));
    assert!(expression.contains(r#""term23""#));
    assert!(!expression.contains(r#""the""#));
}

#[test]
fn keeps_non_latin_terms() {
    assert_eq!(expr("東京"), r#"(("東京"))"#);
    assert_eq!(expr("naïve"), r#"(("naïve"))"#);
}

#[test]
fn a_pasted_paragraph_is_capped_at_the_first_24_terms() {
    let long: Vec<String> = (0..200).map(|i| format!("term{i}")).collect();
    let long = long.join(" ");
    assert!(long.len() > 500);
    let expression = expr(&long);
    assert!(expression.contains(r#""term23""#));
    assert!(!expression.contains(r#""term24""#));
}

#[test]
fn no_input_a_person_can_type_fails_to_parse() {
    for raw in [
        "C++ (2019)",
        "a:b",
        "^start",
        "foo*",
        "red OR blue",
        "x NEAR y",
        "NOT",
        "\"",
        "((((",
        "a - b",
        "{tag}",
        "O'Brien",
    ] {
        let _ = parse_text_query(raw);
    }
    assert_eq!(expr("C++ (2019)"), r#"(("C" OR "2019"))"#);
    assert_eq!(expr("O'Brien"), r#"(("O" OR "Brien"))"#);
}
