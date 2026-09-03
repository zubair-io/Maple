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
//! - `display_tone_curve` (#2232): omit only if all four
//!   `display_tone_curve_*` curves are identity.
//! - `sharpen`: `amount.abs() < 1e-3` → omit. `nr_luminance` / `nr_color`:
//!   `< 1e-3` → omit.
//! - `local_adjustments` (#1698): omit unless some layer in the flat stack sets
//!   some control — see [`crate::local_adjustments_are_active`].
//! - `capture_sharpening`: already gated via `Option` (generalised here).
//! - View tail (`agx`, `display_encode`, `srgb_gamma`, `auto_profile_curve`,
//!   `residual_lut`) ALWAYS run — even a neutral image must go through the view
//!   transform to become a display image. `dither` (P4b terminal) is appended by
//!   the live session, not here (this builder is f32-RGBA, like `build_split`).

use crate::agx::AgxPass;
use crate::auto_profile_curve::AutoProfileCurvePass;
use crate::capture_sharpening::CaptureSharpeningPass;
use crate::clarity::ClarityPass;
use crate::color_grade::{color_grade_is_identity, ColorGradePass};
use crate::dehaze::{AirlightSource, DehazePass};
use crate::display_encode::DisplayEncodePass;
use crate::display_tone_curve::{display_tone_curve_is_identity, DisplayToneCurvePass};
use crate::film_lut::FilmLutPass;
use crate::full_chain::hsl_pass_for;
use crate::full_chain::{BoxedPasses, FullChainInputs, InputShape};
use crate::grain::GrainPass;
use crate::local_adjustments::{local_adjustments_are_active, LocalAdjustmentsPass};
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

// Compile-time guard: `active_mask` packs `input_shape` into the top 2 bits
// of a u32 (shift left by 30). That encoding supports at most 4 variants
// (discriminants 0–3). If a 5th variant (discriminant 4) is ever added, the
// shift would produce a value with bit 32 set, which is out-of-range for u32
// in debug (overflow panic) or silently truncated in release. The assert below
// turns that scenario into a compile error with a clear message instead.
// There is no `const fn` way to iterate an enum's discriminants in stable Rust,
// so we assert on the known highest discriminant value directly.
const _: () = assert!(
    InputShape::SrgbGammaEncoded8 as u32 <= 3,
    "InputShape has a variant with discriminant > 3; active_mask's 2-bit \
     `input_shape` pack in the top 2 bits of u32 (shift 30) would overflow. \
     Widen the encoding or increase the shift before adding a 5th variant."
);

mod noop;
use noop::*;

