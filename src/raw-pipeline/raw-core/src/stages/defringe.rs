//! Chroma-fringe suppression at high-contrast edges (#3407 per-mask, #3411
//! global).
//!
//! A fringe is chroma that only exists because of an edge, so the stage
//! suppresses chroma in proportion to how edge-like the pixel is. Lateral
//! chromatic aberration and sensor blooming both leave one; so does the
//! longitudinal CA that `lateral_ca`'s geometric correction can never
//! address, because it is a colour error rather than a displacement.
//!
//! ONE kernel serves two callers, whose parameters are a superset of each
//! other rather than two implementations:
//!
//! * **Per-mask** (#3407, `PartialAdjustments::defringe`) — a single
//!   `0 … 100` amount that suppresses every hue, run by
//!   `local_adjustments::spatial` over a scratch copy of one layer's output
//!   and blended back by that layer's mask weight. This is where a
//!   photographer actually reaches for it: on the branches against a bright
//!   sky, not over the whole frame.
//! * **Global** (#3411, `AdjustmentModel::defringe_*`) — ACR's six
//!   controls: separate purple and green amounts, each with a hue band on
//!   Adobe's own `[0, 100]` defringe-hue axis, run per tick between
//!   `dehaze` and `local_adjustments`.
//!
//! The two meet at [`DefringeParams`]: the per-mask caller sets
//! `all_hues_strength` and leaves both bands at zero, the global caller does
//! the reverse. A pixel's suppression is the strongest claim on it —
//! `max(all_hues, purple·band, green·band)` — so the per-mask path never
//! evaluates a hue at all and its output is bit-identical to the
//! single-amount stage it replaces.
//!
//! # Algorithm
//!
//! 1. Build the scene-linear Rec.2020 luma plane.
//! 2. At each pixel take the RELATIVE gradient — the central-difference
//!    magnitude divided by the local luma. Relative rather than absolute so
//!    the detector is exposure-invariant: a 2:1 edge reads the same at any
//!    exposure, which an absolute threshold would not.
//! 3. Turn that into an edge weight with a smoothstep between [`EDGE_LO`]
//!    and [`EDGE_HI`], so ordinary texture contributes nothing and only
//!    genuinely steep boundaries are treated as fringe candidates.
//! 4. Decide how much of that edge this pixel's COLOUR is eligible for (the
//!    hue step above — a constant for the per-mask caller).
//! 5. Scale the pixel's Oklab chroma (a, b) by `1 − k·edge`, leaving
//!    lightness untouched. At full strength a fully edge-classified pixel
//!    goes achromatic; everywhere else the chroma is reduced smoothly.
//!
//! Oklab is the right space for the suppression because its a/b axes are
//! perceptual chroma with lightness factored out, so scaling them cannot
//! darken or brighten the pixel — exactly the property the
//! `noise_reduction` chroma path already relies on.
//!
//! # Stencil
//!
//! Central differences read one neighbour per axis, so the reach is
//! [`DEFRINGE_REACH_PX`] = 1 px per side. The tile path's overlap
//! calculator adds that when a layer engages the control.

use rayon::prelude::*;

use crate::color::oklab::{oklab_to_rec2020, rec2020_to_oklab};
use crate::image::{ColorSpace, Image};
use crate::xmp::AdjustmentModel;

/// Rec.2020 luminance coefficients — the same weights every other
/// scene-linear stage in this tree uses.
const LUMA_REC2020: [f32; 3] = [0.2627, 0.6780, 0.0593];

/// Relative-gradient value below which a pixel is not an edge at all.
/// 0.35 is a ~1.4:1 luma step across two pixels — well above the local
/// contrast of ordinary texture at the pixel scale.
const EDGE_LO: f32 = 0.35;

/// Relative gradient at which a pixel is fully edge-classified. 1.2 is
/// roughly a 3:1 step across two pixels, the regime where a fringe is
/// visible in the first place.
const EDGE_HI: f32 = 1.2;

/// Luma floor for the relative gradient's divisor. Below this the pixel
/// carries no usable signal and the quotient stops being a ratio — the same
/// guard `clarity` / `texture` apply to their own luma divisions.
const LUMA_FLOOR: f32 = 1e-6;

/// Spatial reach of the stage, in pixels per side, for the tile path's
/// overlap calculator (#1157): one central-difference neighbour per axis.
pub const DEFRINGE_REACH_PX: usize = 1;

