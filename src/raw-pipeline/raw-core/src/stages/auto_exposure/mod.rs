//! Per-image scene-anchor (Ticket #429).
//!
//! # Why this exists
//! AgX assumes the scene is anchored at mid-gray 0.18. Without a real
//! anchor, different cameras / scenes land at different points on the
//! sigmoid → inconsistent brightness across bodies and cross-camera
//! mismatch. This stage measures the scene's mid-tone in scene-linear
//! Rec.2020 and applies a scalar gain that pushes it to 0.18 BEFORE AgX.
//! Every camera lands at the same AgX position by default.
//!
//! # Algorithm
//!
//! 1. Compute per-pixel luma `Y = dot(REC2020, RGB)` and the geometric
//!    mean of `Y` in the middle 50% percentile range of the distribution
//!    (`P25 ≤ Y ≤ P75`). Trimming the top and bottom 25% gives a robust
//!    mid-tone estimate that ignores specular highlights and crushed
//!    shadows.
//! 2. `anchor_gain = clamp(0.18 / scene_midgrey, max = 8.0)`. The 8.0 cap
//!    (= +3 EV) prevents night scenes (where the midgrey approaches zero)
//!    from blowing out specular highlights into AgX. Black-frame /
//!    degenerate inputs short-circuit to `anchor_gain = 1.0` so the stage
//!    stays well-defined.
//! 3. Scene-linear multiply: `RGB *= anchor_gain`. Commutes with every
//!    subsequent scene-linear op (white balance, scene tone controls,
//!    user exposure, curves) so placement here is algebraically
//!    equivalent to folding the gain into any of those.
//!
//! # User exposure stacks additively on top
//!
//! The user's `AdjustmentModel::exposure` slider is applied downstream in
//! [`crate::stages::scene_tone_controls`] step 1. Mathematically the chain
//! is `pixel * anchor_gain * 2^user_ev`, which the two stages produce by
//! commuting multiplies — same result as a single composed multiply by
//! `anchor_gain * 2^user_ev`. User exposure becomes a relative offset on
//! top of the per-scene anchor, not an absolute setting.
//!
//! # Default behavior
//!
//! `AdjustmentModel::auto_exposure = AutoExposureMode::On` by default. To
//! opt out per-image (e.g. for strict scene-referred output), set
//! `papp:AutoExposure="Off"` in the XMP sidecar — the stage becomes
//! identity for that image.
//!
//! # History — band-aids removed
//!
//! Earlier versions of this file carried a 1:1 port of RawTherapee's
//! `getAutoExp` histogram-shape algorithm (8192 bins → octile-weighted
//! `expcomp` returning an EV) gated behind a `AE_DAMPING = 0.0` constant
//! so it shipped as identity. The same code path was tuned to non-zero
//! damping at one point (commit d431fcf), then reverted in `ba8e0ecb`
//! when the WB pre-gain bundle (Phase 1.2) gave the chain a correct
//! foundation; the unused infrastructure was kept "for a future Auto
//! toggle." Ticket #429 wires up the real scene-anchor algorithm above,
//! which replaces the histogram-shape port and its dead-code AE_DAMPING
//! / MAPLE_AE_DAMPING knobs. The RT port and its raw-CFA companion
//! `build_luma_histogram_from_raw` were deleted in this PR — nothing else
//! consumed the histogram or the engine-shaped `AutoExposure` struct
//! they returned.

use crate::image::{ColorSpace, Image};
use crate::xmp::{AdjustmentModel, AutoExposureMode};

/// Rec.2020 luma weights — match the working color space of the post-DCP
/// `Image` we sample (see `crate::stages::scene_tone_controls::LUMA_REC2020`).
const LUMA_REC2020: [f32; 3] = [0.2627, 0.6780, 0.0593];

/// Target scene-linear value for mid-gray going into AgX. Matches
/// `AGX_MID_GRAY` in `crate::view::agx::coeffs` (0.18); we duplicate the
/// constant here to avoid pulling the `view` module into the `stages`
/// dependency graph, and the literal is the load-bearing scene-referred
/// constant of the entire pipeline.
const SCENE_MIDGRAY_TARGET: f32 = 0.18;

/// Clip on `anchor_gain` so a near-black scene (midgrey → 0) does not
/// drive a hyper-multiplier that blows out specular highlights into the
/// AgX toe. +3 EV (= 8.0) is a conservative ceiling — night scenes
/// either land at -3 EV after the clip (still a meaningful brighten) or
/// the user follows up with explicit exposure compensation.
const MAX_ANCHOR_GAIN: f32 = 8.0;

/// Floor on `scene_midgrey` for the gain division — prevents NaN /
/// Infinity when the trimmed-mean evaluates to zero. The clamp on
/// `anchor_gain` already caps the output; this guard is just numerical
/// safety against the division.
const MIDGREY_FLOOR: f32 = 1e-6;

