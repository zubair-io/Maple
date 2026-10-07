//! One prefix policy for owned preparation and borrowed tick comparison (#4317).
use crate::types::{
    adjustment::{AdjustmentModel, AutoExposureMode},
    ToneCurveMode, WbMethod,
};

macro_rules! prefix_policy {
    ($ae:ident; keep [$($keep:ident),* $(,)?]; neutral {$($neutral:ident: $value:expr),* $(,)?}) => {
        /// Prepare the owned upstream model. Called when upload preparation is needed.
        pub fn stripped_prefix_model(full: &AdjustmentModel, $ae: AutoExposureMode) -> AdjustmentModel {
            AdjustmentModel { $($neutral: $value,)* ..full.clone() }
        }
        /// Compare upstream state without cloning curves, strings or mask vectors.
        /// `cached` must be an owned model returned by `stripped_prefix_model`.
        // Legacy radius remains part of AdjustmentModel equality; retain it for parity.
        #[allow(deprecated)]
        pub fn prefix_matches(full: &AdjustmentModel, cached: &AdjustmentModel, $ae: AutoExposureMode) -> bool {
            // Exhaustive pattern: a schema addition must be classified in this policy.
            let AdjustmentModel { $($neutral: _,)* $($keep: _,)* } = full;
            $ae == cached.auto_exposure $(&& full.$keep == cached.$keep)*
        }
    };
}

