//! `ADJUSTMENT_SCHEMA` default-value guard, split out of `tests.rs` for the
//! 600-LOC budget (#2434). Same visibility trick: `super::*` is the schema
//! module, `super::super::AdjustmentModel` the struct.
#![cfg(test)]
use super::super::AdjustmentModel;
use super::*;

/// Every `F32` schema entry's `default_f32` matches the corresponding
/// field on `AdjustmentModel::default()`.
#[test]
#[allow(deprecated)]
fn schema_f32_defaults_match_struct_default() {
    let m = AdjustmentModel::default();
    for spec in ADJUSTMENT_SCHEMA {
        if !matches!(spec.kind, FieldKind::F32) {
            continue;
        }
        let actual = match spec.name {
            "temperature" => m.temperature,
            "tint" => m.tint,
            "wb_sample_x" => m.wb_sample_x,
            "wb_sample_y" => m.wb_sample_y,
            "wb_algorithm_version" => m.wb_algorithm_version,
            "exposure" => m.exposure,
            "brightness" => m.brightness,
            "contrast" => m.contrast,
            "highlights" => m.highlights,
            "shadows" => m.shadows,
            "whites" => m.whites,
            "blacks" => m.blacks,
            "parametric_highlights" => m.parametric_highlights,
            "parametric_lights" => m.parametric_lights,
            "parametric_darks" => m.parametric_darks,
            "parametric_shadows" => m.parametric_shadows,
            "parametric_shadow_split" => m.parametric_shadow_split,
            "parametric_midtone_split" => m.parametric_midtone_split,
            "parametric_highlight_split" => m.parametric_highlight_split,
            "vibrance" => m.vibrance,
            "saturation" => m.saturation,
            "clarity" => m.clarity,
            "texture" => m.texture,
            "sharpen_amount" => m.sharpen_amount,
            "sharpen_radius" => m.sharpen_radius,
            "sharpen_detail" => m.sharpen_detail,
            "sharpen_masking" => m.sharpen_masking,
            "capture_sharpening_amount" => m.capture_sharpening_amount,
            "capture_sharpening_sigma" => m.capture_sharpening_sigma,
            "capture_sharpening_radius" => m.capture_sharpening_radius,
            "nr_luminance" => m.nr_luminance,
            "nr_color" => m.nr_color,
            "dehaze" => m.dehaze,
            "vignette_amount" => m.vignette_amount,
            "vignette_feather" => m.vignette_feather,
            "grain_amount" => m.grain_amount,
            "grain_size" => m.grain_size,
            "grain_roughness" => m.grain_roughness,
            "film_strength" => m.film_strength,
            "split_tone_shadow_hue" => m.split_tone_shadow_hue,
            "split_tone_shadow_saturation" => m.split_tone_shadow_saturation,
            "split_tone_highlight_hue" => m.split_tone_highlight_hue,
            "split_tone_highlight_saturation" => m.split_tone_highlight_saturation,
            "split_tone_balance" => m.split_tone_balance,
            "color_grade_shadow_luminance" => m.color_grade_shadow_luminance,
            "color_grade_midtone_hue" => m.color_grade_midtone_hue,
            "color_grade_midtone_saturation" => m.color_grade_midtone_saturation,
            "color_grade_midtone_luminance" => m.color_grade_midtone_luminance,
            "color_grade_highlight_luminance" => m.color_grade_highlight_luminance,
            "color_grade_global_hue" => m.color_grade_global_hue,
            "color_grade_global_saturation" => m.color_grade_global_saturation,
            "color_grade_global_luminance" => m.color_grade_global_luminance,
            "hue_adjustment_red" => m.hue_adjustment_red,
            "hue_adjustment_orange" => m.hue_adjustment_orange,
            "hue_adjustment_yellow" => m.hue_adjustment_yellow,
            "hue_adjustment_green" => m.hue_adjustment_green,
            "hue_adjustment_aqua" => m.hue_adjustment_aqua,
            "hue_adjustment_blue" => m.hue_adjustment_blue,
            "hue_adjustment_purple" => m.hue_adjustment_purple,
            "hue_adjustment_magenta" => m.hue_adjustment_magenta,
            "saturation_adjustment_red" => m.saturation_adjustment_red,
            "saturation_adjustment_orange" => m.saturation_adjustment_orange,
            "saturation_adjustment_yellow" => m.saturation_adjustment_yellow,
            "saturation_adjustment_green" => m.saturation_adjustment_green,
            "saturation_adjustment_aqua" => m.saturation_adjustment_aqua,
            "saturation_adjustment_blue" => m.saturation_adjustment_blue,
            "saturation_adjustment_purple" => m.saturation_adjustment_purple,
            "saturation_adjustment_magenta" => m.saturation_adjustment_magenta,
            "luminance_adjustment_red" => m.luminance_adjustment_red,
            "luminance_adjustment_orange" => m.luminance_adjustment_orange,
            "luminance_adjustment_yellow" => m.luminance_adjustment_yellow,
            "luminance_adjustment_green" => m.luminance_adjustment_green,
            "luminance_adjustment_aqua" => m.luminance_adjustment_aqua,
            "luminance_adjustment_blue" => m.luminance_adjustment_blue,
            "luminance_adjustment_purple" => m.luminance_adjustment_purple,
            "luminance_adjustment_magenta" => m.luminance_adjustment_magenta,
            "gray_mixer_red" => m.gray_mixer_red,
            "gray_mixer_orange" => m.gray_mixer_orange,
            "gray_mixer_yellow" => m.gray_mixer_yellow,
            "gray_mixer_green" => m.gray_mixer_green,
            "gray_mixer_aqua" => m.gray_mixer_aqua,
            "gray_mixer_blue" => m.gray_mixer_blue,
            "gray_mixer_purple" => m.gray_mixer_purple,
            "gray_mixer_magenta" => m.gray_mixer_magenta,
            "chroma_prefilter" => m.chroma_prefilter,
            "deep_denoise" => m.deep_denoise,
            "lens_correction_distortion" => m.lens_correction_distortion,
            "lens_correction_ca" => m.lens_correction_ca,
            "lens_correction_vignetting" => m.lens_correction_vignetting,
            "geo_perspective_h" => m.geo_perspective_h,
            "geo_perspective_v" => m.geo_perspective_v,
            "geo_rotation" => m.geo_rotation,
            "geo_aspect" => m.geo_aspect,
            "geo_scale" => m.geo_scale,
            other => panic!("unknown f32 field {}", other),
        };
        assert_eq!(
            actual, spec.default_f32,
            "schema default for {} does not match struct default",
            spec.name
        );
    }
}
