//! Regularized paired-pixel Auto candidate, qualified separately under #5000.
use super::{
    lut::ColorLut,
    paired_observations::{self, Observation},
    preview::ExtractedPreview,
};
use crate::image::ExifOrientation;
use crate::view::{
    acr_fit::model::{ciede2000, srgb_linear_to_lab},
    agx_inverse::srgb_gamma_inv,
};
#[path = "paired_projection.rs"]
mod projection;
use projection::constrain_to_prior;
#[path = "paired_bands.rs"]
mod bands;

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

fn multiply(a: &[f64], x: &[f64]) -> Vec<f64> {
    a.chunks_exact(CELLS)
        .map(|row| row.iter().zip(x).map(|(u, v)| u * v).sum())
        .collect()
}
fn dot(a: &[f64], b: &[f64]) -> f64 {
    a.iter().zip(b).map(|(u, v)| u * v).sum()
}
fn solve(a: &[f64], b: &[f64]) -> Vec<f64> {
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
        let ap = multiply(a, &p);
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
    let mut a = vec![0.; CELLS * CELLS];
    let mut b = vec![[0.; 3]; CELLS];
    let mut confidence = vec![0.; prior.size.pow(3)];
    for row in observations.iter().filter(|row| !row.validation) {
        for &(j, w) in &row.artifact_weights {
            confidence[j] += w * w;
        }
        for &(j, u) in &row.weights {
            for &(k, v) in &row.weights {
                a[j * CELLS + k] += u * v;
            }
            for c in 0..3 {
                b[j][c] += u * (row.target[c] - row.baseline[c]);
            }
        }
    }
    for v in &mut a {
        *v /= count as f64;
    }
    for row in &mut b {
        for v in row {
            *v /= count as f64;
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
        *weight = *weight / count as f64 + 1e-8;
    }
    constrain_to_prior(&mut result.data, prior, &confidence);
    Some((result, coarse))
}

fn lab(rgb: [f32; 3]) -> [f32; 3] {
    srgb_linear_to_lab(rgb.map(srgb_gamma_inv))
}

fn prefer(candidate: &ColorLut, observations: &[Observation], display: &[Observation]) -> bool {
    let mut squared = [[0.; 3]; 2];
    let mut absolute = [[0.; 3]; 2];
    let mut perceptual = [0.; 2];
    let mut tails = [Vec::new(), Vec::new()];
    let mut regional = [[0.; 64]; 2];
    let mut rgb_tails = [Vec::new(), Vec::new()];
    let mut regional_rgb = [[[0.; 3]; 64]; 2];
    let mut counts = [0usize; 64];
    let mut validation_count = 0;
    let mut native_bands = bands::NativeBands::default();
    for row in observations {
        let prediction = std::array::from_fn(|c| {
            row.artifact_weights
                .iter()
                .map(|&(i, w)| w * f64::from(candidate.data[i * 3 + c]))
                .sum::<f64>()
        });
        native_bands.observe(row.target, row.in_bias_region, [prediction, row.baseline]);
        if !row.validation {
            continue;
        }
        validation_count += 1;
        for (i, output) in [prediction, row.baseline].into_iter().enumerate() {
            for c in 0..3 {
                let error = output[c] - row.target[c];
                squared[i][c] += error * error;
                absolute[i][c] += error.abs();
            }
        }
    }
    if validation_count < 32 {
        return false;
    }
    for row in display {
        counts[row.region] += 1;
        let prediction = std::array::from_fn(|c| {
            row.artifact_weights
                .iter()
                .map(|&(i, w)| w * f64::from(candidate.data[i * 3 + c]))
                .sum::<f64>()
        });
        let target = lab(row.target.map(|v| v as f32));
        for (i, output) in [prediction, row.baseline].into_iter().enumerate() {
            let error: [f64; 3] = std::array::from_fn(|c| (output[c] - row.target[c]).abs());
            for c in 0..3 {
                regional_rgb[i][row.region][c] += error[c];
            }
            rgb_tails[i].push(error);
            let de = f64::from(ciede2000(lab(output.map(|v| v as f32)), target));
            regional[i][row.region] += de;
            perceptual[i] += de;
            tails[i].push(de);
        }
    }
    if tails[0].len() < 32 {
        return false;
    }
    let index = (tails[0].len() * 95 / 100).min(tails[0].len() - 1);
    let p95: Vec<f64> = tails
        .iter_mut()
        .map(|values| *values.select_nth_unstable_by(index, f64::total_cmp).1)
        .collect();
    let regions_improve = (0..64).all(|r| {
        counts[r] >= 32
            && (regional[0][r] - regional[1][r]) / counts[r] as f64 <= REGIONAL_SELECTION_MARGIN_DE
    });
    // Do not introduce RGB failures while improving perceptual averages (#5000).
    let rgb_regions_preserved = (0..64).all(|r| {
        (0..3).all(|c| {
            regional_rgb[1][r][c] / counts[r].max(1) as f64 > 0.05
                || regional_rgb[0][r][c] / counts[r].max(1) as f64 <= 0.05
        })
    });
    let rgb_tails_preserved = (0..3).all(|c| {
        let p95: Vec<f64> = rgb_tails
            .iter()
            .map(|rows| {
                let mut values: Vec<_> = rows.iter().map(|v| v[c]).collect();
                *values.select_nth_unstable_by(index, f64::total_cmp).1
            })
            .collect();
        p95[1] > 0.1 || p95[0] <= 0.1
    });
    let native_bands_preserved = native_bands.preserved();
    let accepted = regions_improve
        && native_bands_preserved
        && rgb_regions_preserved
        && rgb_tails_preserved
        && perceptual[0] < perceptual[1]
        && p95[0] <= p95[1]
        && (0..3).all(|c| squared[0][c] <= squared[1][c] && absolute[0][c] <= absolute[1][c]);
    #[cfg(feature = "stage-dump")]
    if let Some(dir) = crate::stage_dump::dump_dir() {
        let regions:Vec<_>=(0..64).map(|r|serde_json::json!({"region":r,"count":counts[r],"candidate_mean":(counts[r]>0).then(||regional[0][r]/counts[r] as f64),"baseline_mean":(counts[r]>0).then(||regional[1][r]/counts[r] as f64)})).collect();
        let report = serde_json::json!({"accepted":accepted,"regions_improve":regions_improve,"native_bands_preserved":native_bands_preserved,"rgb_regions_preserved":rgb_regions_preserved,"rgb_tails_preserved":rgb_tails_preserved,"native_squared_rgb":squared,"native_absolute_rgb":absolute,"display_perceptual_sum":perceptual,"display_p95":p95,"native_validation_samples":validation_count,"display_samples":display.len(),"regions":regions});
        if let Ok(file) = std::fs::File::create(dir.join("auto_fit_selection.json")) {
            let _ = serde_json::to_writer_pretty(std::io::BufWriter::new(file), &report);
        }
    }
    accepted
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
    let observations =
        paired_observations::build(pixels, width, height, orientation, preview, current)?;
    let display = if preview.image.width().max(preview.image.height()) > 1024 {
        Some(paired_observations::build_display(
            pixels,
            width,
            height,
            orientation,
            preview,
            current,
        )?)
    } else {
        None
    };
    let (result, coarse) =
        solve_observations(display.as_deref().unwrap_or(&observations), current)?;
    #[cfg(feature = "stage-dump")]
    if let Some(dir) = crate::stage_dump::dump_dir() {
        #[derive(serde::Serialize)]
        struct Snapshot<'a> {
            width: usize,
            height: usize,
            grid: usize,
            native: &'a [Observation],
            display: Option<&'a [Observation]>,
            prior_size: usize,
            prior: &'a [f32],
            coarse: &'a [f32],
            artifact: &'a [f32],
        }
        let snapshot = Snapshot {
            width,
            height,
            grid: GRID,
            native: &observations,
            display: display.as_deref(),
            prior_size: current.size,
            prior: &current.data,
            coarse: &coarse.data,
            artifact: &result.data,
        };
        if let Ok(file) = std::fs::File::create(dir.join("auto_fit_observations.json")) {
            let _ = serde_json::to_writer(std::io::BufWriter::new(file), &snapshot);
        }
    }
    select_step(
        &result,
        current,
        &observations,
        display.as_deref().unwrap_or(&observations),
    )
}

