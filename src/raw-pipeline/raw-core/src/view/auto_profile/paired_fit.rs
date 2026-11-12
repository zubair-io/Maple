//! Regularized paired-pixel Auto candidate, qualified separately under #5000.
use super::{
    lut::ColorLut,
    paired_observations::{self, Observation},
    preview::ExtractedPreview,
};
use crate::image::ExifOrientation;
#[cfg(test)]
use crate::view::acr_fit::model::ciede2000;
#[path = "paired_projection.rs"]
mod projection;
use projection::constrain_to_prior;
#[path = "paired_assess.rs"]
mod assessment;
#[path = "paired_bands.rs"]
mod bands;
#[path = "paired_correspondence.rs"]
mod correspondence;
#[path = "paired_refinement.rs"]
mod refinement;
use assessment::{
    assess, assess_against, assess_with, lab, predict, prefer, prefer_with, Assessment, Baseline,
};
#[path = "paired_step.rs"]
mod step;
use step::select_step;
#[path = "paired_population.rs"]
mod population;
#[path = "paired_quality_budget.rs"]
mod quality_budget;

pub(super) const GRID: usize = 9;
pub(super) const CELLS: usize = GRID * GRID * GRID;
// Allow small regional sampling/quantization drift; image acceptance budgets stay fixed.
const REGIONAL_SELECTION_MARGIN_DE: f64 = 0.1;

pub(super) fn corners(rgb: [f32; 3]) -> [(usize, f64); 4] {
    corners_at(rgb, GRID)
}

pub(super) fn corners_at(rgb: [f32; 3], size: usize) -> [(usize, f64); 4] {
    let mut lo = [0; 3];
    let mut f = [0.; 3];
    for c in 0..3 {
        let x = f64::from(rgb[c].clamp(0., 1.)) * (size - 1) as f64;
        lo[c] = (x.floor() as usize).min(size - 2);
        f[c] = x - lo[c] as f64;
    }
    let mut axes = [0, 1, 2];
    axes.sort_by(|&a, &b| f[b].total_cmp(&f[a]));
    let stride = [1, size, size * size];
    let start = (lo[2] * size + lo[1]) * size + lo[0];
    [
        (start, 1. - f[axes[0]]),
        (start + stride[axes[0]], f[axes[0]] - f[axes[1]]),
        (
            start + stride[axes[0]] + stride[axes[1]],
            f[axes[1]] - f[axes[2]],
        ),
        (start + 1 + size + size * size, f[axes[2]]),
    ]
}

fn dot(a: &[f64], b: &[f64]) -> f64 {
    a.iter().zip(b).map(|(u, v)| u * v).sum()
}
fn normal_rows(a: &[f64]) -> Vec<Vec<(usize, f64)>> {
    // Footprint interpolation and adjacent-node regularization leave most
    // entries zero. Keep column order so dropping zeros preserves summation.
    a.chunks_exact(CELLS)
        .map(|row| {
            row.iter()
                .copied()
                .enumerate()
                .filter(|(_, v)| *v != 0.)
                .collect()
        })
        .collect()
}

fn multiply(rows: &[Vec<(usize, f64)>], x: &[f64]) -> Vec<f64> {
    rows.iter()
        .map(|row| row.iter().map(|&(i, v)| v * x[i]).sum())
        .collect()
}

fn solve(a: &[f64], b: &[f64]) -> Vec<f64> {
    let rows = normal_rows(a);
    let mut x = vec![0.; CELLS];
    let mut r = b.to_vec();
    let inverse: Vec<_> = (0..CELLS).map(|i| 1. / a[i * CELLS + i]).collect();
    let mut z: Vec<_> = r.iter().zip(&inverse).map(|(v, d)| v * d).collect();
    let mut p = z.clone();
    let mut rz = dot(&r, &z);
    let initial = dot(b, b);
    if initial < 1e-25 {
        return x;
    }
    for _ in 0..256 {
        let ap = multiply(&rows, &p);
        let denominator = dot(&p, &ap);
        if denominator <= 0. {
            break;
        }
        let alpha = rz / denominator;
        for i in 0..CELLS {
            x[i] += alpha * p[i];
            r[i] -= alpha * ap[i];
        }
        if dot(&r, &r) < initial * 1e-14 {
            break;
        }
        for i in 0..CELLS {
            z[i] = r[i] * inverse[i];
        }
        let next = dot(&r, &z);
        let beta = next / rz;
        for i in 0..CELLS {
            p[i] = z[i] + beta * p[i];
        }
        rz = next;
    }
    x
}

