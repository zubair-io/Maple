//! Full GPU-resident develop+view chain assembly (epic #925, P4a / #992-pre).
//!
//! The capstone of P1–P3: every GPU-ported stage composed into ONE ordered
//! `Vec<Box<dyn Pass>>`, run through [`ChainRunner`] with the chain's single
//! end-of-run readback. This module is **composition only** — it does not add or
//! change any per-stage kernel; it imports the [`Pass`] each stage already
//! exposes and orders them to match `raw_core::pipeline::develop` +
//! `raw_core::pipeline::render`'s view tail.
//!
//! ## The develop order (and the gaps)
//!
//! `raw_core::pipeline::develop::develop_scene_linear_from_raw_with_quality`
//! runs, post-demosaic:
//!   linearize · demosaic · crop · baseline_exposure · WB-pre-gain ·
//!   highlight_recovery · DCP · oklab_highlight_recovery · PGTM ·
//!   **capture_sharpening** · auto_exposure · **white_balance** ·
//!   **scene_tone_controls** · **tone_curves** · **vibrance** · **saturation** ·
//!   **clarity** · **texture** · **dehaze** · **local_adjustments** · **vignette** ·
//!   **sharpen** · **nr_luminance** · **nr_color**
//! then `render` appends the view tail:
//!   **agx** · **split_tone** (#1111) · **grain** (#1110, both display-linear) ·
//!   **rec2020_to_srgb** (= [`DisplayEncodePass`]) ·
//!   **srgb_gamma_encode** (= [`SrgbGammaPass`]) · auto_profile-curve ·
//!   auto_profile-residual-LUT · look · dither/quantize.
//!
//! The **bold** stages are the 20 GPU-ported [`Pass`]es this module composes (in
//! exactly that order). The rest are gaps:
//!
//! - **Upstream / out of scope** (run before the post-DCP scene-linear buffer this
//!   chain takes as input): linearize, demosaic, crop, baseline_exposure,
//!   WB-pre-gain, highlight_recovery, DCP, oklab_highlight_recovery, PGTM.
//! - **In-chain, NOT GPU-ported** — P4 must run this CPU-side around the GPU
//!   chain: `auto_exposure` (a scalar mid-gray gain). `local_adjustments` was
//!   the other one until #1698 ported it; it now composes here at develop's 12b
//!   slot, gated on a non-empty layer stack.
//! - **View-tail, GPU-ported in P4a**: `srgb_gamma_encode` (= [`SrgbGammaPass`]),
//!   inserted between [`DisplayEncodePass`] and [`AutoProfileCurvePass`] — the
//!   curve + residual LUT that follow it were *fit* in gamma space, so the gamma
//!   step must precede them (matching raw-core's render tail).
//! - **View-tail, still gaps**: `look` (an empirical per-channel LUT that is a
//!   no-op post-Auto-Profile-pivot — `view::look::apply` is intentionally empty),
//!   and `dither_and_quantize` (the f32 → u8 display-OUTPUT step, P4b — outside
//!   this f32-RGBA crate's scope).
//!
//! With `srgb_gamma_encode` ported, the assembled chain's tail runs
//! `display_encode → srgb_gamma → auto_profile_curve → residual_lut` — the full
//! f32 view tail (sans the f32 → u8 dither). The end-to-end parity test mirrors
//! that exactly on the CPU side (it also runs `srgb_gamma_encode` in the same
//! position) so the comparison is GPU-vs-CPU of the *same* composed stages —
//! see `full_chain/tests.rs`.
//!
//! ## Dehaze airlight
//!
//! `DehazePass` needs an atmospheric-light vector derived from the EXACT buffer
//! the chain feeds it as `src` (the post-texture buffer), because raw-core's
//! `dehaze::apply` computes its airlight internally from that same buffer. In a
//! single composed Vec the airlight isn't known until the upstream passes have
//! run, so [`build_full_chain_passes`] takes the airlight as a parameter; the
//! parity test sources it via a genuine **mid-chain GPU readback** (run the
//! pre-dehaze prefix, read back, `compute_airlight`, then run the dehaze suffix).
//! **LIVE-path (P4b) requirement:** an interactive chain cannot pay a CPU
//! readback per slider tick — it needs an on-GPU parallel reduction at dehaze's
//! position to produce the airlight without leaving the device. The readback here
//! is a HEADLESS test affordance, explicitly sanctioned for this milestone.

