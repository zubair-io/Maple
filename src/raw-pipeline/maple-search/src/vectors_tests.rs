use super::*;

fn basis(axis: usize, scale: f32) -> Vec<f32> {
    let mut vector = vec![0.0; DIM];
    vector[axis] = scale;
    vector
}

fn to_bytes(rows: &[Vec<f32>]) -> Vec<u8> {
    rows.iter()
        .flatten()
        .flat_map(|value| value.to_le_bytes())
        .collect()
}

fn ids(names: &[&str]) -> Vec<String> {
    names.iter().map(|name| (*name).to_owned()).collect()
}

fn hit_ids(hits: &[ScoredId]) -> Vec<&str> {
    hits.iter().map(|hit| hit.id.as_str()).collect()
}

#[test]
fn ranks_rows_by_cosine_similarity() {
    let mut mixed = basis(0, 1.0);
    mixed[1] = 1.0;
    let rows = vec![basis(1, 1.0), mixed, basis(0, 3.0)];
    let matrix = VectorMatrix::from_le_bytes(&to_bytes(&rows), ids(&["y", "xy", "x"])).unwrap();
    let hits = matrix.nearest(&basis(0, 1.0), 3).unwrap();
    assert_eq!(hit_ids(&hits), ["x", "xy", "y"]);
    assert!((hits[0].score - 1.0).abs() < 1e-6);
    assert!((hits[1].score - std::f32::consts::FRAC_1_SQRT_2).abs() < 1e-6);
    assert!(hits[2].score.abs() < 1e-6);
}

#[test]
fn equal_scores_order_by_id_whatever_the_row_order() {
    let rows = vec![basis(0, 1.0), basis(0, 2.0), basis(0, 5.0)];
    let matrix = VectorMatrix::from_le_bytes(&to_bytes(&rows), ids(&["c", "a", "b"])).unwrap();
    let hits = matrix.nearest(&basis(0, 1.0), 2).unwrap();
    assert_eq!(hit_ids(&hits), ["a", "b"]);
}

#[test]
fn a_parallel_scan_matches_a_sequential_ranking() {
    let rows: Vec<Vec<f32>> = (0..5000)
        .map(|row| {
            (0..DIM)
                .map(|col| (((row * 31 + col * 17) % 97) as f32 - 48.0) / 48.0)
                .collect()
        })
        .collect();
    let names: Vec<String> = (0..rows.len()).map(|row| format!("id{row:05}")).collect();
    let matrix = VectorMatrix::from_le_bytes(&to_bytes(&rows), names.clone()).unwrap();
    let query = rows[1234].clone();
    let hits = matrix.nearest(&query, 25).unwrap();

    let mut unit_query = query.clone();
    normalise(&mut unit_query);
    let mut expected: Vec<(String, f32)> = rows
        .iter()
        .zip(&names)
        .map(|(row, name)| {
            let mut unit = row.clone();
            normalise(&mut unit);
            (name.clone(), dot(&unit, &unit_query))
        })
        .collect();
    expected.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    let expected_ids: Vec<&str> = expected[..25].iter().map(|(id, _)| id.as_str()).collect();
    assert_eq!(hit_ids(&hits), expected_ids);
    assert_eq!(
        hits[0].id, "id00070",
        "rows repeat every 97, so the lowest equal id wins"
    );
    assert!((hits[0].score - 1.0).abs() < 1e-5);
}

#[test]
fn rejects_a_payload_that_does_not_match_the_ids() {
    let bytes = to_bytes(&[basis(0, 1.0)]);
    assert!(matches!(
        VectorMatrix::from_le_bytes(&bytes, ids(&["a", "b"])),
        Err(SearchError::VectorShape { rows: 2, .. })
    ));
    assert!(matches!(
        VectorMatrix::from_le_bytes(&bytes[..bytes.len() - 1], ids(&["a"])),
        Err(SearchError::VectorShape { .. })
    ));
}

#[test]
fn rejects_duplicate_ids() {
    let bytes = to_bytes(&[basis(0, 1.0), basis(1, 1.0)]);
    assert!(matches!(
        VectorMatrix::from_le_bytes(&bytes, ids(&["a", "a"])),
        Err(SearchError::DuplicateId(id)) if id == "a"
    ));
}

#[test]
fn rejects_a_query_of_the_wrong_dimension() {
    let matrix = VectorMatrix::default();
    assert!(matches!(
        matrix.nearest(&[1.0, 0.0], 5),
        Err(SearchError::Dimension { got: 2, .. })
    ));
}

#[test]
fn upsert_replaces_an_existing_row_and_appends_a_new_one() {
    let bytes = to_bytes(&[basis(0, 1.0), basis(1, 1.0)]);
    let mut matrix = VectorMatrix::from_le_bytes(&bytes, ids(&["a", "b"])).unwrap();
    matrix.upsert("a", &basis(2, 4.0)).unwrap();
    matrix.upsert("c", &basis(0, 2.0)).unwrap();
    assert_eq!(matrix.len(), 3);
    let hits = matrix.nearest(&basis(2, 1.0), 1).unwrap();
    assert_eq!(hit_ids(&hits), ["a"]);
    assert!((hits[0].score - 1.0).abs() < 1e-6);
    assert_eq!(hit_ids(&matrix.nearest(&basis(0, 1.0), 1).unwrap()), ["c"]);
}

#[test]
fn remove_drops_a_row_and_keeps_the_rest_findable() {
    let bytes = to_bytes(&[basis(0, 1.0), basis(1, 1.0), basis(2, 1.0)]);
    let mut matrix = VectorMatrix::from_le_bytes(&bytes, ids(&["a", "b", "c"])).unwrap();
    assert!(matrix.remove("a"));
    assert!(!matrix.remove("a"));
    assert_eq!(matrix.len(), 2);
    assert_eq!(hit_ids(&matrix.nearest(&basis(2, 1.0), 1).unwrap()), ["c"]);
    assert_eq!(hit_ids(&matrix.nearest(&basis(1, 1.0), 1).unwrap()), ["b"]);
    matrix.upsert("c", &basis(0, 1.0)).unwrap();
    assert_eq!(hit_ids(&matrix.nearest(&basis(0, 1.0), 1).unwrap()), ["c"]);
}

#[test]
fn an_empty_matrix_or_zero_k_finds_nothing() {
    assert!(VectorMatrix::default()
        .nearest(&basis(0, 1.0), 10)
        .unwrap()
        .is_empty());
    let matrix = VectorMatrix::from_le_bytes(&to_bytes(&[basis(0, 1.0)]), ids(&["a"])).unwrap();
    assert!(matrix.nearest(&basis(0, 1.0), 0).unwrap().is_empty());
}
