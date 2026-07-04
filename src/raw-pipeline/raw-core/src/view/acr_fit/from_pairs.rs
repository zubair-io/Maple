//! JPEG-pair front-end for the fit-acr structured solver — Auto 2.0 milestone
//! M0 (#1740).
//!
//! The chart solver (`solve_acr_model_multi`) fits from a dense synthetic
//! sweep chart with KNOWN scene-linear targets (`SpecPatch::target_rec2020`)
//! rendered once by ACR. A real photo has no such chart — the only
//! correspondence available is the scattered `(maple, jpeg)` display-space
//! pairs `auto_profile::pairs::sample_display_pairs` already builds for the
//! Auto 1.0 free-LUT fit (the footprint-mean developed pixel against the
//! decoded embedded-JPEG pixel at the same display location).
//!
//! This module adapts those pairs into the same `NeutralSample` /
//! `SweepSample` shapes stage 1 (tonescale) and stage 2 (field) already
//! consume, so the structured solver runs unchanged on scattered real-photo
//! data instead of chart patches:
//!
//! * **Domain caveat**: `DisplayPair::maple` is Maple's own post-AgX,
//!   post-encode `DisplayEncodedSrgb` buffer (already tone-mapped, clamped to
//!   `[0, 1]`) — NOT the unbounded scene-linear signal the chart fit's
//!   `target_rec2020` provides. Decoding it (`srgb_gamma_inv` + sRGB→Rec.2020)
//!   yields Maple's own DISPLAY-linear Rec.2020, which this front-end treats
//!   as the tonescale/field's "scene" axis. That is the correct read for M0's
//!   question — "how well can a structured tonescale+field re-map Maple's
//!   current output onto the JPEG" is exactly the prediction task the Auto
//!   1.0 curve+LUT already solves, so the comparison is apples-to-apples. It
//!   is NOT yet "replace AgX with the 2.0 tonescale" (that is M1/M2 wiring,
//!   out of scope here) — M0 measures fit quality only.
//! * **Neutral/luma subset**: the tonescale needs achromatic samples the way
//!   the chart's `SpecGroup::Neutral` ramp provides. A real photo has no
//!   dedicated neutral ramp, so this front-end derives it from the pairs
//!   themselves: any pair whose PREDICTED (Maple-side) Oklab chroma is below
//!   [`NEUTRAL_CHROMA_FRAC`] contributes a `NeutralSample`; the field fit then
//!   uses every pair (its own confidence-by-count handles sparse hue/chroma
//!   cells, and cells with no support already default to identity).

use super::field::{fit_field, SweepSample, PAIRS_SHRINK_K};
use super::model::{AcrModel, FitStats, Tonescale};
use super::tonescale::{fit_tonescale_with_range, KnotRange, NeutralSample};
use crate::color::matrices::M_REC2020_TO_SRGB;
use crate::color::oklab::rec2020_to_oklab;
use crate::view::agx_inverse::srgb_gamma_inv;
use crate::view::auto_profile::pairs::DisplayPair;

/// Oklab chroma ceiling (same units as `field.rs`'s `c_pred`, normalised
/// against the field's own `0.30` chroma span) below which a pair is treated
/// as "neutral" for the tonescale fit. `0.30 * NEUTRAL_CHROMA_FRAC` ~= 0.045
/// Oklab chroma units — still well inside "no visible hue" territory while
/// admitting the slightly-tinted near-greys a real photo actually has.
///
/// #1740 M1 calibration: raised from 0.10 to 0.15. A fixture whose strict
/// near-neutrals cluster in one luminance band (test_0006's sit in deep
/// shadow — the M0.5 pathology) starves the tonescale elsewhere; the wider
/// ceiling admits enough lightly-tinted midtone samples to anchor the
/// mid-lattice knots (test_0006 baseline_auto mean ΔE00 4.40 → 3.75 on the
/// ACR-parity harness, no measurable cost on the fixtures that were
/// already well-anchored).
const NEUTRAL_CHROMA_FRAC: f32 = 0.15;

/// Rec.2020 luma coefficients (ITU-R BT.2020), matching `field.rs` /
/// `model.rs`'s `apply_model`.
const REC2020_LUMA: [f32; 3] = [0.2627, 0.6780, 0.0593];

fn rec2020_luma(rgb: [f32; 3]) -> f32 {
    REC2020_LUMA[0] * rgb[0] + REC2020_LUMA[1] * rgb[1] + REC2020_LUMA[2] * rgb[2]
}

