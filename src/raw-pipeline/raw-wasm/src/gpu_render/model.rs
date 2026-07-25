//! Prefix-model + chain-inputs assembly for the GPU live path — pure model
//! arithmetic, no GPU calls. Split out of `gpu_render.rs` to keep it under
//! the 600-LOC file budget (#1170); behavior unchanged (pure code move).
//! See the module docs there for the decode-boundary contract these two
//! helpers implement.

use raw_core::types::adjustment::AutoExposureMode;
use raw_core::xmp::AdjustmentModel;
use raw_gpu::{CurveMode, FullChainInputs, ToneCurveInputs};

/// Build the STRIPPED prefix model (see the `gpu_render` module docs): the
/// GPU-chain-re-run stages are zeroed to their no-op defaults so develop
/// short-circuits them BIT-EXACTLY, leaving only the upstream stages the GPU
/// chain does NOT do (`highlight_recovery`, `capture_sharpening`, `profile`,
/// and — via `ae_mode` — the `auto_exposure` mode the `auto_will_fit` probe
/// pins).
///
/// WB is pinned to the 6500K/0 neutral so `white_balance::apply` returns at its
/// identity short-circuit (`(temp-6500).abs()<0.5 && tint.abs()<0.5`); the GPU
/// chain applies the user's ABSOLUTE WB instead.
///
/// ## Why the GPU-only SUB-params are also neutralized (#1038)
///
/// `build_full_chain_inputs` feeds the live chain `sharpen_radius/detail/masking`,
/// `tone_curve_mode`, and `wb_method` — but those ride stages that are ZEROED /
/// PINNED in this prefix (`sharpen_amount = 0` short-circuits the sharpen stage at
/// `amount.abs() < 1e-3`; the tone-curve point sets are emptied; WB is pinned
/// neutral so its method is inert), so they have NO effect on the developed buffer
/// here. We pin them to their defaults anyway so the prefix model is a function of
/// ONLY the fields that genuinely shape the buffer. Without this, dragging e.g. the
/// sharpen-radius slider (with the default `sharpen_amount = 40` active on the GPU)
/// would change the prefix model and trigger a SPURIOUS re-develop + re-upload
/// every tick in the persistent session — correctness held, but the persistence
/// win was lost. The `prefix_model_for`-equality boundary test pins this invariant.
#[cfg(any(target_arch = "wasm32", test))]
pub(super) fn stripped_prefix_model(
    full: &AdjustmentModel,
    ae_mode: AutoExposureMode,
) -> AdjustmentModel {
    use raw_core::types::{ToneCurveMode, WbMethod};
    AdjustmentModel {
        // Neutral WB → the stage no-ops; the GPU chain re-applies absolute WB.
        temperature: 6500.0,
        tint: 0.0,
        // WB method is inert at the neutral short-circuit; pin it so toggling the
        // method doesn't spuriously change the prefix (the GPU chain owns WB).
        wb_method: WbMethod::Cat16,
        // Effective AE mode from the probe (Off when Auto Profile will fit).
        auto_exposure: ae_mode,
        // Every stage the GPU chain re-runs → no-op default so develop skips it.
        exposure: 0.0,
        brightness: 0.0,
        contrast: 0.0,
        highlights: 0.0,
        shadows: 0.0,
        whites: 0.0,
        blacks: 0.0,
        parametric_highlights: 0.0,
        parametric_lights: 0.0,
        parametric_darks: 0.0,
        parametric_shadows: 0.0,
        tone_curve_luma: Default::default(),
        tone_curve_red: Default::default(),
        tone_curve_green: Default::default(),
        tone_curve_blue: Default::default(),
        // Inert with the point curves emptied; pinned so the curve MODE toggle
        // doesn't spuriously re-develop (the GPU chain applies the curves).
        tone_curve_mode: ToneCurveMode::PerChannel,
        vibrance: 0.0,
        saturation: 0.0,
        clarity: 0.0,
        texture: 0.0,
        dehaze: 0.0,
        // Vignette (#1109) is re-run by the GPU chain — zero the amount so the
        // develop prefix short-circuits the stage (a non-zero value here would
        // DOUBLE-APPLY: once in the prefix, once on the GPU). Feather is inert
        // at amount 0; pin it to its default so dragging the feather sub-param
        // doesn't spuriously re-develop.
        vignette_amount: 0.0,
        vignette_feather: 50.0,
        // Grain (#1110) lives in the GPU chain's display tail and never
        // runs in develop at all — pin its fields so dragging them can't
        // spuriously re-develop the prefix.
        grain_amount: 0.0,
        grain_size: 25.0,
        grain_roughness: 50.0,
        // Split toning (#1111) — display-tail like grain; pin so sub-param
        // drags can't spuriously re-develop the prefix.
        split_tone_shadow_hue: 0.0,
        split_tone_shadow_saturation: 0.0,
        split_tone_highlight_hue: 0.0,
        split_tone_highlight_saturation: 0.0,
        split_tone_balance: 0.0,
        color_grade_shadow_luminance: 0.0,
        color_grade_midtone_hue: 0.0,
        color_grade_midtone_saturation: 0.0,
        color_grade_midtone_luminance: 0.0,
        color_grade_highlight_luminance: 0.0,
        color_grade_global_hue: 0.0,
        color_grade_global_saturation: 0.0,
        color_grade_global_luminance: 0.0,
        // Sharpen is short-circuited (`amount = 0`), so its sub-params are inert;
        // pin them to defaults so dragging radius/detail/masking (with the GPU's
        // real `sharpen_amount` active) doesn't spuriously re-develop.
        sharpen_amount: 0.0,
        sharpen_radius: 1.0,
        sharpen_detail: 25.0,
        sharpen_masking: 0.0,
        nr_luminance: 0.0,
        nr_color: 0.0,
        // KEEP: highlight_recovery, capture_sharpening_*, profile, and every
        // decode-upstream field — they shape the post-AE buffer the GPU chain
        // consumes (so a change to any of them legitimately re-develops).
        ..full.clone()
    }
}

