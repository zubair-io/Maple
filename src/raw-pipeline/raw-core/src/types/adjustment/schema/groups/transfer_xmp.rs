//! Canonical wire keys touched by an adjustment transfer (#3311).
//! Emitted to both runtimes, so a server patch cannot drift from the Web allowlist.

pub const TRANSFER_XMP_ATTRIBUTES: &[(&str, &[&str])] = &[
    ("geo_perspective_h", &["papp:GeoPerspectiveH"]),
    ("geo_perspective_v", &["papp:GeoPerspectiveV"]),
    ("geo_rotation", &["papp:GeoRotation"]),
    ("geo_aspect", &["papp:GeoAspect"]),
    ("geo_scale", &["papp:GeoScale"]),
    ("temperature", &["crs:Temperature"]),
    ("tint", &["crs:Tint"]),
    ("exposure", &["crs:Exposure2012"]),
    ("brightness", &["papp:Brightness"]),
    ("contrast", &["crs:Contrast2012"]),
    ("highlights", &["crs:Highlights2012"]),
    ("shadows", &["crs:Shadows2012"]),
    ("whites", &["crs:Whites2012"]),
    ("blacks", &["crs:Blacks2012"]),
    ("parametric_highlights", &["crs:ParametricHighlights"]),
    ("parametric_lights", &["crs:ParametricLights"]),
    ("parametric_darks", &["crs:ParametricDarks"]),
    ("parametric_shadows", &["crs:ParametricShadows"]),
    ("parametric_shadow_split", &["crs:ParametricShadowSplit"]),
    ("parametric_midtone_split", &["crs:ParametricMidtoneSplit"]),
    (
        "parametric_highlight_split",
        &["crs:ParametricHighlightSplit"],
    ),
    ("vibrance", &["crs:Vibrance"]),
    ("saturation", &["crs:Saturation"]),
    ("clarity", &["crs:Clarity2012"]),
    ("texture", &["crs:Texture"]),
    ("dehaze", &["crs:Dehaze"]),
    ("sharpen_amount", &["crs:Sharpness"]),
    ("sharpen_radius", &["crs:SharpenRadius"]),
    ("sharpen_detail", &["crs:SharpenDetail"]),
    ("sharpen_masking", &["crs:SharpenEdgeMasking"]),
    (
        "capture_sharpening_amount",
        &["papp:CaptureSharpeningAmount"],
    ),
    (
        "capture_sharpening_sigma",
        &[
            "papp:CaptureSharpeningSigma",
            "papp:CaptureSharpeningRadius",
        ],
    ),
    ("nr_luminance", &["crs:LuminanceSmoothing"]),
    ("nr_color", &["crs:ColorNoiseReduction"]),
    ("chroma_prefilter", &["papp:ChromaPrefilter"]),
    ("deep_denoise", &["papp:DeepDenoise"]),
    ("vignette_amount", &["crs:PostCropVignetteAmount"]),
    ("vignette_feather", &["crs:PostCropVignetteFeather"]),
    ("grain_amount", &["crs:GrainAmount"]),
    ("grain_size", &["crs:GrainSize"]),
    ("grain_roughness", &["crs:GrainFrequency"]),
    ("split_tone_shadow_hue", &["crs:SplitToningShadowHue"]),
    (
        "split_tone_shadow_saturation",
        &["crs:SplitToningShadowSaturation"],
    ),
    ("split_tone_highlight_hue", &["crs:SplitToningHighlightHue"]),
    (
        "split_tone_highlight_saturation",
        &["crs:SplitToningHighlightSaturation"],
    ),
    ("split_tone_balance", &["crs:SplitToningBalance"]),
    ("color_grade_shadow_luminance", &["crs:ColorGradeShadowLum"]),
    ("color_grade_midtone_hue", &["crs:ColorGradeMidtoneHue"]),
    (
        "color_grade_midtone_saturation",
        &["crs:ColorGradeMidtoneSat"],
    ),
    (
        "color_grade_midtone_luminance",
        &["crs:ColorGradeMidtoneLum"],
    ),
    (
        "color_grade_highlight_luminance",
        &["crs:ColorGradeHighlightLum"],
    ),
    ("color_grade_global_hue", &["crs:ColorGradeGlobalHue"]),
    (
        "color_grade_global_saturation",
        &["crs:ColorGradeGlobalSat"],
    ),
    ("color_grade_global_luminance", &["crs:ColorGradeGlobalLum"]),
    ("hue_adjustment_red", &["crs:HueAdjustmentRed"]),
    ("hue_adjustment_orange", &["crs:HueAdjustmentOrange"]),
    ("hue_adjustment_yellow", &["crs:HueAdjustmentYellow"]),
    ("hue_adjustment_green", &["crs:HueAdjustmentGreen"]),
    ("hue_adjustment_aqua", &["crs:HueAdjustmentAqua"]),
    ("hue_adjustment_blue", &["crs:HueAdjustmentBlue"]),
    ("hue_adjustment_purple", &["crs:HueAdjustmentPurple"]),
    ("hue_adjustment_magenta", &["crs:HueAdjustmentMagenta"]),
    (
        "saturation_adjustment_red",
        &["crs:SaturationAdjustmentRed"],
    ),
    (
        "saturation_adjustment_orange",
        &["crs:SaturationAdjustmentOrange"],
    ),
    (
        "saturation_adjustment_yellow",
        &["crs:SaturationAdjustmentYellow"],
    ),
    (
        "saturation_adjustment_green",
        &["crs:SaturationAdjustmentGreen"],
    ),
    (
        "saturation_adjustment_aqua",
        &["crs:SaturationAdjustmentAqua"],
    ),
    (
        "saturation_adjustment_blue",
        &["crs:SaturationAdjustmentBlue"],
    ),
    (
        "saturation_adjustment_purple",
        &["crs:SaturationAdjustmentPurple"],
    ),
    (
        "saturation_adjustment_magenta",
        &["crs:SaturationAdjustmentMagenta"],
    ),
    ("luminance_adjustment_red", &["crs:LuminanceAdjustmentRed"]),
    (
        "luminance_adjustment_orange",
        &["crs:LuminanceAdjustmentOrange"],
    ),
    (
        "luminance_adjustment_yellow",
        &["crs:LuminanceAdjustmentYellow"],
    ),
    (
        "luminance_adjustment_green",
        &["crs:LuminanceAdjustmentGreen"],
    ),
    (
        "luminance_adjustment_aqua",
        &["crs:LuminanceAdjustmentAqua"],
    ),
    (
        "luminance_adjustment_blue",
        &["crs:LuminanceAdjustmentBlue"],
    ),
    (
        "luminance_adjustment_purple",
        &["crs:LuminanceAdjustmentPurple"],
    ),
    (
        "luminance_adjustment_magenta",
        &["crs:LuminanceAdjustmentMagenta"],
    ),
    ("gray_mixer_red", &["crs:GrayMixerRed"]),
    ("gray_mixer_orange", &["crs:GrayMixerOrange"]),
    ("gray_mixer_yellow", &["crs:GrayMixerYellow"]),
    ("gray_mixer_green", &["crs:GrayMixerGreen"]),
    ("gray_mixer_aqua", &["crs:GrayMixerAqua"]),
    ("gray_mixer_blue", &["crs:GrayMixerBlue"]),
    ("gray_mixer_purple", &["crs:GrayMixerPurple"]),
    ("gray_mixer_magenta", &["crs:GrayMixerMagenta"]),
    (
        "lens_correction_distortion",
        &["crs:LensProfileDistortionScale"],
    ),
    (
        "lens_correction_ca",
        &["crs:LensProfileChromaticAberrationScale"],
    ),
    (
        "lens_correction_vignetting",
        &["crs:LensProfileVignettingScale"],
    ),
    ("film_strength", &["papp:FilmStrength"]),
    ("wb_sample_x", &["papp:WbSampleX"]),
    ("wb_sample_y", &["papp:WbSampleY"]),
    ("wb_algorithm_version", &["papp:WbAlgorithmVersion"]),
    ("wb_method", &["papp:WbMethod"]),
    ("wb_source", &["papp:WbSource"]),
    ("wb_scale_version", &["papp:WbScaleVersion"]),
    ("highlight_recovery", &["papp:HighlightRecoveryMode"]),
    ("auto_exposure", &["papp:AutoExposure"]),
    ("look", &["papp:Look"]),
    ("profile", &["papp:Profile"]),
    ("film_look", &["papp:FilmLook"]),
    ("hot_pixel_suppression", &["papp:HotPixelSuppression"]),
    ("lens_profile_enable", &["crs:LensProfileEnable"]),
    ("black_white", &["crs:ConvertToGrayscale"]),
    ("tone_curve_mode", &["papp:ToneCurveMode"]),
    (
        "crop",
        &[
            "crs:HasCrop",
            "crs:CropTop",
            "crs:CropLeft",
            "crs:CropBottom",
            "crs:CropRight",
            "crs:CropAngle",
            "crs:CropConstrainToWarp",
        ],
    ),
];

