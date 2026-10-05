//! Fit-quality metrics for the ACR-match solver.
//!
//! `test-support`-only (gated at the `mod metrics` declaration in `mod.rs`):
//! the overlap-consistency check between exposure-shifted renders and the
//! RMS-DE00 goodness-of-fit over unclipped sweep patches. Split out of
//! `mod.rs` so that file keeps real margin under the file-size budget (#2311);
//! behavior is unchanged.

use super::extract_patch_mean_srgb;
use super::is_clipped;
use super::model::{apply_model, ciede2000, srgb_linear_to_lab, tonescale_apply};
use super::model::{AcrModel, FitStats, HueChromaField, Tonescale};
use super::tonescale::{fit_tonescale, NeutralSample};
use super::SpecGroup;
use super::SpecPatch;
use crate::color::matrices::M_REC2020_TO_SRGB;
use crate::view::agx_inverse::srgb_gamma_inv;

/// Compute the overlap consistency metric across adjacent render pairs.
///
/// For each pair of renders (sorted by ev) that overlap in x-space (i.e. the
/// higher-ev render has samples below the clip point of the lower-ev render),
/// fit the tonescale on each render's samples separately and measure the RMS
/// relative difference of `T(x)` over the shared x range.  Returns the
/// maximum such metric across all pairs; `None` if no overlap region exists.
pub(crate) fn compute_overlap_rms_rel(
    per_render_neutrals: &[Vec<NeutralSample>],
    _full_ts: &Tonescale,
) -> Option<f32> {
    // For the overlap metric we need at least two renders with samples.
    let mut non_empty: Vec<&Vec<NeutralSample>> = per_render_neutrals
        .iter()
        .filter(|v| v.len() >= 2)
        .collect();
    if non_empty.len() < 2 {
        return None;
    }

    // Sort ALL non-empty render sample sets by their median x — ascending, so
    // index i and i+1 are the "adjacent" pair sharing the narrowest x-gap
    // (lowest-exposure/widest-range render first, highest-exposure/shifted-
    // left-by-2^ev render last).
    let median_x = |samples: &[NeutralSample]| -> f32 {
        let mut xs: Vec<f32> = samples.iter().map(|s| s.scene_lum).collect();
        xs.sort_by(|a, b| a.partial_cmp(b).unwrap());
        xs[xs.len() / 2]
    };
    non_empty.sort_by(|a, b| median_x(a).partial_cmp(&median_x(b)).unwrap());

    // Evaluate the metric on every adjacent pair and keep the maximum — a
    // single badly-disagreeing seam should surface the warning even if the
    // other seams are clean.
    let mut max_rms: Option<f32> = None;
    for pair in non_empty.windows(2) {
        let (lo, hi) = (pair[0], pair[1]);

        // The overlap is the intersection of the two renders' x ranges.
        let x_min_lo = lo.iter().map(|s| s.scene_lum).fold(f32::INFINITY, f32::min);
        let x_max_lo = lo
            .iter()
            .map(|s| s.scene_lum)
            .fold(f32::NEG_INFINITY, f32::max);
        let x_min_hi = hi.iter().map(|s| s.scene_lum).fold(f32::INFINITY, f32::min);
        let x_max_hi = hi
            .iter()
            .map(|s| s.scene_lum)
            .fold(f32::NEG_INFINITY, f32::max);

        let overlap_lo = x_min_lo.max(x_min_hi);
        let overlap_hi = x_max_lo.min(x_max_hi);
        if overlap_lo >= overlap_hi {
            continue;
        }

        // Fit tonescale separately on each render's samples.
        let Some(ts_lo) = fit_tonescale(lo) else {
            continue;
        };
        let Some(ts_hi) = fit_tonescale(hi) else {
            continue;
        };

        // Sample 20 points in the overlap range and compute RMS relative diff.
        let n_eval = 20usize;
        let mut sum_sq = 0.0f64;
        let mut count = 0usize;
        for i in 0..n_eval {
            let t = i as f32 / (n_eval - 1) as f32;
            let x = overlap_lo + t * (overlap_hi - overlap_lo);
            if x <= 0.0 {
                continue;
            }
            let y0 = tonescale_apply(&ts_lo, x);
            let y1 = tonescale_apply(&ts_hi, x);
            let avg = (y0 + y1) / 2.0;
            if avg < 1e-4 {
                continue;
            }
            let rel = ((y0 - y1) / avg) as f64;
            sum_sq += rel * rel;
            count += 1;
        }

        if count == 0 {
            continue;
        }
        let rms = (sum_sq / count as f64).sqrt() as f32;
        max_rms = Some(max_rms.map_or(rms, |m: f32| m.max(rms)));
    }

    max_rms
}

/// Compute the root-mean-square CIEDE2000 of `apply_model` prediction vs
/// measured display sRGB, over unclipped sweep patches.
pub(crate) fn compute_fit_rms_de(
    specs: &[SpecPatch],
    png_rgb: &[u8],
    png_w: usize,
    ts: &Tonescale,
    field: &HueChromaField,
) -> f32 {
    let m = AcrModel {
        tonescale: ts.clone(),
        field: field.clone(),
        stats: FitStats {
            patches_used: 0,
            patches_clipped: 0,
            fit_rms_de: 0.0,
            overlap_rms_rel: None,
        },
    };
    let mut total_de = 0.0f64;
    let mut n = 0usize;

    for spec in specs {
        if spec.group != SpecGroup::Sweep || spec.clamped {
            continue;
        }
        let mean_8bit = extract_patch_mean_srgb(png_rgb, png_w, spec.col, spec.row);
        if is_clipped(spec, mean_8bit) {
            continue;
        }
        // Measured display.
        let meas_lin = [
            srgb_gamma_inv(mean_8bit[0]),
            srgb_gamma_inv(mean_8bit[1]),
            srgb_gamma_inv(mean_8bit[2]),
        ];
        let lab_meas = srgb_linear_to_lab(meas_lin);

        // Model prediction.
        let pred_rec2020 = apply_model(&m, spec.target_rec2020);
        let pred_srgb = M_REC2020_TO_SRGB.mul_vec(pred_rec2020);
        let pred_srgb_clamped = [
            pred_srgb[0].clamp(0.0, 1.0),
            pred_srgb[1].clamp(0.0, 1.0),
            pred_srgb[2].clamp(0.0, 1.0),
        ];
        let lab_pred = srgb_linear_to_lab(pred_srgb_clamped);

        let de = ciede2000(lab_meas, lab_pred);
        total_de += (de as f64) * (de as f64);
        n += 1;
    }

    if n == 0 {
        0.0
    } else {
        (total_de / n as f64).sqrt() as f32
    }
}
