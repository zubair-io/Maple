use super::*;

fn observations(regional: bool) -> Vec<Observation> {
    let mut rows = Vec::new();
    for region in 0..64 {
        for i in 0..64 {
            let (source, target, baseline) = if regional && region == 0 {
                if i % 2 == 0 {
                    (0.05, 0.05, 0.14)
                } else {
                    (0.79, 0.9, 0.89)
                }
            } else if regional {
                (0.5, 0.5, 0.52)
            } else if i % 16 == 0 {
                (0.79, 0.9, 0.81)
            } else {
                (0.1, 0.1, 0.19)
            };
            rows.push(Observation {
                weights: corners([source; 3]).to_vec(),
                artifact_weights: corners([source; 3]).to_vec(),
                source: [source as f64; 3],
                target: [target; 3],
                baseline: [baseline; 3],
                population: 1,
                validation: true,
                in_bias_region: true,
                region,
            });
        }
    }
    rows
}

fn assert_perceptual_safeguards_allow(rows: &[Observation]) {
    let mut de = [Vec::new(), Vec::new()];
    for region in 0..64 {
        let mut regional = [0.; 2];
        for row in rows.iter().filter(|r| r.region == region) {
            for (i, output) in [row.source, row.baseline].into_iter().enumerate() {
                let error = ciede2000(
                    lab(output.map(|v| v as f32)),
                    lab(row.target.map(|v| v as f32)),
                );
                de[i].push(error);
                regional[i] += error;
            }
        }
        assert!(regional[0] < regional[1]);
    }
    for values in &mut de {
        values.sort_by(f32::total_cmp);
    }
    let index = rows.len() * 95 / 100;
    assert!(de[0][index] <= de[1][index]);
    for c in 0..3 {
        let error = |baseline: bool, squared: bool| {
            rows.iter()
                .map(|r| {
                    let e =
                        ((if baseline { r.baseline[c] } else { r.source[c] }) - r.target[c]).abs();
                    if squared {
                        e * e
                    } else {
                        e
                    }
                })
                .sum::<f64>()
        };
        assert!(error(false, false) < error(true, false));
        assert!(error(false, true) < error(true, true));
    }
}

#[test]
fn rgb_tail_failure_is_rejected_even_when_perceptual_and_native_errors_improve() {
    let rows = observations(false);
    assert_perceptual_safeguards_allow(&rows);
    assert!(!prefer(&ColorLut::identity(GRID), &rows, &rows));
}

#[test]
fn local_rgb_failure_is_rejected_even_when_perceptual_and_native_errors_improve() {
    let rows = observations(true);
    assert_perceptual_safeguards_allow(&rows);
    assert!(!prefer(&ColorLut::identity(GRID), &rows, &rows));
}

#[test]
fn an_existing_rgb_tail_failure_does_not_discard_otherwise_safer_corrections() {
    let mut rows = observations(false);
    for row in &mut rows {
        if row.target[0] > 0.5 {
            row.source = [0.77; 3];
            row.artifact_weights = corners([0.77; 3]).to_vec();
        } else {
            row.baseline = [0.21; 3];
        }
    }
    assert_perceptual_safeguards_allow(&rows);
    assert!(prefer(&ColorLut::identity(GRID), &rows, &rows));
}

#[test]
fn sampled_native_band_limits_keep_the_first_safe_half_step_instead_of_refining_to_the_boundary() {
    let current = ColorLut::identity(GRID);
    let mut proposed = current.clone();
    for node in proposed.data.chunks_exact_mut(3) {
        for value in node {
            *value = (*value - if *value <= 0.25 { 0.02 } else { 0.06 }).max(0.);
        }
    }
    let mut native = Vec::new();
    let mut display = Vec::new();
    for region in 0..64 {
        for i in 0..64 {
            let (source, target) = if i % 16 == 0 {
                (0.625, 0.665)
            } else {
                (0.25, 0.22)
            };
            native.push(Observation {
                weights: corners([source; 3]).to_vec(),
                artifact_weights: corners([source; 3]).to_vec(),
                source: [source as f64; 3],
                target: [target; 3],
                baseline: [source as f64; 3],
                population: 1,
                validation: true,
                in_bias_region: true,
                region,
            });
            display.push(Observation {
                weights: corners([0.25; 3]).to_vec(),
                artifact_weights: corners([0.25; 3]).to_vec(),
                source: [0.25; 3],
                target: [0.22; 3],
                baseline: [0.25; 3],
                population: 1,
                validation: true,
                in_bias_region: true,
                region,
            });
        }
    }
    let full = assess(&proposed, &native, &display);
    assert!(full.compatible);
    assert!(!full.native_bands_preserved);
    let result = select_step(&proposed, &current, &native, &display).unwrap();
    assert!(prefer(&result, &native, &display));
    assert!((result.sample([0.25; 3])[0] - 0.2475).abs() < 1e-7);
}

#[test]
fn new_fit_must_beat_the_existing_paired_artifact() {
    let rows: Vec<_> = observations(false)
        .into_iter()
        .map(|mut row| {
            row.source = [0.5; 3];
            row.target = [0.5; 3];
            row.baseline = [0.8; 3];
            row.artifact_weights = corners([0.5; 3]).to_vec();
            row
        })
        .collect();
    let existing = ColorLut::identity(GRID);
    let mut candidate = existing.clone();
    for value in &mut candidate.data {
        *value += 0.01;
    }
    assert!(assess(&candidate, &rows, &rows).compatible);
    assert!(!assess_against(&candidate, &rows, &rows, Some(&existing)).compatible);
}