use crate::acr_match_pass::AcrMatchPass;
use crate::agx::AgxPass;
use crate::auto_profile_curve::AutoProfileCurvePass;
use crate::capture_sharpening::{CaptureSharpeningParams, CaptureSharpeningPass};
use crate::chain::Pass;
use crate::clarity::ClarityPass;
use crate::dehaze::{AirlightSource, DehazePass};
use crate::display_encode::DisplayEncodePass;
use crate::grain::GrainPass;
use crate::hsl::HslPass;
use crate::local_adjustments::{local_adjustments_are_active, LocalAdjustmentsPass};

/// The 8-band Oklab pass for these inputs. Built in one place so the live
/// chain's assembly gate and its stage-mask bit can never disagree about
/// whether the stage is engaged — `HslPass::is_noop` is what both consult.
pub(crate) fn hsl_pass_for(inputs: &FullChainInputs) -> HslPass {
    HslPass {
        hue: inputs.hsl_hue,
        sat: inputs.hsl_sat,
        lum: inputs.hsl_lum,
        bw_mix: inputs.bw_mix,
        bw_active: inputs.bw_active,
    }
}
use crate::noise_reduction::{NlmColorPass, NlmLumaPass};
use crate::residual_lut::ResidualLutPass;
use crate::saturation::SaturationPass;
use crate::scene_tone_controls::SceneToneControlsPass;
use crate::sharpen::SharpenPass;
use crate::color_grade::{ColorGradePass, ColorGradeSliders};
use crate::srgb_gamma::SrgbGammaPass;
use crate::texture::TexturePass;
use crate::tone_curves::{ToneCurveInputs, ToneCurvesPass};
use crate::vibrance::VibrancePass;
use crate::vignette::VignettePass;
use crate::white_balance::WhiteBalancePass;

/// An ordered, owned list of chain stages. Boxed because the stages are
/// heterogeneous [`Pass`] impls; owned (not `&dyn`) so the builder can hand back
/// a self-contained Vec the caller borrows into `&dyn Pass` at run time.
pub type BoxedPasses = Vec<Box<dyn Pass>>;

