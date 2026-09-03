//! Auto white balance — the illuminant estimate behind
//! [`super::auto_adjustments::compute_auto_adjustments`] (#2247).
//!
//! # Input
//!
//! The probe buffer `compute_auto_adjustments` develops: scene-linear
//! Rec.2020, `auto_exposure: Off`, white balance pinned to 6500 K / 0. What
//! that pin renders as depends on the tier: post-DCP CAT16 treats it as
//! identity; on a calibrated body `wb_camera::resolve_target` reads a
//! never-authored 6500 K / 0 (the `_seen` flags clear) as As Shot and an
//! authored one as a literal 6500 K camera-space target. Either way the
//! residual cast of the neutral population, measured against whatever the
//! chain applied, IS the illuminant estimate — [`ProbeSpace`] resolves the
//! same target through the same function and undoes the same gain.
//!
//! # What #2247 found, and how this module answers it
//!
//! The first estimator (#1371) railed tint on real fixtures (test_0017:
//! −83.6 against the camera's own +3.9; test_0006: −40 against +18.3). Four
//! defects, each with its own answer here:
//!
//! 1. **Clipped highlights voted.** The luma ceiling was a fixed 0.9 in
//!    scene-linear, but the sensor's clip point lands wherever the develop
//!    scale (`2^BaselineExposure`) and the per-channel WB gains put it —
//!    0.786 on test_0017, so the guard rejected nothing and the "white
//!    patch" was exactly the blown sky, whose hue is a clipping artefact
//!    (G and B clip, R does not, so the pre-gained R runs away → magenta).
//!    [`ProbeSpace`] maps every probe pixel back into the space where
//!    clipping is defined — post-gain camera RGB, through the inverse of
//!    the develop chain's own linear render matrix — and drops any pixel
//!    with a channel at its ceiling `2^BE · pre_gain[c] · wb_gain[c]` from
//!    BOTH terms.
//! 2. **The 0.6/0.4 blend was applied to un-normalised sums**, so the
//!    bright term's real weight scaled with its mean level (71% on
//!    test_0017 for a 0.12%-of-frame population). Both terms are reduced to
//!    a G-normalised chromaticity before blending, and the white-patch term
//!    has to be a real population ([`WHITE_PATCH_MIN_PIXELS`] and
//!    [`WHITE_PATCH_MIN_SHARE`]) before it votes at all.
//! 3. **The chroma gate selected for subject colour.** A fixed deviation
//!    threshold evaluated on an image that still carries the cast being
//!    estimated discards the most genuine neutral evidence precisely when
//!    the cast is strongest, leaving whatever the dominant subject was. The
//!    gate is now re-centred on the running estimate over a coarse-to-fine
//!    schedule ([`GATE_SCHEDULE`]), seeded from the camera's own as-shot
//!    reading ([`ProbeSpace::prior`]) — the physically motivated start, and
//!    the value the too-few-pixels fallback already returns.
//! 4. **The neutral was converted in the wrong frame.** The old path solved
//!    a diagonal Rec.2020 gain (`neutral_to_temp_tint`) while the develop
//!    chain applies the slider as a camera-space gain through the DNG
//!    slider frame. On calibrated bodies the measured neutral is now taken
//!    back to a raw camera neutral and solved through the same Robertson
//!    frame the as-shot estimate uses
//!    ([`SliderFrame::illuminant_temp_tint`]), so a develop at the
//!    recommendation neutralises the population it was measured on.
//!    Uncalibrated bodies (`ProfileSource::RawlerFallback`, lossy 8-bit
//!    LinearRaw) keep the post-DCP `neutral_to_temp_tint` path their render
//!    chain matches.
//! 5. **Nothing bounded the move.** With the four defects fixed, what is
//!    left is gray-world's own limit: on a frame whose neutral evidence is a
//!    brick wall (test_0017) or a blue sky (test_0011) the population mean
//!    is the subject, not the light, and the estimate overshoots ACR's Auto
//!    by 2–5× in mired. The camera metered the same scene with a
//!    scene-aware estimator, so its as-shot reading is the prior: the
//!    recommendation may move at most [`MAX_MIRED_MOVE`] / [`MAX_TINT_MOVE`]
//!    from it ([`bounded_by_prior`]) — a clamp, not a damping, so a real
//!    cast inside the bound is still corrected in full.
//!
//! The CI gate is `auto_adjustments_awb_fixture_tests`: agreement with the
//! camera's as-shot reading across the reference set, and idempotence — the
//! estimate re-run on a develop at its own recommendation returns the same
//! pair. This is analysis, not a develop stage: nothing here has a WGSL
//! counterpart in `raw-gpu`.

