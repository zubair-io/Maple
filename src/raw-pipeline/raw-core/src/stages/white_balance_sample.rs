//! Neutral white-balance sampler (#2434): "make the surface I clicked read
//! neutral", as one committed action with the same shape AUTO has.
//!
//! The sample is taken from the SAME probe AUTO analyses — the AE-Off,
//! WB-pinned, tone-at-rest develop of the RAW at Preview quality
//! (`auto_adjustments::probe_model`) — so a sampled neutral and an Auto
//! estimate are two readings of one buffer, judged by one rule
//! ([`ProbeSpace`]): sensor-clipped channels are rejected, crushed pixels
//! are rejected, and the solve runs in the slider frame the develop chain
//! renders with, so a develop at the returned pair renders the sampled
//! surface neutral. A 5×5 neighbourhood around the click is averaged first
//! (a single pixel is noise, not a surface).
//!
//! Provenance: the returned [`WbSample`] carries [`WB_ALGORITHM_VERSION`],
//! which the caller stores as `wb_algorithm_version` next to
//! `wb_source = Sampled` and the normalised click point. Bump the constant
//! when the math that maps a neutral to a slider pair changes, so a sidecar
//! written by an older build is never silently reinterpreted.
//!
//! Analysis, not a develop stage: nothing here has a WGSL counterpart.

use crate::image::{ColorSpace, Image, RawImage};
use crate::pipeline::{develop_scene_linear_from_raw_with_quality, RenderQuality};
use crate::stages::auto_adjustments::{probe_model, LUMA_REC2020};
use crate::stages::auto_adjustments_awb::{chromaticity_of, schema_range, ProbeSpace};
use crate::xmp::AdjustmentModel;

/// Version of the neutral → slider-pair derivation shared by the sampler
/// and AUTO's white balance (#2247's clip-aware, frame-consistent solve).
pub const WB_ALGORITHM_VERSION: u32 = 1;

/// Half-width of the averaged neighbourhood: 2 → a 5×5 window.
pub const SAMPLE_RADIUS: u32 = 2;

/// A committed sample: the slider pair plus the derivation's version.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct WbSample {
    pub temperature: f32,
    pub tint: f32,
    pub algorithm_version: u32,
}

/// Why a click could not become a white balance. Each variant is a
/// user-facing situation the front ends phrase as an actionable message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WbSampleError {
    /// The normalised point is outside `[0, 1]²`.
    OutsideImage,
    /// A channel of the sampled surface sits at the sensor's clip ceiling —
    /// its hue is a clipping artefact, not the light.
    Clipped,
    /// The surface is below the noise floor — no usable chromaticity.
    TooDark,
    /// The solve landed outside the slider domain (2000–12000 K / ±150):
    /// the surface is not a plausible neutral under any supported light.
    OutOfDomain,
    /// The probe develop failed (unsupported RAW, cancelled, …).
    Develop(String),
}

impl std::fmt::Display for WbSampleError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::OutsideImage => write!(f, "sample point is outside the image"),
            Self::Clipped => write!(f, "sampled surface is clipped — pick a darker neutral"),
            Self::TooDark => write!(f, "sampled surface is too dark — pick a brighter neutral"),
            Self::OutOfDomain => write!(
                f,
                "sampled surface is not a plausible neutral (outside 2000–12000 K)"
            ),
            Self::Develop(e) => write!(f, "could not develop the probe: {e}"),
        }
    }
}

impl std::error::Error for WbSampleError {}

/// Sample the neutral at normalised image point `(nx, ny)` — `(0, 0)` the
/// top-left corner, `(1, 1)` the bottom-right — and return the slider pair
/// that renders it neutral under `model`.
pub fn sample_white_balance(
    raw: &RawImage,
    model: &AdjustmentModel,
    nx: f32,
    ny: f32,
) -> Result<WbSample, WbSampleError> {
    if !((0.0..=1.0).contains(&nx) && (0.0..=1.0).contains(&ny)) {
        return Err(WbSampleError::OutsideImage);
    }
    let probe_model = probe_model(model);
    let probe =
        develop_scene_linear_from_raw_with_quality(raw, &probe_model, RenderQuality::Preview)
            .map_err(|e| WbSampleError::Develop(e.to_string()))?;
    let space = ProbeSpace::resolve(raw, &probe_model);
    sample_from_probe(&probe, &space, nx, ny)
}

/// The judgement half of [`sample_white_balance`], on an already-developed
/// probe — split out so tests can drive it on synthetic buffers.
pub(crate) fn sample_from_probe(
    probe: &Image,
    space: &ProbeSpace,
    nx: f32,
    ny: f32,
) -> Result<WbSample, WbSampleError> {
    probe.assert_space(ColorSpace::SceneLinearRec2020);
    let mean = neighbourhood_mean(probe, nx, ny).ok_or(WbSampleError::OutsideImage)?;
    let luma = LUMA_REC2020[0] * mean[0] + LUMA_REC2020[1] * mean[1] + LUMA_REC2020[2] * mean[2];
    if !luma.is_finite() || luma < space.luma_floor() {
        return Err(WbSampleError::TooDark);
    }
    let judged = space.judge(mean);
    if space.is_clipped(judged) {
        return Err(WbSampleError::Clipped);
    }
    let (temperature, tint) = space
        .solve(chromaticity_of(judged))
        .ok_or(WbSampleError::OutOfDomain)?;
    let (t_lo, t_hi) = schema_range("temperature");
    let (tint_lo, tint_hi) = schema_range("tint");
    if !((t_lo..=t_hi).contains(&temperature) && (tint_lo..=tint_hi).contains(&tint)) {
        return Err(WbSampleError::OutOfDomain);
    }
    Ok(WbSample {
        temperature,
        tint,
        algorithm_version: WB_ALGORITHM_VERSION,
    })
}

/// Mean of the finite pixels in the `(2·SAMPLE_RADIUS + 1)²` window around
/// the normalised point, clipped to the image. `None` for an empty image.
fn neighbourhood_mean(probe: &Image, nx: f32, ny: f32) -> Option<[f32; 3]> {
    if probe.width == 0 || probe.height == 0 {
        return None;
    }
    let cx = (nx * (probe.width - 1) as f32).round() as i64;
    let cy = (ny * (probe.height - 1) as f32).round() as i64;
    let r = SAMPLE_RADIUS as i64;
    let x0 = (cx - r).max(0) as u32;
    let x1 = ((cx + r) as u32).min(probe.width - 1);
    let y0 = (cy - r).max(0) as u32;
    let y1 = ((cy + r) as u32).min(probe.height - 1);
    let (sum, n) = (y0..=y1)
        .flat_map(|y| (x0..=x1).map(move |x| (x, y)))
        .map(|(x, y)| probe.pixels[y as usize * probe.width as usize + x as usize])
        .filter(|p| p.iter().all(|v| v.is_finite()))
        .fold(([0.0_f64; 3], 0usize), |(s, n), p| {
            (
                [s[0] + p[0] as f64, s[1] + p[1] as f64, s[2] + p[2] as f64],
                n + 1,
            )
        });
    (n > 0).then(|| sum.map(|v| (v / n as f64) as f32))
}

#[cfg(test)]
#[path = "white_balance_sample_tests.rs"]
mod tests;