/// The slider + per-image inputs that drive the full chain. One value per GPU
/// stage, sourced from the same place the CPU oracle reads — so the GPU Vec and
/// the CPU reference can never disagree on *what* each stage does (only on the
/// float arithmetic the parity test bounds).
///
/// Per-image runtime data (the WB matrix, prepared tone curves, the Auto Profile
/// curve/LUT, capture-sharpening params) is carried pre-derived: those
/// derivations are raw-core's job and run CPU-side once, exactly as the live
/// pipeline derives them before uploading. Dehaze's airlight is the lone
/// exception — it is position-dependent (see the module docs) and supplied
/// separately to [`build_full_chain_passes`].
pub struct FullChainInputs {
    /// Pre-derived linear-Rec.2020 white-balance matrix (raw-core's
    /// `wb_cat16_matrix` or a diagonal from `wb_gains`).
    pub wb_matrix: [[f32; 3]; 3],
    /// The white-balance temperature (Kelvin) + tint the `wb_matrix` was derived
    /// from. Carried alongside the matrix so the LIVE builder
    /// ([`crate::build_live_chain`]) can gate WB on raw-core's EXACT short-circuit
    /// predicate — `(temp - 6500).abs() < 0.5 && tint.abs() < 0.5` — instead of a
    /// matrix near-identity test, which is structurally broken here: at 6500K the
    /// CAT16 round-trip yields a matrix ~6.9e-3 off identity (so a matrix-identity
    /// gate wrongly fires), and a temp 0.5K past the skip band produces a matrix
    /// indistinguishable from the 6500K one (no tolerance separates apply from
    /// skip). The composition builder ([`build_split`]) ignores these — it always
    /// pushes WB — so they're inert outside the live path.
    pub wb_temperature: f32,
    pub wb_tint: f32,
    /// Scene-tone-controls sliders (exposure / brightness / highlights /
    /// shadows / whites / blacks), each `[-100, 100]` (exposure in EV).
    pub tone: [f32; 6],
    /// User tone-curve inputs (parametric + per-channel point curves + mode).
    pub tone_curves: ToneCurveInputs,
    pub vibrance: f32,
    pub saturation: f32,
    /// HSL 8-band sliders (#1112): per-band hue/sat/lum in [-100, 100].
    /// Scene-linear Oklab — positioned after saturation, before clarity.
    /// Order: Red, Orange, Yellow, Green, Aqua, Blue, Purple, Magenta.
    pub hsl_hue: [f32; 8],
    pub hsl_sat: [f32; 8],
    pub hsl_lum: [f32; 8],
    /// Black & white mix (#276): per-band luminance weights in [-100, 100]
    /// over the SAME hue bands as `hsl_*`, plus the mode toggle. When
    /// `bw_active` the 24 HSL sliders above are inert and the stage emits a
    /// zero-chroma image.
    pub bw_mix: [f32; 8],
    pub bw_active: bool,
    pub clarity: f32,
    pub texture: f32,
    pub dehaze: f32,
    /// Local-adjustment layer stack (#1698), in the flat wire
    /// `raw_core::types::local_adjustment::flat` defines — 24 floats per layer,
    /// which is also the WGSL `array<Layer>` storage layout, so nothing is
    /// re-packed between the FFI boundary and the bind group. Empty (the
    /// default for every caller that has no masks) means the stage is a
    /// bit-identical no-op and the pass is omitted. Runs at develop's 12b slot,
    /// between dehaze and vignette.
    pub local_adjustments: Vec<f32>,
    /// Vignette (#1109): amount [-100, 100] (negative darkens corners) and
    /// feather [0, 100] (mask transition width). Runs between dehaze and
    /// sharpen — develop's 12c position.
    pub vignette_amount: f32,
    pub vignette_feather: f32,
    /// Film grain (#1110): amount/size/roughness [0, 100]. Display-linear —
    /// runs in the view tail between agx and display_encode.
    pub grain_amount: f32,
    pub grain_size: f32,
    pub grain_roughness: f32,
    /// Colour grading (#275): hues in degrees [0, 360], saturations
    /// [0, 100], luminances [-100, 100], balance [-100, 100].
    /// Display-linear Oklab three-zone tint — runs in the view tail
    /// between agx and grain. Shadow/highlight hue+sat and the balance
    /// keep the `split_tone_*` names because they are ACR's
    /// `crs:SplitToning*` sliders, exactly as ACR's Color Grading panel
    /// stores them.
    pub split_tone_shadow_hue: f32,
    pub split_tone_shadow_saturation: f32,
    pub split_tone_highlight_hue: f32,
    pub split_tone_highlight_saturation: f32,
    pub split_tone_balance: f32,
    pub color_grade_shadow_luminance: f32,
    pub color_grade_midtone_hue: f32,
    pub color_grade_midtone_saturation: f32,
    pub color_grade_midtone_luminance: f32,
    pub color_grade_highlight_luminance: f32,
    pub color_grade_global_hue: f32,
    pub color_grade_global_saturation: f32,
    pub color_grade_global_luminance: f32,
    pub sharpen_amount: f32,
    pub sharpen_radius: f32,
    pub sharpen_detail: f32,
    pub sharpen_masking: f32,
    pub nr_luminance: f32,
    pub nr_color: f32,
    /// AgX contrast slider (routed to the sigmoid slope).
    pub contrast: f32,
    /// Capture-sharpening params, `Some` only when the stage runs (mirrors
    /// develop's `capture_sharpening_params_from_model(model)` gate — `None` ⇒ the
    /// pass is omitted, exactly as develop omits the stage).
    pub capture_sharpening: Option<CaptureSharpeningParams>,
    /// Flat Auto Profile curve (`ProfileCurve::to_flat()`,
    /// [`crate::PROFILE_CURVE_FLAT_LEN`] floats).
    pub profile_curve_flat: Vec<f32>,
    /// Auto Profile residual LUT node count per axis.
    pub residual_lut_size: usize,
    /// Auto Profile residual LUT flat grid (`size³ × 3` floats).
    pub residual_lut_data: Vec<f32>,
    /// Target display primaries for the `display_encode` view-tail stage
    /// (ticket #1337): `0` = sRGB (default, legacy-compatible), `1` = Display P3.
    ///
    /// C FFI / WASM callers that zero-initialise the struct get `0` ⇒ sRGB,
    /// which is bit-identical to the pre-#1337 output. Rust callers must
    /// include this field explicitly — `FullChainInputs` does not impl
    /// `Default`, so `..Default::default()` is not available.
    pub target_primaries: u32,
    /// How the uploaded scene-linear buffer was produced — determines which
    /// leading stages (WB / DCP / AE) the live builder may skip (#1331).
    /// Appended at the struct tail after `target_primaries` (append-only convention);
    /// the default `PostDcpRec2020Fp16` is the historic value — all existing callers
    /// that leave it at zero-init preserve the current RAW behaviour exactly.
    pub input_shape: InputShape,
    /// View-transform profile selection (#1722, epic #1710 slice 2). Drives
    /// whether the view-tail uses AgX (default for `Auto`/`Neutral`) or the
    /// fitted AcrMatch LUT. See [`PROFILE_ID_ACR_MATCH`].
    ///
    /// Stored as `u8` so raw-gpu does not need to import `raw_core::types::adjustment::Profile`
    /// (which would create a circular crate dep). The discriminant mapping matches
    /// `Profile`'s definition order: 0 = Auto, 1 = Neutral, 2 = AcrMatch.
    /// C FFI / WASM callers that zero-initialise the struct get 0 (Auto), which
    /// maps to AgX — identical to the pre-#1722 behaviour.
    pub profile_id: u8,
}