use crate::color::dcp::{self, ProfileSource};
use crate::image::{CfaPattern, ColorSpace, Image, RawImage};
use crate::math::Matrix3;
use crate::stages::wb_camera::{self, SliderFrame};
use crate::stages::white_balance::neutral_to_temp_tint;
use crate::types::adjustment::ADJUSTMENT_SCHEMA;
use crate::xmp::AdjustmentModel;

use super::auto_adjustments::LUMA_REC2020;

/// A channel this close to its clip ceiling counts as clipped. Preview-quality
/// demosaic averages a 2×2 quad, so a partly clipped quad lands a little
/// under the hard ceiling.
const CLIP_MARGIN: f32 = 0.03;

/// Luma floor as a fraction of the neutral clip level: crushed shadows and
/// noise carry no usable chromaticity.
const LUMA_MIN_FRACTION: f32 = 0.05;

/// Chroma-gate schedule, coarse to fine. Each entry is the maximum channel
/// deviation over the maximum channel, measured AFTER dividing the pixel by
/// the running neutral estimate — so the gate asks "how far from the current
/// idea of neutral", never "how far from the D65 render".
const GATE_SCHEDULE: [f32; 3] = [0.50, 0.35, 0.25];

/// Near-white admission for the white-patch term, as a fraction of the
/// neutral clip level.
const WHITE_PATCH_FRACTION: f32 = 0.7;

/// The white-patch term votes only when it is a real population: at least
/// this many pixels …
const WHITE_PATCH_MIN_PIXELS: usize = 1000;

/// … and at least this share of the gray-world survivors.
const WHITE_PATCH_MIN_SHARE: f32 = 0.005;

/// Gray-world weight in the chromaticity blend; the white-patch term gets the
/// rest. Applied to G-normalised chromaticities, so these ARE the weights.
const GRAY_WORLD_BLEND: f32 = 0.6;

/// Minimum gray-world survivors to trust the estimate at all. Below this the
/// camera-matrix-aware as-shot estimate is returned instead.
const MIN_PIXELS: usize = 64;

/// How far the recommendation may move from the camera's own as-shot
/// reading, in mired (reciprocal megakelvin — the perceptually even CCT
/// axis, so one bound serves 2500 K and 8000 K alike). A gray-world
/// estimate is an average, and on a frame whose neutral evidence is a
/// brick wall or a blue sky the average is the subject, not the light;
/// the camera metered the same scene with a scene-aware estimator, so its
/// reading is the prior and the bound is where the estimate stops
/// outvoting it. Calibrated against ACR's Auto on the reference set
/// (`auto_adjustments_awb_fixture_tests`): ACR's largest move there is
/// 83 mired (test_0007, tungsten), inside this bound.
const MAX_MIRED_MOVE: f32 = 80.0;

/// Same bound for tint, in slider units. ACR's largest tint move on the
/// reference set is 32 (test_0008).
const MAX_TINT_MOVE: f32 = 35.0;