/// Oklab hue degrees spanned by ACR's `[0, 100]` purple defringe axis:
/// blue-violet through magenta. ACR's 30/70 default lands on 282°–318°,
/// the violet-purple a fast wide-angle actually produces.
const PURPLE_BAND_DEG: (f32, f32) = (255.0, 345.0);

/// Oklab hue degrees spanned by ACR's `[0, 100]` green defringe axis:
/// yellow-green through green-cyan. The 40/60 default lands on 136°–154°.
const GREEN_BAND_DEG: (f32, f32) = (100.0, 190.0);

/// Smoothstep width, in `[0, 100]` axis units, applied outside each side of
/// the user's band so band membership is continuous in hue.
const HUE_FEATHER: f32 = 15.0;

/// The slider value at which a global family's desaturation is total. ACR's
/// Defringe amounts run `[0, 20]`; the per-mask control runs `[0, 100]`.
const FULL_GLOBAL_AMOUNT: f32 = 20.0;
const FULL_MASK_AMOUNT: f32 = 100.0;

/// Below this an amount is treated as zero (the chain's shared no-op
/// threshold).
const SLIDER_EPS: f32 = 1e-3;

/// The stage's resolved parameters — every strength already normalised to
/// `[0, 1]`, every band edge already in `[0, 100]` axis units. This is the
/// superset both callers meet at, and the shape the WGSL params uniform
/// mirrors.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct DefringeParams {
    /// Hue-agnostic strength — the per-mask control (#3407). When this is
    /// the only non-zero strength the kernel never evaluates a hue, so the
    /// result is bit-identical to the single-amount stage.
    pub all_hues_strength: f32,
    pub purple_strength: f32,
    pub purple_lo: f32,
    pub purple_hi: f32,
    pub green_strength: f32,
    pub green_lo: f32,
    pub green_hi: f32,
}

impl DefringeParams {
    /// The per-mask control's parameters: one `0 … 100` amount, every hue.
    pub fn per_mask(amount: f32) -> Self {
        Self {
            all_hues_strength: (amount / FULL_MASK_AMOUNT).clamp(0.0, 1.0),
            ..Self::default()
        }
    }

    /// Whether either hue band can claim a pixel. False for the per-mask
    /// caller, which is what lets the kernel skip the hue evaluation
    /// entirely there.
    #[inline]
    fn bands_engaged(&self) -> bool {
        self.purple_strength > 0.0 || self.green_strength > 0.0
    }

    /// Whether the stage does anything at all.
    pub fn is_engaged(&self) -> bool {
        self.all_hues_strength > 0.0 || self.bands_engaged()
    }
}

/// Resolve the global stage's parameters from a model, or `None` when both
/// ACR amounts are inert and the stage is a bit-identical skip.
pub fn params_from_model(model: &AdjustmentModel) -> Option<DefringeParams> {
    params_from_values(
        [
            model.defringe_purple_amount,
            model.defringe_purple_hue_lo,
            model.defringe_purple_hue_hi,
        ],
        [
            model.defringe_green_amount,
            model.defringe_green_hue_lo,
            model.defringe_green_hue_hi,
        ],
    )
}

/// [`params_from_model`] over loose `[amount, hue_lo, hue_hi]` triples —
/// the entry the C-ABI mappers use, since neither params struct carries an
/// `AdjustmentModel` to hand over. Same predicate, same normalisation, so
/// the FFI can never disagree with the model path about whether the stage
/// is engaged or how hard.
pub fn params_from_values(purple: [f32; 3], green: [f32; 3]) -> Option<DefringeParams> {
    let purple_amount = purple[0].max(0.0);
    let green_amount = green[0].max(0.0);
    if purple_amount < SLIDER_EPS && green_amount < SLIDER_EPS {
        return None;
    }
    Some(DefringeParams {
        all_hues_strength: 0.0,
        purple_strength: (purple_amount / FULL_GLOBAL_AMOUNT).clamp(0.0, 1.0),
        purple_lo: purple[1],
        purple_hi: purple[2],
        green_strength: (green_amount / FULL_GLOBAL_AMOUNT).clamp(0.0, 1.0),
        green_lo: green[1],
        green_hi: green[2],
    })
}

