//! Fresh-import defaults for [`AdjustmentModel`].
//!
//! Split out of the sibling `mod.rs` (#376) to keep that file under the
//! 600-LOC hard cap (CONTRIBUTING.md § File-size budget) — the same reason
//! each companion enum already lives in its own module. Pure move: the
//! values, their ordering, and the comments explaining each non-identity
//! default are unchanged.
//!
//! Per-#326 the sharpen defaults deliberately match the reference
//! renderer's import baseline rather than identity; the Swift mirror in
//! `AdjustmentModel.swift` carries the same numbers.

use super::*;

impl Default for AdjustmentModel {
    fn default() -> Self {
        Self {
            temperature: 6500.0,
            tint: 0.0,
            temperature_seen: false,
            tint_seen: false,
            wb_method: WbMethod::Cat16,
            wb_scale_version: WbScaleVersion::V5,
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
            vibrance: 0.0,
            saturation: 0.0,
            clarity: 0.0,
            texture: 0.0,
            // Sharpen defaults converge to the reference renderer's fresh-import baseline
            // (Sharpness=40, Radius=1.0, Detail=25, EdgeMasking=0) per #326.
            // Prior identity defaults (amount=0, radius=0.5) shipped soft
            // first-open output and conflated calibration drift with a
            // defaults mismatch in the perceptual harness.
            sharpen_amount: 40.0,
            sharpen_radius: 1.0,
            sharpen_detail: 25.0,
            sharpen_masking: 0.0,
            capture_sharpening_amount: 0.0,
            capture_sharpening_sigma: 1.0,
            #[allow(deprecated)]
            capture_sharpening_radius: 1.0,
            nr_luminance: 0.0,
            nr_color: 25.0,
            dehaze: 0.0,
            // Per-#643: S5 effects fields (vignette / grain / split tone).
            // Identity-stub defaults so first-open output is unchanged.
            vignette_amount: 0.0,
            vignette_feather: 50.0,
            grain_amount: 0.0,
            grain_size: 25.0,
            grain_roughness: 50.0,
            split_tone_shadow_hue: 0.0,
            split_tone_shadow_saturation: 0.0,
            split_tone_highlight_hue: 0.0,
            split_tone_highlight_saturation: 0.0,
            split_tone_balance: 0.0,
            // Colour grading (#275) — the remaining wheels. All 0, so the
            // stage short-circuits to a bit-identical no-op.
            color_grade_shadow_luminance: 0.0,
            color_grade_midtone_hue: 0.0,
            color_grade_midtone_saturation: 0.0,
            color_grade_midtone_luminance: 0.0,
            color_grade_highlight_luminance: 0.0,
            color_grade_global_hue: 0.0,
            color_grade_global_saturation: 0.0,
            color_grade_global_luminance: 0.0,
            // HSL 8-band defaults: all 0 (identity; stage short-circuits).
            hue_adjustment_red: 0.0,
            hue_adjustment_orange: 0.0,
            hue_adjustment_yellow: 0.0,
            hue_adjustment_green: 0.0,
            hue_adjustment_aqua: 0.0,
            hue_adjustment_blue: 0.0,
            hue_adjustment_purple: 0.0,
            hue_adjustment_magenta: 0.0,
            saturation_adjustment_red: 0.0,
            saturation_adjustment_orange: 0.0,
            saturation_adjustment_yellow: 0.0,
            saturation_adjustment_green: 0.0,
            saturation_adjustment_aqua: 0.0,
            saturation_adjustment_blue: 0.0,
            saturation_adjustment_purple: 0.0,
            saturation_adjustment_magenta: 0.0,
            luminance_adjustment_red: 0.0,
            luminance_adjustment_orange: 0.0,
            luminance_adjustment_yellow: 0.0,
            luminance_adjustment_green: 0.0,
            luminance_adjustment_aqua: 0.0,
            luminance_adjustment_blue: 0.0,
            luminance_adjustment_purple: 0.0,
            luminance_adjustment_magenta: 0.0,
            // Black & white mix (#276): colour render, flat mixer. Both
            // halves are identity — the 8-band stage keeps its HSL path.
            black_white: BlackWhiteMode::Off,
            gray_mixer_red: 0.0,
            gray_mixer_orange: 0.0,
            gray_mixer_yellow: 0.0,
            gray_mixer_green: 0.0,
            gray_mixer_aqua: 0.0,
            gray_mixer_blue: 0.0,
            gray_mixer_purple: 0.0,
            gray_mixer_magenta: 0.0,
            highlight_recovery: HighlightRecoveryMode::ChromaticAdaptation,
            // Per-#429: scene-anchor on by default — places mid-gray at
            // 0.18 before AgX. Users can opt out per-image for strict
            // scene-referred output.
            auto_exposure: AutoExposureMode::On,
            look: Look::Default,
            // Per-#536: Auto Profile is the new default — per-image curve
            // fit at render time. Users opt out per-image via
            // `papp:Profile="Neutral"` (AgX scene-referred view transform).
            profile: Profile::Auto,
            local_adjustments: Vec::new(),
            inpaint_removals: Vec::new(),
            // Per-#436: `PerChannel` is the pre-existing behavior. Default
            // chosen for backward compatibility — `RatioPreserving` is opt-in.
            tone_curve_mode: ToneCurveMode::PerChannel,
            // Per-channel point curves default to identity (empty `Vec`).
            // See the field-level docs above on the struct.
            tone_curve_luma: ToneCurve::default(),
            tone_curve_red: ToneCurve::default(),
            tone_curve_green: ToneCurve::default(),
            tone_curve_blue: ToneCurve::default(),
            // Per-#1104: decode-time chroma pre-filter ships default-off.
            chroma_prefilter: 0.0,
            // Per-#1106: off until a harness sweep shows enabling is free.
            hot_pixel_suppression: HotPixelSuppressionMode::Off,
            // Per-#1105: heavy opt-in stage, always default-off.
            deep_denoise: 0.0,
            // Per-#277: geometry stage defaults to full-frame identity.
            crop: Crop::IDENTITY,
            // Per-#376: the vendor's embedded corrections are authoritative,
            // so they apply at full strength by default — matching ACR,
            // which enables its lens profile whenever the DNG carries one.
            // A RAW without `OpcodeList3` has nothing to scale, so these
            // defaults are a no-op there.
            lens_profile_enable: LensProfileEnable::On,
            lens_correction_distortion: 100.0,
            lens_correction_ca: 100.0,
            lens_correction_vignetting: 100.0,
        }
    }
}