/// The space a probe pixel is judged in: post-gain camera RGB on a calibrated
/// body (where the sensor's clip ceilings are per-channel constants and the
/// slider frame lives), the probe's own Rec.2020 otherwise.
pub(crate) struct ProbeSpace {
    /// Rec.2020 → judging space.
    to_space: Matrix3,
    /// Per-channel sensor clip ceiling in the judging space.
    ceilings: [f32; 3],
    /// Where a scene-neutral surface under the camera's as-shot illuminant
    /// lands in the judging space — the gate's seed. The probe's own WB gain
    /// on a calibrated body (identity when the probe rendered As Shot);
    /// plain neutral in the post-DCP tier, whose Bradford adaptation already
    /// renders the as-shot white as `[1, 1, 1]`.
    prior: [f32; 3],
    /// Scene-linear luma of a neutral surface at the sensor's clip point:
    /// the develop scale, `2^BaselineExposure`.
    neutral_clip: f32,
    tier: Tier,
}

enum Tier {
    /// `stages::wb_camera` ran on the probe: the recommendation is solved in
    /// the DNG slider frame from the raw camera neutral.
    Camera {
        frame: SliderFrame,
        gain: [f32; 3],
        pre_gain: [f32; 3],
    },
    /// Post-DCP white balance: the recommendation is solved as a Rec.2020
    /// gain, matching the render chain for this source.
    Generic,
}

impl ProbeSpace {
    /// Mirror of the develop chain's colour path for `probe_model`
    /// (`pipeline::develop`): BaselineExposure → AsShotNeutral pre-gain →
    /// camera-space WB gain → the DCP linear render matrix. The same tier
    /// decision the chain makes (`skip_pre_gain`, `RawlerFallback`) selects
    /// the generic space.
    pub(crate) fn resolve(raw: &RawImage, probe_model: &AdjustmentModel) -> Self {
        let neutral_clip = raw.baseline_exposure.exp2();
        let skip_pre_gain = matches!(raw.cfa, CfaPattern::LinearRgb) && raw.white_level <= 255;
        let camera = if skip_pre_gain {
            None
        } else {
            Self::camera_tier(raw, probe_model, neutral_clip)
        };
        camera.unwrap_or(Self {
            to_space: Matrix3::IDENTITY,
            ceilings: [neutral_clip; 3],
            prior: [1.0; 3],
            neutral_clip,
            tier: Tier::Generic,
        })
    }

    fn camera_tier(raw: &RawImage, model: &AdjustmentModel, neutral_clip: f32) -> Option<Self> {
        let (profile, source) = dcp::profile_for_with_source(raw).ok()?;
        if matches!(source, ProfileSource::RawlerFallback) {
            return None;
        }
        let frame = SliderFrame::resolve(raw, &profile);
        let (temperature, tint) =
            wb_camera::resolve_target_versioned(model, &frame, &profile, raw.as_shot_neutral);
        // `wb_camera::apply`'s identity short-circuit — the same predicate,
        // not a copy of it.
        let gain = if wb_camera::is_as_shot_target(&frame, temperature, tint) {
            [1.0; 3]
        } else {
            wb_camera::camera_wb_gain(&frame, raw.as_shot_neutral, temperature, tint)
        };
        let render = wb_camera::retargeted_render_profile(&frame, profile, temperature, tint);
        let to_space = dcp::camera_to_rec2020_matrix(&render).ok()?.inverse()?;
        let pre_gain = pre_gain_of(raw.as_shot_neutral);
        let ceilings = [0, 1, 2].map(|c| neutral_clip * pre_gain[c] * gain[c]);
        Some(Self {
            to_space,
            ceilings,
            prior: gain,
            neutral_clip,
            tier: Tier::Camera {
                frame,
                gain,
                pre_gain,
            },
        })
    }

    /// The slider pair that neutralises `neutral` (a G-normalised
    /// chromaticity in the judging space), clamped to the schema's
    /// `temperature` / `tint` domain. `None` when the solve degenerates.
    fn temp_tint(&self, neutral: [f32; 3]) -> Option<(f32, f32)> {
        let (temperature, tint) = match &self.tier {
            Tier::Camera {
                frame,
                gain,
                pre_gain,
            } => {
                // Undo the probe's WB gain and the AsShotNeutral pre-gain:
                // what the sensor itself read for this neutral.
                let raw_neutral = [0, 1, 2].map(|c| neutral[c] / (gain[c] * pre_gain[c]).max(1e-6));
                frame.illuminant_temp_tint(raw_neutral)
            }
            Tier::Generic => neutral_to_temp_tint(neutral),
        };
        if !(temperature.is_finite() && tint.is_finite()) {
            return None;
        }
        let (t_lo, t_hi) = schema_range("temperature");
        let (tint_lo, tint_hi) = schema_range("tint");
        Some((temperature.clamp(t_lo, t_hi), tint.clamp(tint_lo, tint_hi)))
    }
}

