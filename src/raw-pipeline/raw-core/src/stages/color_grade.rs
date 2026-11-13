//! Colour grading — display-linear Oklab three-zone tint (#275).
//!
//! Supersedes the two-zone split-toning stage (#1111, tone/zoom design
//! § 10.3) exactly the way Lightroom's Color Grading panel superseded
//! Split Toning: the shadow and highlight hue/saturation pairs and the
//! balance are the *same* sliders (and the same `crs:SplitToning*` XMP
//! keys ACR still writes for them), joined by a midtone zone, a per-zone
//! luminance offset, and an unweighted global wheel.
//!
//! Runs POST-AgX, before grain and the target-gamut conversion. The zone
//! axis is the pixel's Oklab `L` — perceptual lightness, not display-linear
//! Y. That matters: AgX's shoulder keeps a normally-exposed frame's
//! display-linear Y well under 1, so a linear-Y split would file most of
//! what a photographer calls a highlight under "midtone". The midtone zone
//! is anchored on mid-grey, so the three zones straddle the tone a scene is
//! exposed for. With `L ∈ [0, 1]` and `bal ∈ [-100, +100]`:
//!
//! ```text
//! lb = L ^ exp2(-bal/100)                // balance warps the tonal axis
//! wS = 1 − smoothstep(0, Lmid, lb)
//! wH = smoothstep(Lmid, 1, lb)
//! wM = 1 − wS − wH                       // exact partition of unity
//!
//! (Δa, Δb) = Kc · [ Σ_z w_z · (s_z/100)·(cos h_z, sin h_z) + (s_G/100)·(cos h_G, sin h_G) ]
//! ΔL       = Kl · [ Σ_z w_z · (l_z/100)                    + (l_G/100) ]
//! ```
//!
//! The three zone weights are a C¹ partition of unity — `smoothstep` has
//! zero derivative at both edges, so the shadow→midtone and
//! midtone→highlight hand-offs have no gradient step and a luminance
//! sweep shows no band boundary (`zone_blend_has_no_band_boundary_
//! discontinuity` in the sibling test file pins that numerically).
//!
//! Hues are in degrees (the Lightroom convention); saturations are
//! `[0, 100]`; luminances are `[-100, +100]`. At all-zero saturations and
//! luminances the stage is gated off entirely — neutral-preserving by
//! construction, whatever the hues and balance say.
//!
//! The shifted pixel can leave the sRGB hull; the downstream
//! `rec2020_to_srgb` Oklab gamut compression owns bringing it back
//! (nothing clips here). `L` is clamped into `[0, 1]`: this stage is
//! display-referred and runs *after* the view transform, so the clamp is
//! a display-range guard, not a scene-referred clip.
//!
//! A pure point op — tile-safe with no window data at all.

use crate::color::oklab::{oklab_to_rec2020, rec2020_to_oklab};
use crate::image::{ColorSpace, Image};
use crate::types::AdjustmentModel;

/// Oklab chroma shift at full saturation and unit zone weight. Inherited
/// verbatim from the split-toning calibration (spec § 10.3) so existing
/// sidecars keep their rendered tint strength.
pub const COLOR_GRADE_CHROMA_K: f32 = 0.06;
/// Oklab `L` shift at slider ±100 and unit zone weight. `L` spans roughly
/// `[0, 1]` from display black to display white, so ±100 moves a zone by
/// 15% of the display range — a firm but recoverable lift.
pub const COLOR_GRADE_LUMA_K: f32 = 0.15;
/// Oklab `L` of display-linear mid-grey — the tone the midtone zone is
/// anchored on, where both hand-offs meet and `wM` reaches 1.
///
/// For a neutral pixel every Oklab matrix row sums to 1, so the whole
/// forward transform collapses to a cube root and `L = ∛0.18`.
/// `midtone_anchor_is_mid_grey` in the sibling test file pins that against
/// the real `rec2020_to_oklab`.
pub const MIDTONE_ANCHOR_L: f32 = 0.564_622;
/// Below this a slider counts as "at default" for the identity gate.
const SLIDER_EPS: f32 = 1e-3;

