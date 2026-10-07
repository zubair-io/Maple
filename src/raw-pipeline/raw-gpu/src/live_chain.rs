//! Gated LIVE-chain builder (epic #925, P4b-core / #1027).
//!
//! [`crate::build_full_chain_passes`] / [`crate::build_split`] (P4a) compose the
//! full develop+view chain but run **every pass unconditionally** — that is the
//! *composition* layer, and `full_chain/tests.rs` proves the resulting
//! neutral-slider divergence (~3.7e-3 vs the CPU pipeline) is **by design**: the
//! per-stage short-circuit (each `raw_core::stages::*::apply` early-returns at its
//! no-op threshold) is the **caller's** job, "the P4b live chain, NOT this
//! composition layer."
//!
//! This module is that caller. [`build_live_chain`] decides pass INCLUSION from
//! the live `AdjustmentModel` (carried as [`FullChainInputs`]) using the SAME
//! predicates raw-core's `apply` fns use, then delegates pass CONSTRUCTION to the
//! `build_split` primitives (same structs, same develop order). The result: a
//! neutral model omits every no-op pass and the GPU output matches `develop` +
//! `render`'s neutral output within `1e-4` — Risk A closed.
//!
//! ## Why a new wrapper (not a flag on `build_split`)
//!
//! `build_split`'s tests assert specific pass COUNTS (the aggressive case = 17
//! passes; the capture-sharpening-off case = 16). Pushing gating into it would
//! break those structural gates and conflate "compose the canonical chain" with
//! "decide which passes a given edit needs." Gating lives here; `build_split`
//! stays the canonical-assembly artifact. We can't introspect `Box<dyn Pass>`, so
//! this REPLICATES `build_split`'s one-push-per-stage body with `if predicate {
//! push(SameStruct) }` rather than calling `build_split` then filtering. The lone
//! drift hazard — develop order now living in two places — is covered by the
//! numeric parity gate (a reordered or missing pass fails it) plus the
//! pass-count/order structural tests in `live_chain/tests.rs`.
//! The gates now live in one typed visitor: boxed callers collect each pass,
//! while the single-submit live session encodes it immediately on the stack.
//! Both forms share stage construction and order; no second gated chain exists.
//!
//! ## The gate predicates (single-sourced from `raw-core/src/stages/*`)
//!
//! - `vibrance` / `saturation` / `clarity` / `texture` / `dehaze` /
//!   `vignette` (on its amount): `slider.abs() < 1e-3` → omit (each stage's
//!   `apply` returns early there).
//! - `white_balance`: `(temp - 6500).abs() < 0.5 && tint.abs() < 0.5` → omit.
//!   The live builder gates on the temp/tint [`FullChainInputs`] carries (NOT a
//!   matrix near-identity test — at 6500K the CAT16 round-trip matrix is ~6.9e-3
//!   off identity, and a temp 0.5K past the band produces an indistinguishable
//!   matrix, so no matrix tolerance separates apply from skip). See [`wb_is_noop`].
//! - `scene_tone_controls`: omit only if ALL of `exposure.abs() < 1e-6 &&
//!   {highlights,shadows,whites,blacks}.abs() < 1e-3` (raw-core `mod.rs:22-28`).
//! - `tone_curves`: omit only if no parametric field `≥ 1e-3` AND every point
//!   curve is identity (raw-core `mod.rs:82-102`).
//! - `display_tone_curve` (#2232): omit only if all four
//!   `display_tone_curve_*` curves are identity.
//! - `sharpen`: `amount.abs() < 1e-3` → omit. `nr_luminance` / `nr_color`:
//!   `< 1e-3` → omit.
//! - `local_adjustments` (#1698): omit unless some layer in the flat stack sets
//!   some control — see [`crate::local_adjustments_are_active`].
//! - `capture_sharpening`: already gated via `Option` (generalised here).
//! - View tail (`agx`, `display_encode`, `srgb_gamma`) ALWAYS runs — even a
//!   neutral image must go through the view transform to become a display
//!   image — but the Auto Profile look (`auto_profile_curve`, `residual_lut`)
//!   runs only when its artifacts are PRESENT (RAW shape + non-empty curve /
//!   non-zero LUT size), matching raw-core's `if let Some` skips. `dither`
//!   (P4b terminal) is appended by the live session, not here (this builder is
//!   f32-RGBA, like `build_split`).

use crate::agx::AgxPass;
use crate::auto_profile_curve::{profile_curve_is_active, AutoProfileCurvePass};
use crate::capture_sharpening::CaptureSharpeningPass;
use crate::clarity::ClarityPass;
use crate::color_grade::{color_grade_is_identity, ColorGradePass};
use crate::defringe::DefringePass;
use crate::dehaze::{AirlightSource, DehazePass};
use crate::display_encode::DisplayEncodePass;
use crate::display_tone_curve::{display_tone_curve_is_identity, DisplayToneCurvePass};
use crate::film_lut::FilmLutPass;
use crate::full_chain::hsl_pass_for;
use crate::full_chain::{BoxedPasses, FullChainInputs, InputShape};
use crate::grain::GrainPass;
use crate::local_adjustments::{
    local_adjustments_are_active, local_adjustments_need_spatial, logical_layers,
    LocalAdjustmentsPass,
};
use crate::local_spatial::{layer_needs_spatial, LocalSpatialPass};
use crate::noise_reduction::{NlmColorPass, NlmLumaPass};
use crate::residual_lut::{residual_lut_is_active, ResidualLutPass};
use crate::saturation::SaturationPass;
use crate::scene_tone_controls::SceneToneControlsPass;
use crate::sharpen::SharpenPass;
use crate::srgb_gamma::SrgbGammaPass;
use crate::texture::TexturePass;
use crate::tone_curves::ToneCurvesPass;
use crate::vibrance::VibrancePass;
use crate::vignette::VignettePass;
use crate::white_balance::WhiteBalancePass;