/// The `(min, max)` a schema field declares — the recommendation is a slider
/// value, so it lives in the slider's domain.
fn schema_range(name: &str) -> (f32, f32) {
    ADJUSTMENT_SCHEMA
        .iter()
        .find(|f| f.name == name)
        .map(|f| f.range)
        .unwrap_or_else(|| panic!("ADJUSTMENT_SCHEMA has no `{name}` field"))
}

/// `white_balance::apply_pre_gain`'s per-channel multiplier, including its
/// identity short-circuit and zero guard.
fn pre_gain_of(neutral: [f32; 3]) -> [f32; 3] {
    let is_identity = neutral.iter().all(|n| (n - 1.0).abs() < 1e-4);
    if is_identity {
        return [1.0; 3];
    }
    neutral.map(|n| if n.abs() > 1e-6 { 1.0 / n } else { 1.0 })
}

/// Channel sums of an admitted population, in f64 so a 100 MP probe can't
/// lose precision in the accumulator.
#[derive(Clone, Copy, Default)]
struct Sum {
    rgb: [f64; 3],
    n: usize,
}

impl Sum {
    fn add(self, c: [f32; 3]) -> Self {
        Self {
            rgb: [
                self.rgb[0] + c[0] as f64,
                self.rgb[1] + c[1] as f64,
                self.rgb[2] + c[2] as f64,
            ],
            n: self.n + 1,
        }
    }

    /// G-normalised chromaticity of the population's mean.
    fn chromaticity(&self) -> [f32; 3] {
        let g = self.rgb[1].max(1e-9);
        [(self.rgb[0] / g) as f32, 1.0, (self.rgb[2] / g) as f32]
    }
}

#[derive(Clone, Copy, Default)]
struct Population {
    gray: Sum,
    white: Sum,
}

/// Chroma gate relative to `center`: divide the pixel by the running neutral
/// estimate, then ask how far its channels spread. A surface with exactly
/// the estimate's chromaticity reads `[k, k, k]` and always passes.
fn within_gate(c: [f32; 3], center: [f32; 3], gate: f32) -> bool {
    let v = [0, 1, 2].map(|k| c[k] / center[k].max(1e-6));
    let max = v[0].max(v[1]).max(v[2]);
    if !(max > 1e-6) {
        return false;
    }
    let mean = (v[0] + v[1] + v[2]) / 3.0;
    let dev = v.iter().fold(0.0_f32, |d, x| d.max((x - mean).abs()));
    dev / max <= gate
}

/// One pass over the probe: luma window, sensor-clip exclusion, chroma gate
/// against `center`, then the gray-world and white-patch accumulators.
fn accumulate(probe: &Image, space: &ProbeSpace, center: [f32; 3], gate: f32) -> Population {
    let luma_min = LUMA_MIN_FRACTION * space.neutral_clip;
    let white_min = WHITE_PATCH_FRACTION * space.neutral_clip;
    let clip = space.ceilings.map(|c| c * (1.0 - CLIP_MARGIN));
    probe.pixels.iter().fold(Population::default(), |acc, p| {
        if !p.iter().all(|v| v.is_finite()) {
            return acc;
        }
        let y = LUMA_REC2020[0] * p[0] + LUMA_REC2020[1] * p[1] + LUMA_REC2020[2] * p[2];
        if y < luma_min {
            return acc;
        }
        let c = space.to_space.mul_vec(*p);
        if (0..3).any(|k| c[k] >= clip[k]) || !within_gate(c, center, gate) {
            return acc;
        }
        Population {
            gray: acc.gray.add(c),
            white: if y >= white_min {
                acc.white.add(c)
            } else {
                acc.white
            },
        }
    })
}

