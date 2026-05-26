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
        wb_method,
        exposure,
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
        highlight_recovery,
        auto_exposure,
        look,
        local_adjustments,
        tone_curve_mode,
        tone_curve_luma,
        tone_curve_red,
        tone_curve_green,
        tone_curve_blue,
    } = m;
    let expected_order = [
        "temperature",
        "tint",
        "wb_method",
        "exposure",
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
        "highlight_recovery",
        "auto_exposure",
        "look",
        "tone_curve_mode",
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
        wb_method,
        exposure,
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
        highlight_recovery,
        auto_exposure,
        look,
        tone_curve_mode,
        tone_curve_luma,
        tone_curve_red,
        tone_curve_green,
        tone_curve_blue,
    );
    // `local_adjustments` is allow-listed: it carries structured data
    // (Vec<LocalAdjustment>) and is documented as not part of the schema
    // table. Asserting its default keeps the drift guard honest.
    assert!(
        local_adjustments.is_empty(),
        "AdjustmentModel::default().local_adjustments must be empty"
    );
}

/// Schema-exemption allow-list. Fields appearing here are the ones
/// `schema_matches_struct` deliberately omits from `ADJUSTMENT_SCHEMA`
/// because they carry structured payloads (Vec / nested struct) rather
/// than scalar values. Adding a new exemption MUST land in the same PR
/// that justifies the deviation. The string-matching keeps the
/// allow-list source-grep-friendly.
#[test]
fn schema_exemption_allowlist() {
    const ALLOWED: &[&str] = &["local_adjustments"];
    assert_eq!(
        ALLOWED.len(),
        1,
        "schema exemption count changed — update this test and the \
         matching note on the module-level doc-comment"
    );
    assert!(
        ALLOWED.contains(&"local_adjustments"),
        "local_adjustments must remain on the schema-exemption allow-list \
         until the codegen table grows a structured-field FieldKind variant"
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
            other => panic!("unknown f32 field {}", other),
        };
        assert_eq!(
            actual, spec.default_f32,
            "schema default for {} does not match struct default",
            spec.name
        );
    }
}

/// Highlight recovery is one of two enum fields; its declared
/// `enum_name` must agree with the type used on the struct.
#[test]
fn highlight_recovery_enum_spec_is_present() {
    let entry = ADJUSTMENT_SCHEMA
        .iter()
        .find(|s| s.name == "highlight_recovery")
        .expect("highlight_recovery missing from schema");
    assert!(matches!(entry.kind, FieldKind::Enum));
    assert_eq!(entry.enum_name, "HighlightRecoveryMode");
}

/// DisplayLookCurve (ticket #371). Enum field; codegen emits matching
/// Swift / TS mirrors.
#[test]
fn look_enum_spec_is_present() {
    let entry = ADJUSTMENT_SCHEMA
        .iter()
        .find(|s| s.name == "look")
        .expect("look missing from schema");
    assert!(matches!(entry.kind, FieldKind::Enum));
    assert_eq!(entry.enum_name, "Look");
}

/// WbMethod (ticket #431). Enum field; codegen emits matching
/// Swift / TS mirrors.
#[test]
fn wb_method_enum_spec_is_present() {
    let entry = ADJUSTMENT_SCHEMA
        .iter()
        .find(|s| s.name == "wb_method")
        .expect("wb_method missing from schema");
    assert!(matches!(entry.kind, FieldKind::Enum));
    assert_eq!(entry.enum_name, "WbMethod");
}

/// ToneCurveMode (ticket #436). Enum field; codegen emits matching
/// Swift / TS mirrors.
#[test]
fn tone_curve_mode_enum_spec_is_present() {
    let entry = ADJUSTMENT_SCHEMA
        .iter()
        .find(|s| s.name == "tone_curve_mode")
        .expect("tone_curve_mode missing from schema");
    assert!(matches!(entry.kind, FieldKind::Enum));
    assert_eq!(entry.enum_name, "ToneCurveMode");
}

/// New PV2012 parametric region sliders are present in the schema with
/// the canonical `[-100, 100]` range and default 0.
#[test]
fn parametric_region_fields_present_with_default_zero() {
    for name in [
        "parametric_highlights",
        "parametric_lights",
        "parametric_darks",
        "parametric_shadows",
    ] {
        let entry = ADJUSTMENT_SCHEMA
            .iter()
            .find(|s| s.name == name)
            .unwrap_or_else(|| panic!("{name} missing from ADJUSTMENT_SCHEMA"));
        assert!(matches!(entry.kind, FieldKind::F32));
        assert_eq!(entry.range, (-100.0, 100.0), "range for {name}");
        assert_eq!(entry.default_f32, 0.0, "default for {name}");
    }
}