// `chain_signature` lives in a sibling file to keep this module inside the
// file-size budget (same split shape as `noop` / `tests`).
#[path = "live_chain/signature.rs"]
mod signature;
pub use signature::chain_signature;

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
pub fn build_live_chain<'a>(
    inputs: &'a FullChainInputs<'_>,
    airlight: AirlightSource,
) -> BoxedPasses<'a> {
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
pub fn build_live_split<'a>(
    inputs: &'a FullChainInputs<'_>,
    airlight: AirlightSource,
) -> (BoxedPasses<'a>, BoxedPasses<'a>) {
    // --- Prefix: capture_sharpening (FIRST, develop's 04b placement) through
    //     texture. Each pass is included only when its stage is NOT a no-op,
    //     replicating develop's per-stage `if` guards / the `apply` short-circuit.
    //
    //     For `LinearRec2020Fp16` / `SrgbGammaEncoded8` input shapes the buffer
    //     is already colour-space–correct linear Rec.2020 (the 8-bit path was
    //     pre-converted at session open on the CPU side). WB and
    //     capture_sharpening have no meaning there and are unconditionally
    //     skipped regardless of slider values. ---
    let mut prefix: BoxedPasses = Vec::new();
    // capture_sharpening is RAW-only (#1331): non-RAW shapes (pano PNG, JPEG)
    // upload a buffer that is already post-demosaic, so there was no capture
    // sharpening to apply. `PostDcpRec2020Fp16` is the historic default,
    // preserving the existing RAW behaviour exactly.
    let is_raw_shape = inputs.input_shape == InputShape::PostDcpRec2020Fp16;
    if is_raw_shape {
        if let Some(params) = inputs.capture_sharpening {
            // Already `Option`-gated in `build_split`; `Some` === develop ran the stage.
            prefix.push(Box::new(CaptureSharpeningPass { params }));
        }
    }
    // WB stays engaged for ALL input shapes (#1331): for non-RAW assets the
    // FFI caller passes `decoded_temperature = 6500.0` / `decoded_tint = 0.0`
    // so that `apply_delta(live, decoded=6500/0)` is IDENTITY when the slider
    // is at default (6500K/0), but SHIFTS correctly as the user drags temp/tint.
    // Skipping WB for non-RAW would make the temperature/tint sliders inert.
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
    // HSL (#1112) / black & white (#276) — gated when any of the 24 sliders
    // is engaged (same predicate as raw-core's `hsl_params` is_identity
    // flag: `abs() >= 1e-3`) or B&W is armed.
    {
        let hsl_pass = hsl_pass_for(inputs);
        if !hsl_pass.is_noop() {
            prefix.push(Box::new(hsl_pass));
        }
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
    // Local adjustments (#1698) — develop's 12b position, between dehaze and
    // vignette. See the gate-predicate note in the module docs.
    if local_adjustments_are_active(&inputs.local_adjustments, inputs.scope.layer) {
        suffix.push(Box::new(
            LocalAdjustmentsPass::new(&inputs.local_adjustments, &inputs.mask_rasters)
                .with_scope_layer(inputs.scope.layer),
        ));
    }
    // Vignette (#1109) — develop's 12c position (after local_adjustments,
    // before sharpen). Same `apply` predicate as the raw-core stage's identity
    // short-circuit (`|amount| < 1e-3`); feather alone never engages the stage.
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
            noise_profile: inputs.noise_profile.clone(),
            iso: inputs.iso,
        }));
    }
    if inputs.nr_color.abs() >= SLIDER_EPS {
        suffix.push(Box::new(NlmColorPass {
            nr_color: inputs.nr_color,
            noise_profile: inputs.noise_profile.clone(),
            iso: inputs.iso,
        }));
    }

    // View tail. AgX is the scene→display tone-map. It runs for RAW shapes
    // (`PostDcpRec2020Fp16`), whose buffer is scene-referred. NON-RAW shapes
    // (`LinearRec2020Fp16` / `SrgbGammaEncoded8`) are ALREADY display-referred —
    // a JPEG/PNG/HEIF tone-mapped at capture — so AgX would double-tone-map them
    // (white 1.0 crushes to ~0.82, dim and warm). The CPU pipeline skips AgX for
    // non-RAW for exactly this reason (`ImageEditPipeline.processSceneLinearNonRaw`,
    // `skipAgX: true`); mirror it here so the GPU-live and CPU paths agree. The
    // rest of the tail (`display_encode` → `srgb_gamma` → …) still runs: the
    // non-RAW buffer is linear Rec.2020 and must be encoded to display sRGB. #1513
    // View tail: AgX for every profile (the AcrMatch branch was retired in
    // #2312). Non-RAW shapes (display-referred) skip the tone-map entirely
    // (#1513).
    if is_raw_shape {
        suffix.push(Box::new(AgxPass {
            contrast: inputs.contrast,
        }));
    }
    // Display-referred point curves (#2232, `crs:ToneCurvePV2012*`) —
    // post-AgX, before color_grade. GATED on all four curves being
    // identity (mirrors `stages::display_tone_curve::apply`'s own
    // early-return). Runs for non-RAW shapes too — the same buffer
    // `color_grade` / `grain` already treat as display-linear regardless of
    // `is_raw_shape` (#2478's precedent, applied here since #2232 lands
    // after it).
    if !display_tone_curve_is_identity(&inputs.display_tone_curves) {
        suffix.push(Box::new(DisplayToneCurvePass {
            inputs: inputs.display_tone_curves.clone(),
        }));
    }
    // Colour grading (#275) — display-linear, post-AgX; GATED on every
    // wheel's saturation and luminance (all-default is a true no-op
    // regardless of hues / balance, exactly raw-core's `apply`
    // short-circuit).
    let grade = crate::full_chain::color_grade_sliders(inputs);
    if !color_grade_is_identity(&grade) {
        suffix.push(Box::new(ColorGradePass { sliders: grade }));
    }
    // Film look (epic #2683, Task 7) — display-linear, post-color_grade,
    // pre-grain (matching raw-core's render tail position). GATED on a
    // loaded, non-empty LUT AND an engaged strength — a look with strength 0
    // is a bit-identical no-op (mirrors `film_look::apply`'s own
    // `strength <= 0.0` short-circuit) and an unloaded LUT has no grid to
    // bind.
    if inputs.film_lut_size > 0 && inputs.film_strength > SLIDER_EPS {
        suffix.push(Box::new(FilmLutPass {
            size: inputs.film_lut_size,
            strength: inputs.film_strength,
            data: inputs.film_lut_data.as_ref().into(),
        }));
    }
    // Film grain (#1110) — display-linear, post-AgX; GATED unlike the rest
    // of the tail (grain at amount 0 is a true no-op, so the pass is
    // omitted exactly as raw-core's `apply` short-circuits). Size /
    // roughness alone never engage the stage.
    if inputs.grain_amount.abs() >= SLIDER_EPS {
        suffix.push(Box::new(GrainPass {
            amount: inputs.grain_amount,
            size: inputs.grain_size,
            roughness: inputs.grain_roughness,
        }));
    }
    // target_primaries from FullChainInputs (#1337): 0 = sRGB (default/legacy),
    // 1 = Display P3.
    suffix.push(Box::new(DisplayEncodePass {
        target_primaries: inputs.target_primaries,
    }));
    suffix.push(Box::new(SrgbGammaPass));
    // Auto-Profile curve + residual LUT are the per-image AUTO-profile LOOK
    // artifacts (fit in gamma space from a camera JPEG). NON-RAW input has no
    // JPEG to fit, so there is no look to apply — and applying the default
    // "identity" artifacts is NOT a no-op: it crushes white from 1.0 to ~0.973
    // (byte 248 instead of 255). The CPU non-RAW path runs ONLY display_encode +
    // srgb_gamma for exactly this reason. Skip them for non-RAW so the colorimetric
    // encode is the whole tail; RAW keeps them (its fitted per-image tone curve).
    // #1516 (completes the #1513 non-RAW view-tail skip — AgX above + look here).
    if is_raw_shape {
        suffix.push(Box::new(AutoProfileCurvePass {
            flat_curve: inputs.profile_curve_flat.as_ref().into(),
        }));
        suffix.push(Box::new(ResidualLutPass {
            size: inputs.residual_lut_size,
            data: inputs.residual_lut_data.as_ref().into(),
        }));
    }

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

