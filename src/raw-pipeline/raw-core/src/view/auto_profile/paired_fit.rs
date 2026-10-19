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

fn constrain_to_prior(data: &mut [f32], prior: &ColorLut) {
    let n = prior.size;
    let epsilon = 0.002 / (n - 1) as f32;
    for v in data.iter_mut() {
        *v = v.clamp(0., 1.);
    }
    for _ in 0..32 {
        for z in 0..n {
            for y in 0..n {
                for x in 0..n {
                    let i = ((z * n + y) * n + x) * 3;
                    for (c, (coordinate, stride)) in
                        [(x, 3), (y, 3 * n), (z, 3 * n * n)].into_iter().enumerate()
                    {
                        if coordinate + 1 < n {
                            project_edge(data, &prior.data, i + c, i + stride + c, epsilon);
                        }
                    }
                }
            }
        }
        for k in 0..n - 1 {
            let i = ((k * n + k) * n + k) * 3;
            let j = (((k + 1) * n + k + 1) * n + k + 1) * 3;
            for c in 0..3 {
                project_edge(data, &prior.data, i + c, j + c, epsilon);
            }
        }
    }
}

fn project_edge(data: &mut [f32], prior: &[f32], i: usize, j: usize, epsilon: f32) {
    // The existing calibration remains feasible, including any existing folds.
    let minimum = (prior[j] - prior[i]).min(epsilon);
    let deficit = minimum - (data[j] - data[i]);
    if deficit > 0. {
        let shift = deficit * 0.5;
        data[i] = (data[i] - shift).clamp(0., 1.);
        data[j] = (data[j] + shift).clamp(0., 1.);
    }
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
    for row in observations.iter().filter(|row| !row.validation) {
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
    constrain_to_prior(&mut result.data, prior);
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
    let mut counts = [0usize; 64];
    for row in observations.iter().filter(|row| row.validation) {
        let target = lab(row.target.map(|v| v as f32));

        let prediction = std::array::from_fn(|c| {
            row.artifact_weights
                .iter()
                .map(|&(i, w)| w * f64::from(candidate.data[i * 3 + c]))
                .sum::<f64>()
        });
        for (i, output) in [prediction, row.baseline].into_iter().enumerate() {
            let de = f64::from(ciede2000(lab(output.map(|v| v as f32)), target));
            perceptual[i] += de;

            tails[i].push(de);
            for c in 0..3 {
                let error = output[c] - row.target[c];
                squared[i][c] += error * error;
                absolute[i][c] += error.abs();
            }
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
            regional[i][row.region] += f64::from(ciede2000(lab(output.map(|v| v as f32)), target));
        }
    }
    let regions_improve = (0..64).all(|r| {
        counts[r] >= 32
            && (regional[0][r] - regional[1][r]) / counts[r] as f64 <= REGIONAL_SELECTION_MARGIN_DE
    });
    let accepted = regions_improve
        && perceptual[0] < perceptual[1]
        && p95[0] <= p95[1]
        && (0..3).all(|c| squared[0][c] <= squared[1][c] && absolute[0][c] <= absolute[1][c]);
    #[cfg(feature = "stage-dump")]
    if let Some(dir) = crate::stage_dump::dump_dir() {
        let regions:Vec<_>=(0..64).map(|r|serde_json::json!({"region":r,"count":counts[r],"candidate_mean":(counts[r]>0).then(||regional[0][r]/counts[r] as f64),"baseline_mean":(counts[r]>0).then(||regional[1][r]/counts[r] as f64)})).collect();
        let report = serde_json::json!({"accepted":accepted,"regions_improve":regions_improve,"native_squared_rgb":squared,"native_absolute_rgb":absolute,"native_perceptual_sum":perceptual,"native_p95":p95,"regions":regions});
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
    let (result, coarse) = solve_observations(&observations, current)?;
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
    for fraction in [1., 0.5, 0.25, 0.125, 0.0625] {
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
        if prefer(&candidate, native, display) {
            #[cfg(feature = "stage-dump")]
            if let Some(dir) = crate::stage_dump::dump_dir() {
                if let Ok(file) = std::fs::File::create(dir.join("auto_fit_step.json")) {
                    let _ = serde_json::to_writer(file, &serde_json::json!({"fraction":fraction}));
                }
            }
            return Some(candidate);
        }
    }
    None
}

#[cfg(test)]
#[path = "paired_fit_tests.rs"]
mod tests;
