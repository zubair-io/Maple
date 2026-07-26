//! Identity short-circuit predicates for the live chain builder, split out of
//! `live_chain.rs` for the 600-line hard budget. #1698's layer-stack activity
//! check and #1714's noise-profile plumbing each added to that file; neither
//! crossed the limit alone, their sum did.
//!
//! Each predicate mirrors EXACTLY the corresponding `raw_core::stages::*`
//! identity gate — that correspondence is the whole point, so they live
//! together rather than beside the passes they gate. Pure relocation.

#[allow(unused_imports)]
use super::*;

/// The per-pixel slider no-op threshold raw-core uses across vibrance,
/// saturation, clarity, texture, dehaze, sharpen, NR, and the scene-tone
/// non-exposure fields (`raw_core::stages::*` all gate at `abs() < 1e-3`).
pub(super) const SLIDER_EPS: f32 = 1e-3;
/// Exposure's tighter threshold (`scene_tone_controls::apply` gates exposure at
/// `abs() < 1e-6`, the other four tone fields at `< 1e-3`).
pub(super) const EXPOSURE_EPS: f32 = 1e-6;
/// White-balance neutral white point (Kelvin) and the half-degree short-circuit
/// band `white_balance::apply` uses (`(temp - 6500).abs() < 0.5 && tint.abs() <
/// 0.5`). The live builder gates on these directly (see [`wb_is_noop`]).
pub(super) const WB_NEUTRAL_KELVIN: f32 = 6500.0;
pub(super) const WB_SKIP_BAND: f32 = 0.5;

/// Whether the scene-tone-controls stage is a no-op for these sliders — the EXACT
/// predicate from `raw_core::stages::scene_tone_controls::apply` identity
/// short-circuit: exposure within `1e-6` AND brightness/highlights/shadows/
/// whites/blacks each within `1e-3`.
/// `tone = [exposure, brightness, highlights, shadows, whites, blacks]`.
pub(super) fn scene_tone_is_noop(tone: &[f32; 6]) -> bool {
    tone[0].abs() < EXPOSURE_EPS
        && tone[1].abs() < SLIDER_EPS
        && tone[2].abs() < SLIDER_EPS
        && tone[3].abs() < SLIDER_EPS
        && tone[4].abs() < SLIDER_EPS
        && tone[5].abs() < SLIDER_EPS
}

/// Dispatch shape of the internally-gated scene-tone DAG. Values within a fixed
/// shape deliberately do not participate. Bit layout: pre
/// (exposure/brightness), two-bit masked-step count, post (whites/blacks).
/// Highlights-only and Shadows-only share the same pipeline and bindings. A
/// point-only stage returns zero; the outer active bit distinguishes neutral.
pub(super) fn scene_tone_dispatch_shape(tone: &[f32; 6]) -> u8 {
    let highlights = tone[2].abs() >= SLIDER_EPS;
    let shadows = tone[3].abs() >= SLIDER_EPS;
    if !highlights && !shadows {
        return 0;
    }

    let mut shape = 0u8;
    if tone[0].abs() >= EXPOSURE_EPS || tone[1].abs() >= SLIDER_EPS {
        shape |= 1 << 0;
    }
    let masked_count = u8::from(highlights) + u8::from(shadows);
    shape |= masked_count << 1;
    if tone[4].abs() >= SLIDER_EPS || tone[5].abs() >= SLIDER_EPS {
        shape |= 1 << 3;
    }
    shape
}

/// Whether the tone-curves stage is a no-op — mirrors
/// `raw_core::stages::tone_curves::apply` (`mod.rs:82-102`): no parametric field
/// `≥ 1e-3` AND every point curve (luma / R / G / B) is identity.
///
/// A point curve is identity iff its point list is EMPTY — this is exactly
/// `raw_core::types::ToneCurve::is_identity` (`curves.rs:74` = `points.is_empty()`),
/// which treats even `[(0,0),(1,1)]` as a real (non-identity) curve that the
/// stage runs. The live builder carries the curves as flat point lists
/// (`ToneCurveInputs`), so the test is the same emptiness check here (no
/// raw-core dep), keeping the GPU's pass-inclusion bit-for-bit with develop's.
pub(super) fn tone_curves_is_noop(inputs: &crate::tone_curves::ToneCurveInputs) -> bool {
    let parametric_active = inputs.parametric.iter().any(|p| p.abs() >= SLIDER_EPS);
    if parametric_active {
        return false;
    }
    inputs.luma.is_empty()
        && inputs.red.is_empty()
        && inputs.green.is_empty()
        && inputs.blue.is_empty()
}

/// Whether white balance is a no-op for `(temperature, tint)` — the EXACT
/// predicate `raw_core::stages::white_balance::apply` short-circuits on
/// (`white_balance.rs:169`): `(temp - 6500).abs() < 0.5 && tint.abs() < 0.5`.
///
/// Gating on temp/tint (not the derived matrix) is REQUIRED for parity: at 6500K
/// the CAT16 round-trip matrix sits ~6.9e-3 off identity (a matrix-identity test
/// would wrongly fire and OMIT WB even when the CPU applies it), and conversely a
/// temp 0.5K outside the band yields a matrix indistinguishable from the 6500K
/// one — so no matrix tolerance can separate "CPU applies" from "CPU skips". The
/// temp/tint the matrix was derived from is the only sound discriminator.
pub(super) fn wb_is_noop(temperature: f32, tint: f32) -> bool {
    (temperature - WB_NEUTRAL_KELVIN).abs() < WB_SKIP_BAND && tint.abs() < WB_SKIP_BAND
}
