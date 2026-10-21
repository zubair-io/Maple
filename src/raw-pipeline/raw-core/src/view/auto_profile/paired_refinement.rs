use super::{assess_against, ColorLut, Observation};
use rayon::prelude::*;
#[path = "paired_refinement_projection.rs"]
mod projection;
#[path = "paired_refinement_regions.rs"]
mod regions;
#[path = "paired_refinement_system.rs"]
mod system;

struct TrainingRow<'a> {
    row: &'a Observation,
    groups: [usize; 2],
    count: usize,
}

fn training<'a>(native: &'a [Observation], display: &'a [Observation]) -> Vec<TrainingRow<'a>> {
    let mut result = Vec::new();
    for row in native.iter().filter(|r| !r.validation) {
        let luma = row.target[0] * 0.2126 + row.target[1] * 0.7152 + row.target[2] * 0.0722;
        let band = [0.1, 0.25, 0.5, 0.75]
            .iter()
            .filter(|&&edge| luma >= edge)
            .count();
        result.push(TrainingRow {
            row,
            groups: [0, band + 1],
            count: 2,
        });
    }
    for row in display.iter().filter(|r| !r.validation) {
        result.push(TrainingRow {
            row,
            groups: [6 + row.region, 0],
            count: 1,
        });
    }
    result
}

