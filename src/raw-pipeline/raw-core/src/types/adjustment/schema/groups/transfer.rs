//! Transfer semantics for every field, independently pinned against group coverage (#3311).
//! Relative white balance remains unassigned until #2434 supplies its camera-baseline
//! contract. Absolute WB preserves the authored scale and As Shot sentinel together.

use super::NON_COPYABLE_FIELDS;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TransferMode {
    Absolute,
    Relative,
    AssetRelative,
    Unsupported,
}

impl TransferMode {
    pub const fn name(self) -> &'static str {
        match self {
            Self::Absolute => "Absolute",
            Self::Relative => "Relative",
            Self::AssetRelative => "AssetRelative",
            Self::Unsupported => "Unsupported",
        }
    }
}

/// No fallback for unknown fields: adding a group field requires a transfer decision.
pub fn transfer_mode(field: &str) -> Option<TransferMode> {
    if field == "crop" {
        return Some(TransferMode::AssetRelative);
    }
    if NON_COPYABLE_FIELDS.contains(&field) || matches!(field, "temperature_seen" | "tint_seen") {
        return Some(TransferMode::Unsupported);
    }
    ABSOLUTE_FIELDS
        .contains(&field)
        .then_some(TransferMode::Absolute)
}

// Explicit rather than `all group fields`: a new field must make a reviewed
// transfer decision, even when the decision is to retain today's absolute copy.
const ABSOLUTE_FIELDS: &[&str] = &[
    "temperature",
    "tint",
    "wb_method",
    "wb_scale_version",
    "wb_source",
    "exposure",
    "brightness",
    "contrast",
    "highlights",
    "shadows",
    "whites",
    "blacks",
    "parametric_highlights",
    "parametric_lights",
    "parametric_darks",
    "parametric_shadows",
    "parametric_shadow_split",
    "parametric_midtone_split",
    "parametric_highlight_split",
    "auto_exposure",
    "tone_curve_mode",
    "tone_curve_luma",
    "tone_curve_red",
    "tone_curve_green",
    "tone_curve_blue",
    "display_tone_curve_luma",
    "display_tone_curve_red",
    "display_tone_curve_green",
    "display_tone_curve_blue",
    "vibrance",
    "saturation",
    "hue_adjustment_red",
    "hue_adjustment_orange",
    "hue_adjustment_yellow",
    "hue_adjustment_green",
    "hue_adjustment_aqua",
    "hue_adjustment_blue",
    "hue_adjustment_purple",
    "hue_adjustment_magenta",
    "saturation_adjustment_red",
    "saturation_adjustment_orange",
    "saturation_adjustment_yellow",
    "saturation_adjustment_green",
    "saturation_adjustment_aqua",
    "saturation_adjustment_blue",
    "saturation_adjustment_purple",
    "saturation_adjustment_magenta",
    "luminance_adjustment_red",
    "luminance_adjustment_orange",
    "luminance_adjustment_yellow",
    "luminance_adjustment_green",
    "luminance_adjustment_aqua",
    "luminance_adjustment_blue",
    "luminance_adjustment_purple",
    "luminance_adjustment_magenta",
    "black_white",
    "gray_mixer_red",
    "gray_mixer_orange",
    "gray_mixer_yellow",
    "gray_mixer_green",
    "gray_mixer_aqua",
    "gray_mixer_blue",
    "gray_mixer_purple",
    "gray_mixer_magenta",
    "split_tone_shadow_hue",
    "split_tone_shadow_saturation",
    "split_tone_highlight_hue",
    "split_tone_highlight_saturation",
    "split_tone_balance",
    "color_grade_shadow_luminance",
    "color_grade_midtone_hue",
    "color_grade_midtone_saturation",
    "color_grade_midtone_luminance",
    "color_grade_highlight_luminance",
    "color_grade_global_hue",
    "color_grade_global_saturation",
    "color_grade_global_luminance",
    "highlight_recovery",
    "look",
    "profile",
    "clarity",
    "texture",
    "dehaze",
    "sharpen_amount",
    "sharpen_radius",
    "sharpen_detail",
    "sharpen_masking",
    "capture_sharpening_amount",
    "capture_sharpening_sigma",
    "nr_luminance",
    "nr_color",
    "chroma_prefilter",
    "hot_pixel_suppression",
    "deep_denoise",
    "lens_profile_enable",
    "lens_correction_distortion",
    "lens_correction_ca",
    "lens_correction_vignetting",
    "vignette_amount",
    "vignette_feather",
    "grain_amount",
    "grain_size",
    "grain_roughness",
    "film_look",
    "film_strength",
];

#[cfg(test)]
mod tests {
    use super::super::AdjustmentGroup;
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn every_grouped_field_has_an_explicit_mode_and_no_stale_entries() {
        let grouped: HashSet<_> = AdjustmentGroup::ALL
            .iter()
            .flat_map(|group| group.fields().iter().copied())
            .collect();
        for field in &grouped {
            assert!(
                transfer_mode(field).is_some(),
                "missing transfer decision for {field}"
            );
        }
        assert!(ABSOLUTE_FIELDS.iter().all(|field| grouped.contains(field)));
        assert_eq!(
            ABSOLUTE_FIELDS.iter().collect::<HashSet<_>>().len(),
            ABSOLUTE_FIELDS.len()
        );
        assert_eq!(transfer_mode("crop"), Some(TransferMode::AssetRelative));
        assert_eq!(transfer_mode("unknown_future_field"), None);
        assert_eq!(
            transfer_mode("temperature_seen"),
            Some(TransferMode::Unsupported)
        );
        assert_eq!(transfer_mode("tint_seen"), Some(TransferMode::Unsupported));
        for field in NON_COPYABLE_FIELDS {
            assert_eq!(transfer_mode(field), Some(TransferMode::Unsupported));
        }
    }
}
