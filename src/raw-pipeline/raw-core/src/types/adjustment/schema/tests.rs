//! Tests for the `ADJUSTMENT_SCHEMA` codegen table. Split out of `mod.rs`
//! to keep both files under the 600-LOC hard cap (per CONTRIBUTING.md).
//! Visibility: `super::*` exposes every public item on `schema::mod.rs`,
//! and `super::super::AdjustmentModel` reaches the struct on the parent
//! adjustment module.

#![cfg(test)]

use super::super::AdjustmentModel;
use super::*;

/// Schema-vs-struct drift guard: every scalar / enum field of the
/// struct must appear exactly once in the schema, in declaration order.
/// We can't reflect on Rust structs at compile time, so this test
/// instantiates the default model and pattern-matches every field —
/// adding a field to the struct without updating the test (and the
/// schema) is a build failure.
#[test]
#[allow(deprecated)]
fn schema_matches_struct() {
    let m = AdjustmentModel::default();
    // Pattern-match every field. Adding a struct field without
    // updating this list is a compile error.
    let AdjustmentModel {
        temperature,
        tint,
        temperature_seen,
        tint_seen,
        wb_method,
        wb_scale_version,
        exposure,
        brightness,
        contrast,
        highlights,
        shadows,
        whites,
        blacks,
        parametric_highlights,
        parametric_lights,
        parametric_darks,
        parametric_shadows,
        vibrance,
        saturation,
        clarity,
        texture,
        sharpen_amount,
        sharpen_radius,
        sharpen_detail,
        sharpen_masking,
        capture_sharpening_amount,
        capture_sharpening_sigma,
        capture_sharpening_radius,
        nr_luminance,
        nr_color,
        dehaze,
        vignette_amount,
        vignette_feather,
        grain_amount,
        grain_size,
        grain_roughness,
        split_tone_shadow_hue,
        split_tone_shadow_saturation,
        split_tone_highlight_hue,
        split_tone_highlight_saturation,
        split_tone_balance,
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
        auto_exposure,
        look,
        profile,
        local_adjustments,
        inpaint_removals,
        tone_curve_mode,
        tone_curve_luma,
        tone_curve_red,
        tone_curve_green,
        tone_curve_blue,
        chroma_prefilter,
        hot_pixel_suppression,
        deep_denoise,
        // `crop` is excluded from ADJUSTMENT_SCHEMA by design (nested struct,
        // not a codegen-eligible scalar/enum). Bound here so adding a struct
        // field without updating this test is a compile error.
        crop,
    } = m;
    let expected_order = [
        "temperature",
        "tint",
        "wb_method",
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
        "vibrance",
        "saturation",
        "clarity",
        "texture",
        "sharpen_amount",
        "sharpen_radius",
        "sharpen_detail",
        "sharpen_masking",
        "capture_sharpening_amount",
        "capture_sharpening_sigma",
        "capture_sharpening_radius",
        "nr_luminance",
        "nr_color",
        "dehaze",
        "vignette_amount",
        "vignette_feather",
        "grain_amount",
        "grain_size",
        "grain_roughness",
        "split_tone_shadow_hue",
        "split_tone_shadow_saturation",
        "split_tone_highlight_hue",
        "split_tone_highlight_saturation",
        "split_tone_balance",
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
        "highlight_recovery",
        "auto_exposure",
        "look",
        "profile",
        "tone_curve_mode",
        "tone_curve_luma",
        "tone_curve_red",
        "tone_curve_green",
        "tone_curve_blue",
        "chroma_prefilter",
        "hot_pixel_suppression",
        "deep_denoise",
    ];
    assert_eq!(
        ADJUSTMENT_SCHEMA.len(),
        expected_order.len(),
        "schema length does not match field count"
    );
    for (i, name) in expected_order.iter().enumerate() {
        assert_eq!(
            ADJUSTMENT_SCHEMA[i].name, *name,
            "schema entry {} expected {} got {}",
            i, name, ADJUSTMENT_SCHEMA[i].name
        );
    }
    // Silence unused-variable warnings while still exercising every binding.
    let _ = (
        temperature,
        tint,
        temperature_seen,
        tint_seen,
        wb_method,
        wb_scale_version,
        exposure,
        brightness,
        contrast,
        highlights,
        shadows,
        whites,
        blacks,
        parametric_highlights,
        parametric_lights,
        parametric_darks,
        parametric_shadows,
        vibrance,
        saturation,
        clarity,
        texture,
        sharpen_amount,
        sharpen_radius,
        sharpen_detail,
        sharpen_masking,
        capture_sharpening_amount,
        capture_sharpening_sigma,
        capture_sharpening_radius,
        nr_luminance,
        nr_color,
        dehaze,
        vignette_amount,
        vignette_feather,
        grain_amount,
        grain_size,
        grain_roughness,
        split_tone_shadow_hue,
        split_tone_shadow_saturation,
        split_tone_highlight_hue,
        split_tone_highlight_saturation,
        split_tone_balance,
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
        auto_exposure,
        look,
        profile,
        tone_curve_mode,
        tone_curve_luma,
        tone_curve_red,
        tone_curve_green,
        tone_curve_blue,
        chroma_prefilter,
        hot_pixel_suppression,
        deep_denoise,
        crop,
    );
    // `local_adjustments` is allow-listed: it carries structured data
    // (Vec<LocalAdjustment>) and is documented as not part of the schema
    // table. `crop` is similarly allow-listed (nested struct, not a
    // codegen-eligible scalar/enum — see schema module docs). Asserting
    // their defaults keeps the drift guard honest.
    assert!(
        local_adjustments.is_empty(),
        "AdjustmentModel::default().local_adjustments must be empty"
    );
    assert!(
        inpaint_removals.is_empty(),
        "AdjustmentModel::default().inpaint_removals must be empty"
    );
    assert!(
        crop.is_identity(),
        "AdjustmentModel::default().crop must be identity"
    );
    assert!(
        !temperature_seen,
        "AdjustmentModel::default().temperature_seen must be false"
    );
    assert!(
        !tint_seen,
        "AdjustmentModel::default().tint_seen must be false"
    );
    assert_eq!(
        wb_scale_version,
        super::super::WbScaleVersion::V5,
        "AdjustmentModel::default().wb_scale_version must be V5 (fresh models \
         author in the #1894 Robertson-native slider-frame scale)"
    );
}