/// Decode one `DisplayPair` into `(maple_rec2020_linear, jpeg_srgb_linear)` —
/// the same two quantities the chart solver reads as
/// `(spec.target_rec2020, srgb_gamma_inv(mean_8bit_srgb))`, just sourced from
/// a scattered real-photo pair instead of a chart patch. Both channels are
/// sRGB-gamma-decoded first (`srgb_gamma_inv`); the Maple side is then
/// rotated into Rec.2020 primaries (the field fit's native space) via the
/// same `M_REC2020_TO_SRGB.inverse()` matrix `field.rs` uses for its
/// measured-side conversion.
fn decode_pair(
    pair: &DisplayPair,
    m_srgb_to_rec2020: &crate::math::Matrix3,
) -> ([f32; 3], [f32; 3]) {
    let maple_lin_srgb = [
        srgb_gamma_inv(pair.maple[0]),
        srgb_gamma_inv(pair.maple[1]),
        srgb_gamma_inv(pair.maple[2]),
    ];
    let maple_lin_rec2020 = m_srgb_to_rec2020.mul_vec(maple_lin_srgb);
    let jpeg_lin_srgb = [
        srgb_gamma_inv(pair.jpeg[0]),
        srgb_gamma_inv(pair.jpeg[1]),
        srgb_gamma_inv(pair.jpeg[2]),
    ];
    (maple_lin_rec2020, jpeg_lin_srgb)
}

/// Derive the tonescale's neutral/luma sample set from scattered display
/// pairs: keep only pairs whose Maple-side Oklab chroma is below the
/// [`NEUTRAL_CHROMA_FRAC`]-derived ceiling, and pair their Rec.2020 luma
/// with the JPEG-side sRGB luma (both display-linear).
///
/// An empty (or near-empty) result means the fixture has no usable
/// achromatic region — `fit_tonescale` then fails and the caller should
/// report that per-fixture skip explicitly, not silently substitute identity.
pub fn neutral_samples_from_pairs(pairs: &[DisplayPair]) -> Vec<NeutralSample> {
    let m_srgb_to_rec2020 = M_REC2020_TO_SRGB
        .inverse()
        .expect("M_REC2020_TO_SRGB invertible");
    let chroma_max = NEUTRAL_CHROMA_FRAC * 0.30;

    pairs
        .iter()
        .filter_map(|p| {
            let (maple_rec2020, jpeg_srgb) = decode_pair(p, &m_srgb_to_rec2020);
            let lab = rec2020_to_oklab(maple_rec2020);
            let chroma = (lab[1] * lab[1] + lab[2] * lab[2]).sqrt();
            if chroma > chroma_max {
                return None;
            }
            let scene_lum = rec2020_luma(maple_rec2020);
            if scene_lum <= 0.0 {
                return None;
            }
            // sRGB and Rec.2020 luma coefficients differ, but for a
            // near-neutral triplet (R ~= G ~= B) the two luma definitions
            // agree to within float noise, so BT.709 luma on the JPEG side
            // (matching `field.rs`'s measured-luma convention) is consistent
            // with the BT.2020 luma used for the Maple side.
            let display_lum = 0.2126 * jpeg_srgb[0] + 0.7152 * jpeg_srgb[1] + 0.0722 * jpeg_srgb[2];
            Some(NeutralSample {
                scene_lum,
                display_lum,
            })
        })
        .collect()
}

/// Rec.2020 scene luminance of every pair's Maple side (not just the
/// neutral-chroma subset) — the population [`KnotRange::from_scene_luminances`]
/// derives the tonescale's knot span from, so the lattice covers the
/// luminance range the model is actually evaluated against rather than just
/// the (potentially much narrower) range its near-neutral pixels occupy.
fn all_pairs_scene_luminances(pairs: &[DisplayPair]) -> Vec<f32> {
    let m_srgb_to_rec2020 = M_REC2020_TO_SRGB
        .inverse()
        .expect("M_REC2020_TO_SRGB invertible");
    pairs
        .iter()
        .map(|p| {
            let (maple_rec2020, _jpeg_srgb) = decode_pair(p, &m_srgb_to_rec2020);
            rec2020_luma(maple_rec2020)
        })
        .collect()
}

