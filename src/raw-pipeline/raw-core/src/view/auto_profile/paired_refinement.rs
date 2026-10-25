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

/// Each group's mean error minus its error under the origin LUT. Weighting
/// groups by regression rather than by absolute error stops the solver from
/// trading every other region for the worst one, which selection rejects (#5119).
fn regressions(groups: &[[f64; 3]; 70], origin: &[[f64; 3]; 70]) -> [[f64; 3]; 70] {
    std::array::from_fn(|g| std::array::from_fn(|c| groups[g][c] - origin[g][c]))
}

fn duals(regression: &[[f64; 3]; 70], mass: &[f64; 70]) -> [[f64; 3]; 70] {
    let mut dual = [[0.; 3]; 70];
    for c in 0..3 {
        let maximum = maximum(regression, mass, c);
        for g in (0..70).filter(|&g| mass[g] > 0.) {
            dual[g][c] = (16. * (regression[g][c] / 0.05 - maximum)).exp();
        }
        let sum: f64 = dual.iter().map(|d| d[c]).sum();
        for d in &mut dual {
            d[c] /= sum;
        }
    }
    dual
}

fn maximum(regression: &[[f64; 3]; 70], mass: &[f64; 70], c: usize) -> f64 {
    regression
        .iter()
        .zip(mass)
        .filter(|(_, m)| **m > 0.)
        .map(|(g, _)| g[c] / 0.05)
        .fold(f64::NEG_INFINITY, f64::max)
}

