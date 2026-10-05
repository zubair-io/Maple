//! Fitted white-balance component of the Auto 2.0 fit — #1740 milestone M3.
//!
//! Identifies the GLOBAL illuminant gap between Maple's neutral render and the
//! camera JPEG from the same scattered `(maple, jpeg)` display pairs the
//! structured solver fits (`from_pairs.rs`). The estimate is a diagonal gain
//! triple (green-normalised, ±2-stop clamped) plus its ACR slider-unit reading
//! (temperature/tint via the DNG Robertson path), so shells can surface Auto's
//! white-balance decision as a visible, undoable offset next to the user's own
//! temperature/tint sliders. Identity decay is structural: any estimate that
//! fails its confidence gates reports exact identity (`[1, 1, 1]` / 6500 K /
//! 0), never a clamped guess — a shell that ignores the flag still shows
//! something harmless. The anchor means "no data", not "D65 measured": a
//! faithfully measured cast-free frame reads ≈ +10 tint, the DNG Robertson
//! locus's own offset from CIE D65 (shared with the slider frame, so the
//! numbers stay comparable).
//!
//! This is the quantity #1688 (pre-fit chromatic adaptation, reverted under
//! #1709 for an un-harness-gated baseline_auto regression) and M3's surfacing
//! half both need, fitted ONCE: the future pre-fit alignment step divides the
//! Maple side by these gains before the tonescale/field fit, and the shells
//! display the same gains as the offset. That alignment is deliberately NOT
//! part of this module — it changes pixels and needs the fixture harness to
//! land; this module is measurement-only and has no render-path caller, so it
//! cannot move a single ΔE.
//!
//! Shell contract: `docs/pipeline.md` § "Auto exposure, Auto Profile, Auto
//! Adjustments". Offline measurement: `maple-cli fit-auto2` prints the JSON
//! below for any RAW with an embedded JPEG.

use super::from_pairs::NEUTRAL_CHROMA_FRAC;
use crate::color::dng_temperature::xy_to_temp_tint;
use crate::color::matrices::M_REC2020_TO_SRGB;
use crate::color::oklab::rec2020_to_oklab;
use crate::stages::auto_adjustments_awb::schema_range;
use crate::view::agx_inverse::srgb_gamma_inv;
use crate::view::auto_profile::pairs::DisplayPair;

/// Gain clamp, ±2 stops. Both renders being compared are white-balanced, so a
/// real illuminant gap beyond this is implausible — anything larger is scene
/// content or a clipped channel voting, and rails the estimate into decay.
const WB_GAIN_MIN: f32 = 0.25;
const WB_GAIN_MAX: f32 = 4.0;

/// Minimum neutral pairs for a confident estimate. A median over 64 ratios
/// carries sub-percent standard error against JPEG quantization noise, and is
/// far below the thousands of neutrals a normal frame yields.
const MIN_WB_PAIRS: usize = 64;

/// Population-agreement gate: max over channels of the (p90 − p10) spread of
/// log2 ratios. A true global cast reads the same ratio at every luminance;
/// wider spread means luma-dependent tone differences are leaking into the
/// ratios and the diagonal model is wrong for this frame. Fixture-tunable.
const MAX_SPREAD_LOG2: f32 = 0.5;

/// 8-bit near-white, matching the chart solver's clip mask (`mod.rs`
/// `is_clipped_for_ev`): a clipped channel carries no ratio information, and
/// a blown highlight votes the clip-point hue, not the illuminant (#2247).
const CLIP_8BIT: f32 = 250.0 / 255.0;

/// Linear-space floor for ratio formation (≈ gamma 0.033). Below this the
/// JPEG's 8-bit quantization dominates the ratio and shadow noise explodes it.
const WB_LINEAR_FLOOR: f32 = 1e-3;

/// Field chroma span the neutral fraction is measured against — the same
/// `0.30` `from_pairs.rs` uses, so this gate admits exactly the population
/// the tonescale fit anchors to.
const FIELD_CHROMA_SPAN: f32 = 0.30;

/// D65 anchor reported (exactly) whenever the estimate decays to identity.
const D65_ANCHOR_TEMP: f32 = 6500.0;