fn errors(lut: &ColorLut, rows: &[TrainingRow<'_>]) -> Vec<[f64; 3]> {
    rows.par_iter()
        .map(|r| {
            let output = system::prediction(&lut.data, r.row);
            std::array::from_fn(|c| output[c] - r.row.target[c])
        })
        .collect()
}

fn group_errors(rows: &[TrainingRow<'_>], error: &[[f64; 3]], mass: &[f64; 70]) -> [[f64; 3]; 70] {
    let mut result = [[0.; 3]; 70];
    for (entry, e) in rows.iter().zip(error) {
        for &group in &entry.groups[..entry.count] {
            for c in 0..3 {
                result[group][c] += entry.row.population as f64 * e[c].abs() / mass[group];
            }
        }
    }
    result
}

fn objective(groups: &[[f64; 3]; 70], mass: &[f64; 70]) -> f64 {
    (0..3)
        .map(|c| {
            let maximum = groups
                .iter()
                .zip(mass)
                .filter(|(_, m)| **m > 0.)
                .map(|(g, _)| g[c] / 0.05)
                .fold(0., f64::max);
            let sum: f64 = groups
                .iter()
                .zip(mass)
                .filter(|(_, m)| **m > 0.)
                .map(|(g, _)| (16. * (g[c] / 0.05 - maximum)).exp())
                .sum();
            maximum + sum.ln() / 16.
        })
        .sum()
}

pub(super) fn refine(
    origin: &ColorLut,
    native: &[Observation],
    display: &[Observation],
) -> Option<ColorLut> {
    if origin.size < 2 {
        return None;
    }
    let rows = training(native, display);
    if rows.len() < 128 {
        return None;
    }
    let count = origin.size.pow(3);
    let edges = system::edges(origin.size);
    let mut mass = [0.; 70];
    let mut confidence = vec![1e-8; count];
    let mut total = 0.;
    for entry in &rows {
        total += entry.row.population as f64;
        for &g in &entry.groups[..entry.count] {
            mass[g] += entry.row.population as f64;
        }
        for &(i, w) in &entry.row.artifact_weights {
            confidence[i] += entry.row.population as f64 * w * w;
        }
    }
    for value in &mut confidence {
        *value = *value / total + 1e-8;
    }
    let baseline: Vec<_> = rows
        .par_iter()
        .map(|r| system::prediction(&origin.data, r.row))
        .collect();
    let pattern = system::Pattern::new(&rows, origin.size, &edges);
    let mut artifact = origin.clone();
    let mut best = None;
    let mut error = errors(origin, &rows);
    let initial_score = objective(&group_errors(&rows, &error, &mass), &mass);
    let mut final_score = initial_score;
    for _ in 0..6 {
        let groups = group_errors(&rows, &error, &mass);
        let mut dual = [[0.; 3]; 70];
        for c in 0..3 {
            let maximum = groups
                .iter()
                .zip(mass)
                .filter(|(_, m)| *m > 0.)
                .map(|(g, _)| g[c] / 0.05)
                .fold(0., f64::max);
            let mut sum = 0.;
            for g in 0..70 {
                if mass[g] > 0. {
                    dual[g][c] = (16. * (groups[g][c] / 0.05 - maximum)).exp();
                    sum += dual[g][c];
                }
            }
            for g in 0..70 {
                dual[g][c] /= sum;
            }
        }
        let solve_channel = |c: usize| {
            let weights: Vec<_> = rows
                .iter()
                .zip(&error)
                .map(|(entry, e)| {
                    let group_weight: f64 = entry.groups[..entry.count]
                        .iter()
                        .map(|&g| dual[g][c] / 0.05 * entry.row.population as f64 / mass[g])
                        .sum();
                    group_weight / (e[c] * e[c] + (1f64 / 255.).powi(2)).sqrt()
                })
                .collect();
            let system = system::System::new(&pattern, &weights, origin.size);
            let residuals: Vec<_> = rows
                .iter()
                .zip(&baseline)
                .map(|(entry, base)| entry.row.target[c] - base[c])
                .collect();
            let mut rhs = vec![0.; count];
            pattern.scatter(system.coefficients(), &residuals, &mut rhs);
            let start = (0..count)
                .map(|i| f64::from(artifact.data[i * 3 + c] - origin.data[i * 3 + c]))
                .collect();
            system.solve(&rhs, start)
        };
        let deltas: Vec<_> = (0..3).into_par_iter().map(solve_channel).collect();
        let mut candidate = origin.clone();
        for (c, delta) in deltas.into_iter().enumerate() {
            let delta = delta?;
            for i in 0..count {
                candidate.data[i * 3 + c] += delta[i] as f32;
            }
        }
        let before = objective(&groups, &mass);
        let mut accepted = None;
        for fraction in [1., 0.5, 0.25, 0.125, 0.0625] {
            let mut tested = artifact.clone();
            for ((v, &a), &b) in tested
                .data
                .iter_mut()
                .zip(&artifact.data)
                .zip(&candidate.data)
            {
                *v = a + fraction * (b - a);
            }
            projection::constrain_to_prior(&mut tested.data, origin, &confidence);
            regions::constrain(&mut tested, origin, display, &confidence);
            let tested_error = errors(&tested, &rows);
            let score = objective(&group_errors(&rows, &tested_error, &mass), &mass);
            if score < before {
                accepted = Some((tested, tested_error, score));
                break;
            }
        }
        let Some((tested, tested_error, score)) = accepted else {
            break;
        };
        artifact = tested;
        error = tested_error;
        final_score = score;
        let assessment = assess_against(&artifact, native, display, Some(origin));
        if assessment.compatible && assessment.native_bands_preserved {
            best = Some(artifact.clone());
        }
    }
    #[cfg(feature = "stage-dump")]
    if let Some(dir) = crate::stage_dump::dump_dir() {
        if let Ok(file) = std::fs::File::create(dir.join("auto_fine_refinement.json")) {
            let _ = serde_json::to_writer_pretty(
                file,
                &serde_json::json!({"selected":best.is_some(),"training_rows":rows.len(),"initial_objective":initial_score,"final_objective":final_score,"origin_artifact":&origin.data,"final_artifact":&artifact.data,"selected_artifact":best.as_ref().map(|lut|&lut.data)}),
            );
        }
    }
    best
}

#[cfg(test)]
mod tests {
    use super::*;
    fn row(population: usize, validation: bool) -> Observation {
        Observation {
            weights: vec![],
            artifact_weights: vec![(0, 1.)],
            source: [0.; 3],
            target: [0.2; 3],
            baseline: [0.; 3],
            population,
            validation,
            in_bias_region: true,
            region: 0,
        }
    }
    #[test]
    fn refinement_never_uses_validation_rows_to_fit_group_weights() {
        let rows = [row(1, false), row(999, true)];
        let train = training(&rows, &rows);
        assert_eq!(train.len(), 2);
        assert!(train.iter().all(|r| !r.row.validation));
        assert_eq!(train[0].groups, [0, 2]);
        assert_eq!(train[1].groups[0], 6);
    }
    #[test]
    fn absolute_group_objective_uses_pixel_populations_without_signed_cancellation() {
        let samples = [row(1, false), row(9, false)];
        let train = training(&samples, &[]);
        let mut mass = [0.; 70];
        mass[0] = 10.;
        mass[2] = 10.;
        let error = [[0.1, -0.1, 0.1], [-0.2, 0.2, -0.2]];
        let groups = group_errors(&train, &error, &mass);
        for c in 0..3 {
            assert!((groups[0][c] - 0.19).abs() < 1e-12);
        }
        assert!((objective(&groups, &mass) - 3. * (3.8 + 2f64.ln() / 16.)).abs() < 1e-12);
    }
    #[test]
    fn insufficient_training_cannot_replace_an_existing_lut() {
        assert!(refine(&ColorLut::identity(3), &[], &[]).is_none());
    }
}