/// How the GPU-resident image was produced. Drives which leading stages the live
/// chain must run at the start of each render tick.
///
/// The zero-value `PostDcpRec2020Fp16` is the *default* — the historic RAW path
/// that ran before this enum was introduced — so any `FullChainInputs` zeroed
/// by a legacy caller correctly resolves to the full RAW chain. The non-zero
/// values engage the two new non-RAW branches.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum InputShape {
    /// Scene-linear Rec.2020 fp16 after the full RAW decode (DCP + WB at D65/
    /// 6500K). All chain stages run: WB delta → scene tone → … → view tail.
    /// Value 0 — the historic default.
    #[default]
    PostDcpRec2020Fp16 = 0,
    /// 16-bit linear Rec.2020 input (pano PNG output). The WB / DCP / AE
    /// stages have no meaning — the buffer is already in the correct colour
    /// space — so the live chain starts at the first user-edit stage
    /// (scene_tone_controls). WB and capture_sharpening are skipped.
    LinearRec2020Fp16 = 1,
    /// 8-bit sRGB gamma-encoded input (JPEG / HEIF / 8-bit PNG). A CPU
    /// pre-pass at session-open time converts to scene-linear Rec.2020
    /// (`sRGB→linear + sRGB→Rec.2020 primaries matrix`), after which the
    /// same stage subset as `LinearRec2020Fp16` runs.
    SrgbGammaEncoded8 = 2,
}

/// `profile_id` value for `Profile::AcrMatch` — the fitted ACR-match LUT
/// transform (#1722). Used by [`build_split`] / [`build_live_split`] to
/// switch the view-tail from AgX to AcrMatch.
pub const PROFILE_ID_ACR_MATCH: u8 = 2;