fn solve_observations(
    observations: &[Observation],
    prior: &ColorLut,
) -> Option<(ColorLut, ColorLut)> {
    let count = observations.iter().filter(|row| !row.validation).count();
    if count < 128 || prior.size < 2 {
        return None;
    }
    let population: f64 = observations
        .iter()
        .filter(|r| !r.validation)
        .map(|r| r.population as f64)
        .sum();
    if population <= 0. {
        return None;
    }
    let mut a = vec![0.; CELLS * CELLS];
    let mut b = vec![[0.; 3]; CELLS];
    let mut confidence = vec![0.; prior.size.pow(3)];
    for row in observations.iter().filter(|row| !row.validation) {
        for &(j, w) in &row.artifact_weights {
            confidence[j] += row.population as f64 * w * w;
        }
        for &(j, u) in &row.weights {
            for &(k, v) in &row.weights {
                a[j * CELLS + k] += row.population as f64 * u * v;
            }
            for c in 0..3 {
                b[j][c] += row.population as f64 * u * (row.target[c] - row.baseline[c]);
            }
        }
    }
    for v in &mut a {
        *v /= population;
    }
    for row in &mut b {
        for v in row {
            *v /= population;
        }
    }
    for i in 0..CELLS {
        a[i * CELLS + i] += 1e-8;
        let xyz = [i % GRID, (i / GRID) % GRID, i / (GRID * GRID)];
        for (axis, step) in [1, GRID, GRID * GRID].into_iter().enumerate() {
            if xyz[axis] + 1 < GRID {
                let j = i + step;
                let lambda = 1e-5;
                a[i * CELLS + i] += lambda;
                a[j * CELLS + j] += lambda;
                a[i * CELLS + j] -= lambda;
                a[j * CELLS + i] -= lambda;
            }
        }
    }
    let mut coarse = ColorLut {
        size: GRID,
        data: vec![0.; CELLS * 3],
    };
    for c in 0..3 {
        let target: Vec<_> = b.iter().map(|row| row[c]).collect();
        let delta = solve(&a, &target);
        for i in 0..CELLS {
            coarse.data[i * 3 + c] = delta[i] as f32;
        }
    }
    let mut result = prior.clone();
    let coordinates = ColorLut::identity(prior.size);
    for (node, rgb) in result
        .data
        .chunks_exact_mut(3)
        .zip(coordinates.data.chunks_exact(3))
    {
        let delta = coarse.sample([rgb[0], rgb[1], rgb[2]]);
        for c in 0..3 {
            node[c] += delta[c];
        }
    }
    for weight in &mut confidence {
        *weight = *weight / population + 1e-8;
    }
    constrain_to_prior(&mut result.data, prior, &confidence);
    Some((result, coarse))
}

