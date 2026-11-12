//! Candidate-versus-reference assessment shared by the paired fit's step
//! search, registration choice and refinement (#5000).
use super::{ColorLut, Observation};
use crate::view::{
    acr_fit::model::{ciede2000, srgb_linear_to_lab},
    agx_inverse::srgb_gamma_inv,
};
use rayon::prelude::*;

pub(super) fn lab(rgb: [f32; 3]) -> [f32; 3] {
    srgb_linear_to_lab(rgb.map(srgb_gamma_inv))
}

pub(super) fn prefer(
    candidate: &ColorLut,
    observations: &[Observation],
    display: &[Observation],
) -> bool {
    prefer_with(
        candidate,
        observations,
        display,
        &Baseline::new(observations, display, None),
    )
}

pub(super) fn prefer_with(
    candidate: &ColorLut,
    observations: &[Observation],
    display: &[Observation],
    baseline: &Baseline,
) -> bool {
    let assessment = assess_with(candidate, observations, display, baseline);
    assessment.compatible && assessment.native_bands_preserved
}

/// What the compared-against side contributes to an assessment. It depends
/// only on the rows and the reference, not on the candidate, so the callers
/// that assess many candidates (step search, refinement) compute it once
/// instead of re-running prediction, Lab and CIEDE2000 for it every time
/// (#5172).
pub(super) struct Baseline {
    native: Vec<[f64; 3]>,
    display: Vec<([f64; 3], f64)>,
    against_existing: bool,
}

impl Baseline {
    pub(super) fn new(
        observations: &[Observation],
        display: &[Observation],
        reference: Option<&ColorLut>,
    ) -> Self {
        let prediction =
            |row: &Observation| reference.map_or(row.baseline, |lut| predict(lut, row));
        Self {
            native: observations.par_iter().map(prediction).collect(),
            display: display
                .par_iter()
                .map(|row| {
                    let output = prediction(row);
                    let error = std::array::from_fn(|c| (output[c] - row.target[c]).abs());
                    let target = lab(row.target.map(|v| v as f32));
                    let de = f64::from(ciede2000(lab(output.map(|v| v as f32)), target));
                    (error, de)
                })
                .collect(),
            against_existing: reference.is_some(),
        }
    }
}

pub(super) struct Assessment {
    pub(super) compatible: bool,
    pub(super) native_bands_preserved: bool,
    pub(super) display_perceptual: f64,
}

pub(super) fn assess(
    candidate: &ColorLut,
    observations: &[Observation],
    display: &[Observation],
) -> Assessment {
    assess_against(candidate, observations, display, None)
}

pub(super) fn predict(candidate: &ColorLut, row: &Observation) -> [f64; 3] {
    std::array::from_fn(|c| {
        row.artifact_weights
            .iter()
            .map(|&(i, w)| w * f64::from(candidate.data[i * 3 + c]))
            .sum()
    })
}

pub(super) fn assess_against(
    candidate: &ColorLut,
    observations: &[Observation],
    display: &[Observation],
    reference: Option<&ColorLut>,
) -> Assessment {
    assess_with(
        candidate,
        observations,
        display,
        &Baseline::new(observations, display, reference),
    )
}