/// Auto 2.0's fitted white-balance component: what global cast the camera
/// JPEG carries relative to Maple's neutral render, in physically meaningful
/// units. Infallibly constructed — failure modes decay to identity.
#[derive(Clone, Debug)]
pub struct WbEstimate {
    /// Diagonal gains mapping Maple-white onto JPEG-white, green-normalised
    /// (`[r, 1, b]`), clamped to [`WB_GAIN_MIN`]`..=`[`WB_GAIN_MAX`]. Exactly
    /// `[1, 1, 1]` when `confident` is false.
    pub gains: [f32; 3],
    /// The gains' white read as an ACR temperature slider value (Kelvin,
    /// schema-domain clamped). Exactly 6500.0 when `confident` is false.
    pub temperature_k: f32,
    /// The gains' white read as an ACR tint slider value (schema-domain
    /// clamped). Exactly 0.0 when `confident` is false.
    pub tint: f32,
    /// Neutral pairs that survived every gate and voted.
    pub pairs_used: usize,
    /// Total pairs offered.
    pub pairs_total: usize,
    /// Max over channels of the (p90 − p10) log2-ratio spread. 0.0 when fewer
    /// than 2 pairs voted.
    pub spread_log2: f32,
    /// Count, spread, rail, and finiteness gates all passed. Shells display
    /// the offset only when this is true (and get identity either way).
    pub confident: bool,
}

impl WbEstimate {
    /// Serialise for `maple-cli fit-auto2` and the shell handoff. Hand-rolled,
    /// matching `AcrModel::to_json` (the crate stays serde-free).
    pub fn to_json(&self) -> String {
        format!(
            "{{\"gains\":[{:.4},{:.4},{:.4}],\"temperature_k\":{:.1},\
             \"tint\":{:.2},\"pairs_used\":{},\"pairs_total\":{},\
             \"spread_log2\":{:.4},\"confident\":{}}}",
            self.gains[0],
            self.gains[1],
            self.gains[2],
            self.temperature_k,
            self.tint,
            self.pairs_used,
            self.pairs_total,
            self.spread_log2,
            self.confident,
        )
    }
}

/// Estimate the JPEG's global cast from scattered display pairs.
///
/// Each near-neutral pair votes `jpeg_lin / maple_lin` per channel in LINEAR
/// sRGB (the JPEG's native space — no primary rotation touches the ratios);
/// the per-channel MEDIAN over the voting population is the estimate. Median,
/// not mean: a few mis-gated saturated pairs must not skew a global quantity.
/// The neutral gate is the tonescale fit's own population (predicted Oklab
/// chroma on the Maple side), so the surfaced offset describes the neutrals
/// the fit actually anchored to.
///
/// Never fails: sparse, clipped, disagreeing, or railed populations decay to
/// the D65 identity, with the diagnostics (`pairs_used`, `spread_log2`)
/// telling why.
pub fn estimate_illuminant_gains(pairs: &[DisplayPair]) -> WbEstimate {
    let m_srgb_to_rec2020 = M_REC2020_TO_SRGB
        .inverse()
        .expect("M_REC2020_TO_SRGB invertible");
    let chroma_max = NEUTRAL_CHROMA_FRAC * FIELD_CHROMA_SPAN;

    let mut ratios: [Vec<f32>; 3] = [Vec::new(), Vec::new(), Vec::new()];
    for p in pairs {
        if let Some(vote) = pair_ratios(p, &m_srgb_to_rec2020, chroma_max) {
            ratios[0].push(vote[0]);
            ratios[1].push(vote[1]);
            ratios[2].push(vote[2]);
        }
    }
    let pairs_used = ratios[0].len();
    let spread_log2 = population_spread(&mut ratios);
    let medians = ratios.map(|r| median_sorted(&r));

    // Green-normalise before bounding: the gains are a WHITE (chromaticity),
    // and overall brightness belongs to the tonescale, not this offset.
    let g = medians[1].max(f32::MIN_POSITIVE);
    let white = [medians[0] / g, 1.0, medians[2] / g];
    let railed = white.iter().any(|v| *v < WB_GAIN_MIN || *v > WB_GAIN_MAX);
    let (x, y) = gains_to_xy(white);
    let (temperature, tint) = xy_to_temp_tint(x, y);

    let confident = pairs_used >= MIN_WB_PAIRS
        && spread_log2 <= MAX_SPREAD_LOG2
        && !railed
        && white.iter().all(|v| v.is_finite())
        && temperature.is_finite()
        && tint.is_finite();
    if !confident {
        return WbEstimate {
            gains: [1.0, 1.0, 1.0],
            temperature_k: D65_ANCHOR_TEMP,
            tint: 0.0,
            pairs_used,
            pairs_total: pairs.len(),
            spread_log2,
            confident: false,
        };
    }
    let (t_lo, t_hi) = schema_range("temperature");
    let (tint_lo, tint_hi) = schema_range("tint");
    WbEstimate {
        gains: white.map(|v| v.clamp(WB_GAIN_MIN, WB_GAIN_MAX)),
        temperature_k: temperature.clamp(t_lo, t_hi),
        tint: tint.clamp(tint_lo, tint_hi),
        pairs_used,
        pairs_total: pairs.len(),
        spread_log2,
        confident: true,
    }
}