/// One wheel's raw slider triple: `(hue°, saturation 0..100, luminance
/// -100..100)`.
pub type Wheel = [f32; 3];

/// The sixteen raw slider values the stage reads, grouped per wheel plus
/// balance and the three #5040 zone-isolation controls.
/// Constructed from an [`AdjustmentModel`] via
/// [`ColorGradeSliders::from_model`]; carried verbatim by the GPU pass so
/// both paths hoist their params through the identical float sequence.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ColorGradeSliders {
    pub shadow: Wheel,
    pub midtone: Wheel,
    pub highlight: Wheel,
    pub global: Wheel,
    pub balance: f32,
    pub blending: f32,
    pub shadow_edge: f32,
    pub highlight_edge: f32,
}

impl Default for ColorGradeSliders {
    fn default() -> Self {
        Self {
            shadow: [0.0; 3],
            midtone: [0.0; 3],
            highlight: [0.0; 3],
            global: [0.0; 3],
            balance: 0.0,
            blending: 100.0,
            shadow_edge: MIDTONE_ANCHOR_L,
            highlight_edge: MIDTONE_ANCHOR_L,
        }
    }
}

impl ColorGradeSliders {
    /// Gather the sixteen sliders off the model. Shadow and highlight
    /// hue/saturation and the balance still live on the `split_tone_*`
    /// fields — that is ACR's own layout, where the Color Grading panel
    /// writes those three pairs to `crs:SplitToning*`.
    pub fn from_model(m: &AdjustmentModel) -> Self {
        Self {
            shadow: [
                m.split_tone_shadow_hue,
                m.split_tone_shadow_saturation,
                m.color_grade_shadow_luminance,
            ],
            midtone: [
                m.color_grade_midtone_hue,
                m.color_grade_midtone_saturation,
                m.color_grade_midtone_luminance,
            ],
            highlight: [
                m.split_tone_highlight_hue,
                m.split_tone_highlight_saturation,
                m.color_grade_highlight_luminance,
            ],
            global: [
                m.color_grade_global_hue,
                m.color_grade_global_saturation,
                m.color_grade_global_luminance,
            ],
            balance: m.split_tone_balance,
            blending: m.color_grade_blending,
            shadow_edge: m.color_grade_shadow_edge,
            highlight_edge: m.color_grade_highlight_edge,
        }
    }
}

/// Minimum smoothstep ramp width in Oklab `L` when `blending == 0` (#5040).
pub const MIN_ZONE_RAMP_L: f32 = 0.04;

/// Normalize `(blending, shadow_edge, highlight_edge)` when a zero-initialized
/// C struct or test struct (`shadow_edge == 0.0 && highlight_edge == 0.0`) is
/// passed, falling back to `(100.0, MIDTONE_ANCHOR_L, MIDTONE_ANCHOR_L)`.
#[inline]
pub fn color_grade_zone_or_defaults(
    blending: f32,
    shadow_edge: f32,
    highlight_edge: f32,
) -> (f32, f32, f32) {
    if shadow_edge == 0.0 && highlight_edge == 0.0 {
        (100.0, MIDTONE_ANCHOR_L, MIDTONE_ANCHOR_L)
    } else {
        (blending, shadow_edge, highlight_edge)
    }
}

/// Clamp `shadow_edge` into `[0.10, MIDTONE_ANCHOR_L]`, snapping values within
/// `0.005` of `MIDTONE_ANCHOR_L` (such as a 2-decimal XMP `"0.56"`) to exact
/// `MIDTONE_ANCHOR_L`.
#[inline]
pub fn resolve_shadow_edge(shadow_edge: f32) -> f32 {
    if (shadow_edge - MIDTONE_ANCHOR_L).abs() < 0.005 {
        MIDTONE_ANCHOR_L
    } else {
        shadow_edge.clamp(0.10, MIDTONE_ANCHOR_L)
    }
}

