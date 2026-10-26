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
use crate::stages::local_adjustments::range;
use crate::stages::white_balance_sample::neighbourhood_mean;
use crate::types::{RangeRefinement, SKIN_TONE_RANGE};
use crate::xmp::AdjustmentModel;

const MIN_DEFAULT_SKIN_COVERAGE_WEIGHT: f32 = 0.005;

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
pub fn stage_input_model(model: &AdjustmentModel) -> AdjustmentModel {
    AdjustmentModel {
        local_adjustments: Vec::new(),
        mask_rasters: Vec::new(),
        vignette_amount: 0.0,
        sharpen_amount: 0.0,
        nr_luminance: 0.0,
        nr_color: 0.0,
        display_tone_curve_luma: Default::default(),
        display_tone_curve_red: Default::default(),
        display_tone_curve_green: Default::default(),
        display_tone_curve_blue: Default::default(),
        split_tone_shadow_saturation: 0.0,
        split_tone_highlight_saturation: 0.0,
        color_grade_shadow_luminance: 0.0,
        color_grade_midtone_saturation: 0.0,
        color_grade_midtone_luminance: 0.0,
        color_grade_highlight_luminance: 0.0,
        color_grade_global_saturation: 0.0,
        color_grade_global_luminance: 0.0,
        grain_amount: 0.0,
        film_strength: 0.0,
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

fn signed_circular_delta_deg(a: f32, b: f32) -> f32 {
    let raw = (a - b) % 360.0;
    if raw > 180.0 {
        raw - 360.0
    } else if raw <= -180.0 {
        raw + 360.0
    } else {
        raw
    }
}

/// Evaluate [`SKIN_TONE_RANGE`] for a person-skin mask on the pre-`local_adjustments`
/// scene-linear Rec.2020 `RGBAf` buffer (`width * height * 4` floats).
///
/// The candidate skin seed is derived exclusively from `face_skin_mask_bytes`
/// (the person's face region, never torso/clothing pixels) and applied only
/// when [`SKIN_TONE_RANGE`] (`55° ± 25°`) is inert on the face skin and the
/// face-seeded range improves coverage on `target_mask_bytes` (#5317).
pub fn seed_skin_mask_range_if_default_inert(
    rgba_rec2020: &[f32],
    width: usize,
    height: usize,
    target_mask_bytes: &[u8],
    face_skin_mask_bytes: &[u8],
) -> Option<RangeSeed> {
    let pixel_count = width.checked_mul(height)?;
    if width == 0
        || height == 0
        || target_mask_bytes.len() != pixel_count
        || face_skin_mask_bytes.len() != pixel_count
        || rgba_rec2020.len() != pixel_count.checked_mul(4)?
    {
        return None;
    }

    let step = (width.min(height) / 512).max(1);
    let mut face_default_weight_sum = 0.0_f32;
    let mut hues = Vec::new();
    let mut chromas = Vec::new();
    let mut lightnesses = Vec::new();
    let mut sum_sin = 0.0_f32;
    let mut sum_cos = 0.0_f32;

    for y in (0..height).step_by(step) {
        let row_offset = y * width;
        for x in (0..width).step_by(step) {
            let idx = row_offset + x;
            if face_skin_mask_bytes[idx] < 128 {
                continue;
            }
            let base = idx * 4;
            let rgb = [
                rgba_rec2020[base],
                rgba_rec2020[base + 1],
                rgba_rec2020[base + 2],
            ];
            let lab = rec2020_to_oklab(rgb);
            let (l, a, b) = (lab[0], lab[1], lab[2]);
            let chroma = (a * a + b * b).sqrt();
            if !(l.is_finite()
                && chroma.is_finite()
                && (0.08..=0.98).contains(&l)
                && (0.015..=0.18).contains(&chroma))
            {
                continue;
            }
            let hue_deg = b.atan2(a).to_degrees();
            if !(-55.0..=95.0).contains(&hue_deg) {
                continue;
            }
            face_default_weight_sum += range::weight(&SKIN_TONE_RANGE, rgb);
            hues.push(hue_deg);
            chromas.push(chroma);
            lightnesses.push(l);
            let rad = hue_deg.to_radians();
            sum_sin += rad.sin();
            sum_cos += rad.cos();
        }
    }

    if hues.is_empty() {
        return None;
    }
    if face_default_weight_sum / (hues.len() as f32) >= MIN_DEFAULT_SKIN_COVERAGE_WEIGHT {
        return None;
    }

    let mean_hue = sum_sin.atan2(sum_cos).to_degrees();
    let mut deltas: Vec<f32> = hues
        .iter()
        .map(|&h| signed_circular_delta_deg(h, mean_hue))
        .collect();
    deltas.sort_by(f32::total_cmp);
    chromas.sort_by(f32::total_cmp);
    lightnesses.sort_by(f32::total_cmp);

    let median_hue = signed_circular_delta_deg(mean_hue + deltas[deltas.len() / 2], 0.0);
    let sample = RangeSample {
        hue_deg: median_hue,
        chroma: chromas[chromas.len() / 2],
        l: lightnesses[lightnesses.len() / 2],
    };
    let mut seed = RangeSeed::from_sample(&sample);
    seed.l_min = seed.l_min.min(0.15);
    seed.l_max = seed.l_max.max(0.95);
    let adapted_range = SKIN_TONE_RANGE.with_seed(&seed);

    let mut target_default_weight_sum = 0.0_f32;
    let mut target_adapted_weight_sum = 0.0_f32;
    for y in (0..height).step_by(step) {
        let row_offset = y * width;
        for x in (0..width).step_by(step) {
            let idx = row_offset + x;
            if target_mask_bytes[idx] < 128 {
                continue;
            }
            let base = idx * 4;
            let rgb = [
                rgba_rec2020[base],
                rgba_rec2020[base + 1],
                rgba_rec2020[base + 2],
            ];
            target_default_weight_sum += range::weight(&SKIN_TONE_RANGE, rgb);
            target_adapted_weight_sum += range::weight(&adapted_range, rgb);
        }
    }
    if target_adapted_weight_sum <= target_default_weight_sum {
        return None;
    }
    Some(seed)
}

#[cfg(test)]
#[path = "mask_range_sample_tests.rs"]
mod tests;