/// Scene-anchor gain for `image`.
///
/// Returns the scalar gain that, when multiplied into scene-linear
/// pixels, places the geometric mean of luma in the middle 50% percentile
/// band at [`SCENE_MIDGRAY_TARGET`] (0.18). Result is clamped to
/// `(0.0, MAX_ANCHOR_GAIN]` so degenerate inputs cannot produce wild
/// gains. Returns `1.0` for an all-zero / degenerate image so the
/// stage is well-defined and the caller can multiply unconditionally.
///
/// Deterministic per image; no temporal smoothing or random sampling.
pub fn compute_scene_anchor_gain(image: &Image) -> f32 {
    image.assert_space(ColorSpace::SceneLinearRec2020);
    let n = image.pixels.len();
    if n == 0 {
        return 1.0;
    }

    // Build a luma vector. We need percentile boundaries, so partition.
    // Use `select_nth_unstable_by` (quickselect, O(n) average) instead of a
    // full sort (O(n log n)) — we only need the elements positioned at the
    // P25/P75 ranks, not a fully ordered array. The geometric mean over the
    // [P25..P75) band is order-independent, so the multiset returned by the
    // two-stage partition is bit-equivalent to the fully-sorted band's
    // slice.
    let mut luma: Vec<f32> = image
        .pixels
        .iter()
        .map(|p| LUMA_REC2020[0] * p[0] + LUMA_REC2020[1] * p[1] + LUMA_REC2020[2] * p[2])
        .collect();
    // NaN filter — scene-linear luma can technically carry NaN if the DCP
    // path mishandled an edge pixel; we drop them so the percentile math
    // doesn't degenerate (and so the unstable cmp closure can't see NaN).
    luma.retain(|y| y.is_finite());
    if luma.is_empty() {
        return 1.0;
    }

    let len = luma.len();
    let p25 = len / 4;
    let p75 = (len * 3) / 4;
    // p75 is exclusive (we want indices [p25, p75)); guard against the
    // degenerate len < 4 case where p25 == p75.
    let p75 = p75.max(p25 + 1).min(len);

    // Position the P25-th element at index `p25` (O(n) quickselect). After
    // this call: `luma[..p25] ≤ luma[p25] ≤ luma[p25..]` as a partition,
    // though the two sides are not internally ordered.
    let cmp = |a: &f32, b: &f32| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal);
    luma.select_nth_unstable_by(p25, cmp);
    // Within the upper-3/4 partition `luma[p25..]`, position the P75-th
    // element. Skip when `p75 == len` — the second select would index past
    // the slice end. After this call: `luma[p25..p75]` contains the same
    // multiset as the original `[p25..p75)` band of a fully-sorted array.
    if p75 < len {
        let upper = &mut luma[p25..];
        upper.select_nth_unstable_by(p75 - p25, cmp);
    }
    let band = &luma[p25..p75];

    // Geometric mean = exp(mean(ln(y))). Drop non-positive samples — they
    // would map to -infinity in log space and silently dominate the mean.
    // For black scenes this leaves an empty band → bail to gain = 1.0.
    let mut log_sum = 0.0_f64;
    let mut count = 0_u64;
    for &y in band {
        if y > 0.0 {
            log_sum += (y as f64).ln();
            count += 1;
        }
    }
    if count == 0 {
        return 1.0;
    }
    let log_mean = log_sum / count as f64;
    let midgrey = log_mean.exp() as f32;
    if midgrey < MIDGREY_FLOOR || !midgrey.is_finite() {
        return 1.0;
    }

    let raw_gain = SCENE_MIDGRAY_TARGET / midgrey;
    if !raw_gain.is_finite() || raw_gain <= 0.0 {
        return 1.0;
    }
    raw_gain.min(MAX_ANCHOR_GAIN)
}

/// Apply scene-anchor in place. Honors `model.auto_exposure`:
///
/// * `AutoExposureMode::On` (default) — compute the anchor gain via
///   [`compute_scene_anchor_gain`] and multiply scene-linear pixels.
///   Bit-identity when the gain reduces to 1.0 (typical of synthetic
///   tests with `linear_value = 0.18`).
/// * `AutoExposureMode::Off` — identity. Used for strict scene-referred
///   output where the absolute scene-linear value matters.
///
/// User exposure (`model.exposure`) is NOT applied here — it stacks
/// downstream in `scene_tone_controls::apply` step 1. The two scene-linear
/// multiplies commute, so the order is algebraically irrelevant; we keep
/// them separated for clarity (this stage is "where is the scene?", the
/// other is "where does the user want it?"). Returns the gain applied
/// so callers (diagnostics, future UI) can read it; the production
/// pipeline discards the return value.
pub fn apply(image: &mut Image, model: &AdjustmentModel) -> f32 {
    image.assert_space(ColorSpace::SceneLinearRec2020);
    match model.auto_exposure {
        AutoExposureMode::Off => 1.0,
        AutoExposureMode::On => {
            let gain = compute_scene_anchor_gain(image);
            if (gain - 1.0).abs() > 1e-6 {
                for p in &mut image.pixels {
                    p[0] *= gain;
                    p[1] *= gain;
                    p[2] *= gain;
                }
            }
            gain
        }
    }
}

#[cfg(test)]
mod tests;