/// Where the scene-linear / view boundary sits in the assembled Vec, expressed
/// as the count of passes that run BEFORE `dehaze` (the prefix whose output
/// dehaze's airlight must be measured from). The parity test runs `[..PREFIX]`,
/// reads back, derives the airlight, then runs `dehaze` + the suffix. This is
/// computed from the same builder so the split can't drift from the assembly.
///
/// Returns `(prefix_passes, dehaze_and_suffix_passes)` where concatenating them
/// in order is identical to a single full Vec — the canonical assembly artifact.
/// Gather the thirteen colour-grading sliders off the chain inputs — the
/// single place the `split_tone_*` / `color_grade_*` field split is
/// resolved, shared by the full chain, the live chain and the gate.
pub fn color_grade_sliders(inputs: &FullChainInputs) -> ColorGradeSliders {
    ColorGradeSliders {
        shadow: [
            inputs.split_tone_shadow_hue,
            inputs.split_tone_shadow_saturation,
            inputs.color_grade_shadow_luminance,
        ],
        midtone: [
            inputs.color_grade_midtone_hue,
            inputs.color_grade_midtone_saturation,
            inputs.color_grade_midtone_luminance,
        ],
        highlight: [
            inputs.split_tone_highlight_hue,
            inputs.split_tone_highlight_saturation,
            inputs.color_grade_highlight_luminance,
        ],
        global: [
            inputs.color_grade_global_hue,
            inputs.color_grade_global_saturation,
            inputs.color_grade_global_luminance,
        ],
        balance: inputs.split_tone_balance,
    }
}

/// Passing `airlight` builds the `DehazePass` at the head of the suffix.
pub fn build_full_chain_passes(inputs: &FullChainInputs, airlight: [f32; 3]) -> BoxedPasses {
    let (prefix, suffix) = build_split(inputs, airlight);
    let mut all = prefix;
    all.extend(suffix);
    all
}

