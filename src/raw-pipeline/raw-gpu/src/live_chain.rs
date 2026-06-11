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
//! - `sharpen`: `amount.abs() < 1e-3` → omit. `nr_luminance` / `nr_color`:
//!   `< 1e-3` → omit.
//! - `capture_sharpening`: already gated via `Option` (generalised here).
//! - View tail (`agx`, `display_encode`, `srgb_gamma`, `auto_profile_curve`,
//!   `residual_lut`) ALWAYS run — even a neutral image must go through the view
//!   transform to become a display image. `dither` (P4b terminal) is appended by
//!   the live session, not here (this builder is f32-RGBA, like `build_split`).

use crate::agx::AgxPass;
use crate::auto_profile_curve::AutoProfileCurvePass;
use crate::capture_sharpening::CaptureSharpeningPass;
use crate::clarity::ClarityPass;
use crate::dehaze::{AirlightSource, DehazePass};
use crate::display_encode::DisplayEncodePass;
use crate::full_chain::{BoxedPasses, FullChainInputs};
use crate::noise_reduction::{NlmColorPass, NlmLumaPass};
use crate::residual_lut::ResidualLutPass;
use crate::saturation::SaturationPass;
use crate::scene_tone_controls::SceneToneControlsPass;
use crate::sharpen::SharpenPass;
use crate::srgb_gamma::SrgbGammaPass;
use crate::texture::TexturePass;
use crate::tone_curves::ToneCurvesPass;
use crate::vibrance::VibrancePass;
use crate::vignette::VignettePass;
use crate::white_balance::WhiteBalancePass;

/// The per-pixel slider no-op threshold raw-core uses across vibrance,
/// saturation, clarity, texture, dehaze, sharpen, NR, and the scene-tone
/// non-exposure fields (`raw_core::stages::*` all gate at `abs() < 1e-3`).
const SLIDER_EPS: f32 = 1e-3;
/// Exposure's tighter threshold (`scene_tone_controls::apply` gates exposure at
/// `abs() < 1e-6`, the other four tone fields at `< 1e-3`).
const EXPOSURE_EPS: f32 = 1e-6;
/// White-balance neutral white point (Kelvin) and the half-degree short-circuit
/// band `white_balance::apply` uses (`(temp - 6500).abs() < 0.5 && tint.abs() <
/// 0.5`). The live builder gates on these directly (see [`wb_is_noop`]).
const WB_NEUTRAL_KELVIN: f32 = 6500.0;
const WB_SKIP_BAND: f32 = 0.5;

