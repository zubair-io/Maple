//! Colour-range eyedropper (#362): "select the colour I clicked" for a
//! mask's [`RangeRefinement::Color`], as one committed action with the same
//! shape the neutral white-balance sampler (#2434) has.
//!
//! The refinement is evaluated by `local_adjustments::range::weight` on the
//! pixel ENTERING the local-adjustments stage — scene-linear Rec.2020 after
//! white balance, the tone controls, curves, vibrance, saturation, HSL,
//! clarity, texture and dehaze, before the layer's own edit — so that is
//! exactly the buffer this sampler reads. It develops the RAW under the
//! CURRENT model (not AUTO's tone-at-rest probe: the range must track the
//! exposure and white balance the photographer is looking at) with the
//! stack itself and every stage downstream of it (vignette, sharpen, noise
//! reduction) switched off, which stops the develop at the stage boundary
//! bit-for-bit rather than approximating it. A 5×5 neighbourhood is averaged
//! (a single pixel is noise, not a colour), converted to Oklab, and reported
//! as hue / chroma / lightness.
//!
//! [`RangeSeed`] is the part the hosts write into the layer: the hue, a
//! chroma floor and a lightness window placed so the sampled colour lands at
//! weight 1 (`seed_lands_at_full_weight`). The band width and feather are
//! deliberately NOT part of the seed — they are the user's taste, kept from
//! whatever the layer already carries.
//!
//! Analysis, not a develop stage: nothing here has a WGSL counterpart.

use crate::color::oklab::rec2020_to_oklab;
use crate::image::{ColorSpace, Image, RawImage};
use crate::pipeline::{develop_scene_linear_from_raw_with_quality, RenderQuality};
use crate::stages::white_balance_sample::neighbourhood_mean;
use crate::types::RangeRefinement;
use crate::xmp::AdjustmentModel;

/// Below this Oklab chroma the hue is the neutral axis's noise, not a colour.
/// Twice the smallest chroma floor the seed can write (`0.01`), so a colour
/// that passes lands at weight 1 through the `smoothstep(c0, 2·c0)` gate.
pub const CHROMA_FLOOR: f32 = 0.02;

/// Below this Oklab lightness the surface is black — no usable colour.
pub const L_FLOOR: f32 = 0.05;

/// Half-height of the lightness window the seed opens around the sample.
pub const L_WINDOW: f32 = 0.25;

/// The Oklab reading of the sampled neighbourhood.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RangeSample {
    /// Oklab hue in degrees, `(-180, 180]`.
    pub hue_deg: f32,
    /// Oklab chroma `sqrt(a² + b²)`.
    pub chroma: f32,
    /// Oklab lightness.
    pub l: f32,
}

/// The four range coordinates a sample seeds, quantised to the two decimals
/// every sidecar writer emits (`fmt2` / `fmtNum` / `numericSerializer`), so
/// the model a host holds after a pick is byte-for-byte what its sidecar
/// says.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RangeSeed {
    pub hue_deg: f32,
    pub chroma_min: f32,
    pub l_min: f32,
    pub l_max: f32,
}

/// Why a click could not become a colour range. Each variant is a
/// user-facing situation the front ends phrase as an actionable message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RangeSampleError {
    /// The normalised point is outside `[0, 1]²`.
    OutsideImage,
    /// The surface is (near) neutral — there is no hue to select.
    Neutral,
    /// The surface is black — no usable colour.
    TooDark,
    /// The develop failed (unsupported RAW, cancelled, …).
    Develop(String),
}

impl std::fmt::Display for RangeSampleError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::OutsideImage => write!(f, "sample point is outside the image"),
            Self::Neutral => write!(f, "sampled surface is neutral — pick a coloured area"),
            Self::TooDark => write!(f, "sampled surface is too dark — pick a brighter area"),
            Self::Develop(e) => write!(f, "could not develop the sample: {e}"),
        }
    }
}

impl std::error::Error for RangeSampleError {}

