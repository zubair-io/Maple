//! Auto tone calibration — contrast / highlights / shadows / whites / blacks
//! (#1376, follow-up to the M0 AUTO milestone #1371).
//!
//! # Why this module exists
//!
//! M0's prototype heuristics inverted the tone predictors at full strength and
//! against percentiles measured on a `[0, 1]`-binned histogram. Both choices
//! over-drove: `blacks` railed to −100 on every fixture, `whites` swung to
//! ±100, and `contrast` never engaged because it was gated on a "< 2.5 stops of
//! dynamic range" condition that no real scene satisfies. The synthetic tests
//! asserted only sign and clamp, so railed output passed the gate and the five
//! sliders shipped hard-zeroed. This module replaces them.
//!
//! # The objective target
//!
//! There is no ACR "Auto" render in `test-fixtures/references/` — the reference
//! tree carries per-slider `*_max`/`*_min` cases, a `wb_auto` case (auto WHITE
//! BALANCE, not auto tone), and a `baseline` render per fixture; no sidecar in
//! the tree carries `crs:AutoTone`, `crs:AutoShadows` or `crs:AutoBrightness`.
//! So a per-scene ACR-Auto ground truth does not exist and cannot be diffed
//! against.
//!
//! What DOES exist is ACR's default rendering of each of the twenty reference
//! scenes (`test_NNNN/down/baseline.png`) — professionally rendered versions of
//! the exact frames this calibration is tuned on. The population statistics of
//! their tone distributions are therefore a MEASURED statement of where a good
//! render puts a photograph's tones, and that is the objective target: the
//! per-percentile population median of the reference set's tone distribution.
//!
//! Which population supplies each anchor depends on whether the statistic is
//! sensitive to overall LEVEL. Measured on the same nineteen decodable scenes
//! (`python3 src/scripts/acr_tone_anchors.py`, and the
//! `committed_anchors_match_the_reference_population` gate):
//!
//! ```text
//! percentile      ACR median   Maple, AUTO's pre-tone state   difference
//!   p0.5            0.0242              0.0166                 −0.0076
//!   p10             0.1635              0.0680                 −0.0955
//!   p95             0.8444              0.6773                 −0.1671
//!   p99.5           0.9100              0.7188                 −0.1912
//!   p75 − p25       0.3673              0.3346                 −0.0327
//! ```
//!
//! The four endpoint percentiles are LEVEL-SENSITIVE, and the gap at those rows
//! is dominated by two scene-independent constants: the AgX shoulder being more
//! compressive than ACR's tone curve (the color-parity harness's subject —
//! `budgets.json` is precisely that ledger, and closing it belongs to the
//! ACR-match view transform, #1722), and AUTO's own deliberately conservative
//! exposure rule (deadband, half-strength damping, highlight backstop — shipped
//! and reviewed in #1371, and explicitly out of scope here). Anchoring the
//! endpoints on ACR would make the tone sliders quietly re-do both jobs: every
//! photograph would open with shadows and whites pushed positive by a constant
//! amount that has nothing to do with the scene, and against the ACR p99.5 the
//! whites solve saturates its own ±100 range outright (see
//! `unreachable_targets_saturate_the_solver_and_are_clamped_by_settle`). So the
//! endpoints are anchored on the reference-set population median in the state
//! the tone stage actually receives, and the sliders express only a scene's
//! deviation from the set.
//!
//! The p75 − p25 midtone spread is LEVEL-INVARIANT — a difference of two
//! percentiles, so a constant level offset cancels out of it — and there the two
//! populations agree to 0.033 (≈ 8 code values). That anchor is therefore taken
//! from ACR directly: `contrast` gets an externally-grounded target, and because
//! the two medians are so close, the resulting corrections stay small and
//! land on both sides of zero.
//!
//! Each slider owns the anchor its transfer function actually controls, and is
//! solved by INVERTING the shipping transfer (`scene_tone_controls`,
//! `view::agx`) — not by a hand-fitted curve:
//!
//! ```text
//! contrast    ← the p25…p75 midtone spread   (AgX sigmoid slope)
//! highlights  ← p95                          (smoothstep(0.25, 1.0) band)
//! shadows     ← p10                          ((1 − smoothstep(0, 0.25))² band)
//! whites      ← p99.5                        (smoothstep(0.5, 1.0) band)
//! blacks      ← p0.5                         (toe over the 0.20 span)
//! ```
//!
//! The anchors are display-referred, the sliders are scene-referred, so each
//! anchor is carried across the view transform with [`agx::neutral_curve`] and
//! [`inverse_agx_pixel`] — the same monotone sigmoid the renderer uses — so the
//! target is exactly "the tone the viewer will see". Both groups are evaluated
//! at the REFERENCE slope of 1.0, the slope the population was measured at.
//! Re-referencing the endpoint targets through the solved `contrast` instead
//! sets the two groups fighting: lowering the slope lowers p95's rendered code,
//! which the highlights solve then has to undo, and both end up large to produce
//! a small net change.
//!
//! # Why the sliders cannot rail
//!
//! Four bounds, applied in the order the solve meets them:
//!
//! 1. **A damped TARGET.** Every slider aims at a point [`DAMP`] (one half) of
//!    the way from where its anchor currently sits toward where the population
//!    puts it — never at the anchor itself. AUTO is a starting point the
//!    photographer then tweaks, not a verdict, and a half-correction is the
//!    honest strength for a target that describes a typical scene rather than
//!    this one.
//!
//!    Damping the TARGET rather than the solved slider is load-bearing.
//!    Aiming at the full anchor and halving the answer afterwards reads
//!    correctly but destroys scene-proportionality: the endpoint percentiles sit
//!    in the AgX toe and shoulder, where a slider's whole ±100 range buys very
//!    little display movement, so the full-anchor solve runs to its endpoint on
//!    most frames and every one of them then damps to the SAME number. Measured
//!    on the reference set, that formulation handed four of five sliders an
//!    identical saturated value on more than half the fixtures — bounded, but
//!    carrying no information about the scene.
//! 2. **A capped move.** However far the anchor is, no slider moves its
//!    percentile by more than [`MAX_ANCHOR_MOVE`] in display units. This is the
//!    perceptual statement of "gentle", and it is stated in display units on
//!    purpose: a cap in SLIDER units cannot express it, because the same slider
//!    number means a large tonal move in the midtones and a barely visible one
//!    at the shoulder.
//! 3. **An authority clamp.** A slider only acts over a luma band, so at a given
//!    percentile it may not be able to deliver even the capped move — `whites`
//!    below luma 0.5 is exactly the identity. The target is clamped into the
//!    interval the slider can actually reach, held [`AUTHORITY_MARGIN`] off each
//!    end, so the bisection returns an interior value instead of its bracket
//!    endpoint.
//! 4. **A soft limit.** `v ↦ L · tanh(v / L)` with `L =` [`SOFT_LIMIT`]. Unlike
//!    a clamp this is asymptotic: no input — not a degenerate all-black chart,
//!    not an adversarial synthetic — makes a tone slider REACH ±L, let alone
//!    ±100. It is identity-like for small values (`tanh v ≈ v`), so an ordinary
//!    recommendation passes through untouched and only outliers compress. A hard
//!    clamp was the first cut and was the wrong tool: on the set's flattest
//!    frame it simply pinned three sliders AT the clamp, which is railing with a
//!    smaller number on it.
//!
//! Bounds (1) and (2) keep the values gentle; (3) and (4) make railing
//! structurally impossible. `no_slider_rails_on_the_reference_fixture_set`
//! asserts both halves on every reference photograph — magnitude AND spread,
//! since a slider that hands the same number to every scene is uncalibrated
//! whatever its magnitude.
//!
//! On slider MAGNITUDE: values in the twenties are normal here and are not a
//! symptom of over-driving. These sliders have deliberately modest authority —
//! `highlights` spans ≈ ±0.04 display units at p95 across its ENTIRE ±100 range
//! — so a move of a few display units, which is a small change to look at, costs
//! a large slider number. What distinguishes calibration from railing is that
//! the numbers track the scene: across the reference set each slider's mean sits
//! near zero and its standard deviation is 13–24 units.
//!
//! # Contrast engages
//!
//! `contrast` is now a continuous solve for the AgX slope whose rendered midtone
//! spread matches the anchor, with no dynamic-range gate at all. The dead
//! "< 2.5 stops DR" threshold is gone. It resolves non-zero on every one of the
//! nineteen reference fixtures.