/// Clamp `highlight_edge` into `[MIDTONE_ANCHOR_L, 0.90]`, snapping values
/// within `0.005` of `MIDTONE_ANCHOR_L` to exact `MIDTONE_ANCHOR_L`.
#[inline]
pub fn resolve_highlight_edge(highlight_edge: f32) -> f32 {
    if (highlight_edge - MIDTONE_ANCHOR_L).abs() < 0.005 {
        MIDTONE_ANCHOR_L
    } else {
        highlight_edge.clamp(MIDTONE_ANCHOR_L, 0.90)
    }
}

/// Compute the four smoothstep edges `[s0, s1, h0, h1]` from
/// `(blending, shadow_edge, highlight_edge)` (#5040).
///
/// At defaults (`blending = 100.0`, `shadow_edge = highlight_edge = MIDTONE_ANCHOR_L`),
/// `1.0 - b == 0.0`, so this returns exact `[0.0, MIDTONE_ANCHOR_L, MIDTONE_ANCHOR_L, 1.0]`.
#[inline]
pub fn zone_edges(blending: f32, shadow_edge: f32, highlight_edge: f32) -> [f32; 4] {
    let (blending, shadow_edge, highlight_edge) =
        color_grade_zone_or_defaults(blending, shadow_edge, highlight_edge);
    let b = (blending / 100.0).clamp(0.0, 1.0);
    let ls = resolve_shadow_edge(shadow_edge);
    let lh = resolve_highlight_edge(highlight_edge);
    let s0 = (1.0 - b) * (ls - MIN_ZONE_RAMP_L).max(0.0);
    let s1 = ls;
    let h0 = lh;
    let h1 = 1.0 - (1.0 - b) * (1.0 - lh - MIN_ZONE_RAMP_L).max(0.0);
    [s0, s1, h0, h1]
}

/// Hoisted per-render parameters, shared by the stage, the predictor, and
/// (transcribed) the WGSL host code: the balance exponent, the four zone
/// smoothstep edges, plus one pre-scaled `(Δa, Δb, ΔL)` offset per wheel at
/// unit weight.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ColorGradeParams {
    /// `exp2(-balance/100)` — the exponent that warps the tonal axis.
    pub balance_exp: f32,
    /// `[s0, s1, h0, h1]` smoothstep edges (#5040).
    pub edges: [f32; 4],
    pub shadow: [f32; 3],
    pub midtone: [f32; 3],
    pub highlight: [f32; 3],
    /// Added once, unweighted — the global wheel touches every tone.
    pub global: [f32; 3],
    /// True when every saturation and luminance sits at default: the
    /// whole-stage short-circuit.
    pub is_identity: bool,
}

/// `(Δa, Δb, ΔL)` for one wheel at unit weight, or `None` when the wheel
/// is at default (zero saturation *and* zero luminance).
#[inline]
fn wheel_offset(w: Wheel) -> Option<[f32; 3]> {
    let [hue, sat, lum] = w;
    if sat.abs() < SLIDER_EPS && lum.abs() < SLIDER_EPS {
        return None;
    }
    let h = hue.to_radians();
    let c = COLOR_GRADE_CHROMA_K * (sat / 100.0);
    Some([c * h.cos(), c * h.sin(), COLOR_GRADE_LUMA_K * (lum / 100.0)])
}

/// Hoist the per-render params from the raw sliders.
pub fn color_grade_params(s: &ColorGradeSliders) -> ColorGradeParams {
    let shadow = wheel_offset(s.shadow);
    let midtone = wheel_offset(s.midtone);
    let highlight = wheel_offset(s.highlight);
    let global = wheel_offset(s.global);
    let is_identity =
        shadow.is_none() && midtone.is_none() && highlight.is_none() && global.is_none();
    ColorGradeParams {
        balance_exp: (-s.balance / 100.0).exp2(),
        edges: zone_edges(s.blending, s.shadow_edge, s.highlight_edge),
        shadow: shadow.unwrap_or([0.0; 3]),
        midtone: midtone.unwrap_or([0.0; 3]),
        highlight: highlight.unwrap_or([0.0; 3]),
        global: global.unwrap_or([0.0; 3]),
        is_identity,
    }
}