fn objective(regression: &[[f64; 3]; 70], mass: &[f64; 70]) -> f64 {
    (0..3)
        .map(|c| {
            let maximum = maximum(regression, mass, c);
            let sum: f64 = regression
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
    let regions = regions::Regions::new(origin, display);
    let mut artifact = origin.clone();
    let mut best_perceptual = f64::INFINITY;
    let mut error = errors(origin, &rows);
    let origin_groups = group_errors(&rows, &error, &mass);
    let initial_score = objective(&regressions(&origin_groups, &origin_groups), &mass);
    let mut final_score = initial_score;
    for _ in 0..6 {
        let regression = regressions(&group_errors(&rows, &error, &mass), &origin_groups);
        let dual = duals(&regression, &mass);
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
            system.solve(&rhs, start).map(|(delta, _)| delta)
        };
        let deltas: Vec<_> = (0..3).into_par_iter().map(solve_channel).collect();
        let mut candidate = origin.clone();
        for (c, delta) in deltas.into_iter().enumerate() {
            let delta = delta?;
            for i in 0..count {
                candidate.data[i * 3 + c] += delta[i] as f32;
            }
        }
        let before = objective(&regression, &mass);
        // A step must also pass the selection test itself; the regression
        // objective does not model the dE tail or native squared error (#5119).
        let attempt = |fraction: f32| {
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
            regions.constrain(&mut tested, origin, &confidence);
            let tested_error = errors(&tested, &rows);
            let score = objective(
                &regressions(&group_errors(&rows, &tested_error, &mass), &origin_groups),
                &mass,
            );
            if score >= before {
                return None;
            }
            let assessment = assess_against(&tested, native, display, Some(origin));
            (assessment.compatible && assessment.native_bands_preserved).then_some((
                tested,
                tested_error,
                score,
                assessment.display_perceptual,
            ))
        };
        // The full step is usually accepted; only after it fails are the
        // shorter steps worth evaluating together. The first in order wins.
        let accepted = attempt(1.).or_else(|| {
            [0.5, 0.25, 0.125, 0.0625]
                .into_par_iter()
                .map(attempt)
                .collect::<Vec<_>>()
                .into_iter()
                .flatten()
                .next()
        });
        let Some((tested, tested_error, score, perceptual)) = accepted else {
            break;
        };
        // The RGB objective can keep falling while display dE rises again;
        // stop once the selection's perceptual error no longer improves.
        if perceptual >= best_perceptual {
            break;
        }
        artifact = tested;
        error = tested_error;
        final_score = score;
        best_perceptual = perceptual;
    }
    let best = best_perceptual.is_finite().then_some(artifact);
    #[cfg(feature = "stage-dump")]
    if let Some(dir) = crate::stage_dump::dump_dir() {
        if let Ok(file) = std::fs::File::create(dir.join("auto_fine_refinement.json")) {
            let _ = serde_json::to_writer_pretty(
                file,
                &serde_json::json!({"selected":best.is_some(),"training_rows":rows.len(),"initial_objective":initial_score,"final_objective":final_score,"origin_artifact":&origin.data,"selected_artifact":best.as_ref().map(|lut|&lut.data)}),
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
        let regression = regressions(&groups, &[[0.; 3]; 70]);
        assert!((objective(&regression, &mass) - 3. * (3.8 + 2f64.ln() / 16.)).abs() < 1e-12);
    }
    #[test]
    fn groups_are_weighted_by_regression_from_origin_not_by_absolute_error() {
        let mut mass = [0.; 70];
        mass[0] = 1.;
        mass[6] = 1.;
        let mut origin = [[0.; 3]; 70];
        origin[0] = [0.5; 3];
        origin[6] = [0.05; 3];
        let at_origin = duals(&regressions(&origin, &origin), &mass);
        assert_eq!(at_origin[0], [0.5; 3]);
        assert_eq!(at_origin[6], [0.5; 3]);
        let mut current = origin;
        current[6] = [0.1; 3];
        let dual = duals(&regressions(&current, &origin), &mass);
        assert!(dual[6].iter().all(|&d| d > 0.99));
    }
    fn mix(i: usize) -> f32 {
        let x = (i as u64 + 1).wrapping_mul(0x9e3779b97f4a7c15);
        ((x ^ (x >> 29)).wrapping_mul(0xbf58476d1ce4e5b9) >> 40) as f32 / (1u64 << 24) as f32
    }
    fn observation(i: usize, region: usize, lut: &ColorLut) -> Observation {
        let unit = [mix(3 * i), mix(3 * i + 1), mix(3 * i + 2)];
        // Region 0 holds saturated reds rendered far too green; every region
        // shares a slight blue cast and the LUT nodes around the reds.
        let rgb = if region == 0 {
            [
                0.7 + 0.25 * unit[0],
                0.05 + 0.25 * unit[1],
                0.05 + 0.25 * unit[2],
            ]
        } else {
            unit.map(|v| 0.05 + 0.9 * v)
        };
        let artifact_weights: Vec<_> = super::super::corners_at(rgb, lut.size)
            .into_iter()
            .filter(|&(_, w)| w > 0.)
            .collect();
        let baseline = std::array::from_fn(|c| {
            artifact_weights
                .iter()
                .map(|&(j, w)| w * f64::from(lut.data[j * 3 + c]))
                .sum()
        });
        let green = if region == 0 { 0.6 } else { 0.98 };
        Observation {
            weights: vec![],
            artifact_weights,
            source: [0.; 3],
            target: [
                f64::from(rgb[0]) * 0.97,
                f64::from(rgb[1]) * green,
                f64::from(rgb[2]) * 0.96,
            ],
            baseline,
            population: 1,
            validation: i % 4 == 0,
            in_bias_region: true,
            region,
        }
    }
    #[test]
    fn a_strong_local_cast_beside_a_mild_global_one_is_refined_into_a_selectable_lut() {
        let origin = ColorLut::identity(9);
        let native: Vec<_> = (0..4096)
            .map(|i| observation(i, usize::from(i % 16 != 0), &origin))
            .collect();
        let display: Vec<_> = (0..64 * 64)
            .map(|i| observation(100_000 + i, i % 64, &origin))
            .collect();
        let refined = refine(&origin, &native, &display).expect("the red cast is refined");
        let assessment = assess_against(&refined, &native, &display, Some(&origin));
        assert!(assessment.compatible && assessment.native_bands_preserved);
    }
    #[test]
    fn insufficient_training_cannot_replace_an_existing_lut() {
        assert!(refine(&ColorLut::identity(3), &[], &[]).is_none());
    }
}