use crate::image::{ColorSpace, Image};
use crate::stages::scene_tone_controls as stc;
use crate::view::agx;
use crate::view::agx_inverse::{inverse_agx_pixel, srgb_gamma_inv};
use crate::view::encode::srgb_gamma;

/// Rec.2020 luma weights — the working color space of the probe buffer.
const LUMA_REC2020: [f32; 3] = [0.2627, 0.6780, 0.0593];

// ---------------------------------------------------------------------------
// Objective target — ACR baseline population anchors (see module doc)
// ---------------------------------------------------------------------------

/// Reference-set median sRGB-encoded luma at p0.5. Drives `blacks`.
const ANCHOR_P005: f32 = 0.0166;
/// Reference-set median at p10. Drives `shadows`.
const ANCHOR_P10: f32 = 0.0680;
/// Reference-set median at p95. Drives `highlights`.
const ANCHOR_P95: f32 = 0.6773;
/// Reference-set median at p99.5. Drives `whites`.
const ANCHOR_P995: f32 = 0.7188;
/// ACR's median p75 − p25 midtone spread. Drives `contrast`. This is the one
/// anchor taken from ACR directly — see the module doc on level-invariance.
const ANCHOR_MID_SPREAD: f32 = 0.3673;

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/// Fraction of the way from the measured anchor to the population anchor that
/// each slider aims for. Matches the shipped exposure heuristic's damping
/// factor and its rationale.
const DAMP: f32 = 0.5;