/// The number of view-tail passes for a RAW input shape (`agx`, `display_encode`,
/// `srgb_gamma`, `auto_profile_curve`, `residual_lut`). A neutral RAW chain has
/// exactly this many passes; each engaged slider adds one (or, for the spatial
/// stages, still one `Pass` — they orchestrate their own sub-dispatches). NON-RAW
/// shapes skip the whole LOOK portion — `agx` (#1513) plus `auto_profile_curve`
/// + `residual_lut` (#1516) — leaving only the colorimetric encode
/// (`display_encode` + `srgb_gamma`), so a neutral non-RAW chain has
/// `VIEW_TAIL_PASS_COUNT - 3`. Public so the live-session terminal-`dither`
/// wiring (C2/C3) and the tests can assert the floor without re-counting by hand.
pub const VIEW_TAIL_PASS_COUNT: usize = 5;

/// The active-stage bitmask — which gated passes [`build_live_split`] includes
/// for `inputs`, one bit per scene-linear stage (the view tail is always-on, so
/// it isn't represented). SINGLE-SOURCED with the builder: every bit uses the
/// exact same predicate the corresponding `if` in `build_live_split` uses, so the
/// mask can't disagree with which passes actually get pushed. Used by
/// [`chain_signature`] to key the live pool's bind-group cache.
fn active_mask(inputs: &FullChainInputs) -> u32 {
    let mut m = 0u32;
    let is_raw_shape = inputs.input_shape == InputShape::PostDcpRec2020Fp16;
    // Encode input_shape in the top 2 bits of the mask so a shape change lands
    // in a fresh pool bucket (different passes = different bind-group layouts).
    // The 2-bit mask `& 0b11` is defensive: variant values 0/1/2 are safe, but
    // a future 4th variant (discriminant 3) would still fit; variant 4 (next
    // power of two) would shift into bit 32 and overflow a u32 in debug mode
    // (silent truncation in release). The mask guarantees correctness today and
    // turns any future out-of-range discriminant into a collision (detectable)
    // rather than UB. See also the compile-time assert below.
    m |= ((inputs.input_shape as u32) & 0b11) << 30;
    // Bit 0: capture_sharpening — RAW-only (#1331); always 0 for non-RAW shapes.
    if is_raw_shape && inputs.capture_sharpening.is_some() {
        m |= 1 << 0;
    }
    // Bit 1: WB — engaged for ALL shapes when the slider is outside the skip
    // band (the builder now includes WB unconditionally for non-RAW too).
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
    if !hsl_pass_for(inputs).is_noop() {
        m |= 1 << 15;
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
    if local_adjustments_are_active(&inputs.local_adjustments, inputs.scope.layer) {
        m |= 1 << 16;
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
    if inputs.grain_amount.abs() >= SLIDER_EPS {
        m |= 1 << 13;
    }
    if !color_grade_is_identity(&crate::full_chain::color_grade_sliders(inputs)) {
        m |= 1 << 14;
    }
    // Bit 17: film look (epic #2683, Task 7) — same predicate as the
    // `build_live_split` gate (loaded LUT + engaged strength).
    if inputs.film_lut_size > 0 && inputs.film_strength > SLIDER_EPS {
        m |= 1 << 17;
    }
    // Bit 18: display-referred tone curves (#2232) — same predicate as the
    // `build_live_split` gate above. Fixed-stride pooled buffer (NUM_SLOTS ×
    // SLOT_STRIDE, like `tone_curves`'), so no extra content-hash fold is
    // needed below — only presence changes the dispatch/bind-group shape.
    if !display_tone_curve_is_identity(&inputs.display_tone_curves) {
        m |= 1 << 18;
    }
    m
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