/// Assemble the [`FullChainInputs`] the live chain consumes from the FULL user
/// model + the fitted Auto Profile artifacts. Mirrors `raw_gpu`'s `Case::gpu_inputs`
/// / the FFI `inputs_from_params` exactly: the WB matrix is derived from the
/// model's temp/tint via the SAME `wb_cat16_matrix` / `wb_gains` the CPU stage
/// uses, and `capture_sharpening` is `None` (baked in the develop prefix).
#[cfg(any(target_arch = "wasm32", test))]
pub(super) fn build_full_chain_inputs(
    model: &AdjustmentModel,
    profile_curve_flat: Vec<f32>,
    residual_lut_size: usize,
    residual_lut_data: Vec<f32>,
) -> FullChainInputs {
    use raw_core::types::WbMethod;

    let wb_matrix = match model.wb_method {
        WbMethod::Cat16 => {
            raw_core::stages::white_balance::wb_cat16_matrix(model.temperature, model.tint).0
        }
        WbMethod::DiagonalRec2020 => {
            let g = raw_core::stages::white_balance::wb_gains(model.temperature, model.tint);
            [[g[0], 0.0, 0.0], [0.0, g[1], 0.0], [0.0, 0.0, g[2]]]
        }
    };

    FullChainInputs {
        wb_matrix,
        wb_temperature: model.temperature,
        wb_tint: model.tint,
        tone: [
            model.exposure,
            model.brightness,
            model.highlights,
            model.shadows,
            model.whites,
            model.blacks,
        ],
        tone_curves: ToneCurveInputs {
            parametric: [
                model.parametric_shadows,
                model.parametric_darks,
                model.parametric_lights,
                model.parametric_highlights,
            ],
            luma: model.tone_curve_luma.points.clone(),
            red: model.tone_curve_red.points.clone(),
            green: model.tone_curve_green.points.clone(),
            blue: model.tone_curve_blue.points.clone(),
            mode: match model.tone_curve_mode {
                raw_core::types::ToneCurveMode::RatioPreserving => CurveMode::RatioPreserving,
                raw_core::types::ToneCurveMode::PerChannel => CurveMode::PerChannel,
            },
        },
        vibrance: model.vibrance,
        saturation: model.saturation,
        clarity: model.clarity,
        texture: model.texture,
        dehaze: model.dehaze,
        vignette_amount: model.vignette_amount,
        vignette_feather: model.vignette_feather,
        grain_amount: model.grain_amount,
        grain_size: model.grain_size,
        grain_roughness: model.grain_roughness,
        split_tone_shadow_hue: model.split_tone_shadow_hue,
        split_tone_shadow_saturation: model.split_tone_shadow_saturation,
        split_tone_highlight_hue: model.split_tone_highlight_hue,
        split_tone_highlight_saturation: model.split_tone_highlight_saturation,
        split_tone_balance: model.split_tone_balance,
        color_grade_shadow_luminance: model.color_grade_shadow_luminance,
        color_grade_midtone_hue: model.color_grade_midtone_hue,
        color_grade_midtone_saturation: model.color_grade_midtone_saturation,
        color_grade_midtone_luminance: model.color_grade_midtone_luminance,
        color_grade_highlight_luminance: model.color_grade_highlight_luminance,
        color_grade_global_hue: model.color_grade_global_hue,
        color_grade_global_saturation: model.color_grade_global_saturation,
        color_grade_global_luminance: model.color_grade_global_luminance,
        hsl_hue: [
            model.hue_adjustment_red,
            model.hue_adjustment_orange,
            model.hue_adjustment_yellow,
            model.hue_adjustment_green,
            model.hue_adjustment_aqua,
            model.hue_adjustment_blue,
            model.hue_adjustment_purple,
            model.hue_adjustment_magenta,
        ],
        hsl_sat: [
            model.saturation_adjustment_red,
            model.saturation_adjustment_orange,
            model.saturation_adjustment_yellow,
            model.saturation_adjustment_green,
            model.saturation_adjustment_aqua,
            model.saturation_adjustment_blue,
            model.saturation_adjustment_purple,
            model.saturation_adjustment_magenta,
        ],
        hsl_lum: [
            model.luminance_adjustment_red,
            model.luminance_adjustment_orange,
            model.luminance_adjustment_yellow,
            model.luminance_adjustment_green,
            model.luminance_adjustment_aqua,
            model.luminance_adjustment_blue,
            model.luminance_adjustment_purple,
            model.luminance_adjustment_magenta,
        ],
        // Black & white mix (#276) — same band order as the three HSL
        // groups above. Omitting these would leave the web GPU live path
        // rendering in colour while the CPU refine pass rendered mono.
        bw_mix: [
            model.gray_mixer_red,
            model.gray_mixer_orange,
            model.gray_mixer_yellow,
            model.gray_mixer_green,
            model.gray_mixer_aqua,
            model.gray_mixer_blue,
            model.gray_mixer_purple,
            model.gray_mixer_magenta,
        ],
        bw_active: model.black_white == raw_core::types::BlackWhiteMode::On,
        sharpen_amount: model.sharpen_amount,
        sharpen_radius: model.sharpen_radius,
        sharpen_detail: model.sharpen_detail,
        sharpen_masking: model.sharpen_masking,
        nr_luminance: model.nr_luminance,
        nr_color: model.nr_color,
        contrast: model.contrast,
        // Baked into the develop prefix (`capture_sharpening` runs at its
        // canonical 04b position there) → omit on the GPU chain to avoid a
        // double-apply, mirroring the Apple decode-boundary contract.
        capture_sharpening: None,
        profile_curve_flat,
        residual_lut_size,
        residual_lut_data,
        // Web does not yet surface a P3-canvas path (canvas is tagged
        // display-P3 but the live render target is managed by the browser).
        // Legacy sRGB encode (0) is bit-identical to pre-#1337 behavior.
        target_primaries: 0,
        // Web always decodes RAW and routes through the full chain.
        input_shape: raw_gpu::InputShape::PostDcpRec2020Fp16,
        // Map the model's Profile discriminant (#1722): AcrMatch → 2, everything
        // else (Auto/Neutral/unknown) → 0 (AgX) for conservative fallback.
        profile_id: match model.profile {
            raw_core::types::adjustment::Profile::AcrMatch => raw_gpu::PROFILE_ID_ACR_MATCH,
            _ => 0,
        },
    }
}