/// Adapt EVERY display pair into a [`SweepSample`] (the field fit's own
/// per-cell confidence and identity-default handle sparse hue/chroma/luma
/// cells — no separate gating needed here, matching the chart solver's
/// stage 2 which also hands `fit_field` its full unclipped sweep set).
pub fn sweep_samples_from_pairs(pairs: &[DisplayPair]) -> Vec<SweepSample> {
    let m_srgb_to_rec2020 = M_REC2020_TO_SRGB
        .inverse()
        .expect("M_REC2020_TO_SRGB invertible");
    pairs
        .iter()
        .map(|p| {
            let (maple_rec2020, jpeg_srgb) = decode_pair(p, &m_srgb_to_rec2020);
            SweepSample {
                scene_rec2020: maple_rec2020,
                display_srgb: jpeg_srgb,
            }
        })
        .collect()
}

/// Fit a structured [`AcrModel`] (tonescale + hue/chroma field) directly from
/// scattered display-space `(maple, jpeg)` pairs — the JPEG-pair front-end
/// for Auto 2.0 M0 (#1740). Mirrors `solve_acr_model_multi`'s stages 1, 2 and
/// 4 (tonescale fit, field fit, RMS ΔE00 self-check) but skips stage 3
/// (multi-render overlap — there is only ever one "render": the RAW's own
/// embedded JPEG) and the chart's clip/clamp bookkeeping (the pair sampler
/// already only emits pairs for pixels present in both buffers).
///
/// Returns `Err` when too few neutral-ish pairs survive to fit a tonescale
/// (`fit_tonescale_with_range` needs ≥ 2 samples) — the caller should report
/// this as a per-fixture skip, not fall back to identity silently.
///
/// The tonescale's knot range is derived from the FULL pair population's
/// scene-luminance distribution (`KnotRange::from_scene_luminances`), not
/// just the neutral-chroma subset used to fit the tonescale's values, and not
/// the chart solver's fixed 0.001-4.0 span. Deriving from the neutral subset
/// alone looks appealing (it is exactly what feeds `fit_tonescale`'s knot
/// VALUES) but a real photo's near-neutral pixels can occupy a much narrower
/// luminance band than its dominant chromatic content — e.g. a scene whose
/// only low-chroma pixels sit in deep shadow while its saturated content
/// spans well into the midtones — which would anchor the whole lattice to
/// that narrow band and push most of the actual image into flat-scale
/// extrapolation from it (#1740 M0.5: this exact failure on `test_0006`,
/// caught by the fixture re-measurement after the neutral-only version of
/// this fix). Deriving from every pair's luminance instead mirrors the chart
/// solver's own design: the synthetic neutral ramp is deliberately built to
/// span the same range as the sweep patches it's evaluated against.
pub fn solve_acr_model_from_display_pairs(pairs: &[DisplayPair]) -> Result<AcrModel, String> {
    let neutral = neutral_samples_from_pairs(pairs);
    let knot_range = KnotRange::from_scene_luminances(&all_pairs_scene_luminances(pairs));
    let mut ts = fit_tonescale_with_range(&neutral, knot_range).ok_or_else(|| {
        format!(
            "tonescale fit failed: {} neutral-chroma pairs out of {} total (need >= 2)",
            neutral.len(),
            pairs.len()
        )
    })?;
    shape_tonescale_for_display_domain(&mut ts);

    let sweep = sweep_samples_from_pairs(pairs);
    let (field, patches_used, patches_clipped) = fit_field(&sweep, &ts, PAIRS_SHRINK_K);

    let fit_rms_de = compute_fit_rms_de_from_pairs(pairs, &ts, &field);

    Ok(AcrModel {
        tonescale: ts,
        field,
        stats: FitStats {
            patches_used,
            patches_clipped,
            fit_rms_de,
            overlap_rms_rel: None,
        },
    })
}

/// Minimum tonescale slope, in display-luminance units per scene-luminance
/// unit: consecutive knot values must rise by at least this fraction of
/// their linear scene-luminance gap. The raw fit's monotone clamp-up pass
/// only enforces `>=`, so a clipped-JPEG luminance band (blown sky) fits a
/// run of EXACTLY equal knots — a plateau that renders every input in the
/// band identically (posterization; the banding gate's `max_flat_run_frac`
/// metric, #1740 M1). 5% keeps ordering strictly visible at a cost the
/// harness can't measure (the affected band is within a hair of clip).
const MIN_TONESCALE_SLOPE: f32 = 0.05;