/// Hermite smoothstep, matching `scene_tone_controls::smoothstep` and
/// WGSL's built-in. Guarded for the degenerate `e1 <= e0` an inverted or
/// empty hue band reaches it with.
#[inline]
fn smoothstep(edge0: f32, edge1: f32, x: f32) -> f32 {
    if edge1 <= edge0 {
        return if x >= edge1 { 1.0 } else { 0.0 };
    }
    let t = ((x - edge0) / (edge1 - edge0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// Band membership in `[0, 1]` for a hue already mapped onto the family's
/// `[0, 100]` axis: 1 inside `[lo, hi]`, feathering to 0 over
/// [`HUE_FEATHER`] on each side. An inverted band (`hi <= lo`) selects
/// nothing.
#[inline]
fn band_weight(t: f32, lo: f32, hi: f32) -> f32 {
    if hi <= lo {
        return 0.0;
    }
    smoothstep(lo - HUE_FEATHER, lo, t) * (1.0 - smoothstep(hi, hi + HUE_FEATHER, t))
}

/// Map an Oklab hue in degrees onto a family's `[0, 100]` axis.
#[inline]
fn axis_position(hue_deg: f32, band: (f32, f32)) -> f32 {
    100.0 * (hue_deg - band.0) / (band.1 - band.0)
}

/// The suppression factor for one pixel's colour, before the edge gate.
#[inline]
fn hue_suppression(lab: [f32; 3], p: &DefringeParams) -> f32 {
    if !p.bands_engaged() {
        return p.all_hues_strength;
    }
    let hue = lab[2].atan2(lab[1]).to_degrees().rem_euclid(360.0);
    let purple = p.purple_strength
        * band_weight(axis_position(hue, PURPLE_BAND_DEG), p.purple_lo, p.purple_hi);
    let green =
        p.green_strength * band_weight(axis_position(hue, GREEN_BAND_DEG), p.green_lo, p.green_hi);
    p.all_hues_strength.max(purple.max(green))
}

/// Suppress chroma at high-contrast edges for the PER-MASK control.
/// `amount` is 0 … 100; 0 (and any value below the shared 1e-3 engage
/// threshold) is identity and short-circuits without touching pixels.
pub fn apply(img: &mut Image, amount: f32) {
    if amount.abs() < SLIDER_EPS {
        img.assert_space(ColorSpace::SceneLinearRec2020);
        return;
    }
    apply_params(img, &DefringeParams::per_mask(amount));
}

/// Suppress chroma at high-contrast edges for the GLOBAL controls. Both ACR
/// amounts at their default 0 is an exact bit-identical skip.
pub fn apply_model(img: &mut Image, model: &AdjustmentModel) {
    let Some(params) = params_from_model(model) else {
        return;
    };
    apply_params(img, &params);
}

/// The kernel both callers share, with the parameters already resolved.
pub fn apply_params(img: &mut Image, params: &DefringeParams) {
    img.assert_space(ColorSpace::SceneLinearRec2020);
    if !params.is_engaged() {
        return;
    }
    let w = img.width as usize;
    let h = img.height as usize;
    if w == 0 || h == 0 {
        return;
    }

    let luma: Vec<f32> = img
        .pixels
        .par_iter()
        .map(|p| LUMA_REC2020[0] * p[0] + LUMA_REC2020[1] * p[1] + LUMA_REC2020[2] * p[2])
        .collect();

    img.pixels
        .par_chunks_mut(w)
        .enumerate()
        .for_each(|(y, row)| {
            let up = y.saturating_sub(1) * w;
            let down = (y + 1).min(h - 1) * w;
            let here = y * w;
            for (x, p) in row.iter_mut().enumerate() {
                let left = x.saturating_sub(1);
                let right = (x + 1).min(w - 1);
                let centre = luma[here + x];
                if centre <= LUMA_FLOOR {
                    continue;
                }
                let dx = luma[here + right] - luma[here + left];
                let dy = luma[down + x] - luma[up + x];
                let relative = (dx.abs() + dy.abs()) / centre;
                let edge = smoothstep(EDGE_LO, EDGE_HI, relative);
                if edge <= 0.0 {
                    continue;
                }
                let lab = rec2020_to_oklab(*p);
                let strength = hue_suppression(lab, params);
                if strength <= 0.0 {
                    continue;
                }
                let scale = 1.0 - strength * edge;
                *p = oklab_to_rec2020([lab[0], lab[1] * scale, lab[2] * scale]);
            }
        });
}

#[cfg(test)]
#[path = "defringe/tests.rs"]
mod tests;
