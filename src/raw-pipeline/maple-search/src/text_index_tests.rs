//! What a parsed query finds, on a library shaped like the API's search
//! fixture (`search.test-helpers.ts`): terms OR, phrases are required and
//! adjacent, `-` excludes, stemming matches other word forms.

use super::*;
use crate::terms::parse_text_query;

const LIBRARY: [(&str, &str); 5] = [
    ("harbour", "harbour.dng a quiet harbour at dawn"),
    ("kitchen", "kitchen.jpg bread cooling on a kitchen counter"),
    (
        "skyline",
        "skyline.dng new york the skyline from the bridge",
    ),
    (
        "lantern",
        "lantern.dng kyoto paper lanterns over a narrow street",
    ),
    ("clip", "clip.mp4 boats leaving the harbour"),
];

fn library() -> (tempfile::TempDir, TextIndex) {
    let dir = tempfile::tempdir().unwrap();
    let index = TextIndex::open(dir.path()).unwrap();
    index.rebuild(LIBRARY).unwrap();
    (dir, index)
}

fn find(index: &TextIndex, raw: &str) -> Vec<String> {
    let mut ids: Vec<String> = index
        .search(&parse_text_query(raw), 100)
        .unwrap()
        .into_iter()
        .map(|hit| hit.id)
        .collect();
    ids.sort();
    ids
}

#[test]
fn a_single_term_finds_every_text_mentioning_it() {
    let (_dir, index) = library();
    assert_eq!(find(&index, "harbour"), ["clip", "harbour"]);
}

#[test]
fn two_terms_are_an_or() {
    let (_dir, index) = library();
    assert_eq!(
        find(&index, "harbour lanterns"),
        ["clip", "harbour", "lantern"]
    );
}

#[test]
fn a_stopword_does_not_widen_a_query() {
    let (_dir, index) = library();
    assert_eq!(find(&index, "a harbour"), ["clip", "harbour"]);
}

#[test]
fn a_phrase_requires_its_words_adjacent() {
    let (_dir, index) = library();
    assert_eq!(find(&index, r#""paper lanterns""#), ["lantern"]);
    assert!(find(&index, r#""lanterns paper""#).is_empty());
    assert_eq!(
        find(&index, r#""paper lanterns" harbour"#),
        Vec::<String>::new()
    );
    assert_eq!(find(&index, r#""paper lanterns" kyoto"#), ["lantern"]);
}

#[test]
fn a_negated_term_removes_a_match() {
    let (_dir, index) = library();
    assert!(find(&index, "new york").contains(&"skyline".to_owned()));
    assert!(!find(&index, "new york -bridge").contains(&"skyline".to_owned()));
    assert_eq!(find(&index, "harbour -boats"), ["harbour"]);
}

#[test]
fn the_stemmer_matches_other_word_forms() {
    let (_dir, index) = library();
    assert_eq!(find(&index, "cooling"), ["kitchen"]);
    assert_eq!(find(&index, "cool"), ["kitchen"]);
    assert_eq!(find(&index, "lantern"), ["lantern"]);
}

#[test]
fn a_query_that_cannot_match_finds_nothing() {
    let (_dir, index) = library();
    for raw in ["???", "-boat", "((((", "", "   "] {
        assert!(find(&index, raw).is_empty(), "{raw:?}");
    }
}

#[test]
fn ranks_the_denser_match_first() {
    let dir = tempfile::tempdir().unwrap();
    let index = TextIndex::open(dir.path()).unwrap();
    index
        .rebuild([
            (
                "once",
                "a harbour and many other unrelated words about the town",
            ),
            ("twice", "harbour harbour"),
        ])
        .unwrap();
    let hits = index.search(&parse_text_query("harbour"), 10).unwrap();
    assert_eq!(hits[0].id, "twice");
    assert!(hits[0].score > hits[1].score);
}

#[test]
fn upsert_replaces_and_delete_removes_after_commit() {
    let (_dir, index) = library();
    index.upsert("harbour", "a mountain lake").unwrap();
    index.delete("clip");
    assert_eq!(find(&index, "harbour"), ["clip", "harbour"]);
    index.commit().unwrap();
    assert!(find(&index, "harbour").is_empty());
    assert_eq!(find(&index, "lake"), ["harbour"]);
    assert_eq!(index.num_docs(), 4);
}

#[test]
fn reopening_keeps_committed_documents() {
    let dir = tempfile::tempdir().unwrap();
    {
        let index = TextIndex::open(dir.path()).unwrap();
        index.rebuild(LIBRARY).unwrap();
    }
    let reopened = TextIndex::open(dir.path()).unwrap();
    assert_eq!(reopened.num_docs(), 5);
    assert_eq!(find(&reopened, "kyoto"), ["lantern"]);
}

#[test]
fn rebuild_replaces_everything() {
    let (_dir, index) = library();
    assert_eq!(index.rebuild([("only", "a single harbour")]).unwrap(), 1);
    assert_eq!(find(&index, "harbour"), ["only"]);
}

#[test]
fn finds_every_id_containing_an_excluded_term() {
    let (_dir, index) = library();
    let mut matched = index
        .ids_matching_any(&["boats".to_owned(), "paper lanterns".to_owned()])
        .unwrap();
    matched.sort();
    assert_eq!(matched, ["clip", "lantern"]);
    assert!(index.ids_matching_any(&[]).unwrap().is_empty());
}

#[test]
fn excluded_ids_survive_segments_and_deletes() {
    let (_dir, index) = library();
    index.upsert("ferry", "a ferry full of boats").unwrap();
    index.delete("clip");
    index.commit().unwrap();
    let mut matched = index.ids_matching_any(&["boats".to_owned()]).unwrap();
    matched.sort();
    assert_eq!(matched, ["ferry"]);
}

#[test]
fn accents_fold_in_both_directions() {
    let dir = tempfile::tempdir().unwrap();
    let index = TextIndex::open(dir.path()).unwrap();
    index
        .rebuild([
            ("accented", "a café with a naïve mural"),
            ("plain", "a cafe with a naive mural"),
        ])
        .unwrap();
    for query in ["cafe", "café", "naive", "naïve", "CAFÉ"] {
        assert_eq!(find(&index, query), ["accented", "plain"], "{query:?}");
    }
    assert_eq!(find(&index, r#""naïve mural""#), ["accented", "plain"]);
}

fn tied_top_hundred(ids: &[String], commit_every: usize) -> Vec<(String, usize)> {
    let dir = tempfile::tempdir().unwrap();
    let index = TextIndex::open(dir.path()).unwrap();
    for (position, id) in ids.iter().enumerate() {
        index.upsert(id, "boats moored in the harbour").unwrap();
        if (position + 1) % commit_every == 0 {
            index.commit().unwrap();
        }
    }
    index.commit().unwrap();
    let hits = index.search(&parse_text_query("harbour"), 100).unwrap();
    assert!(hits.iter().all(|hit| hit.score == hits[0].score));
    hits.into_iter()
        .enumerate()
        .map(|(rank, hit)| (hit.id, rank))
        .collect()
}

#[test]
fn equal_scores_cut_by_id_not_insertion_order() {
    let ascending: Vec<String> = (0..150).map(|i| format!("asset{i:03}")).collect();
    let descending: Vec<String> = ascending.iter().rev().cloned().collect();
    let forwards = tied_top_hundred(&ascending, 150);
    let backwards = tied_top_hundred(&descending, 40);
    assert_eq!(forwards.len(), 100);
    assert_eq!(forwards, backwards);
    let expected: Vec<(String, usize)> = ascending[..100].iter().cloned().zip(0..).collect();
    assert_eq!(forwards, expected);
}