/// The split builder (see [`build_full_chain_passes`]). Returns the pre-dehaze
/// prefix and the dehaze+suffix as two Vecs so a caller that needs the
/// mid-chain airlight readback can run the prefix first, then build the suffix's
/// `DehazePass` from the read-back buffer. Concatenated, the two are exactly the
/// single full chain.
//
// The push-after-Vec::new pattern (vs a `vec![]` literal) is deliberate: the
// capture_sharpening pass is conditionally pushed, and the stage-per-line shape
// keeps the develop-order assembly legible (one push = one stage, in order).
#[allow(clippy::vec_init_then_push)]
pub fn build_split(inputs: &FullChainInputs, airlight: [f32; 3]) -> (BoxedPasses, BoxedPasses) {
    // --- Prefix: capture_sharpening (FIRST, matching develop's 04b placement,
    //     pre-WB/pre-auto-exposure) through texture. Everything dehaze's
    //     airlight must be measured downstream of. ---
    let mut prefix: BoxedPasses = Vec::new();
    if let Some(params) = inputs.capture_sharpening {
        prefix.push(Box::new(CaptureSharpeningPass { params }));
    }
    prefix.push(Box::new(WhiteBalancePass {
        matrix: inputs.wb_matrix,
    }));
    prefix.push(Box::new(SceneToneControlsPass {
        exposure: inputs.tone[0],
        brightness: inputs.tone[1],
        highlights: inputs.tone[2],
        shadows: inputs.tone[3],
        whites: inputs.tone[4],
        blacks: inputs.tone[5],
    }));
    prefix.push(Box::new(ToneCurvesPass {
        inputs: inputs.tone_curves.clone(),
    }));
    prefix.push(Box::new(VibrancePass {
        vibrance: inputs.vibrance,
    }));
    prefix.push(Box::new(SaturationPass {
        saturation: inputs.saturation,
    }));
    // HSL (#1112) / black & white (#276) — scene-linear, after saturation,
    // before clarity.
    prefix.push(Box::new(hsl_pass_for(inputs)));
    prefix.push(Box::new(ClarityPass {
        clarity: inputs.clarity,
    }));
    prefix.push(Box::new(TexturePass {
        texture: inputs.texture,
    }));

    // --- Suffix: dehaze (airlight from the prefix output) → sharpen → NR →
    //     view tail (agx → display_encode → srgb_gamma → auto_profile_curve →
    //     residual_lut). look / dither are gaps (module docs). ---
    let mut suffix: BoxedPasses = Vec::new();
    // P4a is the headless COMPOSITION gate (no live loop), so it always supplies a
    // CPU airlight measured from the post-prefix buffer (#1033's on-GPU source is
    // the live path's concern, selected by `build_live_split`).
    suffix.push(Box::new(DehazePass {
        dehaze: inputs.dehaze,
        airlight: AirlightSource::Cpu(airlight),
    }));
    // Local adjustments (#1698) — develop's 12b position, between dehaze and
    // vignette. Unlike the other passes here this one IS gated even in the
    // composition builder: `LocalAdjustmentsPass` needs a non-empty storage
    // buffer to bind, and an empty stack is a true no-op in raw-core too, so
    // there is no "always push it" form to compose.
    if local_adjustments_are_active(&inputs.local_adjustments) {
        suffix.push(Box::new(LocalAdjustmentsPass::new(
            &inputs.local_adjustments,
        )));
    }
    // Vignette (#1109) — develop's 12c position: after local_adjustments,
    // before sharpen.
    suffix.push(Box::new(VignettePass {
        amount: inputs.vignette_amount,
        feather: inputs.vignette_feather,
    }));
    suffix.push(Box::new(SharpenPass {
        amount: inputs.sharpen_amount,
        radius: inputs.sharpen_radius,
        detail: inputs.sharpen_detail,
        masking: inputs.sharpen_masking,
    }));
    suffix.push(Box::new(NlmLumaPass {
        nr_luminance: inputs.nr_luminance,
    }));
    suffix.push(Box::new(NlmColorPass {
        nr_color: inputs.nr_color,
    }));
    // View tail: AgX (default) or AcrMatch (#1722) depending on the profile.
    if inputs.profile_id == PROFILE_ID_ACR_MATCH {
        suffix.push(Box::new(AcrMatchPass));
    } else {
        suffix.push(Box::new(AgxPass {
            contrast: inputs.contrast,
        }));
    }
    // Colour grading (#275) — display-linear Oklab three-zone tint,
    // post-AgX, before grain (the render tail's 16a position).
    suffix.push(Box::new(ColorGradePass {
        sliders: color_grade_sliders(inputs),
    }));
    // Film grain (#1110) — display-linear, post-AgX, before the target
    // gamut (the render tail's 16b position).
    suffix.push(Box::new(GrainPass {
        amount: inputs.grain_amount,
        size: inputs.grain_size,
        roughness: inputs.grain_roughness,
    }));
    // target_primaries from FullChainInputs (#1337). The full-chain headless
    // path defaults to 0 (sRGB) via FullChainInputs::default; the live path
    // reads it from inputs.
    suffix.push(Box::new(DisplayEncodePass {
        target_primaries: inputs.target_primaries,
    }));
    // srgb_gamma_encode: the per-channel IEC OETF. MUST sit between display_encode
    // and the Auto Profile curve — the curve + residual LUT were fit in gamma
    // space (matches raw-core's render tail: rec2020_to_srgb → srgb_gamma_encode →
    // apply_curve → ColorLut::apply).
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

// Shared test-support harness (CPU oracle + `Case` + the scene-linear fixture),
// declared once here and reached by BOTH this module's `tests.rs` and the P4b
// `live_chain/tests.rs` via `crate::full_chain::oracle::*` — so the live gate
// drives the same reference rather than a drifting copy. Test+native only.
#[cfg(all(test, not(target_arch = "wasm32")))]
#[path = "full_chain/oracle.rs"]
pub(crate) mod oracle;

// Parity tests live in a sibling file to keep this module under the 600-LOC
// budget (mirrors clarity / dehaze's tests.rs split). Native test builds only —
// the headless GPU harness has no wasm path.
#[cfg(all(test, not(target_arch = "wasm32")))]
#[path = "full_chain/tests.rs"]
mod tests;