/// Hard ceiling on how far AUTO may move ANY tone anchor, in sRGB-encoded
/// display units (0.05 ≈ 13 of 255). This is the perceptual expression of
/// "gentle": whatever a scene's deviation from the population, and whatever
/// slider authority happens to be available at that luma, no single tone anchor
/// moves further than this. Without it the cap has to be expressed in slider
/// units instead, and because the endpoint percentiles sit in the AgX toe and
/// shoulder — where a slider's entire range buys very little display movement —
/// a slider-unit cap binds on almost every frame and stops distinguishing
/// scenes.
const MAX_ANCHOR_MOVE: f32 = 0.05;

/// Fraction of a slider's reachable luma span held back at each end, so a
/// target the slider cannot quite reach still resolves to an interior value
/// rather than to the ±100 bracket endpoint.
const AUTHORITY_MARGIN: f32 = 0.08;

/// Below this magnitude (slider units) a solved value resolves to exactly 0.
const DEADBAND: f32 = 2.0;

/// Asymptote of the `tanh` soft limit, in slider units. Deliberately well
/// inside the ±100 range, and unreachable by construction — a solved value can
/// approach ±30 but never arrive.
const SOFT_LIMIT: f32 = 30.0;

/// Bisection iterations for every slider solve. The slider domain is 200 units
/// wide, so 24 halvings resolve to ≈ 1.2e−5 units — far below the 1e−3
/// threshold at which `scene_tone_controls` starts applying a slider at all.
const SOLVE_ITERS: usize = 24;

// The log-domain luma histogram the percentiles come from — see that file for
// why the M0 linear `[0, 1]` binning was a correctness bug, not just coarse.
#[path = "auto_adjustments_tone_histogram.rs"]
mod histogram;
pub(crate) use histogram::{LogLumaHistogram, MID_GRAY};

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/// The five tone sliders this module calibrates, in ±100 slider units.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(crate) struct AutoToneSliders {
    pub contrast: f32,
    pub highlights: f32,
    pub shadows: f32,
    pub whites: f32,
    pub blacks: f32,
}