fn select_step(
    proposed: &ColorLut,
    current: &ColorLut,
    native: &[Observation],
    display: &[Observation],
) -> Option<ColorLut> {
    let blend = |fraction: f32| {
        let mut candidate = proposed.clone();
        if fraction != 1. {
            for ((value, &before), &after) in candidate
                .data
                .iter_mut()
                .zip(&current.data)
                .zip(&proposed.data)
            {
                *value = before + fraction * (after - before);
            }
        }
        candidate
    };
    let mut upper = 1.;
    let mut selected = None;
    for fraction in [1., 0.5, 0.25, 0.125, 0.0625] {
        let candidate = blend(fraction);
        if prefer(&candidate, native, display) {
            selected = Some((fraction, candidate));
            break;
        }
        upper = fraction;
    }
    let (mut lower, mut result) = selected?;
    if lower != 1. {
        for _ in 0..8 {
            let fraction = (lower + upper) * 0.5;
            let candidate = blend(fraction);
            if prefer(&candidate, native, display) {
                lower = fraction;
                result = candidate;
            } else {
                upper = fraction;
            }
        }
    }
    #[cfg(feature = "stage-dump")]
    if let Some(dir) = crate::stage_dump::dump_dir() {
        let _ = prefer(&result, native, display);
        if let Ok(file) = std::fs::File::create(dir.join("auto_fit_step.json")) {
            let _ = serde_json::to_writer(file, &serde_json::json!({"fraction":lower}));
        }
    }
    Some(result)
}

#[cfg(test)]
#[path = "paired_fit_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "paired_quality_tests.rs"]
mod quality_tests;