// Build the STRIPPED prefix model (see the `gpu_render` module docs): the
// GPU-chain-re-run stages are zeroed to their no-op defaults so develop
// short-circuits them BIT-EXACTLY, leaving only the upstream stages the GPU
// chain does NOT do (`highlight_recovery`, `capture_sharpening`, `profile`,
// and — via `ae_mode` — the `auto_exposure` mode the `auto_will_fit` probe
// pins).
//
// WB is pinned to the unauthored 6500K/0 sentinel, so the core develops at
// this camera's actual As-Shot point. The live binding applies a camera-frame
// delta using the same resolver as full develop.
//
// ## Why the GPU-only SUB-params are also neutralized (#1038)
//
// `build_full_chain_inputs` feeds the live chain `sharpen_radius/detail/masking`,
// `tone_curve_mode`, and `wb_method` — but those ride stages that are ZEROED /
// PINNED in this prefix (`sharpen_amount = 0` short-circuits the sharpen stage at
// `amount.abs() < 1e-3`; the tone-curve point sets are emptied; WB is pinned
// neutral so its method is inert), so they have NO effect on the developed buffer
// here. We pin them to their defaults anyway so the prefix model is a function of
// ONLY the fields that genuinely shape the buffer. Without this, dragging e.g. the
// sharpen-radius slider (with the default `sharpen_amount = 40` active on the GPU)
// would change the prefix model and trigger a SPURIOUS re-develop + re-upload
// every tick in the persistent session — correctness held, but the persistence
// win was lost. The `prefix_model_for`-equality boundary test pins this invariant.
prefix_policy! {
    ae_mode;
    keep [
        parametric_shadow_split,
        parametric_midtone_split,
        parametric_highlight_split,
        capture_sharpening_amount,
        capture_sharpening_sigma,
        capture_sharpening_radius,
        hue_adjustment_red,
        hue_adjustment_orange,
        hue_adjustment_yellow,
        hue_adjustment_green,
        hue_adjustment_aqua,
        hue_adjustment_blue,
        hue_adjustment_purple,
        hue_adjustment_magenta,
        saturation_adjustment_red,
        saturation_adjustment_orange,
        saturation_adjustment_yellow,
        saturation_adjustment_green,
        saturation_adjustment_aqua,
        saturation_adjustment_blue,
        saturation_adjustment_purple,
        saturation_adjustment_magenta,
        luminance_adjustment_red,
        luminance_adjustment_orange,
        luminance_adjustment_yellow,
        luminance_adjustment_green,
        luminance_adjustment_aqua,
        luminance_adjustment_blue,
        luminance_adjustment_purple,
        luminance_adjustment_magenta,
        black_white,
        gray_mixer_red,
        gray_mixer_orange,
        gray_mixer_yellow,
        gray_mixer_green,
        gray_mixer_aqua,
        gray_mixer_blue,
        gray_mixer_purple,
        gray_mixer_magenta,
        highlight_recovery,
        look,
        profile,
        inpaint_removals,
        retouch_spots,
        chroma_prefilter,
        hot_pixel_suppression,
        deep_denoise,
        crop,
        lens_profile_enable,
        lens_correction_distortion,
        lens_correction_ca,
        lens_correction_vignetting,
        perspective_vertical,
        perspective_horizontal,
        perspective_rotate,
        perspective_scale,
        perspective_aspect,
        perspective_x,
        perspective_y,
        demosaic,
        auto_lateral_ca,
        defringe_purple_amount,
        defringe_purple_hue_lo,
        defringe_purple_hue_hi,
        defringe_green_amount,
        defringe_green_hue_lo,
        defringe_green_hue_hi,
        lens_profile,
    ];
    neutral {
        // Film is a display-tail resource, not part of RAW development.
        film_look: String::new(),
        film_strength: 100.0,
        // Unauthored defaults → the camera As-Shot prefix; live WB is a frame delta.
        temperature: 6500.0,
        tint: 0.0,
        // The prefix is the camera As-Shot develop, independent of imported
        // axes and scale. The live binding resolves those against its cached frame.
        temperature_seen: false,
        tint_seen: false,
        wb_scale_version: crate::types::WbScaleVersion::V5,
        // WB method is inert at the neutral short-circuit; pin it so toggling the
        // method doesn't spuriously change the prefix (the GPU chain owns WB).
        wb_method: WbMethod::Cat16,
        // WB provenance is sidecar metadata; choosing a mode must not
        // invalidate the developed buffer behind the live GPU controls.
        wb_source: crate::types::adjustment::WbSource::AsShot,
        wb_sample_x: 0.0,
        wb_sample_y: 0.0,
        wb_algorithm_version: 0.0,
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
        // Local adjustments (#1698) are re-run by the GPU chain — clear the
        // stack so the develop prefix short-circuits the stage. A non-empty
        // value here would DOUBLE-APPLY: once in the prefix, once on the GPU.
        local_adjustments: Vec::new(),
        // Cleared alongside `local_adjustments` (#3271) — an empty layer
        // stack never resolves a raster, so an unused `Arc` clone here would
        // be pure overhead in the stripped copy.
        mask_rasters: Vec::new(),
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
        // Display-referred point curves (#2232) — display-tail like grain /
        // color_grade, entirely inside the GPU chain (post-AgX); pin so
        // dragging a display-curve control can't spuriously re-develop.
        display_tone_curve_luma: Default::default(),
        display_tone_curve_red: Default::default(),
        display_tone_curve_green: Default::default(),
        display_tone_curve_blue: Default::default(),
        // Sharpen is short-circuited (`amount = 0`), so its sub-params are inert;
        // pin them to defaults so dragging radius/detail/masking (with the GPU's
        // real `sharpen_amount` active) doesn't spuriously re-develop.
        sharpen_amount: 0.0,
        sharpen_radius: 1.0,
        sharpen_detail: 25.0,
        sharpen_masking: 0.0,
        nr_luminance: 0.0,
        nr_color: 0.0,
        // KEEP: highlight_recovery, capture_sharpening_*, profile,
        // `retouch_spots` (#3409 — a decode-product edit with no GPU pass of
        // its own, so it must stay in the prefix; placing a spot correctly
        // re-develops and re-uploads the base), and every other
        // decode-upstream field — they shape the post-AE buffer the GPU chain
        // consumes (so a change to any of them legitimately re-develops).
    }
}
