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
//! Lives in the sibling [`crate::stages::auto_adjustments_awb`] module
//! (#2247). A cast-invariant gray-world + white-patch estimate runs on the
//! D65-pinned probe with sensor-clipped pixels excluded in post-gain camera
//! space, and the measured neutral is solved in the same slider frame the
//! develop chain renders with. When too few pixels survive the gates the
//! estimate falls back to `dcp::estimate_as_shot_cct_tint`, which reads the
//! camera's own interpolated color matrix instead of forcing the raw
//! `as_shot_neutral` through the generic model (#1725).
//!
//! # Tone
//!
//! Auto-tone (contrast / highlights / shadows / whites / blacks) lives in the
//! sibling [`crate::stages::auto_adjustments_tone`] module (#1376). It solves
//! each slider by inverting the shipping transfer function against a
//! display-referred histogram anchor measured from the ACR baseline renders of
//! the reference fixture set, then damps, deadbands and clamps the result. See
//! that module's doc for the objective target and the anti-railing bounds.
//!
//! Refs:
//!   - spec `docs/superpowers/specs/2026-05-26-auto-tone-and-looks-design.md`
//!   - AWB: `.archived-plans/specs/2026-06-18-auto-adjustments-m0-spec.md`

use crate::image::{ColorSpace, Image, RawImage};
use crate::pipeline::{develop_scene_linear_from_raw_with_quality, RenderQuality};
use crate::types::adjustment::AutoExposureMode;
use crate::xmp::AdjustmentModel;

/// Rec.2020 luma weights — match the working color space of the post-WB
/// scene-linear buffer. Identical to the same constant in `auto_tone`.
pub(crate) const LUMA_REC2020: [f32; 3] = [0.2627, 0.6780, 0.0593];

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
    let (temperature, tint) =
        crate::stages::auto_adjustments_awb::compute_awb(&probe, raw, &probe_model);

    // --- Tone (contrast / highlights / shadows / whites / blacks) ---
    // #1376. Solved against the SAME probe buffer, but keyed on the exposure
    // recommendation above: the tone stage runs after exposure, so the
    // calibration measures the histogram the tone bands will actually see.
    let tone = crate::stages::auto_adjustments_tone::compute_auto_tone_sliders(&probe, exposure);

    Ok(AutoAdjustments {
        exposure,
        temperature,
        tint,
        contrast: tone.contrast,
        highlights: tone.highlights,
        shadows: tone.shadows,
        whites: tone.whites,
        blacks: tone.blacks,
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

// Tests live in the sibling `auto_adjustments_tests.rs` so this file stays
// under the 600-LOC budget (PR #1730). Same `#[path]` split pattern as
// `stages/nlm.rs` (`nlm_tests.rs`) and `stages/white_balance.rs`
// (`white_balance_tests.rs`, #1725).
#[cfg(test)]
#[path = "auto_adjustments_tests.rs"]
mod tests;