pub(super) fn fit(
    pixels: &[f32],
    width: usize,
    height: usize,
    orientation: ExifOrientation,
    preview: &ExtractedPreview,
    current: &ColorLut,
    size: usize,
) -> Option<ColorLut> {
    if current.size != size {
        return None;
    }
    // The row builds, and the original and registered fits, only read the
    // developed pixels; run them side by side (#5172).
    let ((observations, display), geometry) = rayon::join(
        || {
            rayon::join(
                || {
                    crate::pipeline::stage("pf_native_rows", || {
                        paired_observations::build(
                            pixels,
                            width,
                            height,
                            orientation,
                            preview,
                            current,
                        )
                    })
                },
                || {
                    if preview.image.width().max(preview.image.height()) > 1024 {
                        crate::pipeline::stage("pf_display_rows", || {
                            paired_observations::build_display(
                                pixels,
                                width,
                                height,
                                orientation,
                                preview,
                                current,
                            )
                        })
                        .map(Some)
                    } else {
                        Some(None)
                    }
                },
            )
        },
        || {
            crate::pipeline::stage("pf_geometry_rows", || {
                paired_observations::build_geometry(
                    pixels,
                    width,
                    height,
                    orientation,
                    preview,
                    current,
                )
            })
        },
    );
    let (observations, display, geometry) = (observations?, display?, geometry?);
    let native_rows = observations.rows.as_slice();
    let display_rows = display
        .as_ref()
        .map(|s| s.rows.as_slice())
        .unwrap_or(native_rows);
    let (original, registered) = rayon::join(
        || {
            let solution = crate::pipeline::stage("pf_solve_original", || {
                solve_observations(display_rows, current)
            })?;
            let choice = crate::pipeline::stage("pf_step_original", || {
                select_step(&solution.0, current, native_rows, display_rows)
            });
            Some((solution, choice))
        },
        || {
            let registration = crate::pipeline::stage("pf_register", || {
                super::fit_registration::estimate(&geometry)
            });
            let aligned = crate::pipeline::stage("pf_aligned_rows", || {
                registration.as_ref().and_then(|r| {
                    paired_observations::build_aligned(
                        pixels,
                        width,
                        height,
                        orientation,
                        preview,
                        current,
                        r.warp,
                    )
                })
            });
            let matched_native = crate::pipeline::stage("pf_matched_rows", || {
                registration.as_ref().and_then(|r| {
                    if !correspondence::supported_both_directions(r.warp) {
                        return None;
                    }
                    let matched = paired_observations::build_native_aligned(
                        pixels,
                        width,
                        height,
                        orientation,
                        preview,
                        current,
                        r.warp,
                    )?;
                    (correspondence::retains_population(&observations, &matched)
                        && aligned.as_ref().is_some_and(|set| {
                            correspondence::retains_population(
                                display.as_ref().unwrap_or(&observations),
                                set,
                            )
                        }))
                    .then_some(matched)
                })
            });
            let matched_native_rows = matched_native.as_ref().map_or(native_rows, |s| &s.rows);
            let matched_display_rows = if matched_native.is_some() {
                aligned.as_ref().map_or(display_rows, |s| &s.rows)
            } else {
                display_rows
            };
            let solution = crate::pipeline::stage("pf_solve_aligned", || {
                aligned
                    .as_ref()
                    .and_then(|set| solve_observations(&set.rows, current))
            });
            let choice = crate::pipeline::stage("pf_step_aligned", || {
                solution.as_ref().and_then(|solution| {
                    select_step(
                        &solution.0,
                        current,
                        matched_native_rows,
                        matched_display_rows,
                    )
                })
            });
            (registration, aligned, matched_native, solution, choice)
        },
    );
    let (original_solution, original_choice) = original?;
    let (registration, aligned, matched_native, aligned_solution, aligned_choice) = registered;
    let matched_native_rows = matched_native.as_ref().map_or(native_rows, |s| &s.rows);
    let matched_display_rows = if matched_native.is_some() {
        aligned.as_ref().map_or(display_rows, |s| &s.rows)
    } else {
        display_rows
    };
    let use_registered = match (&aligned_choice, &original_choice) {
        (Some(candidate), Some(existing)) => {
            let assessment = assess_against(
                candidate,
                matched_native_rows,
                matched_display_rows,
                Some(existing),
            );
            assessment.compatible && assessment.native_bands_preserved
        }
        (Some(_), None) => true,
        _ => false,
    };
    let _selected_solution = if use_registered {
        aligned_solution.as_ref()?
    } else {
        &original_solution
    };
    let chosen = if use_registered {
        aligned_choice
    } else {
        original_choice
    };
    // Refine on the correspondence the selected fit was accepted on; aligned
    // rows the guards rejected must not reshape the fallback (#5000).
    let (selected_native, selected_display) = if use_registered {
        (matched_native_rows, matched_display_rows)
    } else {
        (native_rows, display_rows)
    };
    #[cfg(feature = "stage-dump")]
    if let Some(dir) = crate::stage_dump::dump_dir() {
        if let Ok(file) = std::fs::File::create(dir.join("auto_fit_registration.json")) {
            let _ = serde_json::to_writer_pretty(
                std::io::BufWriter::new(file),
                &serde_json::json!({"registration":registration,"matched_validation":matched_native.is_some(),"selected_fit":if chosen.is_none() {"camera-calibration"} else if use_registered {"registered-paired"} else {"original-paired"}}),
            );
        }
    }
    #[cfg(feature = "stage-dump")]
    if let Some(dir) = crate::stage_dump::dump_dir() {
        let (result, coarse) = _selected_solution;
        let _ = select_step(result, current, selected_native, selected_display);
        #[derive(serde::Serialize)]
        struct Snapshot<'a> {
            width: usize,
            height: usize,
            grid: usize,
            native: &'a [Observation],
            display: Option<&'a [Observation]>,
            aligned: Option<&'a [Observation]>,
            refinement_native: &'a [Observation],
            refinement_display: &'a [Observation],
            prior_size: usize,
            prior: &'a [f32],
            coarse: &'a [f32],
            artifact: &'a [f32],
        }
        let snapshot = Snapshot {
            width,
            height,
            grid: GRID,
            native: selected_native,
            display: Some(selected_display),
            aligned: aligned.as_ref().map(|s| s.rows.as_slice()),
            refinement_native: selected_native,
            refinement_display: selected_display,
            prior_size: current.size,
            prior: &current.data,
            coarse: &coarse.data,
            artifact: &result.data,
        };
        if let Ok(file) = std::fs::File::create(dir.join("auto_fit_observations.json")) {
            let _ = serde_json::to_writer(std::io::BufWriter::new(file), &snapshot);
        }
    }
    let base = chosen?;
    crate::pipeline::stage("pf_refine", || {
        refinement::refine(&base, selected_native, selected_display)
    })
    .or(Some(base))
}

#[cfg(test)]
#[path = "paired_fit_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "paired_quality_tests.rs"]
mod quality_tests;

#[cfg(test)]
#[path = "paired_population_tests.rs"]
mod population_tests;
