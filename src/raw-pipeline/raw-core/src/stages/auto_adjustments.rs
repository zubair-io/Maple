//! Auto Adjustments — one-shot per-image recommendation for all eight sliders.
//!
//! # Summary
//!
//! `compute_auto_adjustments` develops ONE scene-linear Rec.2020 probe buffer
//! from the RAW with `auto_exposure: Off` and white balance pinned to D65
//! (temperature 6500 / tint 0). **All eight output fields are derived from that
//! single buffer.**
//!
//! # Exposure-replaces-anchor contract
//!
//! AUTO's `exposure` is computed against the AE-Off base, so **the caller
//! must REPLACE the XMP anchor** — set `exposure = output.exposure` AND
//! `auto_exposure = Off` together. This avoids the AE double-count: if
//! `auto_exposure` stays `On`, the scene anchor would stack with the
//! recommended `exposure` and blow out the image. The returned value is a
//! REPLACEMENT for the (anchor + manual) pair, not an additive delta.
//!
//! # AWB — illuminant estimation
//!
//! A hybrid gray-world + white-patch estimator runs on the D65-pinned
//! probe buffer. Highly saturated pixels (chroma gate) and crushed/clipped
//! lumas (luma window) are excluded before averaging so a neon sign or a
//! blown-out sky can't drag the estimate. The resulting G-normalized neutral
//! is converted to (temperature, tint) via `neutral_to_temp_tint` which
//! seeds from `estimate_cct_from_neutral` and refines with ≤ 8 bisection
//! steps. Graceful degradation: when too few pixels survive the gates, the
//! function falls back to `dcp::estimate_as_shot_cct_tint`, which reads the
//! camera's own interpolated color matrix instead of forcing the raw
//! `as_shot_neutral` through the generic model (#1725).
//!
//! # Tone (deferred — #1376)
//!
//! Auto-tone (contrast / whites / blacks / highlights / shadows) is deferred
//! to #1376: the prototype histogram heuristics over-drove on real scenes, so
//! AUTO currently reports 0 for those five sliders. Exposure + white balance
//! ship now.
//!
//! Refs:
//!   - spec `docs/superpowers/specs/2026-05-26-auto-tone-and-looks-design.md`
//!   - AWB: `.archived-plans/specs/2026-06-18-auto-adjustments-m0-spec.md`

use crate::image::{ColorSpace, Image, RawImage};
use crate::pipeline::{develop_scene_linear_from_raw_with_quality, RenderQuality};
use crate::stages::white_balance::neutral_to_temp_tint;
use crate::types::adjustment::AutoExposureMode;
use crate::xmp::AdjustmentModel;

/// Rec.2020 luma weights — match the working color space of the post-WB
/// scene-linear buffer. Identical to the same constant in `auto_tone`.
const LUMA_REC2020: [f32; 3] = [0.2627, 0.6780, 0.0593];

/// Number of histogram bins. 4096 = 12 bits.
const HIST_BINS: usize = 4096;

/// Mid-gray anchor — the AgX-design target for a correctly exposed scene.
const TARGET_MIDGRAY: f32 = 0.18;

/// Exposure EV clamp — mirrors the UI slider range.
const EXPOSURE_CLAMP_EV: f32 = 5.0;

/// One-shot per-image slider recommendation for all eight adjustments.
///
/// All fields are in **display-range units**: `exposure` in EV, all others
/// in `±100` slider units (matching the `AdjustmentModel` fields).
///
/// This struct mirrors `AutoTone` field-for-field and extends it with the two
/// white-balance outputs (`temperature` in Kelvin, `tint` in ±100 units) so
/// the caller can populate all eight sliders atomically.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AutoAdjustments {
    /// Recommended exposure in EV. Clamped to `[-5, +5]`. See the
    /// "Exposure-replaces-anchor contract" in the module doc.
    pub exposure: f32,
    /// Recommended temperature in Kelvin (2000 – 50000 range).
    pub temperature: f32,
    /// Recommended tint in ±100 slider units.
    pub tint: f32,
    /// Recommended contrast in ±100 slider units.
    pub contrast: f32,
    /// Recommended highlights in ±100 slider units.
    pub highlights: f32,
    /// Recommended shadows in ±100 slider units.
    pub shadows: f32,
    /// Recommended whites in ±100 slider units.
    pub whites: f32,
    /// Recommended blacks in ±100 slider units.
    pub blacks: f32,
}

impl Default for AutoAdjustments {
    fn default() -> Self {
        Self {
            exposure: 0.0,
            temperature: 6500.0,
            tint: 0.0,
            contrast: 0.0,
            highlights: 0.0,
            shadows: 0.0,
            whites: 0.0,
            blacks: 0.0,
        }
    }
}