/// Identity-decay length floor, in log2 stops past the last fitted knot,
/// and the monotonicity-safety factor that widens it for large boundary
/// gains (see `shape_tonescale_for_display_domain`).
const DECAY_STOPS_MIN: f32 = 1.5;
const DECAY_STOPS_PER_GAIN: f32 = 2.2;

/// Post-fit shaping for the display-domain (JPEG-pair) tonescale — #1740 M1
/// calibration. Two structured constraints the chart-domain fit doesn't
/// need (its synthetic neutral ramp never clips and its evaluation domain
/// never exceeds its knot span):
///
/// 1. **Strict monotonicity** ([`MIN_TONESCALE_SLOPE`]): no two knots may
///    map a luminance gap onto a dead-flat display value.
/// 2. **Identity-decay extrapolation**: three appended knots carry the
///    boundary scale `vals[last] / l_last` smoothly (smoothstep) down to
///    exactly 1.0 over `max(1.5, 2.2·(scale−1))` stops, after which the
///    evaluator's own flat-SCALE extrapolation continues at scale 1.0 —
///    i.e. exact identity. This is the epic's "unsupported cells decay to
///    identity" contract applied to the tonescale's luminance axis: without
///    it, flat-scale extrapolation keeps applying the boundary gain to
///    ever-brighter pixels, overshoots the display range, and the bake's
///    range limit posterizes the whole overshoot region into one flat blob
///    (the operator's test_0000 highlight repro). The decay length grows
///    with the boundary gain so `d(l·scale(l))/dl` stays positive
///    (smoothstep peak slope 1.5, so monotonicity needs
///    `stops > (scale−1)·1.5/ln 2 ≈ (scale−1)·2.16`).
fn shape_tonescale_for_display_domain(ts: &mut Tonescale) {
    let n = ts.knots_log2.len();
    if n < 2 {
        return;
    }
    // 1. Strict monotonicity.
    for i in 1..n {
        let l_prev = ts.knots_log2[i - 1].exp2();
        let l_cur = ts.knots_log2[i].exp2();
        let floor = ts.values[i - 1] + MIN_TONESCALE_SLOPE * (l_cur - l_prev);
        if ts.values[i] < floor {
            ts.values[i] = floor;
        }
    }
    // 2. Identity-decay extrapolation knots.
    let k_last = ts.knots_log2[n - 1];
    let l_last = k_last.exp2();
    let scale_top = ts.values[n - 1] / l_last;
    let stops = DECAY_STOPS_MIN.max(DECAY_STOPS_PER_GAIN * (scale_top - 1.0).abs());
    let smoothstep = |t: f32| t * t * (3.0 - 2.0 * t);
    for frac in [1.0f32 / 3.0, 2.0 / 3.0, 1.0] {
        let k = k_last + stops * frac;
        let l = k.exp2();
        let scale = 1.0 + (scale_top - 1.0) * (1.0 - smoothstep(frac));
        // Clamp-up keeps the appended series monotone even for a
        // sub-identity boundary scale (scale_top < 1).
        let v = (l * scale).max(ts.values[n - 1]);
        ts.knots_log2.push(k);
        ts.values.push(v.max(*ts.values.last().unwrap()));
    }
}

/// RMS CIEDE2000 of `apply_model` prediction vs the measured JPEG pair, over
/// every pair — the pairs-front-end analogue of `mod.rs`'s
/// `compute_fit_rms_de` (which walks `SpecPatch`es against a chart PNG; this
/// walks `DisplayPair`s directly, since there is no chart geometry here).
fn compute_fit_rms_de_from_pairs(
    pairs: &[DisplayPair],
    ts: &Tonescale,
    field: &super::model::HueChromaField,
) -> f32 {
    use super::model::{apply_model, ciede2000, srgb_linear_to_lab};
    let m_srgb_to_rec2020 = M_REC2020_TO_SRGB
        .inverse()
        .expect("M_REC2020_TO_SRGB invertible");
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
    for p in pairs {
        let (maple_rec2020, jpeg_srgb) = decode_pair(p, &m_srgb_to_rec2020);
        let lab_meas = srgb_linear_to_lab(jpeg_srgb);

        let pred_rec2020 = apply_model(&m, maple_rec2020);
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

// Tests live in the sibling `from_pairs_tests.rs` so this file stays closer
// to the 600-LOC hard budget (same `#[path]` split pattern as `mod.rs`'s
// `mod_tests.rs` and `auto_profile/lut.rs`).
#[cfg(test)]
#[path = "from_pairs_tests.rs"]
mod tests;
