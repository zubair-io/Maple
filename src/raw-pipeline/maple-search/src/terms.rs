//! A user's free-text query, read into terms the same way the API's FTS5
//! translation reads it (`src/api/src/db/repos/search.fts.ts`, `toTextFilter`'s
//! parse step), so the Tantivy leg and the SQLite path agree on what a query
//! asks for: bare words OR together, quoted phrases are required, a leading
//! `-` excludes, filler words drop unless nothing else is left, and at most
//! [`MAX_TERMS`] terms count.

use regex::Regex;
use std::sync::LazyLock;

pub const MAX_TERMS: usize = 24;

const STOPWORDS: [&str; 33] = [
    "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "if", "in", "into", "is", "it",
    "no", "not", "of", "on", "or", "such", "that", "the", "their", "then", "there", "these",
    "they", "this", "to", "was", "will", "with",
];

static TERM: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(-?)(?:"([^"]*)"?|(\S+))"#).expect("TERM pattern compiles"));
static NON_TOKEN_RUN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[^\p{L}\p{N}]+").expect("split pattern compiles"));
static HAS_TOKEN_CHARS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[\p{L}\p{N}]").expect("token pattern compiles"));

#[derive(Debug, Clone, PartialEq, Eq)]
struct ParsedTerm {
    text: String,
    phrase: bool,
    negated: bool,
}

impl ParsedTerm {
    fn is_optional_stopword(&self) -> bool {
        !self.phrase && !self.negated && STOPWORDS.contains(&self.text.to_lowercase().as_str())
    }
}

/// What a query asks the text index for.
///
/// `Blank` carries no text filter at all; `Unmatchable` asked for text that no
/// document can satisfy (`???`, `-boat`) — the two are different answers and
/// collapsing them would widen a narrowing query to the whole library.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TextQuery {
    Blank,
    Unmatchable,
    Terms {
        required_phrases: Vec<String>,
        optional_terms: Vec<String>,
        excluded: Vec<String>,
    },
}

pub fn parse_text_query(raw: &str) -> TextQuery {
    if raw.trim().is_empty() {
        return TextQuery::Blank;
    }
    let terms = parse_terms(raw);
    let texts = |keep: fn(&ParsedTerm) -> bool| -> Vec<String> {
        terms
            .iter()
            .filter(|term| keep(term))
            .map(|term| term.text.clone())
            .collect()
    };
    let required_phrases = texts(|t| !t.negated && t.phrase);
    let optional_terms = texts(|t| !t.negated && !t.phrase);
    if required_phrases.is_empty() && optional_terms.is_empty() {
        return TextQuery::Unmatchable;
    }
    TextQuery::Terms {
        required_phrases,
        optional_terms,
        excluded: texts(|t| t.negated),
    }
}

fn parse_terms(input: &str) -> Vec<ParsedTerm> {
    let tokenised: Vec<ParsedTerm> = TERM
        .captures_iter(input)
        .flat_map(|captures| {
            let negated = captures.get(1).is_some_and(|m| m.as_str() == "-");
            match captures.get(2) {
                Some(phrase) => vec![ParsedTerm {
                    text: phrase.as_str().to_owned(),
                    phrase: true,
                    negated,
                }],
                None => split_bare_term(captures.get(3).map_or("", |m| m.as_str()))
                    .map(|text| ParsedTerm {
                        text: text.to_owned(),
                        phrase: false,
                        negated,
                    })
                    .collect(),
            }
        })
        .filter(|term| HAS_TOKEN_CHARS.is_match(&term.text))
        .collect();
    without_stopwords(tokenised)
        .into_iter()
        .take(MAX_TERMS)
        .collect()
}

fn split_bare_term(text: &str) -> impl Iterator<Item = &str> {
    NON_TOKEN_RUN.split(text).filter(|part| !part.is_empty())
}

fn without_stopwords(terms: Vec<ParsedTerm>) -> Vec<ParsedTerm> {
    let kept: Vec<ParsedTerm> = terms
        .iter()
        .filter(|term| !term.is_optional_stopword())
        .cloned()
        .collect();
    if kept.iter().any(|term| !term.negated) {
        kept
    } else {
        terms
    }
}

#[cfg(test)]
#[path = "terms_tests.rs"]
mod tests;