pub const TRANSFER_XMP_ELEMENTS: &[(&str, &str)] = &[
    ("tone_curve_luma", "papp:SceneLinearToneCurve"),
    ("tone_curve_red", "papp:SceneLinearToneCurveRed"),
    ("tone_curve_green", "papp:SceneLinearToneCurveGreen"),
    ("tone_curve_blue", "papp:SceneLinearToneCurveBlue"),
    ("display_tone_curve_luma", "crs:ToneCurvePV2012"),
    ("display_tone_curve_red", "crs:ToneCurvePV2012Red"),
    ("display_tone_curve_green", "crs:ToneCurvePV2012Green"),
    ("display_tone_curve_blue", "crs:ToneCurvePV2012Blue"),
];

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::AdjustmentGroup;
    #[test]
    fn every_transferred_value_has_a_wire_mapping() {
        for field in AdjustmentGroup::ALL.iter().flat_map(|g| g.fields()) {
            assert!(
                matches!(*field, "temperature_seen" | "tint_seen")
                    || TRANSFER_XMP_ATTRIBUTES
                        .iter()
                        .any(|(name, _)| name == field)
                    || TRANSFER_XMP_ELEMENTS.iter().any(|(name, _)| name == field),
                "missing XMP transfer mapping for {field}"
            );
        }
    }
}