pub(super) fn assess_with(
    candidate: &ColorLut,
    observations: &[Observation],
    display: &[Observation],
    reference: &Baseline,
) -> Assessment {
    let mut squared = [[0.; 3]; 2];
    let mut absolute = [[0.; 3]; 2];
    let mut perceptual = [0.; 2];
    let mut tails = [Vec::new(), Vec::new()];
    let mut regional = [[0.; 64]; 2];
    let mut rgb_tails = [Vec::new(), Vec::new()];
    let mut regional_rgb = [[[0.; 3]; 64]; 2];
    let mut counts = [0usize; 64];
    let mut populations = [0usize; 64];
    let mut validation_count = 0;
    let mut native_bands = super::bands::NativeBands::default();
    for (row, &baseline) in observations.iter().zip(&reference.native) {
        let prediction = predict(candidate, row);
        native_bands.observe(
            row.target,
            row.in_bias_region,
            [prediction, baseline],
            row.population,
        );
        if !row.validation {
            continue;
        }
        validation_count += 1;
        for (i, output) in [prediction, baseline].into_iter().enumerate() {
            for c in 0..3 {
                let error = output[c] - row.target[c];
                squared[i][c] += row.population as f64 * error * error;
                absolute[i][c] += row.population as f64 * error.abs();
            }
        }
    }
    if validation_count < 32 {
        return Assessment {
            compatible: false,
            native_bands_preserved: true,
            display_perceptual: f64::INFINITY,
        };
    }
    // Prediction, Lab and CIEDE2000 dominate the cost and are per-row; they run
    // in parallel and the sums below fold in row order, so the bits match the
    // serial loop (#5172).
    let scored: Vec<([f64; 3], f64)> = display
        .par_iter()
        .map(|row| {
            let output = predict(candidate, row);
            let error = std::array::from_fn(|c| (output[c] - row.target[c]).abs());
            let target = lab(row.target.map(|v| v as f32));
            let de = f64::from(ciede2000(lab(output.map(|v| v as f32)), target));
            (error, de)
        })
        .collect();
    for ((row, &own), &other) in display.iter().zip(&scored).zip(&reference.display) {
        counts[row.region] += 1;
        populations[row.region] += row.population;
        for (i, (error, de)) in [own, other].into_iter().enumerate() {
            for c in 0..3 {
                regional_rgb[i][row.region][c] += row.population as f64 * error[c];
            }
            rgb_tails[i].push((error, row.population));
            regional[i][row.region] += row.population as f64 * de;
            perceptual[i] += row.population as f64 * de;
            tails[i].push((de, row.population));
        }
    }
    if tails[0].len() < 32 {
        return Assessment {
            compatible: false,
            native_bands_preserved: true,
            display_perceptual: f64::INFINITY,
        };
    }
    let p95: Vec<f64> = tails
        .iter_mut()
        .map(|values| super::population::p95(values))
        .collect();
    let regions_improve = (0..64).all(|r| {
        counts[r] >= 32
            && (regional[0][r] - regional[1][r]) / populations[r].max(1) as f64
                <= super::REGIONAL_SELECTION_MARGIN_DE
    });
    // Do not introduce RGB failures while improving perceptual averages (#5000).
    let rgb_regions_preserved = (0..64).all(|r| {
        (0..3).all(|c| {
            regional_rgb[1][r][c] / populations[r].max(1) as f64 > 0.05
                || regional_rgb[0][r][c] / populations[r].max(1) as f64 <= 0.05
        })
    });
    let rgb_p95: [[f64; 3]; 2] = std::array::from_fn(|side| {
        std::array::from_fn(|c| {
            let mut values: Vec<_> = rgb_tails[side]
                .iter()
                .map(|(v, weight)| (v[c], *weight))
                .collect();
            super::population::p95(&mut values)
        })
    });
    let rgb_tails_preserved = (0..3).all(|c| rgb_p95[1][c] > 0.1 || rgb_p95[0][c] <= 0.1);
    let worst_ratios = super::quality_budget::worst_ratios(
        native_bands.worst_ratios(),
        perceptual,
        &p95,
        &regional_rgb,
        &populations,
        &rgb_p95,
    );
    let reduces_failure = worst_ratios[1] > 1. && worst_ratios[0] < worst_ratios[1];
    let native_bands_preserved = native_bands.preserved();
    let compatible = regions_improve
        && rgb_regions_preserved
        && rgb_tails_preserved
        && perceptual[0] < perceptual[1]
        && super::quality_budget::tail_preserved(p95[1], p95[0], worst_ratios)
        && (0..3).all(|c| absolute[0][c] <= absolute[1][c])
        && ((0..3).all(|c| squared[0][c] <= squared[1][c]) || reduces_failure);
    #[cfg(feature = "stage-dump")]
    if let Some(dir) = crate::stage_dump::dump_dir() {
        let regions:Vec<_>=(0..64).map(|r|serde_json::json!({"region":r,"count":counts[r],"represented_pixels":populations[r],"candidate_mean":(counts[r]>0).then(||regional[0][r]/populations[r].max(1) as f64),"baseline_mean":(counts[r]>0).then(||regional[1][r]/populations[r].max(1) as f64)})).collect();
        let report = serde_json::json!({"accepted":compatible && native_bands_preserved,"regions_improve":regions_improve,"native_bands_preserved":native_bands_preserved,"rgb_regions_preserved":rgb_regions_preserved,"rgb_tails_preserved":rgb_tails_preserved,"native_squared_rgb":squared,"native_absolute_rgb":absolute,"display_perceptual_sum":perceptual,"display_p95":p95,"worst_normalized_errors":worst_ratios,"reduces_worst_failure":reduces_failure,"native_validation_samples":validation_count,"display_samples":display.len(),"regions":regions});
        if let Ok(file) = std::fs::File::create(dir.join(if reference.against_existing {
            "auto_fit_selection_against_existing.json"
        } else {
            "auto_fit_selection.json"
        })) {
            let _ = serde_json::to_writer_pretty(std::io::BufWriter::new(file), &report);
        }
    }
    Assessment {
        compatible,
        native_bands_preserved,
        display_perceptual: perceptual[0],
    }
}