/// Hermite smoothstep, matching the WGSL builtin.
#[inline]
fn smoothstep(e0: f32, e1: f32, x: f32) -> f32 {
    let t = ((x - e0) / (e1 - e0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// The `(shadow, midtone, highlight)` zone weights at Oklab lightness `l`
/// given smoothstep edges `[s0, s1, h0, h1]` (#5040).
/// Because `s1 <= MIDTONE_ANCHOR_L <= h0`, `ws` and `wh` have disjoint
/// non-zero support on the opposite side of `MIDTONE_ANCHOR_L`, so
/// `wm = 1 - ws - wh >= 0` is an exact C¹ partition of unity everywhere.
#[inline]
pub fn zone_weights_with_edges(l: f32, balance_exp: f32, edges: [f32; 4]) -> [f32; 3] {
    let lb = l.clamp(0.0, 1.0).powf(balance_exp);
    let ws = 1.0 - smoothstep(edges[0], edges[1], lb);
    let wh = smoothstep(edges[2], edges[3], lb);
    [ws, 1.0 - ws - wh, wh]
}

/// The `(shadow, midtone, highlight)` zone weights at Oklab lightness `l`
/// at default edges `[0, MIDTONE_ANCHOR_L, MIDTONE_ANCHOR_L, 1]`.
#[inline]
pub fn zone_weights(l: f32, balance_exp: f32) -> [f32; 3] {
    zone_weights_with_edges(
        l,
        balance_exp,
        [0.0, MIDTONE_ANCHOR_L, MIDTONE_ANCHOR_L, 1.0],
    )
}

/// The `(Δa, Δb, ΔL)` Oklab offset at lightness `l` — the closed form the
/// predictor uses; the stage applies the same offset per pixel.
#[inline]
pub fn color_grade_shift(l: f32, p: &ColorGradeParams) -> [f32; 3] {
    let [ws, wm, wh] = zone_weights_with_edges(l, p.balance_exp, p.edges);
    [
        p.global[0] + ws * p.shadow[0] + wm * p.midtone[0] + wh * p.highlight[0],
        p.global[1] + ws * p.shadow[1] + wm * p.midtone[1] + wh * p.highlight[1],
        p.global[2] + ws * p.shadow[2] + wm * p.midtone[2] + wh * p.highlight[2],
    ]
}

/// Grade one display-linear Rec.2020 pixel. The zone weights read the
/// pixel's PRE-shift lightness, so a luminance offset cannot feed back
/// into which zone the pixel belongs to.
#[inline]
pub fn apply_pixel(rgb: [f32; 3], p: &ColorGradeParams) -> [f32; 3] {
    let lab = rec2020_to_oklab(rgb);
    let shift = color_grade_shift(lab[0], p);
    oklab_to_rec2020([
        (lab[0] + shift[2]).clamp(0.0, 1.0),
        lab[1] + shift[0],
        lab[2] + shift[1],
    ])
}

/// Apply colour grading. Identity short-circuit when every saturation and
/// luminance is at default — the baseline guarantee.
pub fn apply(img: &mut Image, sliders: &ColorGradeSliders) {
    img.assert_space(ColorSpace::DisplayLinearRec2020);
    let p = color_grade_params(sliders);
    if p.is_identity {
        return;
    }
    for px in &mut img.pixels {
        *px = apply_pixel(*px, &p);
    }
}

/// Convenience wrapper for the render chains, which carry the model.
pub fn apply_model(img: &mut Image, model: &AdjustmentModel) {
    apply(img, &ColorGradeSliders::from_model(model));
}

// Tests live in the sibling `color_grade_tests.rs` so this file stays
// under the 600-LOC budget (same `#[path]` split pattern as `stages/hsl.rs`).
#[cfg(test)]
#[path = "color_grade_tests.rs"]
mod tests;
#[cfg(test)]
#[path = "color_grade_zone_tests.rs"]
mod zone_tests;