/// Whether the scene-tone-controls stage is a no-op for these sliders — the EXACT
/// predicate from `raw_core::stages::scene_tone_controls::apply` identity
/// short-circuit: exposure within `1e-6` AND brightness/highlights/shadows/
/// whites/blacks each within `1e-3`.
/// `tone = [exposure, brightness, highlights, shadows, whites, blacks]`.
fn scene_tone_is_noop(tone: &[f32; 6]) -> bool {
    tone[0].abs() < EXPOSURE_EPS
        && tone[1].abs() < SLIDER_EPS
        && tone[2].abs() < SLIDER_EPS
        && tone[3].abs() < SLIDER_EPS
        && tone[4].abs() < SLIDER_EPS
        && tone[5].abs() < SLIDER_EPS
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
fn tone_curves_is_noop(inputs: &crate::tone_curves::ToneCurveInputs) -> bool {
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
fn wb_is_noop(temperature: f32, tint: f32) -> bool {
    (temperature - WB_NEUTRAL_KELVIN).abs() < WB_SKIP_BAND && tint.abs() < WB_SKIP_BAND
}

/// Build the LIVE develop+view chain for `inputs`, OMITTING every no-op pass
/// (the gated counterpart to [`crate::build_full_chain_passes`]). A neutral
/// `AdjustmentModel` yields only the always-on view tail; each engaged slider
/// adds exactly its pass. The view tail's `dither` terminal (P4b) is appended by
/// the live session, not here — this builder stays f32-RGBA, like `build_split`.
///
/// `airlight` selects the `DehazePass`'s airlight source (only built when dehaze
/// is engaged). The LIVE loop passes [`AirlightSource::OnGpu`] (#1033): A is
/// computed on-device with NO GPU→CPU readback, so the dehaze-active chain runs in
/// ONE submit. The headless gate passes [`AirlightSource::Cpu`] of the pre-dehaze
/// buffer (the byte-exact-vs-raw-core reference path).
pub fn build_live_chain(inputs: &FullChainInputs, airlight: AirlightSource) -> BoxedPasses {
    let (prefix, suffix) = build_live_split(inputs, airlight);
    let mut all = prefix;
    all.extend(suffix);
    all
}

/// The split form of [`build_live_chain`], mirroring [`crate::build_split`]'s
/// `(prefix, suffix)` shape so the airlight readback path (C5a) can run the
/// pre-dehaze prefix, derive the airlight, then build the dehaze+suffix.
///
/// Returns `(prefix, suffix)` where:
///   - `prefix` = the gated scene-linear stages BEFORE dehaze (capture_sharpening
///     through texture), each included only if engaged.
///   - `suffix` = dehaze (only if engaged) + sharpen + NR (each gated) + the
///     always-on view tail.
///
/// DEGENERATE-DEHAZE NOTE: when dehaze is omitted (`|dehaze| < 1e-3`), the suffix
/// simply has no `DehazePass` at its head — it is still a coherent, runnable Vec
/// (sharpen/NR/view-tail). The `airlight` argument is ignored when dehaze is
/// omitted.
///
/// AIRLIGHT SOURCE (#1033): with [`AirlightSource::OnGpu`] (the live path) the
/// `DehazePass` measures A on-device from its `src` — which in this chain IS the
/// post-prefix buffer (dehaze is the first suffix pass) — so the old C5a
/// prefix→readback→suffix split is no longer needed for the live loop; the whole
/// chain runs in one submit. With [`AirlightSource::Cpu`] the caller supplies A
/// (the readback fallback / the headless reference path).
#[allow(clippy::vec_init_then_push)]
pub fn build_live_split(
    inputs: &FullChainInputs,
    airlight: AirlightSource,
) -> (BoxedPasses, BoxedPasses) {
    // --- Prefix: capture_sharpening (FIRST, develop's 04b placement) through
    //     texture. Each pass is included only when its stage is NOT a no-op,
    //     replicating develop's per-stage `if` guards / the `apply` short-circuit. ---
    let mut prefix: BoxedPasses = Vec::new();
    if let Some(params) = inputs.capture_sharpening {
        // Already `Option`-gated in `build_split`; `Some` === develop ran the stage.
        prefix.push(Box::new(CaptureSharpeningPass { params }));
    }
    if !wb_is_noop(inputs.wb_temperature, inputs.wb_tint) {
        prefix.push(Box::new(WhiteBalancePass {
            matrix: inputs.wb_matrix,
        }));
    }
    if !scene_tone_is_noop(&inputs.tone) {
        prefix.push(Box::new(SceneToneControlsPass {
            exposure: inputs.tone[0],
            brightness: inputs.tone[1],
            highlights: inputs.tone[2],
            shadows: inputs.tone[3],
            whites: inputs.tone[4],
            blacks: inputs.tone[5],
        }));
    }
    if !tone_curves_is_noop(&inputs.tone_curves) {
        prefix.push(Box::new(ToneCurvesPass {
            inputs: inputs.tone_curves.clone(),
        }));
    }
    if inputs.vibrance.abs() >= SLIDER_EPS {
        prefix.push(Box::new(VibrancePass {
            vibrance: inputs.vibrance,
        }));
    }
    if inputs.saturation.abs() >= SLIDER_EPS {
        prefix.push(Box::new(SaturationPass {
            saturation: inputs.saturation,
        }));
    }
    if inputs.clarity.abs() >= SLIDER_EPS {
        prefix.push(Box::new(ClarityPass {
            clarity: inputs.clarity,
        }));
    }
    if inputs.texture.abs() >= SLIDER_EPS {
        prefix.push(Box::new(TexturePass {
            texture: inputs.texture,
        }));
    }

    // --- Suffix: dehaze (gated; airlight from the prefix output) → sharpen → NR
    //     (gated) → the always-on view tail. ---
    let mut suffix: BoxedPasses = Vec::new();
    if inputs.dehaze.abs() >= SLIDER_EPS {
        suffix.push(Box::new(DehazePass {
            dehaze: inputs.dehaze,
            airlight: airlight.clone(),
        }));
    }
    // Vignette (#1109) — develop's 12c position (after dehaze / the no-op
    // local_adjustments, before sharpen). Same `apply` predicate as the
    // raw-core stage's identity short-circuit (`|amount| < 1e-3`); feather
    // alone never engages the stage.
    if inputs.vignette_amount.abs() >= SLIDER_EPS {
        suffix.push(Box::new(VignettePass {
            amount: inputs.vignette_amount,
            feather: inputs.vignette_feather,
        }));
    }
    if inputs.sharpen_amount.abs() >= SLIDER_EPS {
        suffix.push(Box::new(SharpenPass {
            amount: inputs.sharpen_amount,
            radius: inputs.sharpen_radius,
            detail: inputs.sharpen_detail,
            masking: inputs.sharpen_masking,
        }));
    }
    if inputs.nr_luminance.abs() >= SLIDER_EPS {
        suffix.push(Box::new(NlmLumaPass {
            nr_luminance: inputs.nr_luminance,
        }));
    }
    if inputs.nr_color.abs() >= SLIDER_EPS {
        suffix.push(Box::new(NlmColorPass {
            nr_color: inputs.nr_color,
        }));
    }

    // View tail — ALWAYS runs (the scene→display transform). AgX at contrast 0
    // is the neutral view transform, not a no-op: it still tone-maps. Mirrors
    // `build_split`'s tail order exactly (agx → display_encode → srgb_gamma →
    // auto_profile_curve → residual_lut). `dither` is the session's terminal.
    suffix.push(Box::new(AgxPass {
        contrast: inputs.contrast,
    }));
    suffix.push(Box::new(DisplayEncodePass));
    suffix.push(Box::new(SrgbGammaPass));
    suffix.push(Box::new(AutoProfileCurvePass {
        flat_curve: inputs.profile_curve_flat.clone(),
    }));
    suffix.push(Box::new(ResidualLutPass {
        size: inputs.residual_lut_size,
        data: inputs.residual_lut_data.clone(),
    }));

    (prefix, suffix)
}

/// Whether the dehaze stage is engaged for `inputs` — the SAME predicate
/// [`build_live_split`] gates the `DehazePass` on (`|dehaze| >= 1e-3`). Public so
/// the live session ([`crate::LiveSession`]) can decide whether it must take the
/// mid-chain airlight readback path (dehaze active → A is measured from the
/// post-prefix buffer) vs. the single-submit no-readback path (dehaze inactive).
/// Single-sourced here so it can't disagree with whether the pass was pushed.
pub fn dehaze_is_active(inputs: &FullChainInputs) -> bool {
    inputs.dehaze.abs() >= SLIDER_EPS
}

/// The number of always-on view-tail passes (`agx`, `display_encode`,
/// `srgb_gamma`, `auto_profile_curve`, `residual_lut`). A neutral chain has
/// exactly this many passes; each engaged slider adds one (or, for the spatial
/// stages, still one `Pass` — they orchestrate their own sub-dispatches). Public
/// so the live-session terminal-`dither` wiring (C2/C3) and the tests can assert
/// the floor without re-counting the tail by hand.
pub const VIEW_TAIL_PASS_COUNT: usize = 5;

/// The active-stage bitmask — which gated passes [`build_live_split`] includes
/// for `inputs`, one bit per scene-linear stage (the view tail is always-on, so
/// it isn't represented). SINGLE-SOURCED with the builder: every bit uses the
/// exact same predicate the corresponding `if` in `build_live_split` uses, so the
/// mask can't disagree with which passes actually get pushed. Used by
/// [`chain_signature`] to key the live pool's bind-group cache.
fn active_mask(inputs: &FullChainInputs) -> u32 {
    let mut m = 0u32;
    if inputs.capture_sharpening.is_some() {
        m |= 1 << 0;
    }
    if !wb_is_noop(inputs.wb_temperature, inputs.wb_tint) {
        m |= 1 << 1;
    }
    if !scene_tone_is_noop(&inputs.tone) {
        m |= 1 << 2;
    }
    if !tone_curves_is_noop(&inputs.tone_curves) {
        m |= 1 << 3;
    }
    if inputs.vibrance.abs() >= SLIDER_EPS {
        m |= 1 << 4;
    }
    if inputs.saturation.abs() >= SLIDER_EPS {
        m |= 1 << 5;
    }
    if inputs.clarity.abs() >= SLIDER_EPS {
        m |= 1 << 6;
    }
    if inputs.texture.abs() >= SLIDER_EPS {
        m |= 1 << 7;
    }
    if inputs.dehaze.abs() >= SLIDER_EPS {
        m |= 1 << 8;
    }
    if inputs.vignette_amount.abs() >= SLIDER_EPS {
        m |= 1 << 9;
    }
    if inputs.sharpen_amount.abs() >= SLIDER_EPS {
        m |= 1 << 10;
    }
    if inputs.nr_luminance.abs() >= SLIDER_EPS {
        m |= 1 << 11;
    }
    if inputs.nr_color.abs() >= SLIDER_EPS {
        m |= 1 << 12;
    }
    m
}

/// The chain SIGNATURE for the live pool ([`crate::frame_pool`]): a hash of the
/// active-stage mask + the render dims + anything that changes the DISPATCH COUNT
/// within an active stage. The pool keys its bind-group / scratch cache by this,
/// so two renders with the same signature share resources (zero alloc on the
/// second) while a signature change (a slider crossing a gating threshold, a dims
/// change, a different capture-sharpening iteration count) lands in a fresh
/// bucket — never binding a stale buffer to the wrong kernel.
///
/// Dispatch-count drivers folded in beyond the on/off mask:
/// - **capture-sharpening `iterations`**: its encode loop is `for _ in
///   0..iterations`, so a different count = a different dispatch sequence.
/// - NLM's shift-loop count is a CONST per pass (`LUMA_SEARCH_RADIUS` /
///   `CHROMA_SEARCH_RADIUS`), captured by the nr_luminance / nr_color mask bits —
///   no extra field needed. The box-blur sweeps and dehaze's DAG are fixed once
///   their stage is active.
///
/// Pooled-data-buffer SIZE drivers folded in (#1079):
/// - **`residual_lut_size`**: the residual-LUT pass's pooled storage buffer is
///   `size³·3` floats — the ONE pooled data buffer whose byte length can vary at
///   a constant active mask (the Auto Profile curve is `PROFILE_CURVE_FLAT_LEN`-
///   fixed, the tone-curve slots are `NUM_SLOTS × SLOT_STRIDE`-fixed, the AgX
///   LUT is a const). Without it, a residual LUT GROWING mid-session would make
///   `pool_scratch` replace the too-small buffer while the cached bind group at
///   the same signature kept referencing the OLD one — the dispatch would read
///   stale LUT data. Folding the size in lands the new shape in a fresh bucket.
pub fn chain_signature(inputs: &FullChainInputs, dims: (u32, u32)) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    active_mask(inputs).hash(&mut h);
    dims.0.hash(&mut h);
    dims.1.hash(&mut h);
    // Capture-sharpening iterations drive the RL dispatch-loop length.
    let cs_iters = inputs
        .capture_sharpening
        .as_ref()
        .map(|p| p.iterations)
        .unwrap_or(0);
    cs_iters.hash(&mut h);
    // The residual-LUT edge drives the pooled grid buffer's byte length (#1079).
    // Hash as u64 so the signature is stable across usize widths.
    (inputs.residual_lut_size as u64).hash(&mut h);
    h.finish()
}

// Parity tests live in a sibling file to keep this module under the 600-LOC
// budget (mirrors full_chain / dehaze's tests.rs split). They drive the SHARED
// `crate::full_chain::oracle` harness so the live gate's CPU reference can't
// drift from the P4a gate's. Native test builds only.
#[cfg(all(test, not(target_arch = "wasm32")))]
#[path = "live_chain/tests.rs"]
mod tests;