/// Sample the colour at normalised image point `(nx, ny)` — `(0, 0)` the
/// top-left corner, `(1, 1)` the bottom-right — as the local-adjustments
/// stage would see it under `model`.
pub fn sample_mask_range(
    raw: &RawImage,
    model: &AdjustmentModel,
    nx: f32,
    ny: f32,
) -> Result<RangeSample, RangeSampleError> {
    if !((0.0..=1.0).contains(&nx) && (0.0..=1.0).contains(&ny)) {
        return Err(RangeSampleError::OutsideImage);
    }
    let probe = develop_scene_linear_from_raw_with_quality(
        raw,
        &stage_input_model(model),
        RenderQuality::Preview,
    )
    .map_err(|e| RangeSampleError::Develop(e.to_string()))?;
    sample_from_probe(&probe, nx, ny)
}

/// `model` with the local-adjustment stack and every stage after it
/// switched off, so the scene-linear develop ends with the buffer that
/// stage reads. Each of those stages is a bit-identical no-op at zero.
pub(crate) fn stage_input_model(model: &AdjustmentModel) -> AdjustmentModel {
    AdjustmentModel {
        local_adjustments: Vec::new(),
        mask_rasters: Vec::new(),
        vignette_amount: 0.0,
        sharpen_amount: 0.0,
        nr_luminance: 0.0,
        nr_color: 0.0,
        ..model.clone()
    }
}

/// The judgement half of [`sample_mask_range`], on an already-developed
/// probe — split out so tests can drive it on synthetic buffers.
pub(crate) fn sample_from_probe(
    probe: &Image,
    nx: f32,
    ny: f32,
) -> Result<RangeSample, RangeSampleError> {
    probe.assert_space(ColorSpace::SceneLinearRec2020);
    let mean = neighbourhood_mean(probe, nx, ny).ok_or(RangeSampleError::OutsideImage)?;
    let lab = rec2020_to_oklab(mean);
    let (l, a, b) = (lab[0], lab[1], lab[2]);
    let chroma = (a * a + b * b).sqrt();
    if !(l.is_finite() && chroma.is_finite()) {
        return Err(RangeSampleError::Develop("non-finite sample".into()));
    }
    if l < L_FLOOR {
        return Err(RangeSampleError::TooDark);
    }
    if chroma < CHROMA_FLOOR {
        return Err(RangeSampleError::Neutral);
    }
    Ok(RangeSample {
        hue_deg: b.atan2(a).to_degrees(),
        chroma,
        l,
    })
}

fn floor2(v: f32) -> f32 {
    (v * 100.0).floor() / 100.0
}

fn ceil2(v: f32) -> f32 {
    (v * 100.0).ceil() / 100.0
}

fn round2(v: f32) -> f32 {
    (v * 100.0).round() / 100.0
}

impl RangeSeed {
    /// Place the range so `sample` reads weight 1: the chroma floor at half
    /// the sampled chroma (the gate is fully open from `2·chroma_min`), the
    /// lightness window `±L_WINDOW` around the sample, clamped to the
    /// `[0, 1]` slider domain. Rounding is always AWAY from the sample —
    /// the floor down, the window outward — so quantising never pushes it
    /// back onto a roll-off.
    pub fn from_sample(sample: &RangeSample) -> Self {
        Self {
            hue_deg: round2(sample.hue_deg),
            chroma_min: floor2(sample.chroma / 2.0).max(0.01),
            l_min: floor2(sample.l - L_WINDOW).clamp(0.0, 1.0),
            l_max: ceil2(sample.l + L_WINDOW).clamp(0.0, 1.0),
        }
    }
}

impl RangeRefinement {
    /// `self` re-centred on `seed`, keeping the band width and feather.
    pub fn with_seed(self, seed: &RangeSeed) -> Self {
        let Self::Color {
            hue_half_width_deg,
            feather,
            ..
        } = self;
        Self::Color {
            hue_deg: seed.hue_deg,
            hue_half_width_deg,
            chroma_min: seed.chroma_min,
            l_min: seed.l_min,
            l_max: seed.l_max,
            feather,
        }
    }
}

#[cfg(test)]
#[path = "mask_range_sample_tests.rs"]
mod tests;