/// The estimated scene neutral (G-normalised, in the judging space), or
/// `None` when too few pixels survive the gates.
fn estimate_neutral(probe: &Image, space: &ProbeSpace) -> Option<[f32; 3]> {
    let admitted = |pop: Population| (pop.gray.n >= MIN_PIXELS).then_some(pop);
    let (first, rest) = GATE_SCHEDULE.split_first()?;
    let seed = admitted(accumulate(probe, space, space.prior, *first))?;
    let pop = rest.iter().try_fold(seed, |prev, &gate| {
        admitted(accumulate(probe, space, prev.gray.chromaticity(), gate))
    })?;
    let gray = pop.gray.chromaticity();
    let white_votes = pop.white.n >= WHITE_PATCH_MIN_PIXELS
        && pop.white.n as f32 >= WHITE_PATCH_MIN_SHARE * pop.gray.n as f32;
    if !white_votes {
        return Some(gray);
    }
    let white = pop.white.chromaticity();
    let t = GRAY_WORLD_BLEND;
    Some([0, 1, 2].map(|k| t * gray[k] + (1.0 - t) * white[k]))
}

/// Clamp `estimate` to within [`MAX_MIRED_MOVE`] / [`MAX_TINT_MOVE`] of the
/// camera's as-shot reading `prior`. The move is clamped, not damped: an
/// estimate inside the band is returned as-is, so a real cast the camera
/// under-corrected is still corrected in full.
///
/// A reading outside the slider domain is not a prior:
/// `estimate_as_shot_cct_tint` rails to +180 tint on a body whose
/// calibration the frame cannot invert (test_0004, `RawlerFallback`), and
/// bounding to that would pin the recommendation to garbage. Such a reading
/// is ignored and the estimate stands on its own.
fn bounded_by_prior(estimate: (f32, f32), prior: (f32, f32)) -> (f32, f32) {
    let (t_lo, t_hi) = schema_range("temperature");
    let (tint_lo, tint_hi) = schema_range("tint");
    let prior_usable = (t_lo..=t_hi).contains(&prior.0) && (tint_lo..=tint_hi).contains(&prior.1);
    if !prior_usable {
        return estimate;
    }
    let prior_mired = 1.0e6 / prior.0;
    let mired =
        (1.0e6 / estimate.0).clamp(prior_mired - MAX_MIRED_MOVE, prior_mired + MAX_MIRED_MOVE);
    let tint = estimate
        .1
        .clamp(prior.1 - MAX_TINT_MOVE, prior.1 + MAX_TINT_MOVE);
    ((1.0e6 / mired).clamp(t_lo, t_hi), tint)
}

/// Auto white-balance recommendation as `(temperature_k, tint)` for the
/// probe `compute_auto_adjustments` developed with `probe_model`.
///
/// The camera's own reading (`dcp::estimate_as_shot_cct_tint` — its
/// interpolated colour matrix, not the generic Planckian model, #1725) is
/// both the bound on the estimate ([`bounded_by_prior`]) and the fallback
/// when too few pixels survive the gates or the solve degenerates.
pub(crate) fn compute_awb(
    probe: &Image,
    raw: &RawImage,
    probe_model: &AdjustmentModel,
) -> (f32, f32) {
    probe.assert_space(ColorSpace::SceneLinearRec2020);
    let space = ProbeSpace::resolve(raw, probe_model);
    let as_shot = dcp::estimate_as_shot_cct_tint(raw).unwrap_or((6500.0, 0.0));
    estimate_neutral(probe, &space)
        .and_then(|neutral| space.temp_tint(neutral))
        .map(|estimate| bounded_by_prior(estimate, as_shot))
        .unwrap_or(as_shot)
}

#[cfg(test)]
#[path = "auto_adjustments_awb_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "auto_adjustments_awb_fixture_tests.rs"]
mod fixture_tests;