/// Compute per-image slider recommendations from a `RawImage`.
///
/// Develops ONE scene-linear Rec.2020 probe buffer with `auto_exposure: Off`
/// and white balance pinned to D65 (temperature 6500 / tint 0), then derives
/// ALL eight output fields from that single buffer. `model` is used read-only
/// for non-WB/non-exposure fields (e.g. profile, highlight recovery); it is
/// never mutated.
///
/// # AE-Off probe / exposure-replaces-anchor contract
///
/// The returned `exposure` is computed relative to the AE-Off scene.  The
/// caller **must** set `auto_exposure = Off` together with
/// `exposure = result.exposure` — never apply the result on top of an
/// `auto_exposure: On` model or the anchor and the recommended gain will stack.
///
/// # Errors
///
/// Returns `Err` only when the underlying RAW develop fails (e.g. an
/// unsupported RAW format). On success all fields are finite.
pub fn compute_auto_adjustments(
    raw: &RawImage,
    model: &AdjustmentModel,
) -> crate::error::Result<AutoAdjustments> {
    // Build the AE-Off/D65 probe model. Take the caller's model so settings
    // like highlight_recovery and profile carry through, but pin the three
    // inputs we're estimating so they don't contaminate the analysis.
    let mut probe_model = model.clone();
    probe_model.auto_exposure = AutoExposureMode::Off;
    probe_model.temperature = 6500.0;
    probe_model.tint = 0.0;
    // Also zero all the user adjustments so the probe sees the raw scene
    // directly (we're recommending these from scratch):
    probe_model.exposure = 0.0;
    probe_model.contrast = 0.0;
    probe_model.highlights = 0.0;
    probe_model.shadows = 0.0;
    probe_model.whites = 0.0;
    probe_model.blacks = 0.0;

    // Develop the probe buffer. Use Preview quality for speed — the
    // statistical estimators (percentiles, average) are not sensitive to
    // the extra precision Full provides and Preview is ~4× faster.
    let probe =
        develop_scene_linear_from_raw_with_quality(raw, &probe_model, RenderQuality::Preview)?;

    // Build the luma histogram once; all tone stats share it.
    let hist = build_luma_histogram(&probe);

    // --- Exposure ---
    let exposure = compute_exposure(&hist);

    // --- AWB (temperature + tint) ---
    let (temperature, tint) = compute_awb(&probe, raw);

    // --- Tone (contrast / highlights / shadows / whites / blacks) ---
    // Deferred to #1376. The histogram-percentile heuristics prototyped during
    // M0 over-drove on real scenes (blacks railed to -100, whites to ±100,
    // contrast stayed inert), and there is no objective target to calibrate
    // them against yet. Per review they ship as 0 (no change) so AUTO never
    // emits a railed value; exposure + white balance ship now.
    let (contrast, highlights, shadows, whites, blacks) = (0.0, 0.0, 0.0, 0.0, 0.0);

    Ok(AutoAdjustments {
        exposure,
        temperature,
        tint,
        contrast,
        highlights,
        shadows,
        whites,
        blacks,
    })
}

// ---------------------------------------------------------------------------
// Luma histogram
// ---------------------------------------------------------------------------

fn build_luma_histogram(image: &Image) -> [u32; HIST_BINS] {
    image.assert_space(ColorSpace::SceneLinearRec2020);
    let mut bins = [0u32; HIST_BINS];
    for p in &image.pixels {
        let y = LUMA_REC2020[0] * p[0] + LUMA_REC2020[1] * p[1] + LUMA_REC2020[2] * p[2];
        if !y.is_finite() {
            continue;
        }
        let scaled = (y * HIST_BINS as f32).floor();
        let idx = if scaled <= 0.0 {
            0
        } else if scaled >= (HIST_BINS - 1) as f32 {
            HIST_BINS - 1
        } else {
            scaled as usize
        };
        bins[idx] = bins[idx].saturating_add(1);
    }
    bins
}

/// Walk the cumulative sum and return the normalised scene-linear luma at
/// which the cumulative count crosses `q`. Bin midpoints are returned so
/// the lookup is continuous. Returns `None` when the histogram is empty.
fn percentile(hist: &[u32; HIST_BINS], q: f32) -> Option<f32> {
    let total: u64 = hist.iter().map(|&c| c as u64).sum();
    if total == 0 {
        return None;
    }
    let target = ((total as f64) * (q as f64)).ceil() as u64;
    let mut acc: u64 = 0;
    for (i, &c) in hist.iter().enumerate() {
        acc += c as u64;
        if acc >= target {
            return Some((i as f32 + 0.5) / HIST_BINS as f32);
        }
    }
    Some(1.0)
}