/// Schema-exemption allow-list. Fields appearing here are the ones
/// `schema_matches_struct` deliberately omits from `ADJUSTMENT_SCHEMA`
/// because they carry structured payloads (Vec / nested struct) rather
/// than scalar values. Adding a new exemption MUST land in the same PR
/// that justifies the deviation. The string-matching keeps the allow-list
/// source-grep-friendly.
#[test]
fn schema_exemption_allowlist() {
    // `crop` added in #277: nested `Crop` struct, not a codegen scalar.
    // `inpaint_removals` added in #1486: Vec<Removal> structured payload.
    // `temperature_seen` / `tint_seen` added in #1729: internal parse-state
    // booleans, not user-facing slider values.
    // `wb_scale_version` added in #1780: internal parse-state enum recording
    // which WB slider scale the sidecar's stored values were authored in.
    const ALLOWED: &[&str] = &[
        "local_adjustments",
        "inpaint_removals",
        "crop",
        "temperature_seen",
        "tint_seen",
        "wb_scale_version",
    ];
    assert_eq!(
        ALLOWED.len(),
        6,
        "schema exemption count changed — update this test and the \
         matching note on the module-level doc-comment"
    );
    assert!(
        ALLOWED.contains(&"local_adjustments"),
        "local_adjustments must remain on the schema-exemption allow-list \
         (Vec<LocalAdjustment> with its own schema — unlike the tone-curve \
         fields, which the FieldKind::ToneCurve variant covers since #366)"
    );
    assert!(
        ALLOWED.contains(&"inpaint_removals"),
        "inpaint_removals must remain on the schema-exemption allow-list \
         (Vec<Removal> structured payload, not a codegen-eligible scalar/enum)"
    );
    assert!(
        ALLOWED.contains(&"crop"),
        "crop must remain on the schema-exemption allow-list \
         (nested Crop struct, not a codegen-eligible scalar/enum)"
    );
    assert!(
        ALLOWED.contains(&"temperature_seen"),
        "temperature_seen must remain on the schema-exemption allow-list \
         (internal parse-state bool for #1729 WB anchoring, not a slider value)"
    );
    assert!(
        ALLOWED.contains(&"wb_scale_version"),
        "wb_scale_version must remain on the schema-exemption allow-list \
         (internal parse-state enum for the #1780 WB scale migration, not a \
         slider value)"
    );
    assert!(
        ALLOWED.contains(&"tint_seen"),
        "tint_seen must remain on the schema-exemption allow-list \
         (internal parse-state bool for #1729 WB anchoring, not a slider value)"
    );
}

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
            "split_tone_shadow_hue" => m.split_tone_shadow_hue,
            "split_tone_shadow_saturation" => m.split_tone_shadow_saturation,
            "split_tone_highlight_hue" => m.split_tone_highlight_hue,
            "split_tone_highlight_saturation" => m.split_tone_highlight_saturation,
            "split_tone_balance" => m.split_tone_balance,
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
            other => panic!("unknown f32 field {}", other),
        };
        assert_eq!(
            actual, spec.default_f32,
            "schema default for {} does not match struct default",
            spec.name
        );
    }
}