mod builder;
pub use builder::{build_live_chain, build_live_split};
pub(crate) use builder::{visit_live_chain, LivePassSink};

pub(crate) fn validate_curve_capacity(inputs: &FullChainInputs<'_>) -> Result<(), String> {
    let curves = [
        &inputs.tone_curves.luma,
        &inputs.tone_curves.red,
        &inputs.tone_curves.green,
        &inputs.tone_curves.blue,
        &inputs.display_tone_curves.master,
        &inputs.display_tone_curves.red,
        &inputs.display_tone_curves.green,
        &inputs.display_tone_curves.blue,
    ];
    if curves
        .iter()
        .any(|points| !crate::tone_curves::point_curve_fits_gpu(points))
    {
        return Err(
            "An imported tone curve exceeds the GPU preview's control-point capacity".into(),
        );
    }
    Ok(())
}

mod noop;
pub use noop::scene_tone_is_noop;
use noop::*;

// `active_mask` lives in a sibling file to keep this module inside the
// file-size budget (same split shape as `noop` / `signature` / `tests`).
mod mask;

// `chain_signature` lives in a sibling file to keep this module inside the
// file-size budget (same split shape as `noop` / `tests`).
#[path = "live_chain/signature.rs"]
mod signature;
#[cfg(test)]
pub(crate) use mask::active_mask;
pub use signature::chain_signature;

/// Whether the dehaze stage is engaged for `inputs` — the SAME predicate
/// [`build_live_split`] gates the `DehazePass` on (`|dehaze| >= 1e-3`). Public so
/// the live session ([`crate::LiveSession`]) can decide whether it must take the
/// mid-chain airlight readback path (dehaze active → A is measured from the
/// post-prefix buffer) vs. the single-submit no-readback path (dehaze inactive).
/// Single-sourced here so it can't disagree with whether the pass was pushed.
pub fn dehaze_is_active(inputs: &FullChainInputs) -> bool {
    inputs.dehaze.abs() >= SLIDER_EPS
}

/// The number of view-tail passes for a RAW input shape with Auto Profile
/// artifacts present (`agx`, `display_encode`, `srgb_gamma`,
/// `auto_profile_curve`, `residual_lut`). A neutral RAW chain with fitted
/// artifacts has exactly this many passes; each engaged slider adds one (or,
/// for the spatial stages, still one `Pass` — they orchestrate their own
/// sub-dispatches). Absent Auto artifacts (Neutral / unavailable-Auto) omit
/// the two look passes even for RAW (`VIEW_TAIL_PASS_COUNT - 2`); NON-RAW
/// shapes skip the whole LOOK portion — `agx` (#1513) plus
/// `auto_profile_curve` + `residual_lut` (#1516) — leaving only the
/// colorimetric encode (`display_encode` + `srgb_gamma`), so a neutral
/// non-RAW chain has `VIEW_TAIL_PASS_COUNT - 3`. Public so the live-session
/// terminal-`dither` wiring (C2/C3) and the tests can assert the floor without
/// re-counting by hand.
pub const VIEW_TAIL_PASS_COUNT: usize = 5;

/// Expected view-tail passes for the actual input shape and fitted artifacts.
pub fn view_tail_pass_count(inputs: &FullChainInputs) -> usize {
    if inputs.input_shape != InputShape::PostDcpRec2020Fp16 {
        return VIEW_TAIL_PASS_COUNT - 3;
    }
    VIEW_TAIL_PASS_COUNT - 2
        + usize::from(profile_curve_is_active(&inputs.profile_curve_flat))
        + usize::from(residual_lut_is_active(
            inputs.residual_lut_size,
            &inputs.residual_lut_data,
        ))
}

// Parity tests live in a sibling file to keep this module under the 600-LOC
// budget (mirrors full_chain / dehaze's tests.rs split). They drive the SHARED
// `crate::full_chain::oracle` harness so the live gate's CPU reference can't
// drift from the P4a gate's. Native test builds only.
#[cfg(all(test, not(target_arch = "wasm32")))]
#[path = "live_chain/tests.rs"]
mod tests;
// The input-shape + sub-parameter pass-inclusion gates live in their own file
// (600-LOC file budget); they reuse `tests::{neutral_case, run_live_chain,
// TEST_SESSION_ID}` (`pub(super)` there). Same split shape as `gpu_render`'s
// `tests` / `tests_sizing`.
#[cfg(all(test, not(target_arch = "wasm32")))]
#[path = "live_chain/tests_gating.rs"]
mod tests_gating;
// The scope-pass alpha-lane contract (#3272) lives in its own file (600-LOC
// budget); reuses `tests::run_live_chain` (`pub(super)` there). Same split
// shape as `tests_gating`.
#[cfg(all(test, not(target_arch = "wasm32")))]
#[path = "live_chain/tests_scope.rs"]
mod tests_scope;

#[cfg(all(test, not(target_arch = "wasm32")))]
#[path = "live_chain/tests_capacity.rs"]
mod tests_capacity;