// ---------------------------------------------------------------------------
// Exposure (Phase 1a — same algorithm as auto_tone.rs)
// ---------------------------------------------------------------------------

fn compute_exposure(hist: &[u32; HIST_BINS]) -> f32 {
    let p50 = match percentile(hist, 0.50) {
        Some(p) => p,
        None => return 0.0,
    };
    const P50_FLOOR: f32 = 1e-6;
    // Median → mid-gray (0.18) is the raw signal.
    let median_ev = (TARGET_MIDGRAY / p50.max(P50_FLOOR)).log2();

    // Deadband — a near-correct exposure is left ALONE. AUTO must not fidget
    // with a frame the photographer already exposed well.
    const DEADBAND_EV: f32 = 0.4;
    if median_ev.abs() < DEADBAND_EV {
        return 0.0;
    }

    // Damp — AUTO is a conservative NUDGE toward correct, not a slam. The median
    // is easily dragged by a dark subject (black clothing, deep shadow), which
    // makes the naive rule over-brighten a well-exposed frame; applying half the
    // indicated correction keeps it gentle and leaves the photographer the final
    // call. (Empirically, full-strength median metering blew the highlights on
    // dark-subject portraits — review feedback.)
    let damped = median_ev * 0.5;

    // Highlight backstop — never brighten so far that the near-brightest pixels
    // (p99, ignoring the top 1% specular) clip past ~0.92. Only ever constrains
    // BRIGHTENING; loose on dark scenes (low p99).
    const HIGHLIGHT_TARGET: f32 = 0.92;
    let p99 = percentile(hist, 0.99).unwrap_or(1.0).max(P50_FLOOR);
    let highlight_ev = (HIGHLIGHT_TARGET / p99).log2();

    let exposure = damped.min(highlight_ev);
    if exposure.is_finite() {
        exposure.clamp(-EXPOSURE_CLAMP_EV, EXPOSURE_CLAMP_EV)
    } else {
        0.0
    }
}

// ---------------------------------------------------------------------------
// Auto White Balance
// ---------------------------------------------------------------------------

/// Pixel chroma gate: discard pixels whose chroma saturation exceeds this
/// fraction relative to their luminance. A pure primary at scene value 0.5
/// has channel ratios up to ~3×; a neutral by definition is 1×. The gate
/// discards pixels that are too colourful to be useful gray-world evidence
/// without throwing away slightly off-white regions.
const AWB_CHROMA_GATE: f32 = 0.25; // max channel deviation / max(r,g,b)

/// Luma lower bound: discard pixels with luma below this (crushed / shadow
/// noise — unreliable for illuminant estimation).
const AWB_LUMA_MIN: f32 = 0.05;

/// Luma upper bound: discard pixels above this (specular highlights — blown
/// highlights carry no useful chromaticity).
const AWB_LUMA_MAX: f32 = 0.9;

/// White-patch luma threshold: pixels above this are included in the
/// "near-white" estimate (robust maximum).
const AWB_WHITE_PATCH_THRESHOLD: f32 = 0.7;

/// Blend weight for gray-world vs white-patch average. `0.6` gray-world +
/// `0.4` white-patch is a standard heuristic that keeps neutral scenes
/// anchored while giving the robust near-white estimate weight on high-key
/// or backlit shots.
const AWB_GRAY_WORLD_BLEND: f32 = 0.6;

/// Minimum surviving pixel count to trust the estimate. Below this
/// threshold the function falls back to the camera-matrix-aware as-shot
/// estimate (see [`crate::color::dcp::estimate_as_shot_cct_tint`]).
const AWB_MIN_PIXELS: usize = 64;

