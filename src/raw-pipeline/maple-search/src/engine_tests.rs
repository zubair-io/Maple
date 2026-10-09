use super::*;
use crate::vectors::DIM;

fn basis(axis: usize) -> Vec<f32> {
    let mut vector = vec![0.0; DIM];
    vector[axis] = 1.0;
    vector
}

fn engine(dir: &tempfile::TempDir) -> SearchEngine {
    let engine = SearchEngine::open(&SearchConfig {
        index_dir: dir.path().join("text"),
        embedder: None,
    })
    .unwrap();
    let rows: [(&str, usize, &str); 4] = [
        ("harbour", 0, "a quiet harbour at dawn"),
        ("boats", 0, "boats moored in the harbour"),
        ("kitchen", 1, "bread cooling on a kitchen counter"),
        ("lantern", 2, "paper lanterns over a narrow street"),
    ];
    let bytes: Vec<u8> = rows
        .iter()
        .flat_map(|(_, axis, _)| basis(*axis))
        .flat_map(f32::to_le_bytes)
        .collect();
    let ids = rows.iter().map(|(id, _, _)| (*id).to_owned()).collect();
    assert_eq!(engine.load_vectors(&bytes, ids).unwrap(), 4);
    engine
        .rebuild_text(rows.iter().map(|(id, _, text)| (*id, *text)))
        .unwrap();
    engine
}

fn ids(hits: &[FusedHit]) -> Vec<&str> {
    hits.iter().map(|hit| hit.id.as_str()).collect()
}

#[test]
fn fuses_both_legs_and_reports_each_rank() {
    let dir = tempfile::tempdir().unwrap();
    let engine = engine(&dir);
    let hits = engine.search_with_vector("bread", &basis(0), 10).unwrap();
    let kitchen = hits.iter().find(|hit| hit.id == "kitchen").unwrap();
    assert_eq!(kitchen.text_rank, Some(1));
    assert_eq!(kitchen.vector_rank, Some(3));
    let harbour = hits.iter().find(|hit| hit.id == "harbour").unwrap();
    assert_eq!(harbour.text_rank, None);
    assert!(harbour.vector_rank.is_some());
    assert_eq!(ids(&hits)[0], "kitchen");
}

#[test]
fn a_hit_in_both_legs_ranks_first() {
    let dir = tempfile::tempdir().unwrap();
    let engine = engine(&dir);
    let hits = engine
        .search_with_vector("lanterns", &basis(2), 10)
        .unwrap();
    assert_eq!(hits[0].id, "lantern");
    assert_eq!((hits[0].vector_rank, hits[0].text_rank), (Some(1), Some(1)));
}

#[test]
fn k_caps_the_fused_list() {
    let dir = tempfile::tempdir().unwrap();
    let engine = engine(&dir);
    assert_eq!(
        engine
            .search_with_vector("harbour", &basis(0), 2)
            .unwrap()
            .len(),
        2
    );
}

#[test]
fn an_excluded_term_also_filters_the_vector_leg() {
    let dir = tempfile::tempdir().unwrap();
    let engine = engine(&dir);
    let hits = engine
        .search_with_vector("harbour -boats", &basis(0), 10)
        .unwrap();
    assert!(!ids(&hits).contains(&"boats"));
    assert!(ids(&hits).contains(&"harbour"));
}

#[test]
fn a_query_without_a_positive_term_finds_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let engine = engine(&dir);
    for raw in ["", "???", "-boats"] {
        assert!(engine
            .search_with_vector(raw, &basis(0), 10)
            .unwrap()
            .is_empty());
        assert!(engine.search(raw, 10).unwrap().is_empty(), "{raw:?}");
    }
}

#[test]
fn searching_text_without_an_embedder_is_a_typed_error() {
    let dir = tempfile::tempdir().unwrap();
    let engine = engine(&dir);
    assert!(matches!(
        engine.search("harbour", 10),
        Err(SearchError::NoEmbedder)
    ));
}

#[test]
fn upsert_and_delete_reach_both_legs() {
    let dir = tempfile::tempdir().unwrap();
    let engine = engine(&dir);
    engine
        .upsert("cellar", Some(&basis(3)), Some("wine cellar"))
        .unwrap();
    engine.delete("lantern");
    engine.commit().unwrap();
    let hits = engine
        .search_with_vector("cellar lanterns", &basis(3), 10)
        .unwrap();
    assert_eq!(hits[0].id, "cellar");
    assert_eq!((hits[0].vector_rank, hits[0].text_rank), (Some(1), Some(1)));
    assert!(!ids(&hits).contains(&"lantern"));
    assert_eq!(engine.vector_count(), 4);
    assert_eq!(engine.text_count(), 4);
}

#[test]
fn a_cleared_rebuild_only_shows_once_committed() {
    let dir = tempfile::tempdir().unwrap();
    let engine = engine(&dir);
    engine.clear_text().unwrap();
    engine.upsert("fresh", None, Some("fresh harbour")).unwrap();
    assert_eq!(engine.text_count(), 4);
    engine.commit().unwrap();
    assert_eq!(engine.text_count(), 1);
    let text_ids: Vec<String> = engine
        .text_leg(&parse_text_query("harbour"))
        .unwrap()
        .into_iter()
        .map(|hit| hit.id)
        .collect();
    assert_eq!(text_ids, ["fresh"]);
}

#[test]
fn config_parses_from_json_and_rejects_unknown_keys() {
    let config = SearchConfig::from_json(
        r#"{"index_dir":"/tmp/x","embedder":{"model_cache_dir":"/tmp/m","intra_threads":4}}"#,
    )
    .unwrap();
    assert_eq!(config.embedder.unwrap().intra_threads, Some(4));
    assert!(matches!(
        SearchConfig::from_json(r#"{"index_dir":"/tmp/x","typo":1}"#),
        Err(SearchError::Config(_))
    ));
}
