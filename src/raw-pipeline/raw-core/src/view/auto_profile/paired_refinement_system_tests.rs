use super::*;

const PRODUCT_CEILING: usize = 114;
const TERMS_CEILING: usize = 40_512;

#[test]

fn matrix_free_solution_matches_its_independent_normal_equation_residual() {
    let row = Observation {
        weights: vec![],
        artifact_weights: vec![(1, 0.25), (2, 0.75)],
        source: [0.; 3],
        target: [0.; 3],
        baseline: [0.; 3],
        population: 1,
        validation: false,
        in_bias_region: true,
        region: 0,
    };
    let rows = [TrainingRow {
        row: &row,
        groups: [0, 1],
        count: 2,
    }];
    let weights = [2.];
    let edges = edges(2);
    let pattern = Pattern::new(&rows, 2, &edges);
    let system = System::new(&pattern, &weights, 2);
    let rhs = vec![0., 0.5, 1.5, 0., 0., 0., 0., 0.];
    let (solved, _) = system.solve(&rhs, vec![0.; 8]).unwrap();
    let mut residual: Vec<_> = solved.iter().map(|v| v * system.ridge).collect();
    let predicted = 0.25 * solved[1] + 0.75 * solved[2];
    residual[1] += 0.5 * predicted;
    residual[2] += 1.5 * predicted;
    for &(i, j) in &edges {
        let delta = system.lambda * (solved[i] - solved[j]);
        residual[i] += delta;
        residual[j] -= delta;
    }
    residual[0] = solved[0];
    residual[7] = solved[7];
    assert_eq!(solved[0], 0.);
    assert_eq!(solved[7], 0.);
    assert!(residual.iter().zip(rhs).all(|(a, b)| (a - b).abs() < 1e-6));
}

fn training(observations: &[Observation]) -> Vec<TrainingRow<'_>> {
    observations
        .iter()
        .map(|row| TrainingRow {
            row,
            groups: [0, 1],
            count: 2,
        })
        .collect()
}

fn synthetic_rows(count: usize, size: usize) -> Vec<Observation> {
    (0..count)
        .map(|i| {
            let mut artifact_weights: Vec<(usize, f64)> = Vec::new();
            for pixel in 0..4 {
                let seed = ((i * 4 + pixel) as u64).wrapping_mul(0x9e37_79b9_7f4a_7c15);
                let cluster = (i % 24) as f32 / 23.;
                let rgb: [f32; 3] = std::array::from_fn(|c| {
                    let jitter = ((seed >> (13 + 17 * c)) % 1000) as f32 / 999. - 0.5;
                    (cluster * [1., 0.8, 0.6][c] + 0.08 * jitter).clamp(0., 1.)
                });
                for (node, w) in super::super::super::corners_at(rgb, size) {
                    match artifact_weights.iter_mut().find(|(n, _)| *n == node) {
                        Some(entry) => entry.1 += w / 4.,
                        None => artifact_weights.push((node, w / 4.)),
                    }
                }
            }
            Observation {
                weights: vec![],
                artifact_weights,
                source: [0.; 3],
                target: [((i * 37) % 101) as f64 / 100.; 3],
                baseline: [0.; 3],
                population: 1,
                validation: false,
                in_bias_region: true,
                region: 0,
            }
        })
        .collect()
}

// Pure IEEE +,*,/ with fixed reduction order: the counts are identical on
// every platform, so any solver change that inflates them fails here.

#[test]

fn solver_work_on_a_synthetic_observation_set_stays_pinned() {
    let size = 17;
    let observations = synthetic_rows(20_000, size);
    let rows = training(&observations);
    let weights: Vec<_> = (0..rows.len())
        .map(|i| 1. + (i % 7) as f64 * 0.25)
        .collect();
    let edges = edges(size);
    let pattern = Pattern::new(&rows, size, &edges);
    assert!(pattern.normal.is_some());
    let system = System::new(&pattern, &weights, size);
    let residuals: Vec<_> = observations.iter().map(|r| r.target[0] - 0.5).collect();
    let mut rhs = vec![0.; size.pow(3)];
    pattern.scatter(system.coefficients(), &residuals, &mut rhs);
    let (_, products) = system.solve(&rhs, vec![0.; size.pow(3)]).unwrap();
    let row_walk_terms = 2 * pattern.row_nodes.len();
    eprintln!(
        "products {products}, terms per product {}, row-walk terms {row_walk_terms}",
        system.product_terms()
    );
    assert!(products <= PRODUCT_CEILING);
    assert!(system.product_terms() <= TERMS_CEILING);
    assert!(system.product_terms() < row_walk_terms + edges.len() * 2 + size.pow(3));
}

#[test]

fn rows_too_wide_to_assemble_keep_the_row_walk_without_a_normal_matrix() {
    let size: usize = 17;
    let count = size.pow(3);
    let observations: Vec<_> = (0..400)
        .map(|i| Observation {
            artifact_weights: (0..300)
                .map(|k| ((i * 7 + k * 13) % count, 1. / 300.))
                .collect(),
            ..synthetic_rows(1, size).remove(0)
        })
        .collect();
    let rows = training(&observations);
    let edges = edges(size);
    let pattern = Pattern::new(&rows, size, &edges);
    assert!(pattern.normal.is_none());
    let system = System::new(&pattern, &vec![1.; rows.len()], size);
    assert!(system.normal.is_none());
    let rhs: Vec<_> = (0..count).map(|i| (i % 11) as f64 * 1e-3).collect();
    assert!(system.solve(&rhs, vec![0.; count]).is_some());
}

#[test]

fn row_walk_and_assembled_products_agree() {
    let size = 9;
    let observations = synthetic_rows(2000, size);
    let rows = training(&observations);
    let edges = edges(size);
    let weights: Vec<_> = (0..rows.len()).map(|i| 1. + (i % 5) as f64 * 0.5).collect();
    let assembled = Pattern::new(&rows, size, &edges);
    assert!(assembled.normal.is_some());
    let walked = Pattern {
        normal: None,
        ..Pattern::new(&rows, size, &edges)
    };
    let values: Vec<_> = (0..size.pow(3)).map(|i| (i % 13) as f64 / 13.).collect();
    let product = |pattern: &Pattern| {
        let system = System::new(pattern, &weights, size);
        let mut per_row = vec![0.; rows.len()];
        let mut result = vec![0.; values.len()];
        system.multiply(&values, &mut per_row, &mut result);
        result
    };
    let (a, b) = (product(&assembled), product(&walked));
    assert!(a
        .iter()
        .zip(&b)
        .all(|(x, y)| (x - y).abs() <= 1e-12 * x.abs().max(1.)));
}

#[test]

fn rows_within_the_work_budget_but_too_many_distinct_pairs_keep_the_row_walk() {
    let size: usize = 33;
    let count = size.pow(3);
    let observations: Vec<_> = (0..200)
        .map(|i| Observation {
            artifact_weights: (0..40)
                .map(|k| ((i * 40 + k) * 7919 % count, 1. / 40.))
                .collect(),
            ..synthetic_rows(1, size).remove(0)
        })
        .collect();
    let rows = training(&observations);
    let pattern = Pattern::new(&rows, size, &edges(size));
    assert!(pattern.normal.is_none());
}