/// Compute auto white-balance recommendation as (temperature_k, tint).
///
/// Implements a hybrid gray-world + white-patch illuminant estimate on the
/// probe buffer (already in scene-linear Rec.2020, developed at D65/AE-Off).
/// Saturated and crushed/clipped pixels are excluded so extreme foreground
/// subjects can't dominate the estimate.
///
/// Graceful degradation:
/// - Near-neutral scene (gain very close to [1,1,1]) → ~(6500, 0).
/// - Too few surviving pixels → falls back to `dcp::estimate_as_shot_cct_tint`,
///   which reads the camera's OWN interpolated color matrix rather than
///   forcing the camera-native `AsShotNeutral` through the generic
///   Planckian-locus model (#1725 — that combination rails to a tint bound
///   for essentially every realistic body; see
///   `white_balance_auto::estimate_cct_tint_from_scene_xyz`'s doc comment).
fn compute_awb(probe: &Image, raw: &RawImage) -> (f32, f32) {
    probe.assert_space(ColorSpace::SceneLinearRec2020);

    let mut gray_sum = [0.0_f64; 3];
    let mut gray_n = 0usize;
    let mut white_sum = [0.0_f64; 3];
    let mut white_n = 0usize;

    for p in &probe.pixels {
        let r = p[0];
        let g = p[1];
        let b = p[2];

        // Skip non-finite pixels (specular spikes, sensor defects).
        if !r.is_finite() || !g.is_finite() || !b.is_finite() {
            continue;
        }

        let y = LUMA_REC2020[0] * r + LUMA_REC2020[1] * g + LUMA_REC2020[2] * b;

        // Luma window: discard crushed shadows and clipped highlights.
        if y < AWB_LUMA_MIN || y > AWB_LUMA_MAX {
            continue;
        }

        // Chroma gate: discard highly saturated pixels. A pixel is
        // "too saturated" when its maximum channel deviates from the mean
        // by more than AWB_CHROMA_GATE × max. This rejects pure-primary
        // and highly-saturated subjects (neon signs, vivid foliage) without
        // penalizing slightly warm/cool naturalistic scenes.
        let max_ch = r.max(g).max(b).max(1e-6);
        let mean_ch = (r + g + b) / 3.0;
        let dev = (r - mean_ch)
            .abs()
            .max((g - mean_ch).abs())
            .max((b - mean_ch).abs());
        if dev / max_ch > AWB_CHROMA_GATE {
            continue;
        }

        // Gray-world accumulator: all surviving pixels.
        gray_sum[0] += r as f64;
        gray_sum[1] += g as f64;
        gray_sum[2] += b as f64;
        gray_n += 1;

        // White-patch accumulator: near-white pixels (robust maximum).
        if y > AWB_WHITE_PATCH_THRESHOLD {
            white_sum[0] += r as f64;
            white_sum[1] += g as f64;
            white_sum[2] += b as f64;
            white_n += 1;
        }
    }

    // Fallback: too few surviving pixels — use the camera-matrix-aware
    // as-shot estimate (camera's interpolated ColorMatrix, not the generic
    // Planckian model) so we still return Kelvin/tint rather than a raw
    // neutral, and without railing to a tint bound (#1725).
    if gray_n < AWB_MIN_PIXELS {
        return crate::color::dcp::estimate_as_shot_cct_tint(raw).unwrap_or((6500.0, 0.0));
    }

    let gray_avg = [
        (gray_sum[0] / gray_n as f64) as f32,
        (gray_sum[1] / gray_n as f64) as f32,
        (gray_sum[2] / gray_n as f64) as f32,
    ];

    // If we have enough white-patch pixels, blend; otherwise pure gray-world.
    let scene_illuminant = if white_n >= AWB_MIN_PIXELS {
        let white_avg = [
            (white_sum[0] / white_n as f64) as f32,
            (white_sum[1] / white_n as f64) as f32,
            (white_sum[2] / white_n as f64) as f32,
        ];
        let t = AWB_GRAY_WORLD_BLEND;
        [
            t * gray_avg[0] + (1.0 - t) * white_avg[0],
            t * gray_avg[1] + (1.0 - t) * white_avg[1],
            t * gray_avg[2] + (1.0 - t) * white_avg[2],
        ]
    } else {
        gray_avg
    };

    // G-normalize to AsShotNeutral shape [r, 1, b].
    let g_ref = scene_illuminant[1].max(1e-6);
    let neutral = [
        scene_illuminant[0] / g_ref,
        1.0,
        scene_illuminant[2] / g_ref,
    ];

    // The probe buffer was developed at D65 (gain ≈ [1,1,1]), so the measured
    // neutral is the scene's residual cast relative to D65. A reddish neutral
    // ([r>1, 1, b<1]) means a WARM (low-CCT) source that D65 development
    // under-corrected → `neutral_to_temp_tint` returns a LOW Kelvin to
    // neutralise it (with the green/magenta residual returned as tint).
    neutral_to_temp_tint(neutral)
}

// Tests live in the sibling `auto_adjustments_tests.rs` so this file stays
// under the 600-LOC budget (PR #1730). Same `#[path]` split pattern as
// `stages/nlm.rs` (`nlm_tests.rs`) and `stages/white_balance.rs`
// (`white_balance_tests.rs`, #1725).
#[cfg(test)]
#[path = "auto_adjustments_tests.rs"]
mod tests;