/// The scene-linear percentile vector the solves operate on, already scaled by
/// the recommended exposure gain. Ordered as the anchors above.
#[derive(Clone, Copy, Debug)]
struct Anchors {
    p005: f32,
    p10: f32,
    p25: f32,
    p75: f32,
    p95: f32,
    p995: f32,
}

impl Anchors {
    fn measure(hist: &LogLumaHistogram, exposure_gain: f32) -> Option<Self> {
        let q = |v| hist.percentile(v).map(|y| y * exposure_gain);
        Some(Self {
            p005: q(0.005)?,
            p10: q(0.10)?,
            p25: q(0.25)?,
            p75: q(0.75)?,
            p95: q(0.95)?,
            p995: q(0.995)?,
        })
    }

    /// Push every anchor through a per-pixel tone transfer, so the next slider
    /// in the pipeline order solves against the state it will actually see.
    fn map(self, f: impl Fn(f32) -> f32) -> Self {
        Self {
            p005: f(self.p005),
            p10: f(self.p10),
            p25: f(self.p25),
            p75: f(self.p75),
            p95: f(self.p95),
            p995: f(self.p995),
        }
    }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/// Calibrate the five tone sliders for `probe`.
///
/// `probe` is the AE-Off / D65-pinned scene-linear buffer
/// `compute_auto_adjustments` already developed; `exposure_ev` is the exposure
/// AUTO is about to recommend.
///
/// **The exposure gain is applied to the measured percentiles before any tone
/// solve.** `scene_tone_controls` runs exposure FIRST and every tone band
/// (`smoothstep(0.25, 1.0)`, `(1 − smoothstep(0, 0.25))²`, …) is keyed on
/// absolute scene luma, so a heuristic that reads the un-gained probe is
/// solving for the wrong pixels — a +1 EV recommendation moves the whole
/// histogram a full stop through those bands before the tone stage sees it.
pub(crate) fn compute_auto_tone_sliders(probe: &Image, exposure_ev: f32) -> AutoToneSliders {
    let hist = LogLumaHistogram::build(probe);
    let Some(anchors) = Anchors::measure(&hist, exposure_ev.exp2()) else {
        // Empty / all-non-finite buffer — nothing to recommend.
        return AutoToneSliders::default();
    };
    solve(anchors)
}

/// The pure half of [`compute_auto_tone_sliders`], split out so the unit tests
/// can drive the solver from hand-built percentile vectors without developing a
/// RAW.
fn solve(anchors: Anchors) -> AutoToneSliders {
    // Contrast shapes the midtones; the four endpoint sliders place the ends.
    // Both are solved against the REFERENCE slope of 1.0 — the slope the anchor
    // population was measured at. Re-referencing the endpoint targets through
    // the solved contrast instead sets the two groups fighting: dropping the
    // slope lowers p95's rendered code, which the highlights solve then has to
    // undo, and both sliders end up large to produce a small net change.
    let contrast = settle(solve_contrast(anchors));

    // The four endpoint sliders run in `scene_tone_controls::apply` order —
    // highlights, shadows, whites, blacks — each solved against the state the
    // previous ones leave behind.
    let highlights = settle(solve_toward(anchors.p95, ANCHOR_P95, highlights_at));
    let anchors = anchors.map(|y| highlights_at(y, highlights));

    let shadows = settle(solve_toward(anchors.p10, ANCHOR_P10, shadows_at));
    let anchors = anchors.map(|y| shadows_at(y, shadows));

    let whites = settle(solve_toward(anchors.p995, ANCHOR_P995, whites_at));
    let anchors = anchors.map(|y| whites_at(y, whites));

    let blacks = settle(solve_toward(anchors.p005, ANCHOR_P005, blacks_at));

    AutoToneSliders {
        contrast,
        highlights,
        shadows,
        whites,
        blacks,
    }
}

/// Solve one slider: move the luma `y` — which is where this slider's anchor
/// percentile currently sits — toward `anchor_code`, by [`DAMP`] of the gap but
/// never by more than [`MAX_ANCHOR_MOVE`].
///
/// The move is measured in the DISPLAY domain, where the anchor is defined and
/// where a fixed step means a fixed perceptual amount; the goal is then carried
/// back into scene-linear for the solve.
///
/// AUTHORITY CLAMP. Each slider only acts over a luma band — `shadows` over
/// `(0, 0.25)` with a squared falloff, `whites` above 0.5, and so on — so at a
/// given `y` a slider's whole ±100 range may not span even the capped move, and
/// at some luma values it has no authority at all (`whites` below 0.5 is
/// exactly the identity). Clamping the target into the reachable interval keeps
/// the bisection off its endpoints, so the answer stays proportional to the
/// deviation the scene really has instead of collapsing onto one saturated
/// number.
fn solve_toward(y: f32, anchor_code: f32, transfer: impl Fn(f32, f32) -> f32) -> f32 {
    const SLOPE: f32 = 1.0;
    let current_code = display_code(y, SLOPE);
    let move_code = (DAMP * (anchor_code - current_code)).clamp(-MAX_ANCHOR_MOVE, MAX_ANCHOR_MOVE);
    let wanted = scene_target(current_code + move_code, SLOPE);

    // Authority clamp — see the doc comment. The reachable interval is shrunk
    // by AUTHORITY_MARGIN so the clamped target lands strictly INSIDE it: a
    // target sitting exactly on the boundary makes `bisect` return that
    // boundary, i.e. ±100, which is the endpoint pinning this clamp exists to
    // prevent.
    let (lo, hi) = (transfer(y, -100.0), transfer(y, 100.0));
    let (min, max) = (lo.min(hi), lo.max(hi));
    let inset = AUTHORITY_MARGIN * (max - min);
    let target = wanted.clamp(min + inset, max - inset);
    bisect(-100.0, 100.0, target, |v| transfer(y, v))
}

/// The final bound from the module doc — the `tanh` soft limit — plus the
/// deadband. The damped target, the capped move and the authority clamp are all
/// applied upstream in [`solve_toward`].
fn settle(raw: f32) -> f32 {
    if !raw.is_finite() {
        return 0.0;
    }
    let limited = SOFT_LIMIT * (raw / SOFT_LIMIT).tanh();
    if limited.abs() < DEADBAND {
        0.0
    } else {
        limited
    }
}

// ---------------------------------------------------------------------------
// Anchor transport across the view transform
// ---------------------------------------------------------------------------

/// The scene-linear luma that renders to sRGB-encoded display value `code`.
///
/// The view tail is `AgX → rec2020_to_srgb → srgb_gamma`; the middle step is a
/// matrix that maps the D65 neutral axis onto itself, so for the achromatic
/// anchors this reduces to undoing the gamma and then the sigmoid at the same
/// `slope` the render will use.
fn scene_target(code: f32, slope: f32) -> f32 {
    let display_linear = srgb_gamma_inv(code);
    let scene = inverse_agx_pixel([display_linear; 3], slope);
    LUMA_REC2020[0] * scene[0] + LUMA_REC2020[1] * scene[1] + LUMA_REC2020[2] * scene[2]
}

/// The sRGB-encoded display value scene-linear luma `y` renders to at `slope`.
/// Forward companion of [`scene_target`].
fn display_code(y: f32, slope: f32) -> f32 {
    srgb_gamma(agx::neutral_curve(y, slope))
}

// ---------------------------------------------------------------------------
// Solver
// ---------------------------------------------------------------------------

/// Bisect a monotone `f` over `[lo, hi]` for the argument where `f == target`.
///
/// Direction is detected from the endpoints rather than assumed, because the
/// four slider transfers are not all monotone the same way (positive
/// `highlights` DARKENS; positive `shadows`, `whites` and `blacks` all
/// brighten). Out-of-bracket targets return the nearer endpoint, which the
/// caller's clamp then bounds.
fn bisect(lo: f32, hi: f32, target: f32, f: impl Fn(f32) -> f32) -> f32 {
    let (f_lo, f_hi) = (f(lo), f(hi));
    if !f_lo.is_finite() || !f_hi.is_finite() {
        return 0.0;
    }
    // Flat transfer — the slider has no authority at this operating point
    // (`whites` below luma 0.5 is exactly the identity, for instance). Return
    // "no opinion" rather than an arbitrary endpoint: the endpoint branches
    // below would otherwise hand back ±100 for a slider that does nothing.
    if (f_hi - f_lo).abs() < 1e-9 {
        return 0.0;
    }
    let rising = f_hi >= f_lo;
    let below_lo = if rising {
        target <= f_lo
    } else {
        target >= f_lo
    };
    if below_lo {
        return lo;
    }
    let above_hi = if rising {
        target >= f_hi
    } else {
        target <= f_hi
    };
    if above_hi {
        return hi;
    }
    let (mut lo, mut hi) = (lo, hi);
    for _ in 0..SOLVE_ITERS {
        let mid = 0.5 * (lo + hi);
        let over = if rising {
            f(mid) < target
        } else {
            f(mid) > target
        };
        if over {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    0.5 * (lo + hi)
}

// ---------------------------------------------------------------------------
// Per-slider inversions
// ---------------------------------------------------------------------------

/// Contrast: solve for the AgX slope whose RENDERED p25…p75 spread matches the
/// ACR baseline population median.
///
/// This is the fix for the dead engagement threshold. M0 gated contrast on
/// "scene dynamic range below 2.5 stops", a condition no photograph meets, so
/// the slider was unreachable code. Midtone spread is instead a continuous
/// property every frame has: a flat, low-contrast scene renders a narrow p25…p75
/// band and solves positive; a already-punchy scene solves negative.
fn solve_contrast(a: Anchors) -> f32 {
    let spread_of = |c: f32| {
        let slope = 1.0 + (c / 100.0) * 0.5;
        display_code(a.p75, slope) - display_code(a.p25, slope)
    };
    let current = spread_of(0.0);
    let move_code = (DAMP * (ANCHOR_MID_SPREAD - current)).clamp(-MAX_ANCHOR_MOVE, MAX_ANCHOR_MOVE);
    bisect(-100.0, 100.0, current + move_code, spread_of)
}

// The four endpoint transfers, each `(luma, slider) -> luma`. These ARE the
// shipping stage's per-pixel math with the caller-hoisted terms folded back in,
// so the solver treats the slider as its only free variable. Positive
// `highlights` darkens; the other three brighten — `bisect` detects the
// direction from the endpoints rather than assuming it.

/// Highlights (`p95`).
fn highlights_at(y: f32, slider: f32) -> f32 {
    let h = slider / 100.0;
    y * stc::highlights_mult(y, h, 1.0 + h * 2.0, 1.0 + 2.0 * h.abs())
}

/// Shadows (`p10`).
fn shadows_at(y: f32, slider: f32) -> f32 {
    y * stc::shadows_mult(y, slider / 100.0)
}

/// The whites gain amount, including the negative-side monotonicity floor the
/// stage applies (`WHITES_MIN_GAIN`, #1918). Solving against the UNFLOORED
/// amount would let the solver ask for a crush the renderer will not perform.
fn whites_amount(slider: f32) -> f32 {
    (slider / 200.0).max(-stc::WHITES_MIN_GAIN)
}

/// Whites (`p99.5`).
fn whites_at(y: f32, slider: f32) -> f32 {
    y * stc::whites_mult(y, whites_amount(slider))
}

/// Blacks (`p0.5`). Sign-branched — multiplicative crush below zero, additive
/// lift above — but monotone increasing in the slider across the join, so one
/// bisection covers both branches.
fn blacks_at(y: f32, slider: f32) -> f32 {
    let b_amount = slider / 100.0;
    if b_amount < 0.0 {
        y * stc::blacks_crush_factor(y, b_amount)
    } else {
        y + stc::blacks_lift_delta(y, stc::B_LIFT_MAX * b_amount)
    }
}

#[cfg(test)]
#[path = "auto_adjustments_tone_tests.rs"]
mod tests;