/// One pair's vote, or `None` when the pair is unusable. Gates, in order:
/// finiteness, 8-bit clip on EITHER side, linear floor on EVERY channel, then
/// the tonescale's neutral-chroma gate on the Maple (predicted) side. The JPEG
/// side is deliberately NOT chroma-gated: a saturated JPEG vote against a
/// neutral Maple pixel IS the cast signal, and the median absorbs the rest.
fn pair_ratios(
    pair: &DisplayPair,
    m_srgb_to_rec2020: &crate::math::Matrix3,
    chroma_max: f32,
) -> Option<[f32; 3]> {
    let gamma = [
        pair.maple[0],
        pair.maple[1],
        pair.maple[2],
        pair.jpeg[0],
        pair.jpeg[1],
        pair.jpeg[2],
    ];
    if gamma.iter().any(|v| !v.is_finite() || *v >= CLIP_8BIT) {
        return None;
    }
    let maple_lin = [
        srgb_gamma_inv(pair.maple[0]),
        srgb_gamma_inv(pair.maple[1]),
        srgb_gamma_inv(pair.maple[2]),
    ];
    let jpeg_lin = [
        srgb_gamma_inv(pair.jpeg[0]),
        srgb_gamma_inv(pair.jpeg[1]),
        srgb_gamma_inv(pair.jpeg[2]),
    ];
    if maple_lin
        .iter()
        .chain(jpeg_lin.iter())
        .any(|v| *v < WB_LINEAR_FLOOR)
    {
        return None;
    }
    let lab = rec2020_to_oklab(m_srgb_to_rec2020.mul_vec(maple_lin));
    let chroma = (lab[1] * lab[1] + lab[2] * lab[2]).sqrt();
    if chroma > chroma_max {
        return None;
    }
    Some([
        jpeg_lin[0] / maple_lin[0],
        jpeg_lin[1] / maple_lin[1],
        jpeg_lin[2] / maple_lin[2],
    ])
}

/// Max over channels of the (p90 − p10) log2 spread. Sorts each channel's
/// ratios in place (the medians below read the same order). 0.0 when fewer
/// than 2 pairs voted — the count gate, not this value, rejects them.
fn population_spread(ratios: &mut [Vec<f32>; 3]) -> f32 {
    let mut spread = 0.0f32;
    for channel in ratios.iter_mut() {
        if channel.len() < 2 {
            continue;
        }
        channel.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let lo = channel[channel.len() / 10];
        let hi = channel[channel.len() * 9 / 10];
        spread = spread.max((hi / lo).log2());
    }
    spread
}

/// Median of a SORTED ratio population. Empty input yields 1.0 — the median of
/// nothing is identity, and the count gate rejects the estimate regardless.
fn median_sorted(sorted: &[f32]) -> f32 {
    if sorted.is_empty() {
        return 1.0;
    }
    let mid = sorted.len() / 2;
    if sorted.len() % 2 == 1 {
        sorted[mid]
    } else {
        (sorted[mid - 1] + sorted[mid]) / 2.0
    }
}

/// Read green-normalised gains as a CIE xy white: for a neutral Maple pixel
/// `[v, v, v]` the JPEG reads `[g_r·v, v, g_b·v]`, so the JPEG's white
/// chromaticity IS the gain triple in linear sRGB. sRGB → XYZ D65 is the
/// IEC 61966-2-1 matrix (same coefficients `model::srgb_linear_to_lab` uses).
pub(crate) fn gains_to_xy(gains: [f32; 3]) -> (f32, f32) {
    let x = 0.4124564 * gains[0] + 0.3575761 * gains[1] + 0.1804375 * gains[2];
    let y = 0.2126729 * gains[0] + 0.7151522 * gains[1] + 0.0721750 * gains[2];
    let z = 0.0193339 * gains[0] + 0.1191920 * gains[1] + 0.9503041 * gains[2];
    let sum = (x + y + z).max(f32::MIN_POSITIVE);
    (x / sum, y / sum)
}

// Tests live in the sibling `wb_tests.rs` so this file stays under the
// file-size budget (same `#[path]` split pattern as `from_pairs.rs`).
#[cfg(test)]
#[path = "wb_tests.rs"]
mod tests;
